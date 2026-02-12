import { SimulationResult } from './HistoricalSimulator.js';
import { SimulatorLogger } from './SimulatorLogger.js';

// ============================================================================
// Types & Interfaces
// ============================================================================

export enum CoinType {
    BTC = 'btc',
    ETH = 'eth',
    SOL = 'sol',
    XRP = 'xrp',
}

export interface GeneticConfig {
    populationSize: number;          // Number of individuals per generation
    maxGenerations: number;          // Maximum generations (M)
    convergenceThreshold: number;    // Min PnL improvement to continue (N)
    convergenceGenerations: number;  // How many generations to check for convergence
    mutationRate: number;            // Probability of mutation (0-1)
    mutationStrength: number;        // How much to mutate (0-1, as fraction of range)
    eliteCount: number;              // Number of top performers to keep unchanged
    crossoverRate: number;           // Probability of crossover vs clone
    // Anti-overfitting settings
    minTradeCount: number;           // Minimum trades required (default: 10)
    minTradePenalty: number;         // Penalty multiplier when below minTradeCount (default: 0.5)
    fitnessMode: FitnessMode;        // Primary metric for optimization (default: 'sortino')
    fitnessWeights: FitnessWeights;  // Weights for multi-metric fitness
    diversityThreshold: number;      // Min population diversity before injection (default: 0.1)
    diversityInjectionRate: number;  // Fraction of population to replace if low diversity (default: 0.2)
    // Relative convergence settings (helps quarterly markets with smaller improvements)
    useRelativeConvergence: boolean; // Use percentage-based convergence (default: true)
    convergenceThresholdPercent: number; // Percentage of fitness for convergence (default: 0.01 = 1%)
    // Bootstrap resampling settings (reduces overfitting variance)
    bootstrapRuns: number;           // Number of runs to average per individual (default: 1, recommended: 3-5)
    // Validation enforcement
    requireValidation: boolean;      // Require validation before returning results (default: true)
}

/**
 * Fitness mode determines the primary metric for optimization.
 * - 'pnl': Optimize raw PnL (can overfit to lucky volatile strategies)
 * - 'sharpe': Optimize Sharpe ratio (penalizes all volatility)
 * - 'sortino': Optimize Sortino ratio (only penalizes downside volatility) - RECOMMENDED
 * - 'calmar': Optimize return/drawdown ratio (focuses on avoiding large drawdowns)
 */
export type FitnessMode = 'pnl' | 'sharpe' | 'sortino' | 'calmar';

export interface FitnessWeights {
    pnl: number;              // Weight for total PnL (default: 1.0)
    sharpe: number;           // Weight for Sharpe ratio (default: 0.5)
    sortino: number;          // Weight for Sortino ratio (default: 0.0)
    calmar: number;           // Weight for Calmar ratio (default: 0.0)
    drawdownPenalty: number;  // Penalty multiplier for max drawdown (default: 0.3)
    winRate: number;          // Weight for win rate (default: 0.2)
    consistency: number;      // Weight for PnL consistency (low variance) (default: 0.2)
}

export interface ParameterBounds {
    [key: string]: {
        min: number;
        max: number;
        step?: number;  // Optional step size for discrete parameters
        type?: 'continuous' | 'discrete';
    };
}

export interface Individual {
    params: Record<string, number>;
    fitness: number;
    generation: number;
    // Extended metrics for analysis
    rawPnl?: number;
    sharpeRatio?: number;
    sortinoRatio?: number;
    calmarRatio?: number;
    maxDrawdown?: number;
    winRate?: number;
    tradeCount?: number;
    pnlVariance?: number;
}

export interface GenerationStats {
    generation: number;
    bestFitness: number;
    avgFitness: number;
    worstFitness: number;
    improvement: number;
    bestParams: Record<string, number>;
}

export interface OptimizationResult {
    bestIndividual: Individual;
    generationHistory: GenerationStats[];
    totalGenerations: number;
    converged: boolean;
    convergenceReason: string;
    // Validation results (if validation was run)
    validationResult?: ValidationResult;
    stabilityResult?: StabilityResult;
}

export interface ValidationResult {
    trainPnl: number;
    validationPnl: number;
    holdoutPnl?: number;
    crossPeriodPnls: number[];
    crossPeriodAvg: number;
    crossPeriodStdDev: number;
    overfit: boolean;  // true if validation << training
}

