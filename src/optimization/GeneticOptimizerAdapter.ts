/**
 * GeneticOptimizerAdapter
 *
 * Wraps the existing GeneticOptimizer to implement the IOptimizer interface.
 * This allows the genetic algorithm to be used interchangeably with Bayesian
 * and CMA-ES optimizers.
 */

import type {
    IOptimizer,
    ParameterBounds,
    EvaluationResult,
    StopCondition,
    GeneticAdapterConfig,
} from './interfaces.js';
import { DEFAULT_GENETIC_CONFIG } from './interfaces.js';
import { SimulatorLogger } from '../simulation/SimulatorLogger.js';

// ============================================================================
// Fitness Weights (copied from GeneticOptimizer for standalone operation)
// ============================================================================

interface FitnessWeights {
    pnl: number;
    sharpe: number;
    drawdownPenalty: number;
    winRate: number;
    consistency: number;
}

// ============================================================================
// Individual (internal representation)
// ============================================================================

interface Individual {
    params: Record<string, number>;
    fitness: number;
    generation: number;
    rawPnl?: number;
    sharpeRatio?: number;
    maxDrawdown?: number;
    winRate?: number;
    tradeCount?: number;
}

// ============================================================================
// GeneticOptimizerAdapter Class
// ============================================================================

export class GeneticOptimizerAdapter implements IOptimizer {
    readonly name = 'Genetic';

    private config: GeneticAdapterConfig;
    private fitnessWeights: FitnessWeights;
    private bounds: ParameterBounds = {};
    private population: Individual[] = [];
    private currentGeneration = 0;
    private fitnessHistory: { best: number; avg: number }[] = [];
    private initialized = false;
    private logger: SimulatorLogger | null;

    constructor(
        config: Partial<GeneticAdapterConfig> = {},
        logger?: SimulatorLogger
    ) {
        this.config = { ...DEFAULT_GENETIC_CONFIG, ...config };
        this.fitnessWeights = {
            pnl: 1.0,
            sharpe: 0.5,
            drawdownPenalty: 0.3,
            winRate: 0.2,
            consistency: 0.2,
        };
        this.logger = logger ?? null;
    }

    // -------------------------------------------------------------------------
    // IOptimizer Interface Implementation
    // -------------------------------------------------------------------------

    initialize(bounds: ParameterBounds): void {
        this.bounds = bounds;
        this.population = [];
        this.currentGeneration = 0;
        this.fitnessHistory = [];

        // Initialize first generation with random individuals
        for (let i = 0; i < this.config.populationSize; i++) {
            const params = this.generateRandomParams();
            this.population.push({
                params,
                fitness: 0,
                generation: 0,
            });
        }

        this.initialized = true;
        this.log(`Initialized population of ${this.population.length} individuals`);
    }

    ask(): Record<string, number>[] {
        if (!this.initialized) {
            throw new Error('GeneticOptimizer: Must call initialize() before ask()');
        }
        return this.population.map(ind => ({ ...ind.params }));
    }

    tell(results: EvaluationResult[]): void {
        if (!this.initialized) {
            throw new Error('GeneticOptimizer: Must call initialize() before tell()');
        }

        // Update fitness scores
        for (let i = 0; i < results.length && i < this.population.length; i++) {
            const result = results[i];
            const individual = this.population[i];

            // Store raw metrics
            individual.rawPnl = result.rawPnl ?? result.fitness;
            individual.sharpeRatio = result.sharpeRatio ?? 0;
            individual.maxDrawdown = result.maxDrawdown ?? 0;
            individual.winRate = result.winRate ?? 0;
            individual.tradeCount = result.tradeCount ?? 0;

            // Calculate multi-metric fitness
            individual.fitness = this.calculateMultiMetricFitness(result);
        }

        // Sort by fitness (descending)
        this.population.sort((a, b) => b.fitness - a.fitness);

        // Enforce diversity
        this.enforceDiversity();

        // Record generation stats
        const fitnesses = this.population.map(ind => ind.fitness);
        const bestFitness = Math.max(...fitnesses);
        const avgFitness = fitnesses.reduce((a, b) => a + b, 0) / fitnesses.length;
        this.fitnessHistory.push({ best: bestFitness, avg: avgFitness });

        this.log(
            `Gen ${this.currentGeneration}: Best=$${bestFitness.toFixed(2)} Avg=$${avgFitness.toFixed(2)}`
        );

        // Evolve to next generation
        this.evolve();
    }

