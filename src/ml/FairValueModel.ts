import { writeFileSync, readFileSync, existsSync } from 'fs';
import { MarketRegime } from './MarketRegimeDetector.js';
import { ModelPerformanceTracker } from './ModelPerformanceTracker.js';

/**
 * Configuration for adaptive learning rate.
 */
export interface AdaptiveLearningConfig {
    initialRate: number;           // e.g., 0.01
    minRate: number;               // e.g., 0.0001
    maxRate: number;               // e.g., 0.1
    decayFactor: number;           // e.g., 0.9999 (per training step)
    errorScaling: boolean;         // Scale LR by error magnitude
    performanceAdaptive: boolean;  // Adjust based on tracker metrics
}

/**
 * Prediction result with uncertainty estimates.
 */
export interface PredictionWithUncertainty {
    upPrice: number;
    downPrice: number;
    upConfidence: number;      // 0-1, higher = more confident
    downConfidence: number;    // 0-1, higher = more confident
    upUncertainty: number;     // Variance-based uncertainty
    downUncertainty: number;
}

/**
 * Online learning model to predict fair token prices.
 * Uses simple linear regression with gradient descent.
 *
 * Features: 33 total (17 price + 16 depth) + new features
 *
 * Enhancements:
 * - Adaptive learning rate
 * - Gradient momentum (Adam-lite)
 * - Uncertainty estimation
 * - Regime-aware predictions
 */
export class FairValueModel {
    private weightsUp: number[];
    private weightsDown: number[];
    private biasUp: number = 0;
    private biasDown: number = 0;
    private learningRate: number;
    private savePath: string;
    private trainingSamples: number = 0;

    // Adaptive learning rate
    private adaptiveConfig: AdaptiveLearningConfig;
    private currentLearningRate: number;

    // Gradient momentum (Adam-lite)
    private momentumUp: number[];
    private momentumDown: number[];
    private biasMomentumUp: number = 0;
    private biasMomentumDown: number = 0;
    private readonly beta: number = 0.9;  // Momentum coefficient

    // Performance tracker for adaptive learning
    private performanceTracker: ModelPerformanceTracker;

    // Regime-aware weights
    private weightsUpByRegime: Map<MarketRegime, number[]> = new Map();
    private weightsDownByRegime: Map<MarketRegime, number[]> = new Map();
    private biasUpByRegime: Map<MarketRegime, number> = new Map();
    private biasDownByRegime: Map<MarketRegime, number> = new Map();
    private momentumUpByRegime: Map<MarketRegime, number[]> = new Map();
    private momentumDownByRegime: Map<MarketRegime, number[]> = new Map();
    private regimeTrainingSamples: Map<MarketRegime, number> = new Map();

    // Uncertainty estimation
    private predictionHistory: Array<{
        features: number[];
        predictionUp: number;
        predictionDown: number;
        actualUp?: number;
        actualDown?: number;
    }> = [];
    private readonly uncertaintyHistorySize: number = 100;

    // Return prediction head (for hybrid loss training)
    private weightsUpReturn: number[];
    private weightsDownReturn: number[];
    private momentumUpReturn: number[];
    private momentumDownReturn: number[];
    private useReturnTraining: boolean = false;
    private returnLossWeight: number = 0.3;

    // Feature count: 17 price + 8 UP depth + 8 DOWN depth + 10 time + 6 order flow + 4 cross-token + 3 period start = 56
    private static readonly NUM_FEATURES = 56;

    constructor(
        learningRate: number = 0.01,
        savePath: string = './models/fairvalue.json',
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

        // Initialize weights with small random values (Xavier initialization)
        const scale = Math.sqrt(2 / FairValueModel.NUM_FEATURES);
        this.weightsUp = Array(FairValueModel.NUM_FEATURES).fill(0).map(() => (Math.random() - 0.5) * scale);
        this.weightsDown = Array(FairValueModel.NUM_FEATURES).fill(0).map(() => (Math.random() - 0.5) * scale);

        // Initialize momentum arrays
        this.momentumUp = Array(FairValueModel.NUM_FEATURES).fill(0);
        this.momentumDown = Array(FairValueModel.NUM_FEATURES).fill(0);

        // Initialize return prediction weights (for hybrid loss training)
        this.weightsUpReturn = Array(FairValueModel.NUM_FEATURES).fill(0).map(() => (Math.random() - 0.5) * scale);
        this.weightsDownReturn = Array(FairValueModel.NUM_FEATURES).fill(0).map(() => (Math.random() - 0.5) * scale);
        this.momentumUpReturn = Array(FairValueModel.NUM_FEATURES).fill(0);
        this.momentumDownReturn = Array(FairValueModel.NUM_FEATURES).fill(0);

        // Initialize regime-specific weights
        this.initializeRegimeWeights();

        // Initialize performance tracker
        this.performanceTracker = new ModelPerformanceTracker(
            'fairvalue',
            100,
            { maxMae: 0.15, degradationRate: 1.5, minSamplesForAlert: 50 },
            savePath.replace('.json', '_performance.json')
        );
    }