export interface StabilityResult {
    originalPnl: number;
    perturbedPnls: number[];
    avgPerturbedPnl: number;
    stabilityScore: number;  // avgPerturbed / original (closer to 1 = more stable)
    isStable: boolean;       // true if stabilityScore > 0.7
}

// ============================================================================
// GeneticOptimizer Class
// ============================================================================

export class GeneticOptimizer {
    private config: GeneticConfig;
    private bounds: ParameterBounds;
    private population: Individual[] = [];
    private generationHistory: GenerationStats[] = [];
    private currentGeneration = 0;
    private logger: SimulatorLogger;

    constructor(config: GeneticConfig, bounds: ParameterBounds, logger: SimulatorLogger) {
        this.config = config;
        this.bounds = bounds;
        this.logger = logger;
    }

    /**
     * Creates a GeneticConfig with sensible defaults for any unspecified fields.
     * Use this helper when you want default values.
     */
    public static createConfig(overrides: Partial<GeneticConfig> = {}): GeneticConfig {
        // Default weights for multi-metric fitness
        // When fitnessMode is set, these weights are used as secondary factors
        const defaultFitnessWeights: FitnessWeights = {
            pnl: 0.3,           // Reduced - raw PnL is less important with risk-adjusted mode
            sharpe: 0.2,        // Sharpe as secondary signal
            sortino: 0.0,       // Primary metric handled by fitnessMode
            calmar: 0.0,        // Primary metric handled by fitnessMode
            drawdownPenalty: 0.5, // Increased - penalize large drawdowns
            winRate: 0.1,       // Minor factor
            consistency: 0.2,   // Reward consistent returns
        };

        return {
            populationSize: overrides.populationSize ?? 20,
            maxGenerations: overrides.maxGenerations ?? 50,
            convergenceThreshold: overrides.convergenceThreshold ?? 1.0,
            convergenceGenerations: overrides.convergenceGenerations ?? 5,
            mutationRate: overrides.mutationRate ?? 0.2,
            mutationStrength: overrides.mutationStrength ?? 0.3,
            eliteCount: overrides.eliteCount ?? 2,
            crossoverRate: overrides.crossoverRate ?? 0.7,
            minTradeCount: overrides.minTradeCount ?? 10,
            minTradePenalty: overrides.minTradePenalty ?? 0.5,
            fitnessMode: overrides.fitnessMode ?? 'sortino',  // Default to Sortino (risk-adjusted)
            fitnessWeights: overrides.fitnessWeights ?? defaultFitnessWeights,
            diversityThreshold: overrides.diversityThreshold ?? 0.1,
            diversityInjectionRate: overrides.diversityInjectionRate ?? 0.2,
            useRelativeConvergence: overrides.useRelativeConvergence ?? true,
            convergenceThresholdPercent: overrides.convergenceThresholdPercent ?? 0.01,
            bootstrapRuns: overrides.bootstrapRuns ?? 1,
            requireValidation: overrides.requireValidation ?? true,
        };
    }

    // -------------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------------

    /**
     * Initializes the first generation with random individuals.
     */
    public initializePopulation(): Record<string, number>[] {
        this.population = [];
        this.generationHistory = [];
        this.currentGeneration = 0;

        for (let i = 0; i < this.config.populationSize; i++) {
            const params = this.generateRandomParams();
            this.population.push({
                params,
                fitness: 0,
                generation: 0,
            });
        }

        return this.population.map(ind => ind.params);
    }

