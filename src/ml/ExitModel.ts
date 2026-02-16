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
 * Simulated exit level for theoretical trade tracking.
 */
export interface SimulatedExitLevel {
    targetPrice: number;            // Absolute price
    offsetFromMid: number;          // e.g., 0.02 for +2%
    wasHit: boolean;                // Did price reach this?
    firstHitTimeMs: number | null;  // When first hit
    hitCount: number;               // Times crossed
    timeAboveLevel: number;         // Total ms above
}

/**
 * Enhanced prediction interface with expected value optimization.
 * Now includes timeout prediction (integrated from TimeoutModel).
 */
export interface EnhancedExitPrediction {
    suggestedPrice: number;       // Recommended exit price (maximizes expected value)
    suggestedOffset: number;      // Offset from mid that was selected
    fillProbability: number;      // P(fill) at suggested price
    expectedValue: number;        // E[PnL] = P(fill) * offset at suggested price
    confidence: number;           // Model confidence
    suggestedTimeoutMs: number;   // Recommended timeout based on fill probability

    // Multi-level predictions with expected values
    levelPredictions: Array<{
        offset: number;           // e.g., 0.02
        fillProbability: number;  // P(fill) at this offset
        expectedValue: number;    // E[PnL] = P(fill) * offset
    }>;
}

/**
 * Model to predict optimal exit price using Expected Value Optimization.
 *
 * Strategy:
 * - Trains to predict P(fill | features, offset) as binary classification
 * - At inference, calculates E[PnL] = P(fill) * offset for each level
 * - Selects the offset that maximizes expected value
 *
 * This balances the tradeoff between:
 * - Higher prices (more profit if filled)
 * - Lower prices (higher fill probability)
 *
 * Enhancements:
 * - Adaptive learning rate
 * - Gradient momentum (Adam-lite)
 * - Performance tracking
 */
export class ExitModel {
    private weights: number[];
    private bias: number = 0;
    private learningRate: number;
    private savePath: string;
    private trainingSamples: number = 0;

    // Adaptive learning rate
    private adaptiveConfig: AdaptiveLearningConfig;
    private currentLearningRate: number;

    // Gradient momentum
    private momentum: number[];
    private biasMomentum: number = 0;
    private readonly beta: number = 0.9;

    // Performance tracker
    private performanceTracker: ModelPerformanceTracker;

    // Number of features for exit model (aligned with FairValueModel's 56 features + targetOffset)
    // This ensures consistency across models and provides richer context for predictions
    private static readonly NUM_FEATURES = 57;
    private static readonly LEGACY_NUM_FEATURES = 54;  // Previous version had 54 features

    // Simulation levels for multi-level price tracking
    private static readonly SIMULATION_OFFSETS = [0.005, 0.01, 0.015, 0.02, 0.025, 0.03];

    // Timeout constants (integrated from TimeoutModel)
    // Timeout scales with fill probability: low P(fill) → longer timeout
    private static readonly MIN_TIMEOUT_MS = 5 * 1000;     // 5 seconds minimum
    private static readonly MAX_TIMEOUT_MS = 120 * 1000;   // 2 minutes maximum
    private static readonly DEFAULT_TIMEOUT_MS = 30 * 1000; // 30 seconds default
    private static readonly BUY_BASE_TIMEOUT_MS = 20 * 1000; // Base timeout for buy orders

    constructor(
        learningRate: number = 0.01,
        savePath: string = './models/exit.json',
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
        const scale = Math.sqrt(2 / ExitModel.NUM_FEATURES);
        this.weights = Array(ExitModel.NUM_FEATURES).fill(0).map(() => (Math.random() - 0.5) * scale);

        // Initialize momentum
        this.momentum = Array(ExitModel.NUM_FEATURES).fill(0);

        // Initialize performance tracker
        this.performanceTracker = new ModelPerformanceTracker(
            'exit',
            100,
            { maxMae: 0.2, degradationRate: 1.5, minSamplesForAlert: 30 },
            savePath.replace('.json', '_performance.json')
        );
    }

