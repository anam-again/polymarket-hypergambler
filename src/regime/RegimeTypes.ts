// ============================================================================
// RegimeTypes - Type definitions for regime-based trading
// ============================================================================

/**
 * Market regime types based on volatility and trend strength.
 */
export enum RegimeType {
    HIGH_VOL_TRENDING = 'HIGH_VOL_TRENDING',
    HIGH_VOL_RANGING = 'HIGH_VOL_RANGING',
    LOW_VOL_TRENDING = 'LOW_VOL_TRENDING',
    LOW_VOL_RANGING = 'LOW_VOL_RANGING',
}

/**
 * Configuration for regime detection thresholds.
 */
export interface RegimeDetectionConfig {
    /** Threshold for classifying high vs low volatility (default: 0.5) */
    volatilityThreshold: number;
    /** Threshold for classifying trending vs ranging (default: 0.3) */
    trendThreshold: number;
}

/**
 * Per-regime scaling factors for MSPEQs.
 * Maps regime type to MSPEQ name to scaling factor.
 */
export interface PerRegimeScaling {
    [RegimeType.HIGH_VOL_TRENDING]: Record<string, number>;
    [RegimeType.HIGH_VOL_RANGING]: Record<string, number>;
    [RegimeType.LOW_VOL_TRENDING]: Record<string, number>;
    [RegimeType.LOW_VOL_RANGING]: Record<string, number>;
}

/**
 * Statistics for a single regime's performance.
 */
export interface RegimeStats {
    /** The regime type */
    regime: RegimeType;
    /** Number of periods in this regime */
    periodCount: number;
    /** Number of trades in this regime */
    tradeCount: number;
    /** Total PnL from trades in this regime */
    pnl: number;
    /** Sharpe ratio for this regime */
    sharpeRatio: number;
}

/**
 * All regime types as an array for iteration.
 */
export const ALL_REGIME_TYPES: RegimeType[] = [
    RegimeType.HIGH_VOL_TRENDING,
    RegimeType.HIGH_VOL_RANGING,
    RegimeType.LOW_VOL_TRENDING,
    RegimeType.LOW_VOL_RANGING,
];