    shouldStop(): StopCondition {
        // Check max generations
        if (this.currentGeneration >= this.config.maxIterations) {
            return {
                stop: true,
                reason: `Reached max generations (${this.config.maxIterations})`,
            };
        }

        // Check convergence
        if (this.fitnessHistory.length >= this.config.convergenceIterations) {
            const recent = this.fitnessHistory.slice(-this.config.convergenceIterations);
            const improvements = recent.slice(1).map((h, i) => h.best - recent[i].best);
            const avgImprovement = improvements.reduce((a, b) => a + b, 0) / improvements.length;

            const currentBestFitness = this.population[0]?.fitness ?? 0;
            let threshold = this.config.convergenceThreshold;

            if (currentBestFitness > 0 && this.config.useRelativeConvergence) {
                const relativeThreshold = currentBestFitness * this.config.convergenceThresholdPercent;
                threshold = Math.max(relativeThreshold, 0.10);
            }

            if (Math.abs(avgImprovement) < threshold) {
                return {
                    stop: true,
                    reason: `Converged (avg improvement ${avgImprovement.toFixed(4)} < ${threshold.toFixed(2)})`,
                };
            }
        }

        return { stop: false, reason: '' };
    }

    getBest(): EvaluationResult | null {
        if (this.population.length === 0) return null;

        const best = this.population[0];
        return {
            params: { ...best.params },
            fitness: best.fitness,
            rawPnl: best.rawPnl,
            sharpeRatio: best.sharpeRatio,
            maxDrawdown: best.maxDrawdown,
            winRate: best.winRate,
            tradeCount: best.tradeCount,
        };
    }

    getIteration(): number {
        return this.currentGeneration;
    }

    // -------------------------------------------------------------------------
    // Genetic Operations
    // -------------------------------------------------------------------------

    private evolve(): void {
        this.currentGeneration++;
        const newPopulation: Individual[] = [];

        // Elitism: keep top performers unchanged
        for (let i = 0; i < this.config.eliteCount && i < this.population.length; i++) {
            newPopulation.push({
                ...this.population[i],
                generation: this.currentGeneration,
            });
        }

        // Fill rest with offspring
        while (newPopulation.length < this.config.populationSize) {
            const parent1 = this.selectParent();
            const parent2 = this.selectParent();

            let childParams: Record<string, number>;

            if (Math.random() < this.config.crossoverRate) {
                childParams = this.crossover(parent1.params, parent2.params);
            } else {
                childParams = { ...parent1.params };
            }

            // Mutation
            if (Math.random() < this.config.mutationRate) {
                childParams = this.mutate(childParams);
            }

            newPopulation.push({
                params: childParams,
                fitness: 0,
                generation: this.currentGeneration,
            });
        }

        this.population = newPopulation;
    }

    private selectParent(): Individual {
        // Tournament selection
        const tournamentSize = Math.min(3, this.population.length);
        let best: Individual | null = null;

        for (let i = 0; i < tournamentSize; i++) {
            const idx = Math.floor(Math.random() * this.population.length);
            const candidate = this.population[idx];

            if (!best || candidate.fitness > best.fitness) {
                best = candidate;
            }
        }

        return best!;
    }

    private crossover(
        parent1: Record<string, number>,
        parent2: Record<string, number>
    ): Record<string, number> {
        const child: Record<string, number> = {};
        for (const key of Object.keys(this.bounds)) {
            child[key] = Math.random() < 0.5 ? parent1[key] : parent2[key];
        }
        return child;
    }

    private mutate(params: Record<string, number>): Record<string, number> {
        const mutated = { ...params };

        for (const [key, bound] of Object.entries(this.bounds)) {
            if (Math.random() < 0.5) {
                const range = bound.max - bound.min;
                const noise = (Math.random() - 0.5) * 2 * range * this.config.mutationStrength;
                let newValue = mutated[key] + noise;

                // Clamp to bounds
                newValue = Math.max(bound.min, Math.min(bound.max, newValue));

                // Apply step if discrete
                if (bound.step) {
                    newValue = Math.round(newValue / bound.step) * bound.step;
                }

                mutated[key] = newValue;
            }
        }

        return mutated;
    }

