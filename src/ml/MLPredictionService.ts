/**
 * MLPredictionService - Unified ML prediction wrapper for MSPEQ strategies
 *
 * Provides a clean interface for strategies to use ML models:
 * - FairValueModel for fair value prediction
 * - ExitModel for optimal exit price with expected value optimization
 * - MarketRegimeDetector for regime-aware trading
 *
 * Each strategy gets its own MLPredictionService instance with isolated model weights.
 * Models train during simulation on that strategy's trades only (no cross-contamination).
 */

import { existsSync, mkdirSync } from 'fs';
import { FairValueModel, PredictionWithUncertainty } from './FairValueModel.js';
import { ExitModel, EnhancedExitPrediction } from './ExitModel.js';
import { MarketRegimeDetector, MarketRegime, RegimeFeatures } from './MarketRegimeDetector.js';

// ============================================================================
// Types & Interfaces
// ============================================================================

/**
 * Configuration for MLPredictionService
 */
export interface MLServiceConfig {
    /** Base learning rate for models (default: 0.01) */
    learningRate?: number;

    /** Directory path for model persistence (e.g., './models/EarlyBuyerMSPEQ/') */
    modelPath?: string;

    /** Strategy name for logging (e.g., 'EarlyBuyerMSPEQ') */
    strategyName?: string;

    /** Whether to load existing models on initialization (default: true) */
    loadExisting?: boolean;

    /** Minimum confidence threshold for ML gating (default: 0.5) */
    minConfidence?: number;

    /** Minimum fill probability for exit model (default: 0.3) */
    minFillProbability?: number;
}

/**
 * Combined ML prediction result
 */
export interface MLPrediction {
    /** Predicted fair value for UP token (0-1) */
    fairValueUp: number;

    /** Predicted fair value for DOWN token (0-1) */
    fairValueDown: number;

    /** Confidence in UP prediction (0-1) */
    upConfidence: number;

    /** Confidence in DOWN prediction (0-1) */
    downConfidence: number;

    /** Combined confidence score (average of up and down) */
    confidence: number;

    /** Current market regime */
    regime: MarketRegime;

    /** Regime-based position multiplier */
    positionMultiplier: number;
}

/**
 * Trade outcome for training
 */
export interface TradeOutcome {
    /** Features at time of entry */
    entryFeatures: Record<string, number>;

    /** Features at time of exit (if different from entry) */
    exitFeatures?: Record<string, number>;

    /** Actual UP price at outcome time */
    actualUpPrice: number;

    /** Actual DOWN price at outcome time */
    actualDownPrice: number;

    /** Realized profit/loss */
    pnl: number;

    /** Whether the order filled */
    filled: boolean;

    /** Entry price */
    entryPrice: number;

    /** Exit price (if filled) */
    exitPrice?: number;

    /** Trade direction: 'UP' or 'DOWN' */
    direction: 'UP' | 'DOWN';
}

// ============================================================================
// MLPredictionService Class
// ============================================================================

export class MLPredictionService {
    private fairValueModel: FairValueModel;
    private exitModel: ExitModel;
    private regimeDetector: MarketRegimeDetector;

    private config: Required<MLServiceConfig>;
    private trainingSamples: number = 0;

    constructor(config: MLServiceConfig = {}) {
        // Apply defaults
        this.config = {
            learningRate: config.learningRate ?? 0.01,
            modelPath: config.modelPath ?? './models/default/',
            strategyName: config.strategyName ?? 'Unknown',
            loadExisting: config.loadExisting ?? true,
            minConfidence: config.minConfidence ?? 0.5,
            minFillProbability: config.minFillProbability ?? 0.3,
        };

        // Ensure model directory exists
        if (!existsSync(this.config.modelPath)) {
            mkdirSync(this.config.modelPath, { recursive: true });
        }

        // Initialize models with per-strategy paths
        this.fairValueModel = new FairValueModel(
            this.config.learningRate,
            `${this.config.modelPath}/fairvalue.json`
        );

        this.exitModel = new ExitModel(
            this.config.learningRate,
            `${this.config.modelPath}/exit.json`
        );

        this.regimeDetector = new MarketRegimeDetector();

        // Load existing weights if enabled
        if (this.config.loadExisting) {
            this.load();
        }
    }