    private initializeRegimeWeights(): void {
        const scale = Math.sqrt(2 / FairValueModel.NUM_FEATURES);
        for (const regime of Object.values(MarketRegime)) {
            this.weightsUpByRegime.set(
                regime,
                Array(FairValueModel.NUM_FEATURES).fill(0).map(() => (Math.random() - 0.5) * scale)
            );
            this.weightsDownByRegime.set(
                regime,
                Array(FairValueModel.NUM_FEATURES).fill(0).map(() => (Math.random() - 0.5) * scale)
            );
            this.biasUpByRegime.set(regime, 0);
            this.biasDownByRegime.set(regime, 0);
            this.momentumUpByRegime.set(regime, Array(FairValueModel.NUM_FEATURES).fill(0));
            this.momentumDownByRegime.set(regime, Array(FairValueModel.NUM_FEATURES).fill(0));
            this.regimeTrainingSamples.set(regime, 0);
        }
    }

    /**
     * Predicts fair UP and DOWN token prices given features.
     */
    predict(features: Record<string, number>): { upPrice: number; downPrice: number } {
        const featureVector = this.toVector(features);

        // Linear combination + sigmoid to keep in [0, 1]
        const upRaw = this.dot(this.weightsUp, featureVector) + this.biasUp;
        const downRaw = this.dot(this.weightsDown, featureVector) + this.biasDown;

        let upPrice = this.sigmoid(upRaw);
        let downPrice = this.sigmoid(downRaw);

        // Safeguard against NaN - return neutral prices if model is corrupted
        if (!isFinite(upPrice) || !isFinite(downPrice)) {
            console.warn('[FairValueModel] NaN detected in prediction - returning neutral prices');
            upPrice = 0.5;
            downPrice = 0.5;
        }

        return { upPrice, downPrice };
    }

    /**
     * Predicts with uncertainty estimates.
     */
    predictWithUncertainty(features: Record<string, number>, regime?: MarketRegime): PredictionWithUncertainty {
        const featureVector = this.toVector(features);

        // Use regime-specific weights if available and have enough training
        let weightsUp = this.weightsUp;
        let weightsDown = this.weightsDown;
        let biasUp = this.biasUp;
        let biasDown = this.biasDown;

        if (regime) {
            const regimeSamples = this.regimeTrainingSamples.get(regime) ?? 0;
            if (regimeSamples >= 20) {
                weightsUp = this.weightsUpByRegime.get(regime) ?? this.weightsUp;
                weightsDown = this.weightsDownByRegime.get(regime) ?? this.weightsDown;
                biasUp = this.biasUpByRegime.get(regime) ?? this.biasUp;
                biasDown = this.biasDownByRegime.get(regime) ?? this.biasDown;
            }
        }

        // Base predictions
        const upRaw = this.dot(weightsUp, featureVector) + biasUp;
        const downRaw = this.dot(weightsDown, featureVector) + biasDown;
        const upPrice = this.sigmoid(upRaw);
        const downPrice = this.sigmoid(downRaw);

        // Estimate uncertainty for both directions
        const { upConfidence, downConfidence, upUncertainty, downUncertainty } = this.estimateConfidence(
            featureVector, weightsUp, biasUp, weightsDown, biasDown
        );

        // Store for uncertainty tracking
        this.predictionHistory.push({
            features: [...featureVector],
            predictionUp: upPrice,
            predictionDown: downPrice,
        });
        if (this.predictionHistory.length > this.uncertaintyHistorySize) {
            this.predictionHistory.shift();
        }

        return {
            upPrice,
            downPrice,
            upConfidence,
            downConfidence,
            upUncertainty,
            downUncertainty,
        };
    }