    // -------------------------------------------------------------------------
    // Fitness & Diversity
    // -------------------------------------------------------------------------

    private calculateMultiMetricFitness(result: EvaluationResult): number {
        const w = this.fitnessWeights;

        // Base fitness from PnL
        let fitness = (result.rawPnl ?? result.fitness) * w.pnl;

        // Add Sharpe ratio contribution
        if (result.sharpeRatio !== undefined) {
            fitness += result.sharpeRatio * 10 * w.sharpe;
        }

        // Penalize drawdown
        if (result.maxDrawdown !== undefined) {
            fitness += result.maxDrawdown * w.drawdownPenalty;
        }

        // Add win rate contribution
        if (result.winRate !== undefined) {
            fitness += result.winRate * 0.1 * w.winRate;
        }

        // Consistency (use sharpe as proxy)
        if (result.sharpeRatio !== undefined && result.sharpeRatio > 0) {
            fitness += result.sharpeRatio * 5 * w.consistency;
        }

        // Apply minimum trade count penalty
        const tradeCount = result.tradeCount ?? 0;
        if (tradeCount < this.config.minTradeCount) {
            const penaltyRatio = tradeCount / this.config.minTradeCount;
            fitness *= penaltyRatio * this.config.minTradePenalty;
            if (tradeCount === 0) {
                fitness = -1000;
            }
        }

        // Clamp fitness
        const MAX_REASONABLE_FITNESS = 100000;
        if (!isFinite(fitness) || isNaN(fitness)) {
            fitness = -1000;
        } else {
            fitness = Math.max(-MAX_REASONABLE_FITNESS, Math.min(MAX_REASONABLE_FITNESS, fitness));
        }

        return fitness;
    }

    private enforceDiversity(): void {
        const diversity = this.calculateDiversity();

        if (diversity < this.config.diversityThreshold) {
            const numToReplace = Math.floor(
                this.population.length * this.config.diversityInjectionRate
            );
            this.log(
                `Low diversity (${(diversity * 100).toFixed(1)}%), injecting ${numToReplace} random individuals`
            );

            // Replace worst performers with random individuals
            for (let i = 0; i < numToReplace && i < this.population.length; i++) {
                const idx = this.population.length - 1 - i;
                this.population[idx] = {
                    params: this.generateRandomParams(),
                    fitness: 0,
                    generation: this.currentGeneration,
                };
            }
        }
    }

    private calculateDiversity(): number {
        if (this.population.length < 2) return 1.0;

        let totalDistance = 0;
        let comparisons = 0;

        for (let i = 0; i < this.population.length; i++) {
            for (let j = i + 1; j < this.population.length; j++) {
                totalDistance += this.calculateIndividualDistance(
                    this.population[i].params,
                    this.population[j].params
                );
                comparisons++;
            }
        }

        return comparisons > 0 ? totalDistance / comparisons : 1.0;
    }

    private calculateIndividualDistance(
        params1: Record<string, number>,
        params2: Record<string, number>
    ): number {
        let sumSquaredDiff = 0;
        let numParams = 0;

        for (const [key, bound] of Object.entries(this.bounds)) {
            const range = bound.max - bound.min;
            if (range > 0) {
                const normalizedDiff = (params1[key] - params2[key]) / range;
                sumSquaredDiff += normalizedDiff * normalizedDiff;
                numParams++;
            }
        }

        return numParams > 0 ? Math.sqrt(sumSquaredDiff / numParams) : 0;
    }

    // -------------------------------------------------------------------------
    // Utilities
    // -------------------------------------------------------------------------

    private generateRandomParams(): Record<string, number> {
        const params: Record<string, number> = {};

        for (const [key, bound] of Object.entries(this.bounds)) {
            let value = bound.min + Math.random() * (bound.max - bound.min);
            if (bound.step) {
                value = Math.round(value / bound.step) * bound.step;
            }
            params[key] = value;
        }

        return params;
    }

    private log(message: string): void {
        if (this.logger) {
            this.logger.log(`  [Genetic] ${message}`);
        }
    }
}
