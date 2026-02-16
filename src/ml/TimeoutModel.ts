import { writeFileSync, readFileSync, existsSync } from 'fs';
import { ModelPerformanceTracker } from './ModelPerformanceTracker.js';

/**
 * Configuration for adaptive learning rate.
 */
export interface AdaptiveLearningConfig {
    initialRate: number;
    minRate: number;
    maxRate: number;
    decayFactor: number;
    errorScaling: boolean;
    performanceAdaptive: boolean;
}

/**
 * Model to predict optimal timeout duration for unfilled orders.
 * Predicts how long to wait before canceling/repricing an order.
 * Separate predictions for BUY and SELL orders.
 *
 * Enhancements:
 * - Adaptive learning rate
 * - Gradient momentum (Adam-lite)
 * - Performance tracking
 */
export class TimeoutModel {
    private weightsBuy: number[];
    private weightsSell: number[];
    private biasBuy: number = 0;
    private biasSell: number = 0;
    private learningRate: number;
    private savePath: string;
    private trainingSamples: number = 0;

    // Adaptive learning rate
    private adaptiveConfig: AdaptiveLearningConfig;
    private currentLearningRate: number;

    // Gradient momentum
    private momentumBuy: number[];
    private momentumSell: number[];
    private biasMomentumBuy: number = 0;
    private biasMomentumSell: number = 0;
    private readonly beta: number = 0.9;

    // Performance tracker
    private performanceTracker: ModelPerformanceTracker;

    // Base timeout range in milliseconds
    private static readonly MIN_TIMEOUT_MS = 5 * 1000;    // 5 seconds minimum
    private static readonly MAX_TIMEOUT_MS = 120 * 1000;  // 2 minutes maximum
    private static readonly DEFAULT_TIMEOUT_MS = 30 * 1000; // 30 seconds default

    // Number of features (same as FairValueModel price features, without depth)
    private static readonly NUM_FEATURES = 17;

    constructor(
        learningRate: number = 0.01,
        savePath: string = './models/timeout.json',
        adaptiveConfig?: Partial<AdaptiveLearningConfig>
    ) {
        this.learningRate = learningRate;
        this.currentLearningRate = learningRate;
        this.savePath = savePath;

        // Adaptive learning config
        this.adaptiveConfig = {
            initialRate: adaptiveConfig?.initialRate ?? learningRate,
            minRate: adaptiveConfig?.minRate ?? 0.0001,
            maxRate: adaptiveConfig?.maxRate ?? 0.1,
            decayFactor: adaptiveConfig?.decayFactor ?? 0.9999,
            errorScaling: adaptiveConfig?.errorScaling ?? true,
            performanceAdaptive: adaptiveConfig?.performanceAdaptive ?? true,
        };
        this.currentLearningRate = this.adaptiveConfig.initialRate;

        // Initialize weights with small random values
        const scale = Math.sqrt(2 / TimeoutModel.NUM_FEATURES);
        this.weightsBuy = Array(TimeoutModel.NUM_FEATURES).fill(0).map(() => (Math.random() - 0.5) * scale);
        this.weightsSell = Array(TimeoutModel.NUM_FEATURES).fill(0).map(() => (Math.random() - 0.5) * scale);

        // Initialize momentum
        this.momentumBuy = Array(TimeoutModel.NUM_FEATURES).fill(0);
        this.momentumSell = Array(TimeoutModel.NUM_FEATURES).fill(0);

        // Initialize performance tracker
        this.performanceTracker = new ModelPerformanceTracker(
            'timeout',
            100,
            { maxMae: 0.3, degradationRate: 1.5, minSamplesForAlert: 30 },
            savePath.replace('.json', '_performance.json')
        );
    }

    /**
     * Predicts optimal timeout in milliseconds for an order.
     * @param features Market features at order placement
     * @param isBuy Whether this is a BUY order (true) or SELL order (false)
     * @returns Predicted timeout in milliseconds
     */
    predict(features: Record<string, number>, isBuy: boolean): number {
        const featureVector = this.toVector(features);
        const weights = isBuy ? this.weightsBuy : this.weightsSell;
        const bias = isBuy ? this.biasBuy : this.biasSell;

        // Raw output from linear combination
        const raw = this.dot(weights, featureVector) + bias;

        // Use sigmoid to map to [0, 1], then scale to timeout range
        const sigmoid = 1 / (1 + Math.exp(-Math.max(-10, Math.min(10, raw))));

        // Map sigmoid output to timeout range
        const timeoutMs = TimeoutModel.MIN_TIMEOUT_MS +
            sigmoid * (TimeoutModel.MAX_TIMEOUT_MS - TimeoutModel.MIN_TIMEOUT_MS);

        return Math.round(timeoutMs);
    }