    /**
     * Updates fitness scores from simulation results using multi-metric fitness.
     */
    public updateFitness(results: SimulationResult[]): void {
        for (let i = 0; i < results.length && i < this.population.length; i++) {
            const result = results[i];
            const individual = this.population[i];

            // Store raw metrics for analysis
            individual.rawPnl = result.totalPnl;
            individual.sharpeRatio = result.sharpeRatio;
            individual.sortinoRatio = result.sortinoRatio;
            individual.calmarRatio = result.calmarRatio;
            individual.maxDrawdown = result.maxDrawdown;
            individual.winRate = result.winRate;
            individual.tradeCount = result.matchedTrades + result.expiredTrades;

            // Calculate PnL variance (consistency measure)
            // Note: This is a simplified approximation using available metrics
            individual.pnlVariance = result.avgPnl !== 0
                ? Math.pow(result.sharpeRatio !== 0 ? result.avgPnl / result.sharpeRatio : result.avgPnl, 2)
                : 0;

            // Calculate multi-metric fitness
            individual.fitness = this.calculateMultiMetricFitness(result, individual.tradeCount);
        }

        // Sort by fitness (descending)
        this.population.sort((a, b) => b.fitness - a.fitness);

        // Check population diversity and inject random individuals if too low
        this.enforceDiversity();

        // Record generation stats
        const stats = this.calculateGenerationStats();
        this.generationHistory.push(stats);

        this.printGenerationStats(stats);
    }

    /**
     * Calculates multi-metric fitness score based on fitnessMode.
     *
     * The fitnessMode determines the PRIMARY metric:
     * - 'pnl': Raw total PnL (original behavior)
     * - 'sharpe': Risk-adjusted returns (penalizes all volatility)
     * - 'sortino': Risk-adjusted returns (only penalizes downside volatility) - RECOMMENDED
     * - 'calmar': Return per unit of max drawdown (focuses on avoiding large losses)
     *
     * Secondary factors (from fitnessWeights) are added to fine-tune selection.
     */
    private calculateMultiMetricFitness(result: SimulationResult, tradeCount: number): number {
        const w = this.config.fitnessWeights;
        const mode = this.config.fitnessMode;

        // =====================================================================
        // PRIMARY FITNESS: Based on fitnessMode
        // =====================================================================
        // Scale ratios to be comparable to PnL values (~$10-100 range)
        const RATIO_SCALE = 20;  // Sortino/Sharpe of 1.0 → 20 fitness points
        const CALMAR_SCALE = 10; // Calmar of 1.0 → 10 fitness points

        let primaryFitness: number;
        switch (mode) {
            case 'sharpe':
                // Sharpe ratio: avgReturn / stdDev
                // Good strategies have Sharpe > 1, excellent > 2
                primaryFitness = result.sharpeRatio * RATIO_SCALE;
                break;
            case 'sortino':
                // Sortino ratio: avgReturn / downsideDeviation
                // Better than Sharpe because it doesn't penalize upside volatility
                primaryFitness = result.sortinoRatio * RATIO_SCALE;
                break;
            case 'calmar':
                // Calmar ratio: totalPnl / |maxDrawdown|
                // Good for avoiding strategies with large drawdowns
                primaryFitness = result.calmarRatio * CALMAR_SCALE;
                break;
            case 'pnl':
            default:
                // Raw PnL (original behavior)
                primaryFitness = result.totalPnl;
                break;
        }

        // =====================================================================
        // SECONDARY FACTORS: Fine-tune beyond primary metric
        // =====================================================================
        let secondaryFitness = 0;

        // Add weighted contributions from other metrics
        secondaryFitness += result.totalPnl * w.pnl;
        secondaryFitness += result.sharpeRatio * 10 * w.sharpe;
        secondaryFitness += result.sortinoRatio * 10 * w.sortino;
        secondaryFitness += result.calmarRatio * 5 * w.calmar;

        // Penalize drawdown (drawdown is negative, so this subtracts)
        secondaryFitness += result.maxDrawdown * w.drawdownPenalty;

        // Add win rate contribution (0-100, scale down)
        secondaryFitness += result.winRate * 0.1 * w.winRate;

        // Reward consistency (low variance of returns)
        const consistency = Math.max(result.sharpeRatio, result.sortinoRatio, 0);
        secondaryFitness += consistency * 5 * w.consistency;

        // =====================================================================
        // COMBINE: Primary (70%) + Secondary (30%)
        // =====================================================================
        let fitness = primaryFitness * 0.7 + secondaryFitness * 0.3;

        // =====================================================================
        // PENALTIES
        // =====================================================================
        // Apply minimum trade count penalty
        if (tradeCount < this.config.minTradeCount) {
            const penaltyRatio = tradeCount / this.config.minTradeCount;
            fitness *= penaltyRatio * this.config.minTradePenalty;
            // If zero trades, heavy penalty
            if (tradeCount === 0) {
                fitness = -1000;
            }
        }

        // Safety: clamp fitness to reasonable bounds and handle invalid values
        const MAX_REASONABLE_FITNESS = 100000;
        if (isNaN(fitness) || !isFinite(fitness)) {
            fitness = -1000;
        } else {
            fitness = Math.max(-MAX_REASONABLE_FITNESS, Math.min(MAX_REASONABLE_FITNESS, fitness));
        }

        return fitness;
    }