    /**
     * Estimates prediction confidence using perturbation-based uncertainty.
     * Lower variance under perturbations = higher confidence.
     * Now computes UP and DOWN confidence separately.
     */
    private estimateConfidenceSingle(
        features: number[],
        weights: number[],
        bias: number,
        direction: 'up' | 'down'
    ): { confidence: number; uncertainty: number } {
        const perturbedPredictions: number[] = [];
        const perturbationScale = 0.05;  // 5% perturbation

        // Generate perturbed predictions
        for (let i = 0; i < 10; i++) {
            const perturbed = features.map(f => f * (1 + (Math.random() - 0.5) * perturbationScale));
            const raw = this.dot(weights, perturbed) + bias;
            perturbedPredictions.push(this.sigmoid(raw));
        }

        // Calculate variance
        const mean = perturbedPredictions.reduce((a, b) => a + b, 0) / perturbedPredictions.length;
        const variance = perturbedPredictions.reduce((sum, p) => sum + (p - mean) ** 2, 0) / perturbedPredictions.length;
        const stdDev = Math.sqrt(variance);

        // Also consider recent prediction errors for this direction
        let historicalError = 0;
        const recentWithActuals = this.predictionHistory.filter(p =>
            direction === 'up' ? p.actualUp !== undefined : p.actualDown !== undefined
        );
        if (recentWithActuals.length > 0) {
            historicalError = recentWithActuals.slice(-20).reduce((sum, p) => {
                const predicted = direction === 'up' ? p.predictionUp : p.predictionDown;
                const actual = direction === 'up' ? (p.actualUp ?? predicted) : (p.actualDown ?? predicted);
                return sum + Math.abs(predicted - actual);
            }, 0) / Math.min(20, recentWithActuals.length);
        }

        // Confidence: inverse of uncertainty
        // Map variance and historical error to confidence
        const perturbationUncertainty = Math.min(1, stdDev * 10);
        const totalUncertainty = perturbationUncertainty * 0.6 + historicalError * 0.4;
        const confidence = Math.max(0.1, Math.min(0.95, 1 - totalUncertainty));

        return { confidence, uncertainty: totalUncertainty };
    }

    /**
     * Estimates confidence for both UP and DOWN predictions separately.
     */
    private estimateConfidence(
        features: number[],
        weightsUp: number[],
        biasUp: number,
        weightsDown: number[],
        biasDown: number
    ): { upConfidence: number; downConfidence: number; upUncertainty: number; downUncertainty: number } {
        const upResult = this.estimateConfidenceSingle(features, weightsUp, biasUp, 'up');
        const downResult = this.estimateConfidenceSingle(features, weightsDown, biasDown, 'down');

        return {
            upConfidence: upResult.confidence,
            downConfidence: downResult.confidence,
            upUncertainty: upResult.uncertainty,
            downUncertainty: downResult.uncertainty,
        };
    }

    /**
     * Online training: update weights based on observed outcome.
     * @param features Features at time of prediction
     * @param actualUpPrice Actual UP price after convergence window
     * @param actualDownPrice Actual DOWN price after convergence window
     * @param regime Optional market regime for regime-specific training
     * @param sampleWeight Optional weight for this sample (default 1.0). Higher weights = larger updates.
     *                     Used for PnL-weighted training where high-profit trades get more influence.
     */
    train(
        features: Record<string, number>,
        actualUpPrice: number,
        actualDownPrice: number,
        regime?: MarketRegime,
        sampleWeight?: number
    ): void {
        const featureVector = this.toVector(features);
        const prediction = this.predict(features);

        // Calculate errors
        const upError = prediction.upPrice - actualUpPrice;
        const downError = prediction.downPrice - actualDownPrice;

        // Track performance
        this.performanceTracker.record(prediction.upPrice, actualUpPrice, features);
        this.performanceTracker.record(prediction.downPrice, actualDownPrice, features);

        // Update prediction history with actuals
        const lastPrediction = this.predictionHistory[this.predictionHistory.length - 1];
        if (lastPrediction) {
            lastPrediction.actualUp = actualUpPrice;
            lastPrediction.actualDown = actualDownPrice;
        }

        // Adapt learning rate and apply sample weight
        const avgError = (Math.abs(upError) + Math.abs(downError)) / 2;
        const baseLR = this.adaptLearningRate(avgError);
        const effectiveLR = baseLR * (sampleWeight ?? 1.0);

        // Gradient descent update with sigmoid derivative and momentum
        const upGradient = upError * prediction.upPrice * (1 - prediction.upPrice);
        const downGradient = downError * prediction.downPrice * (1 - prediction.downPrice);

        // Skip update if gradients are NaN/Infinity (prevents model corruption)
        if (!isFinite(upGradient) || !isFinite(downGradient)) {
            console.warn('[FairValueModel] NaN gradient detected - skipping training update');
            return;
        }

        // Update global weights with momentum
        this.updateWithMomentum(
            this.weightsUp,
            this.momentumUp,
            featureVector.map(f => upGradient * f),
            effectiveLR
        );
        this.updateWithMomentum(
            this.weightsDown,
            this.momentumDown,
            featureVector.map(f => downGradient * f),
            effectiveLR
        );

        // Update biases with momentum
        this.biasMomentumUp = this.beta * this.biasMomentumUp + (1 - this.beta) * upGradient;
        this.biasMomentumDown = this.beta * this.biasMomentumDown + (1 - this.beta) * downGradient;
        this.biasUp -= effectiveLR * this.biasMomentumUp;
        this.biasDown -= effectiveLR * this.biasMomentumDown;

        // Clip weights and biases
        this.clipWeights();

        // Update regime-specific weights if regime provided
        if (regime) {
            this.trainRegime(regime, featureVector, upGradient, downGradient, effectiveLR);
        }

        // Train return prediction head (hybrid loss)
        if (this.useReturnTraining && this.returnLossWeight > 0) {
            // Get previous prices from features (they represent state at prediction time)
            const prevUpMid = features.upMid ?? 0.5;
            const prevDownMid = features.downMid ?? 0.5;

            // Calculate actual returns
            const actualUpReturn = (actualUpPrice - prevUpMid) / Math.max(prevUpMid, 0.01);
            const actualDownReturn = (actualDownPrice - prevDownMid) / Math.max(prevDownMid, 0.01);

            // Train return prediction head
            this.trainReturns(featureVector, actualUpReturn, actualDownReturn, effectiveLR);
        }

        this.trainingSamples++;
    }