    /**
     * Legacy predict method - returns fill probability at the given offset.
     * For full expected value optimization, use findOptimalPrice() instead.
     *
     * @returns suggestedPrice (based on originalPrice + small adjustment) and confidence
     */
    predict(features: Record<string, number>): { suggestedPrice: number; confidence: number } {
        const featureVector = this.toVector(features);

        // Predict fill probability using sigmoid
        const raw = this.dot(this.weights, featureVector) + this.bias;
        const fillProb = this.sigmoid(raw);

        // Use fill probability as confidence
        const confidence = Math.max(0.3, Math.min(0.95, fillProb));

        // Suggested price based on original price with small adjustment
        // Higher fill probability = can be more aggressive (higher price for sells)
        const originalPrice = features.originalPrice ?? 0.5;
        const adjustment = (fillProb - 0.5) * 0.1;  // -0.05 to +0.05

        return {
            suggestedPrice: Math.max(0.01, Math.min(0.99, originalPrice + adjustment)),
            confidence,
        };
    }

    /**
     * Online training: update weights using binary classification for fill probability.
     *
     * Uses binary cross-entropy loss:
     * - Target: 1 if filled, 0 if not filled
     * - Prediction: sigmoid(raw) = P(fill)
     * - Gradient: (prediction - target) * features
     *
     * @param features Features at time of exit decision (must include targetOffset)
     * @param actualFillPrice The price at which the order eventually filled (or 0 if expired)
     * @param filled Whether the order filled
     */
    train(features: Record<string, number>, actualFillPrice: number, filled: boolean): void {
        const featureVector = this.toVector(features);

        // Forward pass: predict fill probability using sigmoid
        const raw = this.dot(this.weights, featureVector) + this.bias;
        const predictedFillProb = this.sigmoid(raw);

        // Target: 1 for filled, 0 for not filled
        const target = filled ? 1 : 0;

        // Binary cross-entropy gradient: (prediction - target)
        // This pushes toward 1 for fills and toward 0 for non-fills
        const error = predictedFillProb - target;

        // Track performance
        this.performanceTracker.recordWithDirection(
            predictedFillProb,
            target,
            filled ? 1 : 0,
            filled ? 1 : -1,
            features
        );

        // Adapt learning rate
        const effectiveLR = this.adaptLearningRate(error);

        // Gradient descent update with momentum
        const gradient = featureVector.map(f => error * f);
        this.updateWithMomentum(this.weights, this.momentum, gradient, effectiveLR);

        // Update bias with momentum
        this.biasMomentum = this.beta * this.biasMomentum + (1 - this.beta) * error;
        this.bias -= effectiveLR * this.biasMomentum;

        // Clip weights
        this.clipWeights();

        this.trainingSamples++;
    }

