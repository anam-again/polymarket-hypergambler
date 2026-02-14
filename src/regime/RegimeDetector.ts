// ============================================================================
// RegimeDetector - Detects market regime from signals
// ============================================================================

import { SignalSnapshot } from '../signals/SignalProvider.js';
import { RegimeType, RegimeDetectionConfig } from './RegimeTypes.js';

/**
 * RegimeDetector - Classifies market conditions into one of four regimes.
 *
 * Uses volatility and trendStrength signals to classify:
 * - HIGH_VOL_TRENDING: High volatility + strong trend
 * - HIGH_VOL_RANGING: High volatility + no trend
 * - LOW_VOL_TRENDING: Low volatility + strong trend
 * - LOW_VOL_RANGING: Low volatility + no trend
 */
export class RegimeDetector {
    private config: RegimeDetectionConfig;

    constructor(config: RegimeDetectionConfig) {
        this.config = config;
    }

    /**
     * Detects the current market regime from signals.
     *
     * @param signals - Either a SignalSnapshot or a plain record of signal values
     * @returns The detected RegimeType
     */
    detect(signals: SignalSnapshot | Record<string, number>): RegimeType {
        const volatility = signals.volatility ?? 0.5;
        const trendStrength = Math.abs(signals.trendStrength ?? 0);

        const isHighVol = volatility > this.config.volatilityThreshold;
        const isTrending = trendStrength > this.config.trendThreshold;

        if (isHighVol && isTrending) return RegimeType.HIGH_VOL_TRENDING;
        if (isHighVol && !isTrending) return RegimeType.HIGH_VOL_RANGING;
        if (!isHighVol && isTrending) return RegimeType.LOW_VOL_TRENDING;
        return RegimeType.LOW_VOL_RANGING;
    }

    /**
     * Gets the current configuration.
     */
    getConfig(): RegimeDetectionConfig {
        return { ...this.config };
    }

    /**
     * Creates a RegimeDetector from flat optimization parameters.
     *
     * @param params - Flat parameter record from optimizer
     * @returns New RegimeDetector instance
     */
    static fromParams(params: Record<string, number>): RegimeDetector {
        return new RegimeDetector({
            volatilityThreshold: params.regimeVolThreshold ?? 0.5,
            trendThreshold: params.regimeTrendThreshold ?? 0.3,
        });
    }

    /**
     * Returns parameter bounds for genetic optimization.
     */
    static getBounds(): Record<string, { min: number; max: number }> {
        return {
            regimeVolThreshold: { min: 0.2, max: 0.8 },
            regimeTrendThreshold: { min: 0.1, max: 0.6 },
        };
    }
}