    /**
     * Trains the model based on order outcome.
     * @param features Market features at order placement
     * @param isBuy Whether this was a BUY order
     * @param filled Whether the order eventually filled
     * @param actualWaitTimeMs How long we actually waited (before fill or cancel)
     * @param predictedTimeoutMs What the model predicted
     */
    train(
        features: Record<string, number>,
        isBuy: boolean,
        filled: boolean,
        actualWaitTimeMs: number,
        predictedTimeoutMs: number
    ): void {
        const featureVector = this.toVector(features);
        const weights = isBuy ? this.weightsBuy : this.weightsSell;
        const momentum = isBuy ? this.momentumBuy : this.momentumSell;

        // Determine target timeout based on outcome
        let targetTimeoutMs: number;

        if (filled) {
            // Order filled - the actual wait time was appropriate or could be shorter
            // Train toward actual fill time (with some buffer)
            targetTimeoutMs = Math.max(TimeoutModel.MIN_TIMEOUT_MS, actualWaitTimeMs * 1.1);
        } else {
            // Order didn't fill - we might have been too impatient or too patient
            if (actualWaitTimeMs >= predictedTimeoutMs * 0.9) {
                // We waited close to or past the predicted timeout and it didn't fill
                // Market conditions weren't favorable - train toward longer timeout
                targetTimeoutMs = Math.min(TimeoutModel.MAX_TIMEOUT_MS, predictedTimeoutMs * 1.3);
            } else {
                // We canceled early for some reason - keep prediction similar
                targetTimeoutMs = predictedTimeoutMs;
            }
        }

        // Normalize target to [0, 1] for sigmoid
        const targetNormalized = (targetTimeoutMs - TimeoutModel.MIN_TIMEOUT_MS) /
            (TimeoutModel.MAX_TIMEOUT_MS - TimeoutModel.MIN_TIMEOUT_MS);
        const predNormalized = (predictedTimeoutMs - TimeoutModel.MIN_TIMEOUT_MS) /
            (TimeoutModel.MAX_TIMEOUT_MS - TimeoutModel.MIN_TIMEOUT_MS);

        // Track performance
        this.performanceTracker.recordWithDirection(
            predNormalized,
            targetNormalized,
            filled ? 1 : 0,
            filled ? 1 : -1,
            features
        );

        // Gradient descent update with momentum
        const error = predNormalized - targetNormalized;
        const gradient = error * predNormalized * (1 - predNormalized);

        // Adapt learning rate
        const effectiveLR = this.adaptLearningRate(error);

        // Update weights with momentum
        const gradientVector = featureVector.map(f => gradient * f);
        this.updateWithMomentum(weights, momentum, gradientVector, effectiveLR);

        // Update bias with momentum
        if (isBuy) {
            this.biasMomentumBuy = this.beta * this.biasMomentumBuy + (1 - this.beta) * gradient;
            this.biasBuy -= effectiveLR * this.biasMomentumBuy;
            this.biasBuy = Math.max(-3, Math.min(3, this.biasBuy));
        } else {
            this.biasMomentumSell = this.beta * this.biasMomentumSell + (1 - this.beta) * gradient;
            this.biasSell -= effectiveLR * this.biasMomentumSell;
            this.biasSell = Math.max(-3, Math.min(3, this.biasSell));
        }

        // Clip weights
        for (let i = 0; i < weights.length; i++) {
            weights[i] = Math.max(-0.5, Math.min(0.5, weights[i]));
        }

        this.trainingSamples++;
    }

    /**
     * Adapts learning rate based on error and performance trends.
     */
    private adaptLearningRate(error: number): number {
        let rate = this.currentLearningRate;

        // Decay over time
        rate *= this.adaptiveConfig.decayFactor;

        // Scale by error magnitude
        if (this.adaptiveConfig.errorScaling) {
            const errorScale = Math.min(2.0, 1 + Math.abs(error) / 0.2);
            rate *= errorScale;
        }

        // Adjust based on recent performance
        if (this.adaptiveConfig.performanceAdaptive) {
            const metrics = this.performanceTracker.getMetrics();
            if (metrics.recentTrend === 'degrading') {
                rate *= 0.5;
            } else if (metrics.recentTrend === 'improving') {
                rate *= 1.1;
            }
        }

        // Clamp to valid range
        rate = Math.max(this.adaptiveConfig.minRate, Math.min(this.adaptiveConfig.maxRate, rate));

        this.currentLearningRate = rate;
        return rate;
    }

    /**
     * Updates weights with momentum.
     */
    private updateWithMomentum(
        weights: number[],
        momentum: number[],
        gradient: number[],
        learningRate: number
    ): void {
        for (let i = 0; i < weights.length; i++) {
            momentum[i] = this.beta * momentum[i] + (1 - this.beta) * gradient[i];
            weights[i] -= learningRate * momentum[i];
        }
    }

    /**
     * Training from replay buffer.
     */
    trainFromReplay(features: Record<string, number>, target: number): void {
        // Validate input
        if (typeof target !== 'number' || isNaN(target) || target < 0 || target > 1) {
            console.warn(`[TimeoutModel] Invalid replay target: ${target}, skipping`);
            return;
        }

        const isBuy = (features._isBuy ?? 1) === 1;
        const actualWaitTimeMs = target * 120000;  // Denormalize
        const predictedTimeoutMs = this.predict(features, isBuy);
        const filled = features._filled === 1;
        this.train(features, isBuy, filled, actualWaitTimeMs, predictedTimeoutMs);
    }

