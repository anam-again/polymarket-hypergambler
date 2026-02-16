import { ModelPerformanceTracker, PerformanceMetrics } from './ModelPerformanceTracker.js';
import { writeFileSync, readFileSync, existsSync } from 'fs';

/**
 * Tunable hyperparameters for the trading system.
 */
export interface TunableParams {
    learningRate: number;
    momentumBeta: number;
    mispricingThreshold: number;
    targetProfitMargin: number;
    weightClipMax: number;
    convergenceWindowMs: number;
    positionSizeMultiplier: number;
}

/**
 * Parameter ranges for tuning.
 */
export interface ParameterRanges {
    learningRate: [number, number];
    momentumBeta: [number, number];
    mispricingThreshold: [number, number];
    targetProfitMargin: [number, number];
    weightClipMax: [number, number];
    convergenceWindowMs: [number, number];
    positionSizeMultiplier: [number, number];
}

/**
 * Result of a parameter evaluation.
 */
interface TuningResult {
    params: TunableParams;
    score: number;
    metrics: Partial<PerformanceMetrics>;
    timestamp: number;
    evaluationPeriodMs: number;
}

/**
 * Hyperparameter Tuner
 *
 * Uses a simplified Bayesian-style optimization to find optimal hyperparameters.
 * Periodically suggests new parameters based on past performance.
 *
 * Key features:
 * - Tracks parameter -> performance mapping
 * - Explores promising regions more intensively
 * - Exploits known good configurations
 * - Gradual parameter adjustment to avoid instability
 */
export class HyperparameterTuner {
    private currentParams: TunableParams;
    private ranges: ParameterRanges;
    private history: TuningResult[] = [];
    private savePath: string;

    // Exploration vs exploitation
    private explorationRate: number = 0.3;  // 30% exploration
    private readonly minExplorationRate: number = 0.1;
    private readonly explorationDecay: number = 0.99;

    // Tuning configuration
    private readonly maxHistorySize: number = 100;
    private readonly minEvaluationsBeforeTuning: number = 5;
    private evaluationStartTime: number = Date.now();

    // Best known parameters
    private bestParams: TunableParams | null = null;
    private bestScore: number = -Infinity;

    constructor(
        initialParams: TunableParams,
        ranges?: Partial<ParameterRanges>,
        savePath: string = './models/hypertuner.json'
    ) {
        this.currentParams = { ...initialParams };
        this.savePath = savePath;

        // Default parameter ranges
        this.ranges = {
            learningRate: ranges?.learningRate ?? [0.0001, 0.1],
            momentumBeta: ranges?.momentumBeta ?? [0.8, 0.99],
            mispricingThreshold: ranges?.mispricingThreshold ?? [0.01, 0.10],
            targetProfitMargin: ranges?.targetProfitMargin ?? [0.01, 0.05],
            weightClipMax: ranges?.weightClipMax ?? [0.1, 0.5],
            convergenceWindowMs: ranges?.convergenceWindowMs ?? [10000, 60000],
            positionSizeMultiplier: ranges?.positionSizeMultiplier ?? [0.5, 2.0],
        };
    }

    /**
     * Records current performance and updates history.
     */
    recordPerformance(metrics: PerformanceMetrics): void {
        const evaluationPeriodMs = Date.now() - this.evaluationStartTime;

        // Calculate score: optimize for risk-adjusted returns
        // Use directional accuracy and negative MAE as primary metrics
        const score = this.calculateScore(metrics);

        const result: TuningResult = {
            params: { ...this.currentParams },
            score,
            metrics: {
                mae: metrics.mae,
                directionalAccuracy: metrics.directionalAccuracy,
                sharpeRatio: metrics.sharpeRatio,
                recentTrend: metrics.recentTrend,
            },
            timestamp: Date.now(),
            evaluationPeriodMs,
        };

        this.history.push(result);

        // Update best
        if (score > this.bestScore) {
            this.bestScore = score;
            this.bestParams = { ...this.currentParams };
        }

        // Maintain history size
        while (this.history.length > this.maxHistorySize) {
            this.history.shift();
        }

        // Decay exploration rate
        this.explorationRate = Math.max(
            this.minExplorationRate,
            this.explorationRate * this.explorationDecay
        );

        // Reset evaluation timer
        this.evaluationStartTime = Date.now();
    }