    // -------------------------------------------------------------------------
    // Core Prediction Methods
    // -------------------------------------------------------------------------

    /**
     * Predicts fair values and confidence for current market state.
     *
     * @param features Current market features (56 features for FairValueModel)
     * @returns MLPrediction with fair values, confidence, and regime info
     */
    predictFairValue(features: Record<string, number>): MLPrediction {
        // Detect current regime from features
        const regime = this.detectRegime(features);

        // Get fair value prediction with uncertainty
        const prediction = this.fairValueModel.predictWithUncertainty(features, regime);

        // Get regime multipliers for position sizing
        const multipliers = this.regimeDetector.getRegimeMultipliers();

        // Combined confidence is average of UP and DOWN confidence
        const combinedConfidence = (prediction.upConfidence + prediction.downConfidence) / 2;

        return {
            fairValueUp: prediction.upPrice,
            fairValueDown: prediction.downPrice,
            upConfidence: prediction.upConfidence,
            downConfidence: prediction.downConfidence,
            confidence: combinedConfidence,
            regime,
            positionMultiplier: multipliers.positionSizeMultiplier,
        };
    }

    /**
     * Finds optimal exit price using expected value optimization.
     *
     * E[PnL] = P(fill) * offset
     * Selects the offset that maximizes expected value while respecting min fill probability.
     *
     * @param features Current market features
     * @param direction Trade direction ('UP' or 'DOWN')
     * @param currentMidPrice Current mid price of the token
     * @returns Enhanced exit prediction with suggested price and fill probability
     */
    findOptimalExitPrice(
        features: Record<string, number>,
        direction: 'UP' | 'DOWN',
        currentMidPrice: number
    ): EnhancedExitPrediction {
        return this.exitModel.findOptimalPrice(
            features,
            this.config.minFillProbability,
            direction,
            currentMidPrice
        );
    }

    /**
     * Predicts fill probability at a specific price offset.
     *
     * @param features Current market features
     * @param offset Price offset from mid (e.g., 0.02 for +2%)
     * @returns Fill probability (0-1)
     */
    predictFillProbability(features: Record<string, number>, offset: number): number {
        return this.exitModel.predictFillProbability(features, offset);
    }

    /**
     * Checks if trading should proceed based on ML confidence.
     *
     * @param features Current market features
     * @param minConfidence Minimum confidence threshold (uses config default if not provided)
     * @returns { shouldTrade: boolean, confidence: number, reason?: string }
     */
    shouldTrade(
        features: Record<string, number>,
        minConfidence?: number
    ): { shouldTrade: boolean; confidence: number; reason?: string } {
        const threshold = minConfidence ?? this.config.minConfidence;
        const prediction = this.predictFairValue(features);

        if (prediction.confidence < threshold) {
            return {
                shouldTrade: false,
                confidence: prediction.confidence,
                reason: `Confidence ${prediction.confidence.toFixed(3)} < threshold ${threshold.toFixed(3)}`,
            };
        }

        // Additional regime-based gating
        if (prediction.regime === MarketRegime.HIGH_VOL_RANGING && prediction.positionMultiplier < 0.6) {
            return {
                shouldTrade: false,
                confidence: prediction.confidence,
                reason: `High vol ranging regime with low position multiplier`,
            };
        }

        return {
            shouldTrade: true,
            confidence: prediction.confidence,
        };
    }