    /**
     * Predicts price returns (not absolute prices).
     * Returns bounded by tanh to [-1, 1].
     */
    predictReturns(features: Record<string, number>): { upReturn: number; downReturn: number } {
        const featureVector = this.toVector(features);
        // Use tanh for returns (can be negative or positive, bounded [-1, 1])
        const upRaw = this.dot(this.weightsUpReturn, featureVector);
        const downRaw = this.dot(this.weightsDownReturn, featureVector);
        return {
            upReturn: Math.tanh(upRaw),
            downReturn: Math.tanh(downRaw),
        };
    }

    /**
     * Trains the return prediction head using tanh activation.
     */
    private trainReturns(
        featureVector: number[],
        actualUpReturn: number,
        actualDownReturn: number,
        learningRate: number
    ): void {
        // Forward pass: predict returns with tanh
        const rawUp = this.dot(this.weightsUpReturn, featureVector);
        const rawDown = this.dot(this.weightsDownReturn, featureVector);
        const predictedUp = Math.tanh(rawUp);
        const predictedDown = Math.tanh(rawDown);

        // tanh derivative: (1 - tanh(x)^2)
        const upGradient = (predictedUp - actualUpReturn) * (1 - predictedUp * predictedUp);
        const downGradient = (predictedDown - actualDownReturn) * (1 - predictedDown * predictedDown);

        // Skip update if gradients are NaN/Infinity
        if (!isFinite(upGradient) || !isFinite(downGradient)) {
            return;
        }

        const returnLR = learningRate * this.returnLossWeight;
        this.updateWithMomentum(
            this.weightsUpReturn,
            this.momentumUpReturn,
            featureVector.map(f => upGradient * f),
            returnLR
        );
        this.updateWithMomentum(
            this.weightsDownReturn,
            this.momentumDownReturn,
            featureVector.map(f => downGradient * f),
            returnLR
        );

        // Clip return weights
        const maxWeight = 0.3;
        for (let i = 0; i < this.weightsUpReturn.length; i++) {
            this.weightsUpReturn[i] = Math.max(-maxWeight, Math.min(maxWeight, this.weightsUpReturn[i]));
            this.weightsDownReturn[i] = Math.max(-maxWeight, Math.min(maxWeight, this.weightsDownReturn[i]));
        }
    }

    /**
     * Enables return-based training with specified weight.
     * @param enabled Whether to use return prediction training
     * @param weight Weight for return loss (0-1), default 0.3
     */
    setReturnTraining(enabled: boolean, weight: number = 0.3): void {
        this.useReturnTraining = enabled;
        this.returnLossWeight = Math.max(0, Math.min(1, weight));
    }

    /**
     * Trains regime-specific weights.
     */
    private trainRegime(
        regime: MarketRegime,
        featureVector: number[],
        upGradient: number,
        downGradient: number,
        learningRate: number
    ): void {
        const weightsUp = this.weightsUpByRegime.get(regime)!;
        const weightsDown = this.weightsDownByRegime.get(regime)!;
        const momentumUp = this.momentumUpByRegime.get(regime)!;
        const momentumDown = this.momentumDownByRegime.get(regime)!;

        this.updateWithMomentum(
            weightsUp,
            momentumUp,
            featureVector.map(f => upGradient * f),
            learningRate
        );
        this.updateWithMomentum(
            weightsDown,
            momentumDown,
            featureVector.map(f => downGradient * f),
            learningRate
        );

        // Update regime biases
        let biasUp = this.biasUpByRegime.get(regime) ?? 0;
        let biasDown = this.biasDownByRegime.get(regime) ?? 0;
        biasUp -= learningRate * upGradient;
        biasDown -= learningRate * downGradient;
        this.biasUpByRegime.set(regime, Math.max(-2, Math.min(2, biasUp)));
        this.biasDownByRegime.set(regime, Math.max(-2, Math.min(2, biasDown)));

        // Clip regime weights
        for (let i = 0; i < weightsUp.length; i++) {
            weightsUp[i] = Math.max(-0.3, Math.min(0.3, weightsUp[i]));
            weightsDown[i] = Math.max(-0.3, Math.min(0.3, weightsDown[i]));
        }

        // Increment regime sample count
        const count = this.regimeTrainingSamples.get(regime) ?? 0;
        this.regimeTrainingSamples.set(regime, count + 1);
    }