    /**
     * Evolves to the next generation. Returns new parameter sets to test.
     */
    public evolve(): Record<string, number>[] {
        this.currentGeneration++;

        const newPopulation: Individual[] = [];

        // Elitism: keep top performers unchanged
        for (let i = 0; i < this.config.eliteCount && i < this.population.length; i++) {
            newPopulation.push({
                ...this.population[i],
                generation: this.currentGeneration,
            });
        }

        // Fill rest of population with offspring
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
        return this.population.map(ind => ind.params);
    }

    /**
     * Enforces population diversity by injecting random individuals if diversity is too low.
     */
    private enforceDiversity(): void {
        const diversity = this.calculatePopulationDiversity();

        if (diversity < this.config.diversityThreshold) {
            const numToReplace = Math.floor(this.population.length * this.config.diversityInjectionRate);
            this.logger.log(`  [Diversity] Low diversity (${(diversity * 100).toFixed(1)}%), injecting ${numToReplace} random individuals`);

            // Replace worst performers with random individuals
            for (let i = 0; i < numToReplace && i < this.population.length; i++) {
                const idx = this.population.length - 1 - i;  // Replace from bottom
                this.population[idx] = {
                    params: this.generateRandomParams(),
                    fitness: 0,
                    generation: this.currentGeneration,
                };
            }
        }
    }

    /**
     * Calculates population diversity as average pairwise distance (0-1).
     */
    private calculatePopulationDiversity(): number {
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

    /**
     * Calculates normalized distance between two individuals (0-1).
     */
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

        // Return RMS of normalized differences
        return numParams > 0 ? Math.sqrt(sumSquaredDiff / numParams) : 0;
    }

    /**
     * Gets current population diversity (for external monitoring).
     */
    public getPopulationDiversity(): number {
        return this.calculatePopulationDiversity();
    }

    /**
     * Checks if optimization should stop.
     */
    public shouldStop(): { stop: boolean; reason: string } {
        // Check max generations
        if (this.currentGeneration >= this.config.maxGenerations) {
            return { stop: true, reason: `Reached max generations (${this.config.maxGenerations})` };
        }

        // Check convergence (need enough history)
        if (this.generationHistory.length >= this.config.convergenceGenerations) {
            const recentHistory = this.generationHistory.slice(-this.config.convergenceGenerations);
            const improvements = recentHistory.map(h => h.improvement);
            const avgImprovement = improvements.reduce((a, b) => a + b, 0) / improvements.length;

            // Get current best fitness for relative comparison
            const currentBestFitness = this.population[0]?.fitness ?? 0;

            // Use relative threshold: stop if improvement is < X% of current fitness
            // For negative fitness, use absolute threshold as fallback
            let effectiveThreshold = this.config.convergenceThreshold;
            if (currentBestFitness > 0 && this.config.useRelativeConvergence) {
                // Default: 1% of current fitness, with minimum floor
                const relativeThreshold = currentBestFitness * this.config.convergenceThresholdPercent;
                effectiveThreshold = Math.max(relativeThreshold, 0.10);  // Min $0.10
            }

            if (Math.abs(avgImprovement) < effectiveThreshold) {
                return {
                    stop: true,
                    reason: `Converged (avg improvement ${avgImprovement.toFixed(4)} < threshold ${effectiveThreshold.toFixed(2)})`,
                };
            }
        }

        return { stop: false, reason: '' };
    }

    /**
     * Gets the final optimization result.
     */
    public getResult(): OptimizationResult {
        const stopCheck = this.shouldStop();

        return {
            bestIndividual: this.population[0],
            generationHistory: this.generationHistory,
            totalGenerations: this.currentGeneration,
            converged: stopCheck.stop,
            convergenceReason: stopCheck.reason,
        };
    }