    /**
     * Gets ML-adjusted position size based on confidence and regime.
     *
     * @param baseSize Base position size in dollars
     * @param features Current market features
     * @param mlPositionMultiplier Additional multiplier from genetic optimization (default: 1.0)
     * @returns Adjusted position size
     */
    getAdjustedPositionSize(
        baseSize: number,
        features: Record<string, number>,
        mlPositionMultiplier: number = 1.0
    ): number {
        const prediction = this.predictFairValue(features);

        // Scale by confidence (0.5 to 1.5 range based on confidence)
        const confidenceMultiplier = 0.5 + prediction.confidence;

        // Apply regime multiplier
        const regimeMultiplier = prediction.positionMultiplier;

        // Apply genetic-optimized multiplier
        const finalMultiplier = confidenceMultiplier * regimeMultiplier * mlPositionMultiplier;

        // Clamp to reasonable range (50% to 150% of base)
        const clampedMultiplier = Math.max(0.5, Math.min(1.5, finalMultiplier));

        return baseSize * clampedMultiplier;
    }

    // -------------------------------------------------------------------------
    // Regime Detection
    // -------------------------------------------------------------------------

    /**
     * Detects current market regime from features.
     *
     * @param features Market features containing volatility, momentum, etc.
     * @returns Current MarketRegime
     */
    detectRegime(features: Record<string, number>): MarketRegime {
        // Extract regime features from market features
        const regimeFeatures: RegimeFeatures = {
            volatility30s: features.volatility30s ?? features.volatility ?? 0,
            volatility60s: features.volatility60s ?? (features.volatility ?? 0) * 0.9,
            momentum: features.momentum ?? 0,
            trendStrength: features.trendStrength ?? Math.abs(features.momentum ?? 0) * 10,
            priceVsMa: features.priceVsMa ?? 0,
        };

        return this.regimeDetector.detectRegime(regimeFeatures);
    }

    /**
     * Gets current regime.
     */
    getCurrentRegime(): MarketRegime {
        return this.regimeDetector.getCurrentRegime();
    }

    /**
     * Gets regime multipliers for current regime.
     */
    getRegimeMultipliers(): {
        learningRateMultiplier: number;
        positionSizeMultiplier: number;
        timeoutMultiplier: number;
    } {
        return this.regimeDetector.getRegimeMultipliers();
    }

    // -------------------------------------------------------------------------
    // Training Methods
    // -------------------------------------------------------------------------

    /**
     * Trains models on trade outcome.
     *
     * Called after a trade completes (fills or expires) to update model weights.
     *
     * @param outcome Trade outcome containing features and results
     */
    trainOnOutcome(outcome: TradeOutcome): void {
        const regime = this.detectRegime(outcome.entryFeatures);

        // Calculate sample weight based on PnL (PnL-weighted training)
        // Higher profit trades have more influence on learning
        const sampleWeight = this.calculateSampleWeight(outcome.pnl);

        // Train FairValueModel on actual prices
        this.fairValueModel.train(
            outcome.entryFeatures,
            outcome.actualUpPrice,
            outcome.actualDownPrice,
            regime,
            sampleWeight
        );

        // Train ExitModel on fill outcome
        const exitFeatures = outcome.exitFeatures ?? outcome.entryFeatures;
        this.exitModel.train(
            exitFeatures,
            outcome.exitPrice ?? outcome.entryPrice,
            outcome.filled
        );

        this.trainingSamples++;
    }

    /**
     * Trains FairValueModel directly (for simple cases).
     *
     * @param features Features at time of prediction
     * @param actualUpPrice Actual UP price after convergence
     * @param actualDownPrice Actual DOWN price after convergence
     * @param regime Optional market regime
     */
    trainFairValue(
        features: Record<string, number>,
        actualUpPrice: number,
        actualDownPrice: number,
        regime?: MarketRegime
    ): void {
        this.fairValueModel.train(
            features,
            actualUpPrice,
            actualDownPrice,
            regime ?? this.detectRegime(features)
        );
        this.trainingSamples++;
    }

    /**
     * Applies a penalty for not making trades in a period.
     * Used when the model should have predicted a trade opportunity.
     *
     * @param features Features at time when trade should have been made
     * @param actualUpPrice Actual UP price
     * @param actualDownPrice Actual DOWN price
     * @param penaltyMultiplier Multiplier for learning rate (default: 3.0)
     */
    applyNoTradePenalty(
        features: Record<string, number>,
        actualUpPrice: number,
        actualDownPrice: number,
        penaltyMultiplier: number = 3.0
    ): void {
        const regime = this.detectRegime(features);
        this.fairValueModel.applyNoTradePenalty(
            features,
            actualUpPrice,
            actualDownPrice,
            penaltyMultiplier,
            regime
        );
    }