    // Track consecutive degradation for learning rate reset
    private consecutiveDegradationCount: number = 0;
    private static readonly DEGRADATION_RESET_THRESHOLD = 10;

    /**
     * Adapts learning rate based on error and performance trends.
     * Includes reset mechanism when performance degrades significantly.
     */
    private adaptLearningRate(error: number): number {
        let rate = this.currentLearningRate;

        // Decay over time
        rate *= this.adaptiveConfig.decayFactor;

        // Scale by error magnitude (larger errors = bigger updates, capped)
        if (this.adaptiveConfig.errorScaling) {
            const errorScale = Math.min(2.0, 1 + Math.abs(error) / 0.1);
            rate *= errorScale;
        }

        // Adjust based on recent performance
        if (this.adaptiveConfig.performanceAdaptive) {
            const metrics = this.performanceTracker.getMetrics();
            if (metrics.recentTrend === 'degrading') {
                rate *= 0.5;  // Slow down when degrading
                this.consecutiveDegradationCount++;

                // Reset learning rate if stuck in degradation
                if (this.consecutiveDegradationCount >= FairValueModel.DEGRADATION_RESET_THRESHOLD) {
                    rate = this.adaptiveConfig.initialRate * 0.5;  // Reset to half of initial
                    this.consecutiveDegradationCount = 0;
                    console.log(`[FairValueModel] Learning rate reset due to prolonged degradation: ${rate.toFixed(6)}`);
                }
            } else if (metrics.recentTrend === 'improving') {
                rate *= 1.1;  // Speed up when improving
                this.consecutiveDegradationCount = 0;
            } else {
                // Stable: slowly recover toward initial rate if we're too low
                if (rate < this.adaptiveConfig.initialRate * 0.1) {
                    rate *= 1.01;  // Gradual recovery
                }
                this.consecutiveDegradationCount = 0;
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
            // Update momentum: v = beta * v + (1-beta) * gradient
            momentum[i] = this.beta * momentum[i] + (1 - this.beta) * gradient[i];

            // Update weights with momentum
            weights[i] -= learningRate * momentum[i];
        }
    }

    /**
     * Clips weights to prevent sigmoid saturation.
     */
    private clipWeights(): void {
        const maxWeight = 0.3;
        const maxBias = 2.0;

        for (let i = 0; i < this.weightsUp.length; i++) {
            this.weightsUp[i] = Math.max(-maxWeight, Math.min(maxWeight, this.weightsUp[i]));
            this.weightsDown[i] = Math.max(-maxWeight, Math.min(maxWeight, this.weightsDown[i]));
        }

        this.biasUp = Math.max(-maxBias, Math.min(maxBias, this.biasUp));
        this.biasDown = Math.max(-maxBias, Math.min(maxBias, this.biasDown));
    }

    /**
     * Batch training for multiple samples.
     */
    trainBatch(
        samples: Array<{
            features: Record<string, number>;
            actualUpPrice: number;
            actualDownPrice: number;
            regime?: MarketRegime;
        }>
    ): void {
        for (const sample of samples) {
            this.train(sample.features, sample.actualUpPrice, sample.actualDownPrice, sample.regime);
        }
    }

    /**
     * Training from replay buffer (for IReplayTrainable).
     */
    trainFromReplay(features: Record<string, number>, target: number): void {
        // Validate inputs
        if (typeof target !== 'number' || isNaN(target) || target < 0 || target > 1) {
            console.warn(`[FairValueModel] Invalid replay target: ${target}, skipping`);
            return;
        }

        // Determine direction from special _direction feature
        const direction = features._direction;

        // Validate direction
        if (direction !== 0 && direction !== 1) {
            console.warn(`[FairValueModel] Invalid replay direction: ${direction}, skipping`);
            return;
        }

        if (direction === 1) {
            // UP training
            const prediction = this.predict(features);
            this.train(features, target, prediction.downPrice);
        } else {
            // DOWN training
            const prediction = this.predict(features);
            this.train(features, prediction.upPrice, target);
        }
    }

    /**
     * Converts feature dict to array in consistent order.
     * Uses sanitize() instead of ?? to also catch NaN values.
     */
    private toVector(features: Record<string, number>): number[] {
        const s = this.sanitize.bind(this);
        return [
            // Binance price features (17)
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

            // UP token order book depth features (8)
            s(features.upBidDepth1pct, 0),
            s(features.upAskDepth1pct, 0),
            s(features.upBidDepth5pct, 0),
            s(features.upAskDepth5pct, 0),
            s(features.upVolumeImbalance, 0),
            s(features.upBidVWAP, 0.5),
            s(features.upAskVWAP, 0.5),
            s(features.upBookPressure, 1),

            // DOWN token order book depth features (8)
            s(features.downBidDepth1pct, 0),
            s(features.downAskDepth1pct, 0),
            s(features.downBidDepth5pct, 0),
            s(features.downAskDepth5pct, 0),
            s(features.downVolumeImbalance, 0),
            s(features.downBidVWAP, 0.5),
            s(features.downAskVWAP, 0.5),
            s(features.downBookPressure, 1),

            // Time-based features (10)
            s(features.minuteInHour, 0),
            s(features.secondInMinute, 0),
            s(features.timeToHourEnd, 0),
            s(features.isFirstQuarter, 0),
            s(features.isLastQuarter, 0),
            s(features.minuteSin, 0),
            s(features.minuteCos, 1),
            s(features.hourSin, 0),
            s(features.hourCos, 1),
            s(features.periodProgress, 0),

            // Order flow features (6)
            s(features.upBidAskRatio, 1),
            s(features.downBidAskRatio, 1),
            s(features.upTopBidConcentration, 0),
            s(features.upTopAskConcentration, 0),
            s(features.downTopBidConcentration, 0),
            s(features.downTopAskConcentration, 0),

            // Cross-token features (4)
            s(features.upDownCorrelation, 0),
            s(features.upDownSpreadRatio, 1),
            s(features.combinedLiquidity, 0),
            s(features.imbalanceVelocity, 0),

            // Period start features (3) - price change from period open
            s(features.upPriceVsPeriodStart, 0),
            s(features.downPriceVsPeriodStart, 0),
            s(features.binancePriceVsPeriodStart, 0),
        ];
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

    private dot(a: number[], b: number[]): number {
        let sum = 0;
        const len = Math.min(a.length, b.length);
        for (let i = 0; i < len; i++) {
            sum += a[i] * (b[i] ?? 0);
        }
        return sum;
    }

    private sigmoid(x: number): number {
        // Clip to prevent overflow
        const clipped = Math.max(-500, Math.min(500, x));
        return 1 / (1 + Math.exp(-clipped));
    }

    /**
     * Saves model weights to disk.
     */
    save(): void {
        try {
            const data = {
                version: '4.0',  // v4 adds return prediction weights
                numFeatures: FairValueModel.NUM_FEATURES,
                weightsUp: this.weightsUp,
                weightsDown: this.weightsDown,
                biasUp: this.biasUp,
                biasDown: this.biasDown,
                momentumUp: this.momentumUp,
                momentumDown: this.momentumDown,
                biasMomentumUp: this.biasMomentumUp,
                biasMomentumDown: this.biasMomentumDown,
                currentLearningRate: this.currentLearningRate,
                learningRate: this.learningRate,
                trainingSamples: this.trainingSamples,
                consecutiveDegradationCount: this.consecutiveDegradationCount,
                // Regime-specific data
                regimeWeightsUp: Object.fromEntries(this.weightsUpByRegime),
                regimeWeightsDown: Object.fromEntries(this.weightsDownByRegime),
                regimeBiasUp: Object.fromEntries(this.biasUpByRegime),
                regimeBiasDown: Object.fromEntries(this.biasDownByRegime),
                regimeTrainingSamples: Object.fromEntries(this.regimeTrainingSamples),
                // Return prediction weights (v4)
                weightsUpReturn: this.weightsUpReturn,
                weightsDownReturn: this.weightsDownReturn,
                momentumUpReturn: this.momentumUpReturn,
                momentumDownReturn: this.momentumDownReturn,
                useReturnTraining: this.useReturnTraining,
                returnLossWeight: this.returnLossWeight,
                savedAt: new Date().toISOString(),
            };
            writeFileSync(this.savePath, JSON.stringify(data, null, 2));

            // Also save performance tracker
            this.performanceTracker.save();
        } catch (e) {
            console.error(`[FairValueModel] Failed to save: ${e}`);
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

            // Handle version compatibility
            const savedFeatures = data.numFeatures ?? 33;
            if (savedFeatures !== FairValueModel.NUM_FEATURES) {
                // Feature count changed - reinitialize with old weights where possible
                console.warn(`[FairValueModel] Feature count changed (${savedFeatures} -> ${FairValueModel.NUM_FEATURES}), migrating weights`);

                // Copy old weights to beginning, initialize rest
                const scale = Math.sqrt(2 / FairValueModel.NUM_FEATURES);
                this.weightsUp = Array(FairValueModel.NUM_FEATURES).fill(0).map((_, i) =>
                    i < savedFeatures && data.weightsUp[i] !== undefined
                        ? data.weightsUp[i]
                        : (Math.random() - 0.5) * scale
                );
                this.weightsDown = Array(FairValueModel.NUM_FEATURES).fill(0).map((_, i) =>
                    i < savedFeatures && data.weightsDown[i] !== undefined
                        ? data.weightsDown[i]
                        : (Math.random() - 0.5) * scale
                );

                // Initialize new momentum arrays
                this.momentumUp = Array(FairValueModel.NUM_FEATURES).fill(0);
                this.momentumDown = Array(FairValueModel.NUM_FEATURES).fill(0);
            } else {
                this.weightsUp = data.weightsUp;
                this.weightsDown = data.weightsDown;

                // Load momentum if available
                if (data.momentumUp && data.momentumUp.length === FairValueModel.NUM_FEATURES) {
                    this.momentumUp = data.momentumUp;
                    this.momentumDown = data.momentumDown;
                }
            }

            this.biasUp = data.biasUp ?? 0;
            this.biasDown = data.biasDown ?? 0;
            this.biasMomentumUp = data.biasMomentumUp ?? 0;
            this.biasMomentumDown = data.biasMomentumDown ?? 0;
            this.currentLearningRate = data.currentLearningRate ?? this.learningRate;
            this.trainingSamples = data.trainingSamples ?? 0;

            // Load regime-specific weights if available
            if (data.regimeWeightsUp) {
                for (const [regime, weights] of Object.entries(data.regimeWeightsUp)) {
                    if (Array.isArray(weights) && weights.length === FairValueModel.NUM_FEATURES) {
                        this.weightsUpByRegime.set(regime as MarketRegime, weights as number[]);
                    }
                }
            }
            if (data.regimeWeightsDown) {
                for (const [regime, weights] of Object.entries(data.regimeWeightsDown)) {
                    if (Array.isArray(weights) && weights.length === FairValueModel.NUM_FEATURES) {
                        this.weightsDownByRegime.set(regime as MarketRegime, weights as number[]);
                    }
                }
            }
            if (data.regimeBiasUp) {
                for (const [regime, bias] of Object.entries(data.regimeBiasUp)) {
                    this.biasUpByRegime.set(regime as MarketRegime, bias as number);
                }
            }
            if (data.regimeBiasDown) {
                for (const [regime, bias] of Object.entries(data.regimeBiasDown)) {
                    this.biasDownByRegime.set(regime as MarketRegime, bias as number);
                }
            }
            if (data.regimeTrainingSamples) {
                for (const [regime, count] of Object.entries(data.regimeTrainingSamples)) {
                    this.regimeTrainingSamples.set(regime as MarketRegime, count as number);
                }
            }

            // Load return prediction weights if available (v4+)
            if (data.weightsUpReturn && data.weightsUpReturn.length === FairValueModel.NUM_FEATURES) {
                this.weightsUpReturn = data.weightsUpReturn;
                this.weightsDownReturn = data.weightsDownReturn ?? this.weightsDownReturn;
                this.momentumUpReturn = data.momentumUpReturn ?? Array(FairValueModel.NUM_FEATURES).fill(0);
                this.momentumDownReturn = data.momentumDownReturn ?? Array(FairValueModel.NUM_FEATURES).fill(0);
            }
            if (typeof data.useReturnTraining === 'boolean') {
                this.useReturnTraining = data.useReturnTraining;
            }
            if (typeof data.returnLossWeight === 'number') {
                this.returnLossWeight = data.returnLossWeight;
            }

            // Check for NaN corruption and reset if found
            const hasNaN = this.weightsUp.some(w => !isFinite(w)) ||
                           this.weightsDown.some(w => !isFinite(w)) ||
                           !isFinite(this.biasUp) ||
                           !isFinite(this.biasDown);

            if (hasNaN) {
                console.warn(`[FairValueModel] Detected NaN/Infinity in loaded weights - resetting to random`);
                this.reset();
                return false;
            }

            console.log(`[FairValueModel] Loaded from ${this.savePath} (${this.trainingSamples} training samples)`);

            // Load performance tracker
            this.performanceTracker.loadIfExists();

            return true;
        } catch (e) {
            console.warn(`[FairValueModel] Failed to load: ${e}`);
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
     * Returns the performance tracker.
     */
    getPerformanceTracker(): ModelPerformanceTracker {
        return this.performanceTracker;
    }

    /**
     * Returns feature names for logging/debugging (instance method).
     */
    getFeatureNames(): string[] {
        return FairValueModel.getFeatureNames();
    }

    /**
     * Returns feature names for logging/debugging (static method).
     */
    static getFeatureNames(): string[] {
        return [
            // Price features
            'candle10s', 'candle20s', 'candle30s', 'candle60s', 'candle5m',
            'ma30s', 'ma60s', 'ma5m',
            'volatility30s', 'volatility60s', 'momentum', 'priceVsMa',
            'upMid', 'downMid', 'upSpread', 'downSpread', 'imbalance',
            // UP depth features
            'upBidDepth1pct', 'upAskDepth1pct', 'upBidDepth5pct', 'upAskDepth5pct',
            'upVolumeImbalance', 'upBidVWAP', 'upAskVWAP', 'upBookPressure',
            // DOWN depth features
            'downBidDepth1pct', 'downAskDepth1pct', 'downBidDepth5pct', 'downAskDepth5pct',
            'downVolumeImbalance', 'downBidVWAP', 'downAskVWAP', 'downBookPressure',
            // Time features
            'minuteInHour', 'secondInMinute', 'timeToHourEnd', 'isFirstQuarter', 'isLastQuarter',
            'minuteSin', 'minuteCos', 'hourSin', 'hourCos', 'periodProgress',
            // Order flow features
            'upBidAskRatio', 'downBidAskRatio', 'upTopBidConcentration', 'upTopAskConcentration',
            'downTopBidConcentration', 'downTopAskConcentration',
            // Cross-token features
            'upDownCorrelation', 'upDownSpreadRatio', 'combinedLiquidity', 'imbalanceVelocity',
            // Period start features
            'upPriceVsPeriodStart', 'downPriceVsPeriodStart', 'binancePriceVsPeriodStart',
        ];
    }

    /**
     * Returns the weight for a specific feature (for debugging/analysis).
     */
    getFeatureWeight(featureName: string, token: 'up' | 'down'): number | null {
        const names = FairValueModel.getFeatureNames();
        const index = names.indexOf(featureName);
        if (index === -1) return null;

        return token === 'up' ? this.weightsUp[index] : this.weightsDown[index];
    }

    /**
     * Returns all feature weights as a map (for debugging/analysis).
     */
    getFeatureWeights(token: 'up' | 'down'): Record<string, number> {
        const names = FairValueModel.getFeatureNames();
        const weights = token === 'up' ? this.weightsUp : this.weightsDown;
        const result: Record<string, number> = {};

        for (let i = 0; i < names.length; i++) {
            result[names[i]] = weights[i] ?? 0;
        }

        return result;
    }

    /**
     * Returns regime training sample counts.
     */
    getRegimeTrainingSamples(): Map<MarketRegime, number> {
        return new Map(this.regimeTrainingSamples);
    }

    /**
     * Applies a penalty for not making trades in a period.
     */
    applyNoTradePenalty(
        features: Record<string, number>,
        actualUpPrice: number,
        actualDownPrice: number,
        penaltyMultiplier: number = 3.0,
        regime?: MarketRegime
    ): void {
        const featureVector = this.toVector(features);
        const prediction = this.predict(features);

        // Apply penalty with increased learning rate
        const effectiveLR = this.currentLearningRate * penaltyMultiplier;

        const upError = prediction.upPrice - actualUpPrice;
        const downError = prediction.downPrice - actualDownPrice;

        const upGradient = upError * prediction.upPrice * (1 - prediction.upPrice);
        const downGradient = downError * prediction.downPrice * (1 - prediction.downPrice);

        // Update global weights with penalty
        this.updateWithMomentum(
            this.weightsUp,
            this.momentumUp,
            featureVector.map(f => upGradient * f),
            effectiveLR
        );
        this.updateWithMomentum(
            this.weightsDown,
            this.momentumDown,
            featureVector.map(f => downGradient * f),
            effectiveLR
        );

        this.biasUp -= effectiveLR * upGradient;
        this.biasDown -= effectiveLR * downGradient;

        // Clip weights
        this.clipWeights();

        // Also update regime weights if provided
        if (regime) {
            this.trainRegime(regime, featureVector, upGradient, downGradient, effectiveLR);
        }
    }

    /**
     * Resets the model to random weights.
     */
    reset(): void {
        const scale = Math.sqrt(2 / FairValueModel.NUM_FEATURES);
        this.weightsUp = Array(FairValueModel.NUM_FEATURES).fill(0).map(() => (Math.random() - 0.5) * scale);
        this.weightsDown = Array(FairValueModel.NUM_FEATURES).fill(0).map(() => (Math.random() - 0.5) * scale);
        this.momentumUp = Array(FairValueModel.NUM_FEATURES).fill(0);
        this.momentumDown = Array(FairValueModel.NUM_FEATURES).fill(0);
        this.biasUp = 0;
        this.biasDown = 0;
        this.biasMomentumUp = 0;
        this.biasMomentumDown = 0;
        this.currentLearningRate = this.adaptiveConfig.initialRate;
        this.trainingSamples = 0;
        this.predictionHistory = [];

        // Reset return prediction weights
        this.weightsUpReturn = Array(FairValueModel.NUM_FEATURES).fill(0).map(() => (Math.random() - 0.5) * scale);
        this.weightsDownReturn = Array(FairValueModel.NUM_FEATURES).fill(0).map(() => (Math.random() - 0.5) * scale);
        this.momentumUpReturn = Array(FairValueModel.NUM_FEATURES).fill(0);
        this.momentumDownReturn = Array(FairValueModel.NUM_FEATURES).fill(0);

        // Reset regime weights
        this.initializeRegimeWeights();

        // Reset performance tracker
        this.performanceTracker.clear();
    }
}
