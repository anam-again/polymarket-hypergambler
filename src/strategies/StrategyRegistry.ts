/**
 * StrategyRegistry - Centralized Strategy Metadata
 *
 * This file provides a single source of truth for strategy identification,
 * replacing scattered .includes() patterns throughout the codebase.
 *
 * Usage:
 *   import { getBaseType, isRegimeAwareStrategy, isMSPEQStrategy } from '../strategies/index.js';
 *
 *   const baseType = getBaseType('RegimeAwareQuarterlyEarlyBuyerMSPEQ');
 *   // => 'EarlyBuyerMSPEQ'
 */

// ============================================================================
// Strategy Base Types
// ============================================================================

/**
 * The underlying bot implementation types.
 * These correspond to actual bot classes in src/bots/.
 */
export type StrategyBaseType =
    | 'FirstCandleMSPEQ'
    | 'EarlyBuyerMSPEQ'
    | 'MarketMakerMSPEQ'
    | 'NCandleMSPEQ'
    | 'CrossPeriodMomentumMSPEQ'
    | 'Contrarian'
    | 'TrendFollowing'
    | 'FirstCandle'
    | 'FirstCandleV2'
    | 'EveningStar'
    | 'MorningStar'
    | 'MeanReversion'
    | 'NCandle'
    | 'EarlyBuyerV2'
    | 'EsotericNormalization'
    | 'MarketMaker';

// ============================================================================
// Strategy Metadata Interface
// ============================================================================

export interface StrategyMetadata {
    /** Full strategy name (e.g., "RegimeAwareQuarterlyEarlyBuyerMSPEQ") */
    name: string;
    /** Underlying implementation (e.g., "EarlyBuyerMSPEQ") */
    baseType: StrategyBaseType;
    /** Whether this is a quarterly (15-min) strategy */
    isQuarterly: boolean;
    /** Whether this strategy uses regime-aware optimization */
    isRegimeAware: boolean;
    /** Whether this strategy uses Multi-Signal PEQ */
    isMSPEQ: boolean;
    /** Signal names used for MSPEQ optimization */
    signalNames: readonly string[];
    /** Base parameter names (frozen in Stage 2 optimization) */
    baseParamNames?: readonly string[];
}

// ============================================================================
// Standard Signal Sets
// ============================================================================

/** Standard 3-signal set used by most strategies */
const STANDARD_3_SIGNALS = ['candleSize', 'volatility', 'momentum'] as const;

/** Full 4-signal set including timeLeft */
const FULL_4_SIGNALS = ['candleSize', 'timeLeft', 'volatility', 'momentum'] as const;

// ============================================================================
// Base Parameter Names by Strategy Type
// ============================================================================

const FIRSTCANDLE_MSPEQ_BASE_PARAMS = [
    'targetDollars',
    'candleMinutes',
    'breakoutBuffer',
    'pullbackBuffer',
    'cutoffMinute',
    'candleSizeReference',
    'baseBuyPrice',
    'minProfitMargin',
] as const;

const EARLYBUYER_MSPEQ_BASE_PARAMS = [
    'targetDollars',
    'baseBuyPrice',
    'baseSellPrice',
    'baseCutoffMinute',
    'candleSizeReference',
    'minProfitMargin',
    'directionThreshold',
] as const;

const MARKETMAKER_MSPEQ_BASE_PARAMS = [
    'spreadSize',
    'baseSpreadDistance',
    'baseProfitMargin',
    'baseMinPrice',
    'baseMaxPrice',
    'baseStopLossAmount',
    'buyExpirySeconds',
    'totalActiveTrades',
    'maxVolatility',
    'minVolatility',
    'volatilityLookbackPeriods',
    'targetDollars',
    'baseCutoffMinute',
    'candleSizeReference',
] as const;

const NCANDLE_MSPEQ_BASE_PARAMS = [
    'candleMinutes',
    'buyPriceBuffer',
    'sellPriceBuffer',
    'minProfitMargin',
    'stopLossMultiplier',
    'stoplossTimeout',
    'sellTimeout',
    'stoplossFailureTimeout',
    'earlySellScalar',
    'targetDollars',
    'cutoffMinute',
    'maxTradesPerHour',
    'candleSizeReference',
] as const;