    /**
     * Converts feature dict to array in consistent order.
     * Uses price-related features (not depth features for simplicity).
     */
    private toVector(features: Record<string, number>): number[] {
        return [
            features.candle10s ?? 0,
            features.candle20s ?? 0,
            features.candle30s ?? 0,
            features.candle60s ?? 0,
            features.candle5m ?? 0,
            features.ma30s ?? 0,
            features.ma60s ?? 0,
            features.ma5m ?? 0,
            features.volatility30s ?? 0,
            features.volatility60s ?? 0,
            features.momentum ?? 0,
            features.priceVsMa ?? 0,
            features.upMid ?? 0.5,
            features.downMid ?? 0.5,
            features.upSpread ?? 0,
            features.downSpread ?? 0,
            features.imbalance ?? 0,
        ];
    }

    private dot(a: number[], b: number[]): number {
        return a.reduce((sum, ai, i) => sum + ai * (b[i] ?? 0), 0);
    }

    /**
     * Saves model weights to disk.
     */
    save(): void {
        try {
            const data = {
                version: '2.0',  // v2 includes momentum
                numFeatures: TimeoutModel.NUM_FEATURES,
                weightsBuy: this.weightsBuy,
                weightsSell: this.weightsSell,
                biasBuy: this.biasBuy,
                biasSell: this.biasSell,
                momentumBuy: this.momentumBuy,
                momentumSell: this.momentumSell,
                biasMomentumBuy: this.biasMomentumBuy,
                biasMomentumSell: this.biasMomentumSell,
                currentLearningRate: this.currentLearningRate,
                learningRate: this.learningRate,
                trainingSamples: this.trainingSamples,
                savedAt: new Date().toISOString(),
            };
            writeFileSync(this.savePath, JSON.stringify(data, null, 2));

            // Save performance tracker
            this.performanceTracker.save();
        } catch (e) {
            console.error(`[TimeoutModel] Failed to save: ${e}`);
        }
    }

    /**
     * Loads model weights from disk if file exists.
     */
    loadIfExists(): boolean {
        if (!existsSync(this.savePath)) return false;

        try {
            const content = readFileSync(this.savePath, 'utf-8');
            const data = JSON.parse(content);

            if (data.numFeatures !== TimeoutModel.NUM_FEATURES) {
                console.warn(`[TimeoutModel] Feature count mismatch, reinitializing`);
                return false;
            }

            this.weightsBuy = data.weightsBuy;
            this.weightsSell = data.weightsSell;
            this.biasBuy = data.biasBuy ?? 0;
            this.biasSell = data.biasSell ?? 0;
            this.trainingSamples = data.trainingSamples ?? 0;
            this.currentLearningRate = data.currentLearningRate ?? this.learningRate;

            // Load momentum if available
            if (data.momentumBuy && data.momentumBuy.length === TimeoutModel.NUM_FEATURES) {
                this.momentumBuy = data.momentumBuy;
                this.momentumSell = data.momentumSell;
                this.biasMomentumBuy = data.biasMomentumBuy ?? 0;
                this.biasMomentumSell = data.biasMomentumSell ?? 0;
            }

            console.log(`[TimeoutModel] Loaded from ${this.savePath} (${this.trainingSamples} samples)`);

            // Load performance tracker
            this.performanceTracker.loadIfExists();

            return true;
        } catch (e) {
            console.warn(`[TimeoutModel] Failed to load: ${e}`);
            return false;
        }
    }

    /**
     * Returns the number of training samples processed.
     */
    getTrainingSamples(): number {
        return this.trainingSamples;
    }

    /**
     * Returns the current learning rate.
     */
    getCurrentLearningRate(): number {
        return this.currentLearningRate;
    }

    /**
     * Returns performance metrics.
     */
    getPerformanceMetrics() {
        return this.performanceTracker.getMetrics();
    }

    /**
     * Returns the default timeout for fallback.
     */
    static getDefaultTimeoutMs(): number {
        return TimeoutModel.DEFAULT_TIMEOUT_MS;
    }

    /**
     * Resets the model to random weights.
     */
    reset(): void {
        const scale = Math.sqrt(2 / TimeoutModel.NUM_FEATURES);
        this.weightsBuy = Array(TimeoutModel.NUM_FEATURES).fill(0).map(() => (Math.random() - 0.5) * scale);
        this.weightsSell = Array(TimeoutModel.NUM_FEATURES).fill(0).map(() => (Math.random() - 0.5) * scale);
        this.momentumBuy = Array(TimeoutModel.NUM_FEATURES).fill(0);
        this.momentumSell = Array(TimeoutModel.NUM_FEATURES).fill(0);
        this.biasBuy = 0;
        this.biasSell = 0;
        this.biasMomentumBuy = 0;
        this.biasMomentumSell = 0;
        this.currentLearningRate = this.adaptiveConfig.initialRate;
        this.trainingSamples = 0;
        this.performanceTracker.clear();
    }
}
