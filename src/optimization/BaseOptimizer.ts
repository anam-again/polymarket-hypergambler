/**
 * Base Optimizer Abstract Class
 *
 * Provides shared utilities for all optimizer implementations including
 * bounds handling, normalization, and convergence tracking.
 */

import type {
    IOptimizer,
    ParameterBounds,
    ParameterBound,
    EvaluationResult,
    StopCondition,
    BaseOptimizerConfig,
} from './interfaces.js';

export abstract class BaseOptimizer implements IOptimizer {
    abstract readonly name: string;

    protected bounds: ParameterBounds = {};
    protected paramNames: string[] = [];
    protected dimension: number = 0;
    protected iteration: number = 0;
    protected fitnessHistory: number[] = [];
    protected best: EvaluationResult | null = null;
    protected config: BaseOptimizerConfig;
    protected initialized: boolean = false;

    constructor(config: BaseOptimizerConfig) {
        this.config = config;
    }

    // -------------------------------------------------------------------------
    // IOptimizer Interface Implementation
    // -------------------------------------------------------------------------

    initialize(bounds: ParameterBounds): void {
        this.bounds = bounds;
        this.paramNames = Object.keys(bounds);
        this.dimension = this.paramNames.length;
        this.iteration = 0;
        this.fitnessHistory = [];
        this.best = null;
        this.initialized = true;
        this.onInitialize();
    }

    /** Hook for subclasses to perform additional initialization */
    protected abstract onInitialize(): void;

    abstract ask(): Record<string, number>[];

    tell(results: EvaluationResult[]): void {
        if (!this.initialized) {
            throw new Error(`${this.name}: Must call initialize() before tell()`);
        }

        // Update best
        for (const result of results) {
            if (this.best === null || result.fitness > this.best.fitness) {
                this.best = { ...result };
            }
        }

        // Track fitness history for convergence detection
        const bestInBatch = Math.max(...results.map(r => r.fitness));
        this.fitnessHistory.push(bestInBatch);

        this.iteration++;
        this.onTell(results);
    }

    /** Hook for subclasses to perform additional processing after tell() */
    protected abstract onTell(results: EvaluationResult[]): void;

    shouldStop(): StopCondition {
        // Check max iterations
        if (this.iteration >= this.config.maxIterations) {
            return { stop: true, reason: `Reached max iterations (${this.config.maxIterations})` };
        }

        // Check convergence
        if (this.fitnessHistory.length >= this.config.convergenceIterations) {
            const recent = this.fitnessHistory.slice(-this.config.convergenceIterations);
            const improvements = recent.slice(1).map((v, i) => v - recent[i]);
            const avgImprovement = improvements.reduce((a, b) => a + b, 0) / improvements.length;

            let threshold = this.config.convergenceThreshold;
            if (this.config.useRelativeConvergence && this.best && this.best.fitness > 0) {
                const relativeThreshold = this.best.fitness * this.config.convergenceThresholdPercent;
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
        return this.best;
    }

    getIteration(): number {
        return this.iteration;
    }

    // -------------------------------------------------------------------------
    // Normalization Utilities
    // -------------------------------------------------------------------------

    /**
     * Normalize a parameter value to [0, 1] range based on its bounds.
     */
    protected normalizeValue(value: number, bound: ParameterBound): number {
        const range = bound.max - bound.min;
        if (range === 0) return 0.5;
        return (value - bound.min) / range;
    }

    /**
     * Denormalize a [0, 1] value back to the original parameter range.
     */
    protected denormalizeValue(normalized: number, bound: ParameterBound): number {
        const range = bound.max - bound.min;
        let value = bound.min + normalized * range;

        // Apply step if discrete
        if (bound.step) {
            value = Math.round(value / bound.step) * bound.step;
        }

        // Clamp to bounds
        return Math.max(bound.min, Math.min(bound.max, value));
    }

    /**
     * Normalize parameter dict to [0, 1]^d vector.
     */
    protected normalizeParams(params: Record<string, number>): number[] {
        return this.paramNames.map(name =>
            this.normalizeValue(params[name], this.bounds[name])
        );
    }

    /**
     * Denormalize [0, 1]^d vector to parameter dict.
     */
    protected denormalizeVector(vector: number[]): Record<string, number> {
        const params: Record<string, number> = {};
        for (let i = 0; i < this.paramNames.length; i++) {
            params[this.paramNames[i]] = this.denormalizeValue(
                vector[i],
                this.bounds[this.paramNames[i]]
            );
        }
        return params;
    }

    /**
     * Clamp a vector to [0, 1]^d.
     */
    protected clampVector(vector: number[]): number[] {
        return vector.map(v => Math.max(0, Math.min(1, v)));
    }

    /**
     * Generate a random normalized vector in [0, 1]^d.
     */
    protected randomNormalizedVector(): number[] {
        return Array.from({ length: this.dimension }, () => Math.random());
    }

    /**
     * Generate random parameters within bounds.
     */
    protected generateRandomParams(): Record<string, number> {
        const params: Record<string, number> = {};
        for (const [name, bound] of Object.entries(this.bounds)) {
            let value = bound.min + Math.random() * (bound.max - bound.min);
            if (bound.step) {
                value = Math.round(value / bound.step) * bound.step;
            }
            params[name] = value;
        }
        return params;
    }

    // -------------------------------------------------------------------------
    // Distance & Diversity Utilities
    // -------------------------------------------------------------------------

    /**
     * Calculate normalized Euclidean distance between two parameter sets.
     */
    protected calculateDistance(
        params1: Record<string, number>,
        params2: Record<string, number>
    ): number {
        let sumSquaredDiff = 0;
        for (const [name, bound] of Object.entries(this.bounds)) {
            const range = bound.max - bound.min;
            if (range > 0) {
                const diff = (params1[name] - params2[name]) / range;
                sumSquaredDiff += diff * diff;
            }
        }
        return Math.sqrt(sumSquaredDiff / this.dimension);
    }

    /**
     * Calculate population diversity as average pairwise distance.
     */
    protected calculateDiversity(population: Record<string, number>[]): number {
        if (population.length < 2) return 1.0;

        let totalDistance = 0;
        let comparisons = 0;

        for (let i = 0; i < population.length; i++) {
            for (let j = i + 1; j < population.length; j++) {
                totalDistance += this.calculateDistance(population[i], population[j]);
                comparisons++;
            }
        }

        return comparisons > 0 ? totalDistance / comparisons : 1.0;
    }
}