const CROSSPERIODMOMENTUM_MSPEQ_BASE_PARAMS = [
    'targetDollars',
    'baseBuyPrice',
    'baseSellPrice',
    'baseCutoffMinute',
    'candleSizeReference',
    'minProfitMargin',
    'directionThreshold',
    'baseMomentumThreshold',
    'baseMinWinStreak',
] as const;

// ============================================================================
// Strategy Registry
// ============================================================================

/**
 * The centralized strategy registry - single source of truth for all strategies.
 */
export const STRATEGY_REGISTRY: Record<string, StrategyMetadata> = {
    // =========================================================================
    // Non-MSPEQ Hourly Strategies
    // =========================================================================
    'Contrarian': {
        name: 'Contrarian',
        baseType: 'Contrarian',
        isQuarterly: false,
        isRegimeAware: false,
        isMSPEQ: false,
        signalNames: [],
    },
    'TrendFollowing': {
        name: 'TrendFollowing',
        baseType: 'TrendFollowing',
        isQuarterly: false,
        isRegimeAware: false,
        isMSPEQ: false,
        signalNames: [],
    },
    'FirstCandle': {
        name: 'FirstCandle',
        baseType: 'FirstCandle',
        isQuarterly: false,
        isRegimeAware: false,
        isMSPEQ: false,
        signalNames: [],
    },
    'FirstCandleV2': {
        name: 'FirstCandleV2',
        baseType: 'FirstCandleV2',
        isQuarterly: false,
        isRegimeAware: false,
        isMSPEQ: false,
        signalNames: [],
    },
    'EveningStar': {
        name: 'EveningStar',
        baseType: 'EveningStar',
        isQuarterly: false,
        isRegimeAware: false,
        isMSPEQ: false,
        signalNames: [],
    },
    'MorningStar': {
        name: 'MorningStar',
        baseType: 'MorningStar',
        isQuarterly: false,
        isRegimeAware: false,
        isMSPEQ: false,
        signalNames: [],
    },
    'MeanReversion': {
        name: 'MeanReversion',
        baseType: 'MeanReversion',
        isQuarterly: false,
        isRegimeAware: false,
        isMSPEQ: false,
        signalNames: [],
    },
    'NCandle': {
        name: 'NCandle',
        baseType: 'NCandle',
        isQuarterly: false,
        isRegimeAware: false,
        isMSPEQ: false,
        signalNames: [],
    },
    'EarlyBuyerV2': {
        name: 'EarlyBuyerV2',
        baseType: 'EarlyBuyerV2',
        isQuarterly: false,
        isRegimeAware: false,
        isMSPEQ: false,
        signalNames: [],
    },
    'EsotericNormalization': {
        name: 'EsotericNormalization',
        baseType: 'EsotericNormalization',
        isQuarterly: false,
        isRegimeAware: false,
        isMSPEQ: false,
        signalNames: [],
    },
    'MarketMaker': {
        name: 'MarketMaker',
        baseType: 'MarketMaker',
        isQuarterly: false,
        isRegimeAware: false,
        isMSPEQ: false,
        signalNames: [],
    },

    // =========================================================================
    // Non-MSPEQ Quarterly Strategies
    // =========================================================================
    'QuarterlyFirstCandle': {
        name: 'QuarterlyFirstCandle',
        baseType: 'FirstCandle',
        isQuarterly: true,
        isRegimeAware: false,
        isMSPEQ: false,
        signalNames: [],
    },
    'QuarterlyMeanReversion': {
        name: 'QuarterlyMeanReversion',
        baseType: 'MeanReversion',
        isQuarterly: true,
        isRegimeAware: false,
        isMSPEQ: false,
        signalNames: [],
    },
    'QuarterlyTrendFollowing': {
        name: 'QuarterlyTrendFollowing',
        baseType: 'TrendFollowing',
        isQuarterly: true,
        isRegimeAware: false,
        isMSPEQ: false,
        signalNames: [],
    },
    'QuarterlyNCandle': {
        name: 'QuarterlyNCandle',
        baseType: 'NCandle',
        isQuarterly: true,
        isRegimeAware: false,
        isMSPEQ: false,
        signalNames: [],
    },
    'QuarterlyEarlyBuyerV2': {
        name: 'QuarterlyEarlyBuyerV2',
        baseType: 'EarlyBuyerV2',
        isQuarterly: true,
        isRegimeAware: false,
        isMSPEQ: false,
        signalNames: [],
    },
    'QuarterlyEsotericNormalization': {
        name: 'QuarterlyEsotericNormalization',
        baseType: 'EsotericNormalization',
        isQuarterly: true,
        isRegimeAware: false,
        isMSPEQ: false,
        signalNames: [],
    },
    'QuarterlyMarketMaker': {
        name: 'QuarterlyMarketMaker',
        baseType: 'MarketMaker',
        isQuarterly: true,
        isRegimeAware: false,
        isMSPEQ: false,
        signalNames: [],
    },

    // =========================================================================
    // MSPEQ Hourly Strategies
    // =========================================================================
    'FirstCandleMSPEQ': {
        name: 'FirstCandleMSPEQ',
        baseType: 'FirstCandleMSPEQ',
        isQuarterly: false,
        isRegimeAware: false,
        isMSPEQ: true,
        signalNames: FULL_4_SIGNALS,
        baseParamNames: FIRSTCANDLE_MSPEQ_BASE_PARAMS,
    },
    'EarlyBuyerMSPEQ': {
        name: 'EarlyBuyerMSPEQ',
        baseType: 'EarlyBuyerMSPEQ',
        isQuarterly: false,
        isRegimeAware: false,
        isMSPEQ: true,
        signalNames: FULL_4_SIGNALS,
        baseParamNames: EARLYBUYER_MSPEQ_BASE_PARAMS,
    },
    'MarketMakerMSPEQ': {
        name: 'MarketMakerMSPEQ',
        baseType: 'MarketMakerMSPEQ',
        isQuarterly: false,
        isRegimeAware: false,
        isMSPEQ: true,
        signalNames: FULL_4_SIGNALS,
        baseParamNames: MARKETMAKER_MSPEQ_BASE_PARAMS,
    },
    'NCandleMSPEQ': {
        name: 'NCandleMSPEQ',
        baseType: 'NCandleMSPEQ',
        isQuarterly: false,
        isRegimeAware: false,
        isMSPEQ: true,
        signalNames: FULL_4_SIGNALS,
        baseParamNames: NCANDLE_MSPEQ_BASE_PARAMS,
    },
    'CrossPeriodMomentumMSPEQ': {
        name: 'CrossPeriodMomentumMSPEQ',
        baseType: 'CrossPeriodMomentumMSPEQ',
        isQuarterly: false,
        isRegimeAware: false,
        isMSPEQ: true,
        signalNames: FULL_4_SIGNALS,
        baseParamNames: CROSSPERIODMOMENTUM_MSPEQ_BASE_PARAMS,
    },

    // =========================================================================
    // MSPEQ Quarterly Strategies
    // =========================================================================
    'QuarterlyFirstCandleMSPEQ': {
        name: 'QuarterlyFirstCandleMSPEQ',
        baseType: 'FirstCandleMSPEQ',
        isQuarterly: true,
        isRegimeAware: false,
        isMSPEQ: true,
        signalNames: FULL_4_SIGNALS,
        baseParamNames: FIRSTCANDLE_MSPEQ_BASE_PARAMS,
    },
    'QuarterlyEarlyBuyerMSPEQ': {
        name: 'QuarterlyEarlyBuyerMSPEQ',
        baseType: 'EarlyBuyerMSPEQ',
        isQuarterly: true,
        isRegimeAware: false,
        isMSPEQ: true,
        signalNames: FULL_4_SIGNALS,
        baseParamNames: EARLYBUYER_MSPEQ_BASE_PARAMS,
    },
    'QuarterlyMarketMakerMSPEQ': {
        name: 'QuarterlyMarketMakerMSPEQ',
        baseType: 'MarketMakerMSPEQ',
        isQuarterly: true,
        isRegimeAware: false,
        isMSPEQ: true,
        signalNames: FULL_4_SIGNALS,
        baseParamNames: MARKETMAKER_MSPEQ_BASE_PARAMS,
    },
    'QuarterlyNCandleMSPEQ': {
        name: 'QuarterlyNCandleMSPEQ',
        baseType: 'NCandleMSPEQ',
        isQuarterly: true,
        isRegimeAware: false,
        isMSPEQ: true,
        signalNames: FULL_4_SIGNALS,
        baseParamNames: NCANDLE_MSPEQ_BASE_PARAMS,
    },
    'QuarterlyCrossPeriodMomentumMSPEQ': {
        name: 'QuarterlyCrossPeriodMomentumMSPEQ',
        baseType: 'CrossPeriodMomentumMSPEQ',
        isQuarterly: true,
        isRegimeAware: false,
        isMSPEQ: true,
        signalNames: FULL_4_SIGNALS,
        baseParamNames: CROSSPERIODMOMENTUM_MSPEQ_BASE_PARAMS,
    },

    // =========================================================================
    // Regime-Aware MSPEQ Strategies (Hourly)
    // =========================================================================
    'RegimeAwareFirstCandleMSPEQ': {
        name: 'RegimeAwareFirstCandleMSPEQ',
        baseType: 'FirstCandleMSPEQ',
        isQuarterly: false,
        isRegimeAware: true,
        isMSPEQ: true,
        signalNames: FULL_4_SIGNALS,
        baseParamNames: FIRSTCANDLE_MSPEQ_BASE_PARAMS,
    },
    'RegimeAwareEarlyBuyerMSPEQ': {
        name: 'RegimeAwareEarlyBuyerMSPEQ',
        baseType: 'EarlyBuyerMSPEQ',
        isQuarterly: false,
        isRegimeAware: true,
        isMSPEQ: true,
        signalNames: FULL_4_SIGNALS,
        baseParamNames: EARLYBUYER_MSPEQ_BASE_PARAMS,
    },
    'RegimeAwareMarketMakerMSPEQ': {
        name: 'RegimeAwareMarketMakerMSPEQ',
        baseType: 'MarketMakerMSPEQ',
        isQuarterly: false,
        isRegimeAware: true,
        isMSPEQ: true,
        signalNames: FULL_4_SIGNALS,
        baseParamNames: MARKETMAKER_MSPEQ_BASE_PARAMS,
    },
    'RegimeAwareNCandleMSPEQ': {
        name: 'RegimeAwareNCandleMSPEQ',
        baseType: 'NCandleMSPEQ',
        isQuarterly: false,
        isRegimeAware: true,
        isMSPEQ: true,
        signalNames: FULL_4_SIGNALS,
        baseParamNames: NCANDLE_MSPEQ_BASE_PARAMS,
    },
    'RegimeAwareCrossPeriodMomentumMSPEQ': {
        name: 'RegimeAwareCrossPeriodMomentumMSPEQ',
        baseType: 'CrossPeriodMomentumMSPEQ',
        isQuarterly: false,
        isRegimeAware: true,
        isMSPEQ: true,
        signalNames: FULL_4_SIGNALS,
        baseParamNames: CROSSPERIODMOMENTUM_MSPEQ_BASE_PARAMS,
    },

    // =========================================================================
    // Regime-Aware MSPEQ Strategies (Quarterly)
    // =========================================================================
    'RegimeAwareQuarterlyFirstCandleMSPEQ': {
        name: 'RegimeAwareQuarterlyFirstCandleMSPEQ',
        baseType: 'FirstCandleMSPEQ',
        isQuarterly: true,
        isRegimeAware: true,
        isMSPEQ: true,
        signalNames: FULL_4_SIGNALS,
        baseParamNames: FIRSTCANDLE_MSPEQ_BASE_PARAMS,
    },
    'RegimeAwareQuarterlyEarlyBuyerMSPEQ': {
        name: 'RegimeAwareQuarterlyEarlyBuyerMSPEQ',
        baseType: 'EarlyBuyerMSPEQ',
        isQuarterly: true,
        isRegimeAware: true,
        isMSPEQ: true,
        signalNames: FULL_4_SIGNALS,
        baseParamNames: EARLYBUYER_MSPEQ_BASE_PARAMS,
    },
    'RegimeAwareQuarterlyMarketMakerMSPEQ': {
        name: 'RegimeAwareQuarterlyMarketMakerMSPEQ',
        baseType: 'MarketMakerMSPEQ',
        isQuarterly: true,
        isRegimeAware: true,
        isMSPEQ: true,
        signalNames: FULL_4_SIGNALS,
        baseParamNames: MARKETMAKER_MSPEQ_BASE_PARAMS,
    },
    'RegimeAwareQuarterlyNCandleMSPEQ': {
        name: 'RegimeAwareQuarterlyNCandleMSPEQ',
        baseType: 'NCandleMSPEQ',
        isQuarterly: true,
        isRegimeAware: true,
        isMSPEQ: true,
        signalNames: FULL_4_SIGNALS,
        baseParamNames: NCANDLE_MSPEQ_BASE_PARAMS,
    },
    'RegimeAwareQuarterlyCrossPeriodMomentumMSPEQ': {
        name: 'RegimeAwareQuarterlyCrossPeriodMomentumMSPEQ',
        baseType: 'CrossPeriodMomentumMSPEQ',
        isQuarterly: true,
        isRegimeAware: true,
        isMSPEQ: true,
        signalNames: FULL_4_SIGNALS,
        baseParamNames: CROSSPERIODMOMENTUM_MSPEQ_BASE_PARAMS,
    },
};