    /**
     * Gets current generation number.
     */
    public getGeneration(): number {
        return this.currentGeneration;
    }

    /**
     * Gets the best individual so far.
     */
    public getBest(): Individual | null {
        return this.population.length > 0 ? this.population[0] : null;
    }

    /**
     * Gets the number of bootstrap runs per individual.
     */
    public getBootstrapRuns(): number {
        return this.config.bootstrapRuns;
    }

    /**
     * Returns whether validation is required before returning results.
     */
    public isValidationRequired(): boolean {
        return this.config.requireValidation;
    }

    // -------------------------------------------------------------------------
    // Genetic Operations
    // -------------------------------------------------------------------------

    /**
     * Tournament selection - picks best of random subset.
     */
    private selectParent(): Individual {
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

    /**
     * Uniform crossover - randomly picks genes from each parent.
     */
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

    /**
     * Gaussian mutation - adds random noise to parameters.
     */
    private mutate(params: Record<string, number>): Record<string, number> {
        const mutated = { ...params };

        for (const [key, bound] of Object.entries(this.bounds)) {
            if (Math.random() < 0.5) {  // Mutate ~50% of genes
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

    /**
     * Generates random parameters within bounds.
     */
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

    // -------------------------------------------------------------------------
    // Statistics
    // -------------------------------------------------------------------------

    private calculateGenerationStats(): GenerationStats {
        const fitnesses = this.population.map(ind => ind.fitness);
        const bestFitness = Math.max(...fitnesses);
        const worstFitness = Math.min(...fitnesses);
        const avgFitness = fitnesses.reduce((a, b) => a + b, 0) / fitnesses.length;

        const prevBest = this.generationHistory.length > 0
            ? this.generationHistory[this.generationHistory.length - 1].bestFitness
            : 0;

        return {
            generation: this.currentGeneration,
            bestFitness,
            avgFitness,
            worstFitness,
            improvement: bestFitness - prevBest,
            bestParams: { ...this.population[0].params },
        };
    }

    private printGenerationStats(stats: GenerationStats): void {
        // ANSI color codes
        const RESET = '\x1b[0m';
        const GREEN = '\x1b[32m';
        const RED = '\x1b[31m';
        const CYAN = '\x1b[36m';
        const YELLOW = '\x1b[33m';

        const improvementStr = stats.improvement >= 0
            ? `${GREEN}+${stats.improvement.toFixed(2)}${RESET}`
            : `${RED}${stats.improvement.toFixed(2)}${RESET}`;

        const bestColor = stats.bestFitness >= 0 ? GREEN : RED;
        const avgColor = stats.avgFitness >= 0 ? YELLOW : RED;

        this.logger.log(
            `  Gen ${stats.generation.toString().padStart(3)}: ` +
            `${CYAN}Best${RESET}=${bestColor}$${stats.bestFitness.toFixed(2)}${RESET} ` +
            `${CYAN}Avg${RESET}=${avgColor}$${stats.avgFitness.toFixed(2)}${RESET} ` +
            `(${improvementStr})`
        );
    }

    /**
     * Generates perturbed versions of parameters for stability testing.
     * Returns array of parameter sets with small random perturbations.
     */
    public generatePerturbedParams(
        baseParams: Record<string, number>,
        numPerturbations: number = 10,
        perturbationStrength: number = 0.1  // 10% of range
    ): Record<string, number>[] {
        const perturbedSets: Record<string, number>[] = [];

        for (let i = 0; i < numPerturbations; i++) {
            const perturbed: Record<string, number> = {};

            for (const [key, bound] of Object.entries(this.bounds)) {
                const range = bound.max - bound.min;
                // Random perturbation within ±perturbationStrength of range
                const noise = (Math.random() - 0.5) * 2 * range * perturbationStrength;
                let newValue = baseParams[key] + noise;

                // Clamp to bounds
                newValue = Math.max(bound.min, Math.min(bound.max, newValue));

                // Apply step if discrete
                if (bound.step) {
                    newValue = Math.round(newValue / bound.step) * bound.step;
                }

                perturbed[key] = newValue;
            }

            perturbedSets.push(perturbed);
        }

        return perturbedSets;
    }

    /**
     * Calculates stability score from perturbed simulation results.
     */
    public calculateStabilityScore(
        originalPnl: number,
        perturbedPnls: number[]
    ): StabilityResult {
        const avgPerturbedPnl = perturbedPnls.reduce((a, b) => a + b, 0) / perturbedPnls.length;

        // Stability score: how close perturbed results are to original
        // 1.0 = perfectly stable, < 1 = worse when perturbed, > 1 = better when perturbed
        const stabilityScore = originalPnl !== 0
            ? avgPerturbedPnl / originalPnl
            : (avgPerturbedPnl >= 0 ? 1.0 : 0);

        return {
            originalPnl,
            perturbedPnls,
            avgPerturbedPnl,
            stabilityScore,
            isStable: stabilityScore >= 0.7 && stabilityScore <= 1.3,
        };
    }

    /**
     * Prints final optimization summary.
     */
    public printSummary(): void {
        const result = this.getResult();

        // ANSI color codes
        const RESET = '\x1b[0m';
        const GREEN = '\x1b[32m';
        const RED = '\x1b[31m';
        const CYAN = '\x1b[36m';
        const YELLOW = '\x1b[33m';
        const BOLD = '\x1b[1m';

        const colorPnl = (value: number) => value >= 0 ? `${GREEN}$${value.toFixed(2)}${RESET}` : `${RED}$${value.toFixed(2)}${RESET}`;

        this.logger.log(`\n${CYAN}${'='.repeat(60)}${RESET}`);
        this.logger.log(`${BOLD}${CYAN}GENETIC OPTIMIZATION RESULTS${RESET}`);
        this.logger.log(`${CYAN}${'='.repeat(60)}${RESET}`);

        this.logger.log(`\nConvergence: ${result.convergenceReason}`);
        this.logger.log(`Total Generations: ${result.totalGenerations}`);

        this.logger.log(`\n${BOLD}Best Individual:${RESET}`);
        this.logger.log(`  Fitness Mode: ${this.config.fitnessMode}`);
        this.logger.log(`  Composite Fitness: ${result.bestIndividual.fitness.toFixed(2)}`);
        this.logger.log(`  ${CYAN}Raw PnL${RESET}: ${colorPnl(result.bestIndividual.rawPnl ?? 0)}`);
        this.logger.log(`  Sharpe Ratio: ${(result.bestIndividual.sharpeRatio ?? 0).toFixed(3)}`);
        this.logger.log(`  ${CYAN}Sortino Ratio${RESET}: ${(result.bestIndividual.sortinoRatio ?? 0).toFixed(3)}`);
        this.logger.log(`  Calmar Ratio: ${(result.bestIndividual.calmarRatio ?? 0).toFixed(3)}`);
        this.logger.log(`  Max Drawdown: ${RED}$${(result.bestIndividual.maxDrawdown ?? 0).toFixed(2)}${RESET}`);
        this.logger.log(`  Win Rate: ${YELLOW}${(result.bestIndividual.winRate ?? 0).toFixed(1)}%${RESET}`);
        this.logger.log(`  Trade Count: ${result.bestIndividual.tradeCount ?? 0}`);
        this.logger.log(`  Found in Generation: ${result.bestIndividual.generation}`);
        this.logger.log(`  Parameters:`);

        for (const [key, value] of Object.entries(result.bestIndividual.params)) {
            this.logger.log(`    ${key}: ${value.toFixed(4)}`);
        }

        // Show improvement over generations
        if (this.generationHistory.length > 1) {
            const firstGen = this.generationHistory[0];
            const lastGen = this.generationHistory[this.generationHistory.length - 1];
            const totalImprovement = lastGen.bestFitness - firstGen.bestFitness;
            const improvementColor = totalImprovement >= 0 ? GREEN : RED;

            this.logger.log(`\n${BOLD}Improvement Over Optimization:${RESET}`);
            this.logger.log(`  Initial Best PnL: ${colorPnl(firstGen.bestFitness)}`);
            this.logger.log(`  Final Best PnL:   ${colorPnl(lastGen.bestFitness)}`);
            this.logger.log(`  Total Improvement: ${improvementColor}$${totalImprovement.toFixed(2)} (${((totalImprovement / Math.abs(firstGen.bestFitness || 1)) * 100).toFixed(1)}%)${RESET}`);
        }
    }
}
