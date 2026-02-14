// ============================================================================
// TradeGate - Per-regime trade gating with MSPEQ confidence scoring
// ============================================================================

import { MultiSignalPEQ, MultiSignalPEQConfig } from '../utils/MultiSignalPEQ.js';
import { RegimeType, ALL_REGIME_TYPES } from './RegimeTypes.js';

/**
 * Configuration for TradeGate.
 */
export interface TradeGateConfig {
    /** MSPEQ configuration for computing confidence score */
    mspeq: MultiSignalPEQConfig;
    /** Per-regime thresholds for trade gating */
    regimeThresholds: Record<RegimeType, number>;
}

/**
 * Result of trade gate evaluation.
 */
export interface TradeGateResult {
    /** Whether trading should proceed */
    shouldTrade: boolean;
    /** Confidence score from MSPEQ (0-1) */
    confidence: number;
}

/**
 * TradeGate - Determines whether to trade based on market conditions.
 *
 * Uses an MSPEQ to compute a confidence score, then compares against
 * per-regime thresholds to decide if trading should proceed.
 *
 * Higher thresholds = more selective (fewer trades)
 * Lower thresholds = less selective (more trades)
 */
export class TradeGate {
    private mspeq: MultiSignalPEQ;
    private thresholds: Record<RegimeType, number>;

    constructor(config: TradeGateConfig) {
        this.mspeq = new MultiSignalPEQ(config.mspeq);
        this.thresholds = config.regimeThresholds;
    }

    /**
     * Evaluates whether trading should proceed given current signals and regime.
     *
     * @param signals - Current signal values
     * @param regime - Current market regime
     * @returns Trade gate result with shouldTrade flag and confidence score
     */
    evaluate(signals: Record<string, number>, regime: RegimeType): TradeGateResult {
        const rawConfidence = this.mspeq.compute(signals);
        // Clamp confidence to [0, 1]
        const confidence = Math.max(0, Math.min(1, rawConfidence));

        return {
            shouldTrade: confidence >= this.thresholds[regime],
            confidence,
        };
    }

    /**
     * Gets the threshold for a specific regime.
     */
    getThreshold(regime: RegimeType): number {
        return this.thresholds[regime];
    }

    /**
     * Creates a TradeGate from flat optimization parameters.
     *
     * @param params - Flat parameter record from optimizer
     * @param signalNames - Array of signal names to use
     * @returns New TradeGate instance
     */
    static fromParams(params: Record<string, number>, signalNames: string[]): TradeGate {
        const mspeq = MultiSignalPEQ.fromFlatParams('tradeGate', params, signalNames);

        const regimeThresholds: Record<RegimeType, number> = {
            [RegimeType.HIGH_VOL_TRENDING]: params.tradeGate_HIGH_VOL_TRENDING_threshold ?? 0.5,
            [RegimeType.HIGH_VOL_RANGING]: params.tradeGate_HIGH_VOL_RANGING_threshold ?? 0.5,
            [RegimeType.LOW_VOL_TRENDING]: params.tradeGate_LOW_VOL_TRENDING_threshold ?? 0.5,
            [RegimeType.LOW_VOL_RANGING]: params.tradeGate_LOW_VOL_RANGING_threshold ?? 0.5,
        };

        return new TradeGate({
            mspeq: mspeq.getConfig(),
            regimeThresholds,
        });
    }

    /**
     * Returns parameter bounds for genetic optimization.
     *
     * @param signalNames - Array of signal names to generate bounds for
     */
    static getBounds(signalNames: string[]): Record<string, { min: number; max: number }> {
        const bounds: Record<string, { min: number; max: number }> = {};

        // MSPEQ bounds for trade gate (weight, c0, c1 per signal)
        for (const name of signalNames) {
            bounds[`tradeGate_${name}_w`] = { min: 0, max: 1 };
            bounds[`tradeGate_${name}_c0`] = { min: 0, max: 1 };
            bounds[`tradeGate_${name}_c1`] = { min: -0.5, max: 0.5 };
        }

        // Per-regime thresholds
        for (const regime of ALL_REGIME_TYPES) {
            bounds[`tradeGate_${regime}_threshold`] = { min: 0.1, max: 0.9 };
        }

        return bounds;
    }
}