// ============================================================================
// Lookup Utilities
// ============================================================================

/**
 * Gets the full metadata for a strategy.
 * Returns undefined if the strategy is not in the registry.
 */
export function getStrategyMetadata(strategyName: string): StrategyMetadata | undefined {
    return STRATEGY_REGISTRY[strategyName];
}

/**
 * Gets the base type (underlying bot implementation) for a strategy.
 * Returns undefined if the strategy is not in the registry.
 */
export function getBaseType(strategyName: string): StrategyBaseType | undefined {
    return STRATEGY_REGISTRY[strategyName]?.baseType;
}

/**
 * Checks if a strategy uses a specific base type.
 */
export function isStrategyOfBaseType(strategyName: string, baseType: StrategyBaseType): boolean {
    return STRATEGY_REGISTRY[strategyName]?.baseType === baseType;
}

/**
 * Checks if a strategy uses Multi-Signal PEQ.
 */
export function isMSPEQStrategy(strategyName: string): boolean {
    return STRATEGY_REGISTRY[strategyName]?.isMSPEQ ?? false;
}

/**
 * Checks if a strategy is regime-aware.
 */
export function isRegimeAwareStrategy(strategyName: string): boolean {
    return STRATEGY_REGISTRY[strategyName]?.isRegimeAware ?? false;
}

