import { SimulationResult } from './HistoricalSimulator.js';

// ============================================================================
// Types & Interfaces
// ============================================================================

export interface GeneticConfig {
    populationSize: number;          // Number of individuals per generation
    maxGenerations: number;          // Maximum generations (M)
    convergenceThreshold: number;    // Min PnL improvement to continue (N)
    convergenceGenerations: number;  // How many generations to check for convergence
    mutationRate: number;            // Probability of mutation (0-1)
    mutationStrength: number;        // How much to mutate (0-1, as fraction of range)
    eliteCount: number;              // Number of top performers to keep unchanged
    crossoverRate: number;           // Probability of crossover vs clone
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

    constructor(config: Partial<GeneticConfig>, bounds: ParameterBounds) {
        this.config = {
            populationSize: config.populationSize ?? 20,
            maxGenerations: config.maxGenerations ?? 50,
            convergenceThreshold: config.convergenceThreshold ?? 1.0,
            convergenceGenerations: config.convergenceGenerations ?? 5,
            mutationRate: config.mutationRate ?? 0.2,
            mutationStrength: config.mutationStrength ?? 0.3,
            eliteCount: config.eliteCount ?? 2,
            crossoverRate: config.crossoverRate ?? 0.7,
        };
        this.bounds = bounds;
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
     * Updates fitness scores from simulation results.
     */
    public updateFitness(results: SimulationResult[]): void {
        for (let i = 0; i < results.length && i < this.population.length; i++) {
            this.population[i].fitness = results[i].totalPnl;
        }

        // Sort by fitness (descending)
        this.population.sort((a, b) => b.fitness - a.fitness);

        // Record generation stats
        const stats = this.calculateGenerationStats();
        this.generationHistory.push(stats);

        this.printGenerationStats(stats);
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

            if (Math.abs(avgImprovement) < this.config.convergenceThreshold) {
                return {
                    stop: true,
                    reason: `Converged (avg improvement ${avgImprovement.toFixed(4)} < threshold ${this.config.convergenceThreshold})`,
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
        const improvementStr = stats.improvement >= 0
            ? `+${stats.improvement.toFixed(2)}`
            : stats.improvement.toFixed(2);

        console.log(
            `  Gen ${stats.generation.toString().padStart(3)}: ` +
            `Best=$${stats.bestFitness.toFixed(2)} ` +
            `Avg=$${stats.avgFitness.toFixed(2)} ` +
            `(${improvementStr})`
        );
    }

    /**
     * Prints final optimization summary.
     */
    public printSummary(): void {
        const result = this.getResult();

        console.log(`\n${'='.repeat(60)}`);
        console.log('GENETIC OPTIMIZATION RESULTS');
        console.log(`${'='.repeat(60)}`);

        console.log(`\nConvergence: ${result.convergenceReason}`);
        console.log(`Total Generations: ${result.totalGenerations}`);

        console.log(`\nBest Individual:`);
        console.log(`  Fitness (PnL): $${result.bestIndividual.fitness.toFixed(2)}`);
        console.log(`  Found in Generation: ${result.bestIndividual.generation}`);
        console.log(`  Parameters:`);

        for (const [key, value] of Object.entries(result.bestIndividual.params)) {
            console.log(`    ${key}: ${value.toFixed(4)}`);
        }

        // Show improvement over generations
        if (this.generationHistory.length > 1) {
            const firstGen = this.generationHistory[0];
            const lastGen = this.generationHistory[this.generationHistory.length - 1];
            const totalImprovement = lastGen.bestFitness - firstGen.bestFitness;

            console.log(`\nImprovement Over Optimization:`);
            console.log(`  Initial Best PnL: $${firstGen.bestFitness.toFixed(2)}`);
            console.log(`  Final Best PnL:   $${lastGen.bestFitness.toFixed(2)}`);
            console.log(`  Total Improvement: $${totalImprovement.toFixed(2)} (${((totalImprovement / Math.abs(firstGen.bestFitness || 1)) * 100).toFixed(1)}%)`);
        }
    }
}