    /**
     * Sigmoid activation function for fill probability.
     */
    private sigmoid(x: number): number {
        // Clip to prevent overflow
        const clipped = Math.max(-500, Math.min(500, x));
        return 1 / (1 + Math.exp(-clipped));
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
            const errorScale = Math.min(2.0, 1 + Math.abs(error) / 0.1);
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
     * Clips weights to prevent extreme values.
     */
    private clipWeights(): void {
        const maxWeight = 0.5;
        const maxBias = 3.0;

        for (let i = 0; i < this.weights.length; i++) {
            this.weights[i] = Math.max(-maxWeight, Math.min(maxWeight, this.weights[i]));
        }
        this.bias = Math.max(-maxBias, Math.min(maxBias, this.bias));
    }

    /**
     * Training from replay buffer.
     */
    trainFromReplay(features: Record<string, number>, target: number): void {
        // Validate input
        if (typeof target !== 'number' || isNaN(target)) {
            console.warn(`[ExitModel] Invalid replay target: ${target}, skipping`);
            return;
        }

        const filled = target > 0;
        this.train(features, target, filled);
    }

    /**
     * Trains the model from simulation data using binary classification.
     *
     * For each simulated price level, trains the model to predict P(fill):
     * - If level was hit: target = 1 (filled)
     * - If level was not hit: target = 0 (not filled)
     *
     * The model learns P(fill | features, offset), which is then used
     * to calculate expected value = P(fill) * offset at inference time.
     *
     * @param features The market features at entry time
     * @param levelOutcomes Array of simulated exit levels with outcomes
     * @param direction 'UP' or 'DOWN' trade direction
     */
    trainFromSimulation(
        features: Record<string, number>,
        levelOutcomes: SimulatedExitLevel[],
        direction: 'UP' | 'DOWN'
    ): void {
        if (levelOutcomes.length === 0) return;

        // Train binary classification for each price level
        for (const level of levelOutcomes) {
            // Add offset to features - this is crucial for learning P(fill | offset)
            const levelFeatures = {
                ...features,
                targetOffset: level.offsetFromMid,
                orderType: direction === 'UP' ? 0 : 1, // SELL for UP, BUY for DOWN
            };

            // Binary classification: filled (1) or not filled (0)
            // The actualFillPrice parameter is not used for classification,
            // only the filled boolean matters
            this.train(levelFeatures, level.targetPrice, level.wasHit);
        }
    }

    /**
     * Predicts fill probability at a given price offset.
     * Uses sigmoid activation on raw output.
     */
    predictFillProbability(features: Record<string, number>, offset: number): number {
        const offsetFeatures = { ...features, targetOffset: offset };
        const featureVector = this.toVector(offsetFeatures);

        const raw = this.dot(this.weights, featureVector) + this.bias;
        return this.sigmoid(raw);
    }

    /**
     * Finds the optimal exit price using Expected Value Optimization.
     *
     * For each price level, calculates:
     *   E[PnL] = P(fill) * offset
     *
     * Selects the offset that maximizes expected value, subject to:
     *   - minFillProbability floor (won't select levels below this)
     *
     * @param features Current market features
     * @param minFillProbability Minimum acceptable fill probability (e.g., 0.3)
     * @param direction Trade direction ('UP' or 'DOWN')
     * @param currentMidPrice Current mid price of the token
     * @returns Enhanced prediction with suggested price and expected values
     */
    findOptimalPrice(
        features: Record<string, number>,
        minFillProbability: number,
        direction: 'UP' | 'DOWN',
        currentMidPrice: number
    ): EnhancedExitPrediction {
        const levelPredictions: Array<{
            offset: number;
            fillProbability: number;
            expectedValue: number;
        }> = [];

        // Calculate fill probability and expected value for each level
        for (const offset of ExitModel.SIMULATION_OFFSETS) {
            const fillProb = this.predictFillProbability(features, offset);
            const expectedValue = fillProb * offset;  // E[PnL] = P(fill) * profit
            levelPredictions.push({ offset, fillProbability: fillProb, expectedValue });
        }

        // Find the level that maximizes expected value, respecting min probability floor
        let bestLevel = levelPredictions[0];  // Default to lowest offset
        let maxExpectedValue = -Infinity;

        for (const level of levelPredictions) {
            // Only consider levels that meet minimum fill probability
            if (level.fillProbability >= minFillProbability) {
                if (level.expectedValue > maxExpectedValue) {
                    maxExpectedValue = level.expectedValue;
                    bestLevel = level;
                }
            }
        }

        // If no level meets minFillProbability, fall back to highest probability level
        if (maxExpectedValue === -Infinity) {
            bestLevel = levelPredictions.reduce((best, curr) =>
                curr.fillProbability > best.fillProbability ? curr : best
            );
        }

        // Calculate suggested price - always add offset since we're SELLING tokens we bought
        const suggestedPrice = Math.min(0.99, currentMidPrice + bestLevel.offset);

        // Confidence based on expected value relative to max possible
        // Max possible = 1.0 * max_offset (100% fill at highest price)
        const maxPossibleEV = Math.max(...ExitModel.SIMULATION_OFFSETS);
        const confidence = Math.min(0.95, 0.3 + (bestLevel.expectedValue / maxPossibleEV) * 0.65);

        // Calculate timeout based on fill probability
        // Lower fill probability → need longer timeout to achieve fill
        const suggestedTimeoutMs = this.calculateTimeoutFromFillProbability(bestLevel.fillProbability);

        return {
            suggestedPrice,
            suggestedOffset: bestLevel.offset,
            fillProbability: bestLevel.fillProbability,
            expectedValue: bestLevel.expectedValue,
            confidence,
            suggestedTimeoutMs,
            levelPredictions: levelPredictions.sort((a, b) => a.offset - b.offset),
        };
    }

    /**
     * Calculates timeout based on fill probability.
     * Lower fill probability requires longer timeout.
     *
     * Formula: timeout = MIN + (1 - fillProb) * (MAX - MIN)
     * - fillProb = 1.0 → MIN_TIMEOUT (5s) - very likely to fill quickly
     * - fillProb = 0.5 → midpoint (62.5s)
     * - fillProb = 0.0 → MAX_TIMEOUT (120s) - unlikely to fill, wait longer
     */
    private calculateTimeoutFromFillProbability(fillProbability: number): number {
        const clampedProb = Math.max(0, Math.min(1, fillProbability));
        const timeoutMs = ExitModel.MIN_TIMEOUT_MS +
            (1 - clampedProb) * (ExitModel.MAX_TIMEOUT_MS - ExitModel.MIN_TIMEOUT_MS);
        return Math.round(timeoutMs);
    }

    /**
     * Predicts timeout for a buy order.
     * Uses market features to estimate fill probability, then derives timeout.
     *
     * Buy orders are typically more aggressive (taking liquidity), so we use
     * a shorter base timeout with adjustments based on market conditions.
     *
     * @param features Market features at order placement
     * @returns Predicted timeout in milliseconds
     */
    predictBuyTimeout(features: Record<string, number>): number {
        // For buy orders, use market conditions to estimate fill likelihood
        // Key indicators: spread, volatility, book pressure
        const spread = features.upSpread ?? features.downSpread ?? 0.01;
        const volatility = features.volatility30s ?? 0;
        const bookPressure = features.upBookPressure ?? features.downBookPressure ?? 1;
        const momentum = features.momentum ?? 0;

        // Base fill probability estimate for buy orders
        // Tighter spread + higher volatility + favorable momentum → higher fill prob
        let estimatedFillProb = 0.7; // Default: buy orders usually fill

        // Adjust for spread (wider spread → lower fill prob)
        if (spread > 0.02) estimatedFillProb -= 0.1;
        if (spread > 0.03) estimatedFillProb -= 0.1;

        // Adjust for volatility (higher volatility → higher fill prob due to price movement)
        if (volatility > 0.001) estimatedFillProb += 0.05;
        if (volatility > 0.002) estimatedFillProb += 0.05;

        // Adjust for book pressure (high pressure against us → lower fill prob)
        if (bookPressure < 0.8) estimatedFillProb -= 0.1;
        if (bookPressure > 1.2) estimatedFillProb += 0.1;

        // Clamp to valid range
        estimatedFillProb = Math.max(0.3, Math.min(0.95, estimatedFillProb));

        // Calculate timeout from estimated fill probability
        // Buy orders use a tighter range since they're more time-sensitive
        const buyMinTimeout = ExitModel.BUY_BASE_TIMEOUT_MS;
        const buyMaxTimeout = ExitModel.MAX_TIMEOUT_MS * 0.75; // Cap at 90s for buys

        const timeoutMs = buyMinTimeout +
            (1 - estimatedFillProb) * (buyMaxTimeout - buyMinTimeout);

        return Math.round(timeoutMs);
    }

    /**
     * Predicts timeout for a sell order at a given price offset.
     * Uses the fill probability from the model to derive timeout.
     *
     * @param features Market features
     * @param targetOffset Price offset from mid (e.g., 0.02 for +2%)
     * @returns Predicted timeout in milliseconds
     */
    predictSellTimeout(features: Record<string, number>, targetOffset: number = 0.01): number {
        const fillProb = this.predictFillProbability(features, targetOffset);
        return this.calculateTimeoutFromFillProbability(fillProb);
    }

    /**
     * Returns the simulation offsets used for multi-level tracking.
     */
    static getSimulationOffsets(): number[] {
        return [...ExitModel.SIMULATION_OFFSETS];
    }

    /**
     * Returns the default timeout for fallback scenarios.
     */
    static getDefaultTimeoutMs(): number {
        return ExitModel.DEFAULT_TIMEOUT_MS;
    }

    /**
     * Returns timeout range constants.
     */
    static getTimeoutRange(): { min: number; max: number; default: number } {
        return {
            min: ExitModel.MIN_TIMEOUT_MS,
            max: ExitModel.MAX_TIMEOUT_MS,
            default: ExitModel.DEFAULT_TIMEOUT_MS,
        };
    }

    /**
     * Converts feature dict to array in consistent order (54 features).
     * Aligned with FairValueModel's 53 features + targetOffset for level-specific predictions.
     * Uses sanitize() instead of ?? to also catch NaN values.
     */
    private toVector(features: Record<string, number>): number[] {
        const s = this.sanitize.bind(this);
        return [
            // Price features (indices 0-16) - 17 features
            s(features.candle10s, 0),
            s(features.candle20s, 0),
            s(features.candle30s, 0),
            s(features.candle60s, 0),
            s(features.candle5m, 0),
            s(features.ma30s, 0),
            s(features.ma60s, 0),
            s(features.ma5m, 0),
            s(features.volatility30s, 0),
            s(features.volatility60s, 0),
            s(features.momentum, 0),
            s(features.priceVsMa, 0),
            s(features.upMid, 0.5),
            s(features.downMid, 0.5),
            s(features.upSpread, 0),
            s(features.downSpread, 0),
            s(features.imbalance, 0),

            // UP depth features (indices 17-24) - 8 features
            s(features.upBidDepth1pct, 0),
            s(features.upAskDepth1pct, 0),
            s(features.upBidDepth5pct, 0),
            s(features.upAskDepth5pct, 0),
            s(features.upVolumeImbalance, 0),
            s(features.upBidVWAP, 0.5),
            s(features.upAskVWAP, 0.5),
            s(features.upBookPressure, 1),

            // DOWN depth features (indices 25-32) - 8 features
            s(features.downBidDepth1pct, 0),
            s(features.downAskDepth1pct, 0),
            s(features.downBidDepth5pct, 0),
            s(features.downAskDepth5pct, 0),
            s(features.downVolumeImbalance, 0),
            s(features.downBidVWAP, 0.5),
            s(features.downAskVWAP, 0.5),
            s(features.downBookPressure, 1),

            // Time features (indices 33-42) - 10 features
            s(features.minuteInHour, 0),
            s(features.secondInMinute, 0),
            s(features.timeToHourEnd, 1),
            s(features.isFirstQuarter, 0),
            s(features.isLastQuarter, 0),
            s(features.minuteSin, 0),
            s(features.minuteCos, 1),
            s(features.hourSin, 0),
            s(features.hourCos, 1),
            s(features.periodProgress, 0),

            // Order flow features (indices 43-48) - 6 features
            s(features.upBidAskRatio, 1),
            s(features.downBidAskRatio, 1),
            s(features.upTopBidConcentration, 0),
            s(features.upTopAskConcentration, 0),
            s(features.downTopBidConcentration, 0),
            s(features.downTopAskConcentration, 0),

            // Cross-token features (indices 49-52) - 4 features
            s(features.upDownCorrelation, 0),
            s(features.upDownSpreadRatio, 1),
            s(features.combinedLiquidity, 0),
            s(features.imbalanceVelocity, 0),

            // Period start features (indices 53-55) - 3 features
            s(features.upPriceVsPeriodStart, 0),
            s(features.downPriceVsPeriodStart, 0),
            s(features.binancePriceVsPeriodStart, 0),

            // Target offset for level-specific predictions (index 56)
            s(features.targetOffset, 0),
        ];
    }

    private dot(a: number[], b: number[]): number {
        return a.reduce((sum, ai, i) => sum + ai * (b[i] ?? 0), 0);
    }

    /**
     * Sanitize a feature value - handles NaN, undefined, null, and Infinity.
     * The ?? operator only catches undefined/null, not NaN!
     */
    private sanitize(value: number | undefined | null, defaultValue: number): number {
        if (value === undefined || value === null || !isFinite(value)) {
            return defaultValue;
        }
        return value;
    }

    /**
     * Saves model weights to disk.
     */
    save(): void {
        try {
            const data = {
                version: '2.0',  // v2 includes momentum
                numFeatures: ExitModel.NUM_FEATURES,
                weights: this.weights,
                bias: this.bias,
                momentum: this.momentum,
                biasMomentum: this.biasMomentum,
                currentLearningRate: this.currentLearningRate,
                learningRate: this.learningRate,
                trainingSamples: this.trainingSamples,
                savedAt: new Date().toISOString(),
            };
            writeFileSync(this.savePath, JSON.stringify(data, null, 2));

            // Save performance tracker
            this.performanceTracker.save();
        } catch (e) {
            console.error(`[ExitModel] Failed to save: ${e}`);
        }
    }

    /**
     * Loads model weights from disk if file exists.
     * Supports migration from legacy 8-feature models to 25-feature models.
     */
    loadIfExists(): boolean {
        if (!existsSync(this.savePath)) return false;

        try {
            const content = readFileSync(this.savePath, 'utf-8');
            const data = JSON.parse(content);

            // Check if this is a legacy 8-feature model that needs migration
            if (data.numFeatures === ExitModel.LEGACY_NUM_FEATURES) {
                console.log(`[ExitModel] Migrating from ${ExitModel.LEGACY_NUM_FEATURES} to ${ExitModel.NUM_FEATURES} features`);
                this.migrateFromLegacy(data);
                return true;
            }

            // Validate version compatibility
            if (data.numFeatures !== ExitModel.NUM_FEATURES) {
                console.warn(`[ExitModel] Feature count mismatch (${data.numFeatures} vs ${ExitModel.NUM_FEATURES}), reinitializing`);
                return false;
            }

            this.weights = data.weights;
            this.bias = data.bias ?? 0;
            this.trainingSamples = data.trainingSamples ?? 0;
            this.currentLearningRate = data.currentLearningRate ?? this.learningRate;

            // Load momentum if available
            if (data.momentum && data.momentum.length === ExitModel.NUM_FEATURES) {
                this.momentum = data.momentum;
                this.biasMomentum = data.biasMomentum ?? 0;
            }

            console.log(`[ExitModel] Loaded from ${this.savePath} (${this.trainingSamples} training samples)`);

            // Load performance tracker
            this.performanceTracker.loadIfExists();

            return true;
        } catch (e) {
            console.warn(`[ExitModel] Failed to load: ${e}`);
            return false;
        }
    }

    /**
     * Migrates a legacy 8-feature model to the new 25-feature format.
     * Preserves learned weights for original features, initializes new features with small random values.
     */
    private migrateFromLegacy(data: { weights: number[]; bias?: number; momentum?: number[]; biasMomentum?: number; trainingSamples?: number; currentLearningRate?: number }): void {
        // Preserve original 8 weights
        const scale = Math.sqrt(2 / ExitModel.NUM_FEATURES);
        this.weights = Array(ExitModel.NUM_FEATURES).fill(0).map((_, i) => {
            if (i < ExitModel.LEGACY_NUM_FEATURES && data.weights[i] !== undefined) {
                return data.weights[i];
            }
            // Initialize new features with small random values
            return (Math.random() - 0.5) * scale * 0.5; // Smaller init for new features
        });

        // Preserve original momentum for first 8 features
        this.momentum = Array(ExitModel.NUM_FEATURES).fill(0).map((_, i) => {
            if (i < ExitModel.LEGACY_NUM_FEATURES && data.momentum && data.momentum[i] !== undefined) {
                return data.momentum[i];
            }
            return 0;
        });

        this.bias = data.bias ?? 0;
        this.biasMomentum = data.biasMomentum ?? 0;
        this.trainingSamples = data.trainingSamples ?? 0;
        this.currentLearningRate = data.currentLearningRate ?? this.learningRate;

        // Load performance tracker
        this.performanceTracker.loadIfExists();

        console.log(`[ExitModel] Migration complete: preserved ${ExitModel.LEGACY_NUM_FEATURES} weights, initialized ${ExitModel.NUM_FEATURES - ExitModel.LEGACY_NUM_FEATURES} new features`);
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
     * Returns feature names for logging/debugging (57 features).
     * Aligned with FairValueModel's 56 features + targetOffset.
     */
    static getFeatureNames(): string[] {
        return [
            // Price features (17)
            'candle10s', 'candle20s', 'candle30s', 'candle60s', 'candle5m',
            'ma30s', 'ma60s', 'ma5m',
            'volatility30s', 'volatility60s', 'momentum', 'priceVsMa',
            'upMid', 'downMid', 'upSpread', 'downSpread', 'imbalance',
            // UP depth features (8)
            'upBidDepth1pct', 'upAskDepth1pct', 'upBidDepth5pct', 'upAskDepth5pct',
            'upVolumeImbalance', 'upBidVWAP', 'upAskVWAP', 'upBookPressure',
            // DOWN depth features (8)
            'downBidDepth1pct', 'downAskDepth1pct', 'downBidDepth5pct', 'downAskDepth5pct',
            'downVolumeImbalance', 'downBidVWAP', 'downAskVWAP', 'downBookPressure',
            // Time features (10)
            'minuteInHour', 'secondInMinute', 'timeToHourEnd', 'isFirstQuarter', 'isLastQuarter',
            'minuteSin', 'minuteCos', 'hourSin', 'hourCos', 'periodProgress',
            // Order flow features (6)
            'upBidAskRatio', 'downBidAskRatio', 'upTopBidConcentration', 'upTopAskConcentration',
            'downTopBidConcentration', 'downTopAskConcentration',
            // Cross-token features (4)
            'upDownCorrelation', 'upDownSpreadRatio', 'combinedLiquidity', 'imbalanceVelocity',
            // Period start features (3)
            'upPriceVsPeriodStart', 'downPriceVsPeriodStart', 'binancePriceVsPeriodStart',
            // Target offset (1)
            'targetOffset',
        ];
    }

    /**
     * Returns all feature weights as a map (for debugging/analysis).
     */
    getFeatureWeights(): Record<string, number> {
        const names = ExitModel.getFeatureNames();
        const result: Record<string, number> = {};

        for (let i = 0; i < names.length; i++) {
            result[names[i]] = this.weights[i];
        }

        return result;
    }

    /**
     * Resets the model to random weights.
     */
    reset(): void {
        const scale = Math.sqrt(2 / ExitModel.NUM_FEATURES);
        this.weights = Array(ExitModel.NUM_FEATURES).fill(0).map(() => (Math.random() - 0.5) * scale);
        this.momentum = Array(ExitModel.NUM_FEATURES).fill(0);
        this.bias = 0;
        this.biasMomentum = 0;
        this.currentLearningRate = this.adaptiveConfig.initialRate;
        this.trainingSamples = 0;
        this.performanceTracker.clear();
    }
}