/**
 * Checks if a strategy is for quarterly (15-min) markets.
 */
export function isQuarterlyStrategy(strategyName: string): boolean {
    return STRATEGY_REGISTRY[strategyName]?.isQuarterly ?? false;
}

/**
 * Gets the signal names used by a strategy.
 * Returns a default set if the strategy is not in the registry.
 */
export function getSignalNames(strategyName: string): readonly string[] {
    return STRATEGY_REGISTRY[strategyName]?.signalNames ?? STANDARD_3_SIGNALS;
}

/**
 * Gets the base parameter names for a strategy (used in Stage 2 optimization).
 * Returns undefined if the strategy doesn't have base params defined.
 */
export function getBaseParamNames(strategyName: string): readonly string[] | undefined {
    return STRATEGY_REGISTRY[strategyName]?.baseParamNames;
}

/**
 * Gets all registered strategy names.
 */
export function getAllStrategyNames(): string[] {
    return Object.keys(STRATEGY_REGISTRY);
}

/**
 * Gets all strategies matching a predicate.
 */
export function getStrategiesWhere(predicate: (meta: StrategyMetadata) => boolean): StrategyMetadata[] {
    return Object.values(STRATEGY_REGISTRY).filter(predicate);
}

/**
 * Gets all MSPEQ strategy names.
 */
export function getAllMSPEQStrategyNames(): string[] {
    return Object.keys(STRATEGY_REGISTRY).filter(name => STRATEGY_REGISTRY[name].isMSPEQ);
}

/**
 * Gets all regime-aware strategy names.
 */
export function getAllRegimeAwareStrategyNames(): string[] {
    return Object.keys(STRATEGY_REGISTRY).filter(name => STRATEGY_REGISTRY[name].isRegimeAware);
}