    /**
     * Calculates sample weight based on PnL for PnL-weighted training.
     * Higher profit trades get more weight (within limits).
     */
    private calculateSampleWeight(pnl: number): number {
        // Base weight of 1.0
        // Scale factor of 10 means $0.10 profit = 2x weight
        const scalingFactor = 10;
        const baseWeight = 1.0;

        // Profitable trades: increase weight
        // Loss trades: slightly decrease weight (but not too much - we want to learn from losses)
        if (pnl >= 0) {
            return baseWeight + (pnl * scalingFactor);
        } else {
            // Losses still contribute but with reduced weight
            return Math.max(0.3, baseWeight + (pnl * scalingFactor * 0.5));
        }
    }

    // -------------------------------------------------------------------------
    // Model Persistence
    // -------------------------------------------------------------------------

    /**
     * Saves all model weights to disk.
     */
    save(): void {
        this.fairValueModel.save();
        this.exitModel.save();
        console.log(`[MLPredictionService:${this.config.strategyName}] Saved models (${this.trainingSamples} training samples)`);
    }

    /**
     * Loads model weights from disk if they exist.
     *
     * @returns true if models were loaded, false if starting fresh
     */
    load(): boolean {
        const fvLoaded = this.fairValueModel.loadIfExists();
        const exitLoaded = this.exitModel.loadIfExists();

        if (fvLoaded || exitLoaded) {
            console.log(`[MLPredictionService:${this.config.strategyName}] Loaded existing models`);
            return true;
        }

        console.log(`[MLPredictionService:${this.config.strategyName}] Starting with fresh models`);
        return false;
    }

    /**
     * Resets all models to random weights.
     * Used for fresh simulation starts where we want isolated training.
     */
    reset(): void {
        this.fairValueModel.reset();
        this.exitModel.reset();
        this.regimeDetector.reset();
        this.trainingSamples = 0;
        console.log(`[MLPredictionService:${this.config.strategyName}] Reset to fresh models`);
    }

    // -------------------------------------------------------------------------
    // Statistics & Debugging
    // -------------------------------------------------------------------------

    /**
     * Gets training statistics for logging/debugging.
     */
    getStats(): {
        trainingSamples: number;
        fairValueSamples: number;
        exitModelSamples: number;
        currentRegime: MarketRegime;
        regimeDurationMs: number;
    } {
        return {
            trainingSamples: this.trainingSamples,
            fairValueSamples: this.fairValueModel.getTrainingSamples(),
            exitModelSamples: this.exitModel.getTrainingSamples(),
            currentRegime: this.regimeDetector.getCurrentRegime(),
            regimeDurationMs: this.regimeDetector.getRegimeDuration(),
        };
    }

    /**
     * Gets performance metrics from FairValueModel.
     */
    getFairValueMetrics() {
        return this.fairValueModel.getPerformanceMetrics();
    }

    /**
     * Gets performance metrics from ExitModel.
     */
    getExitModelMetrics() {
        return this.exitModel.getPerformanceMetrics();
    }

    /**
     * Gets regime statistics.
     */
    getRegimeStats() {
        return this.regimeDetector.getStats();
    }

    /**
     * Gets the underlying FairValueModel (for advanced use cases).
     */
    getFairValueModel(): FairValueModel {
        return this.fairValueModel;
    }

    /**
     * Gets the underlying ExitModel (for advanced use cases).
     */
    getExitModel(): ExitModel {
        return this.exitModel;
    }

    /**
     * Gets the underlying MarketRegimeDetector (for advanced use cases).
     */
    getRegimeDetector(): MarketRegimeDetector {
        return this.regimeDetector;
    }

    /**
     * Gets the strategy name for logging.
     */
    getStrategyName(): string {
        return this.config.strategyName;
    }

    /**
     * Gets the model path for persistence.
     */
    getModelPath(): string {
        return this.config.modelPath;
    }
}