    /**
     * Calculates a score from performance metrics.
     * Higher is better.
     */
    private calculateScore(metrics: PerformanceMetrics): number {
        // Components:
        // 1. Directional accuracy (0-1) - most important
        // 2. Negative MAE (higher = better, lower error)
        // 3. Sharpe ratio (risk-adjusted)
        // 4. Trend bonus (improving = good)

        let score = 0;

        // Directional accuracy (weight: 0.4)
        score += (metrics.directionalAccuracy - 0.5) * 2 * 0.4;  // Scale to [-1, 1]

        // MAE (weight: 0.3) - invert so lower is better
        const maeScore = Math.max(0, 1 - metrics.mae * 5);  // 0.2 MAE = 0 score
        score += maeScore * 0.3;

        // Sharpe ratio (weight: 0.2)
        const sharpeScore = Math.max(-1, Math.min(1, metrics.sharpeRatio));
        score += sharpeScore * 0.2;

        // Trend bonus (weight: 0.1)
        if (metrics.recentTrend === 'improving') {
            score += 0.1;
        } else if (metrics.recentTrend === 'degrading') {
            score -= 0.1;
        }

        return score;
    }

    /**
     * Suggests new parameters based on history.
     * Call this periodically (e.g., every hour).
     */
    suggestParams(): TunableParams {
        if (this.history.length < this.minEvaluationsBeforeTuning) {
            // Not enough data - continue with current params
            return { ...this.currentParams };
        }

        // Decide between exploration and exploitation
        if (Math.random() < this.explorationRate) {
            return this.explore();
        } else {
            return this.exploit();
        }
    }

    /**
     * Exploration: try new parameter combinations.
     */
    private explore(): TunableParams {
        const newParams = { ...this.currentParams };

        // Randomly select 1-3 parameters to mutate
        const paramNames = Object.keys(this.ranges) as Array<keyof TunableParams>;
        const numToMutate = 1 + Math.floor(Math.random() * 3);
        const toMutate = this.shuffle(paramNames).slice(0, numToMutate);

        for (const param of toMutate) {
            const [min, max] = this.ranges[param];
            const current = this.currentParams[param];

            // Gaussian perturbation around current value
            const range = max - min;
            const perturbation = (Math.random() - 0.5) * range * 0.3;  // 30% of range
            let newValue = current + perturbation;

            // Clamp to range
            newValue = Math.max(min, Math.min(max, newValue));

            (newParams as Record<string, number>)[param] = newValue;
        }

        return newParams;
    }

    /**
     * Exploitation: use best known configuration with minor tweaks.
     */
    private exploit(): TunableParams {
        // Start from best known params
        const base = this.bestParams ?? this.currentParams;
        const newParams = { ...base };

        // Small perturbation to refine
        const paramNames = Object.keys(this.ranges) as Array<keyof TunableParams>;
        const toTweak = this.shuffle(paramNames).slice(0, 1);

        for (const param of toTweak) {
            const [min, max] = this.ranges[param];
            const current = base[param];

            // Small Gaussian perturbation
            const range = max - min;
            const perturbation = (Math.random() - 0.5) * range * 0.1;  // 10% of range
            let newValue = current + perturbation;

            newValue = Math.max(min, Math.min(max, newValue));
            (newParams as Record<string, number>)[param] = newValue;
        }

        return newParams;
    }

    /**
     * Applies suggested parameters.
     */
    applyParams(params: TunableParams): void {
        this.currentParams = { ...params };
    }

    /**
     * Returns the current parameters.
     */
    getCurrentParams(): TunableParams {
        return { ...this.currentParams };
    }

    /**
     * Returns the best known parameters.
     */
    getBestParams(): TunableParams | null {
        return this.bestParams ? { ...this.bestParams } : null;
    }

    /**
     * Returns the best score achieved.
     */
    getBestScore(): number {
        return this.bestScore;
    }

    /**
     * Returns tuning statistics.
     */
    getStats(): {
        historySize: number;
        explorationRate: number;
        bestScore: number;
        avgScore: number;
        recentScores: number[];
    } {
        const recentScores = this.history.slice(-10).map(h => h.score);
        const avgScore = recentScores.length > 0
            ? recentScores.reduce((a, b) => a + b, 0) / recentScores.length
            : 0;

        return {
            historySize: this.history.length,
            explorationRate: this.explorationRate,
            bestScore: this.bestScore,
            avgScore,
            recentScores,
        };
    }

    /**
     * Returns parameter importance based on correlation with score.
     */
    getParameterImportance(): Map<string, number> {
        const importance = new Map<string, number>();

        if (this.history.length < 10) {
            return importance;
        }

        const paramNames = Object.keys(this.ranges) as Array<keyof TunableParams>;

        for (const param of paramNames) {
            const pairs = this.history.map(h => ({
                x: h.params[param],
                y: h.score,
            }));

            const correlation = this.pearsonCorrelation(pairs);
            importance.set(param, Math.abs(correlation));
        }

        return importance;
    }

    /**
     * Calculates Pearson correlation.
     */
    private pearsonCorrelation(pairs: { x: number; y: number }[]): number {
        const n = pairs.length;
        if (n < 2) return 0;

        const sumX = pairs.reduce((s, p) => s + p.x, 0);
        const sumY = pairs.reduce((s, p) => s + p.y, 0);
        const sumXY = pairs.reduce((s, p) => s + p.x * p.y, 0);
        const sumX2 = pairs.reduce((s, p) => s + p.x * p.x, 0);
        const sumY2 = pairs.reduce((s, p) => s + p.y * p.y, 0);

        const numerator = n * sumXY - sumX * sumY;
        const denominator = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));

        if (denominator === 0) return 0;
        return numerator / denominator;
    }

    /**
     * Shuffles array (Fisher-Yates).
     */
    private shuffle<T>(array: T[]): T[] {
        const result = [...array];
        for (let i = result.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [result[i], result[j]] = [result[j], result[i]];
        }
        return result;
    }

    /**
     * Saves tuner state to disk.
     */
    save(): void {
        try {
            const data = {
                version: '1.0',
                currentParams: this.currentParams,
                bestParams: this.bestParams,
                bestScore: this.bestScore,
                explorationRate: this.explorationRate,
                history: this.history.slice(-50),  // Only save recent history
                savedAt: new Date().toISOString(),
            };
            writeFileSync(this.savePath, JSON.stringify(data, null, 2));
        } catch (e) {
            console.error(`[HyperparameterTuner] Failed to save: ${e}`);
        }
    }

    /**
     * Loads tuner state from disk if file exists.
     */
    loadIfExists(): boolean {
        if (!existsSync(this.savePath)) return false;

        try {
            const content = readFileSync(this.savePath, 'utf-8');
            const data = JSON.parse(content);

            if (data.currentParams) {
                this.currentParams = data.currentParams;
            }
            if (data.bestParams) {
                this.bestParams = data.bestParams;
                this.bestScore = data.bestScore ?? -Infinity;
            }
            if (data.explorationRate) {
                this.explorationRate = data.explorationRate;
            }
            if (data.history) {
                this.history = data.history;
            }

            console.log(`[HyperparameterTuner] Loaded from ${this.savePath} (${this.history.length} history entries)`);
            return true;
        } catch (e) {
            console.warn(`[HyperparameterTuner] Failed to load: ${e}`);
            return false;
        }
    }

    /**
     * Resets tuner state.
     */
    reset(initialParams?: TunableParams): void {
        if (initialParams) {
            this.currentParams = { ...initialParams };
        }
        this.history = [];
        this.bestParams = null;
        this.bestScore = -Infinity;
        this.explorationRate = 0.3;
        this.evaluationStartTime = Date.now();
    }

    /**
     * Returns default parameters as a starting point.
     */
    static getDefaultParams(): TunableParams {
        return {
            learningRate: 0.01,
            momentumBeta: 0.9,
            mispricingThreshold: 0.03,
            targetProfitMargin: 0.02,
            weightClipMax: 0.3,
            convergenceWindowMs: 30000,
            positionSizeMultiplier: 1.0,
        };
    }
}
