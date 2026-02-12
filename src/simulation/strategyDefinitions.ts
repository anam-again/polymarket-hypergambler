/**
 * Strategy Definitions for Genetic Optimization
 *
 * This file contains:
 * - Parameter bounds for each strategy
 * - Factory functions to create simulated bots
 * - The geneticStrategies array that ties them together
 */

import { BotParams, SimulatedBot } from './HistoricalSimulator.js';
import { BtcDirection } from '../types/interfaces.js';
import { createMockClobClient, QuantBotSimulationAdapter } from './QuantBotSimulationAdapter.js';
import type { ParameterBounds } from './GeneticOptimizer.js';

// Import bot classes
import { ContrarianV2 } from '../bots/ContrarianV2.js';
import { TrendFollowing } from '../bots/TrendFollowing.js';
import { FirstCandle } from '../bots/FirstCandle.js';
import { FirstCandleV2 } from '../bots/FirstCandleV2.js';
import { EveningStar } from '../bots/EveningStar.js';
import { MorningStar } from '../bots/MorningStar.js';
import { MeanReversion } from '../bots/MeanReversion.js';
import { NCandle } from '../bots/NCandle.js';
import { EarlyBuyerV2 } from '../bots/EarlyBuyerV2.js';
import { EsotericNormalization } from '../bots/EsotericNormalization.js';
import { MarketMaker } from '../bots/MarketMaker.js';
import { FirstCandleMSPEQ } from '../bots/FirstCandleMSPEQ.js';
import { EarlyBuyerMSPEQ } from '../bots/EarlyBuyerMSPEQ.js';
import { MarketMakerMSPEQ } from '../bots/MarketMakerMSPEQ.js';
import { NCandleMSPEQ } from '../bots/NCandleMSPEQ.js';
import { CrossPeriodMomentumMSPEQ } from '../bots/CrossPeriodMomentumMSPEQ.js';
import { ScalingPEQ } from '../utils/ScalingPEQ.js';
import { generateMSPEQBounds, STANDARD_NORMALIZATIONS } from '../utils/MultiSignalPEQ.js';

// ============================================================================
// Constants
// ============================================================================

const SIM_LOG_DIR = './logs/simulator/bots';

// Signal names for MSPEQ: candleSize, volatility, momentum (3 signals per MSPEQ)
const MSPEQ_SIGNAL_NAMES = [
    'candleSize',
    'timeLeft',
    'volatility',
    'momentum',
    // 'priceImbalance',
    // 'rangePosition',
    // 'trendStrength',
    // 'volatilityTrend',
    // 'hourOfDay',
] as const;

// ============================================================================
// Base Parameter Names (frozen in Stage 2 optimization)
// ============================================================================

/** Base parameter names that get frozen in Stage 2 for FirstCandleMSPEQ */
export const MSPEQ_BASE_PARAM_NAMES = [
    'targetDollars',
    'candleMinutes',
    'breakoutBuffer',
    'pullbackBuffer',
    'cutoffMinute',
    'candleSizeReference',
    'baseBuyPrice',
    'minProfitMargin',
] as const;

/** Base parameter names that get frozen in Stage 2 for EarlyBuyerMSPEQ */
export const EARLYBUYER_MSPEQ_BASE_PARAM_NAMES = [
    'targetDollars',
    'baseBuyPrice',
    'baseSellPrice',
    'baseCutoffMinute',
    'candleSizeReference',
    'minProfitMargin',
    'directionThreshold',
] as const;

/** Base parameter names that get frozen in Stage 2 for MarketMakerMSPEQ */
export const MARKETMAKER_MSPEQ_BASE_PARAM_NAMES = [
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

/** Base parameter names that get frozen in Stage 2 for NCandleMSPEQ */
export const NCANDLE_MSPEQ_BASE_PARAM_NAMES = [
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

/** Base parameter names that get frozen in Stage 2 for CrossPeriodMomentumMSPEQ */
export const CROSSPERIODMOMENTUM_MSPEQ_BASE_PARAM_NAMES = [
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
// Parameter Bounds for Genetic Optimization
// ============================================================================

const contrarianBounds: ParameterBounds = {
    targetDollars: { min: 5, max: 20, step: 1 },
    targetBuyPrice: { min: 0.02, max: 0.98 },
    targetSellPrice: { min: 0.02, max: 0.98 },
    lookbackHours: { min: 1, max: 12, step: 1 },
    cutoffMinute: { min: 15, max: 45, step: 5 },
};

const trendFollowingBounds: ParameterBounds = {
    targetDollars: { min: 5, max: 20, step: 1 },
    shortMaPeriod: { min: 1, max: 20, step: 1 },
    longMaPeriod: { min: 4, max: 60, step: 1 },
    adxPeriod: { min: 2, max: 50, step: 1 },
    adxThreshold: { min: 7, max: 80 },
    atrPeriod: { min: 5, max: 30, step: 1 },
    atrStopMultiple: { min: 1.0, max: 4.0 },
    targetBuyPrice: { min: 0.02, max: 0.98 },
    targetSellPrice: { min: 0.02, max: 0.98 },
    cutoffMinute: { min: 10, max: 50, step: 5 },
};

const firstCandleBounds: ParameterBounds = {
    targetDollars: { min: 5, max: 20, step: 1 },
    candleMinutes: { min: 5, max: 30, step: 2 },
    breakoutBuffer: { min: 0, max: 1000 },
    pullbackBuffer: { min: 0, max: 1000 },
    targetBuyPrice: { min: 0.02, max: 0.98 },
    targetSellPrice: { min: 0.02, max: 0.98 },
    cutoffMinute: { min: 5, max: 55, step: 5 },
};

const firstCandleV2Bounds: ParameterBounds = {
    targetDollars: { min: 5, max: 20, step: 1 },
    candleMinutes: { min: 5, max: 30, step: 2 },
    breakoutBuffer: { min: 10, max: 300 },
    pullbackBuffer: { min: 0, max: 1000 },
    buyPriceBuffer: { min: 0.01, max: 0.90 },
    sellPriceBuffer: { min: 0.01, max: 0.90 },
    minProfitMargin: { min: 0.01, max: 0.90 },
    maxSellPrice: { min: 0.30, max: 0.98 },
    cutoffMinute: { min: 5, max: 55, step: 5 },
};

const eveningStarBounds: ParameterBounds = {
    targetDollars: { min: 5, max: 20, step: 1 },
    candleMinutes: { min: 3, max: 20, step: 1 },
    minBullishMove: { min: 20, max: 150 },
    maxIndecisionRange: { min: 10, max: 75 },
    minBearishMove: { min: 20, max: 150 },
    targetBuyPrice: { min: 0.02, max: 0.9 },
    targetSellPrice: { min: 0.1, max: 0.98 },
    cutoffMinute: { min: 30, max: 55, step: 5 },
};

const morningStarBounds: ParameterBounds = {
    targetDollars: { min: 5, max: 20, step: 1 },
    candleMinutes: { min: 3, max: 20, step: 1 },
    minBearishMove: { min: 20, max: 150 },
    maxIndecisionRange: { min: 10, max: 75 },
    minBullishMove: { min: 20, max: 150 },
    targetBuyPrice: { min: 0.02, max: 0.98 },
    targetSellPrice: { min: 0.02, max: 0.98 },
    cutoffMinute: { min: 30, max: 55, step: 5 },
};

const meanReversionBounds: ParameterBounds = {
    targetDollars: { min: 5, max: 20, step: 1 },
    lookbackPeriods: { min: 5, max: 50, step: 1 },
    entryThreshold: { min: 1.0, max: 4.0 },
    targetBuyPrice: { min: 0.02, max: 0.95 },
    targetSellPrice: { min: 0.05, max: 0.98 },
    cutoffMinute: { min: 30, max: 55, step: 5 },
};

const nCandleBounds: ParameterBounds = {
    targetDollars: { min: 5, max: 20, step: 5 },
    candleMinutes: { min: 3, max: 20, step: 1 },
    buyPriceBuffer: { min: 0.01, max: 0.10, step: .01 },
    buyPriceBufferPEQ_c0: { min: 0, max: 2.0 },
    buyPriceBufferPEQ_c1: { min: -2, max: 2.0 },
    sellPriceBuffer: { min: 0.01, max: 0.10, step: .01 },
    minProfitMargin: { min: 0.01, max: 1, step: .01 },
    minProfitMarginPEQ_c0: { min: 0, max: 2.0 },
    minProfitMarginPEQ_c1: { min: -2, max: 2.0 },
    stopLossMultiplier: { min: 0, max: 5 },
    stoplossTimeout: { min: 10, max: 3600, step: 5 },
    stoplossTimeoutPEQ_c0: { min: 0, max: 2.0 },
    stoplossTimeoutPEQ_c1: { min: -2, max: 2.0 },
    sellTimeout: { min: 30, max: 3600, step: 30 },
    sellTimeoutPEQ_c0: { min: 0, max: 2.0 },
    sellTimeoutPEQ_c1: { min: -2, max: 2.0 },
    stoplossFailureTimeout: { min: 5, max: 3600, step: 5 },
    stoplossFailureTimeoutPEQ_c0: { min: 0, max: 2.0 },
    stoplossFailureTimeoutPEQ_c1: { min: -2, max: 2.0 },
    earlySellScalar: { min: -1, max: 1.0 },
    cutoffMinute: { min: 10, max: 55, step: 5 },
    maxTradesPerHour: { min: 1, max: 20, step: 1 },
};

const earlyBuyerV2Bounds: ParameterBounds = {
    targetBuyPrice: { min: 0.02, max: 0.90 },
    targetSellPrice: { min: 0.1, max: 0.98 },
    targetDollars: { min: 5, max: 25, step: 1 },
    cutoffMinute: { min: 15, max: 45, step: 1 },
    minFlops: { min: 1, max: 6 },
    flopsLookbackHours: { min: 2, max: 12, step: 1 },
    btcDirection: { min: 0, max: 1, step: 1 },
};

const esotericNormalizationBounds: ParameterBounds = {
    baseStdDev: { min: 0, max: 300 },
    minStdDevRatio: { min: 0.1, max: 0.5 },
    timeDecayPower: { min: 0.5, max: 3.0 },
    priceScaleMultiplier: { min: 0.5, max: 2.0 },
    priceScaleConstant: { min: -50, max: 50 },
    purchaseThreshold: { min: 0.04, max: 0.15 },
    sellPremium: { min: 0.02, max: 0.10 },
    targetDollars: { min: 5, max: 25, step: 1 },
    cutoffMinute: { min: 30, max: 50, step: 1 },
    maxTradesPerPeriod: { min: 1, max: 3, step: 1 },
};

const marketMakerBounds: ParameterBounds = {
    spreadSize: { min: 1, max: 10, step: 1 },
    minSpreadDistance: { min: 0, max: 0.10, step: 0.01 },
    profitMargin: { min: 0.01, max: 0.50 },
    minPrice: { min: 0.02, max: 0.90 },
    maxPrice: { min: 0.1, max: 0.98 },
    stopLossAmount: { min: 0.01, max: 1.0 },
    buyExpirySeconds: { min: 10, max: 3600, step: 10 },
    totalActiveTrades: { min: 1, max: 15, step: 1 },
    maxVolatility: { min: 0.5, max: 100 },
    minVolatility: { min: 0, max: 100 },
    volatilityLookbackPeriods: { min: 1, max: 100, step: 1 },
    targetDollars: { min: 5, max: 20, step: 5 },
    cutoffMinute: { min: 5, max: 55, step: 5 },
    sellTimeout: { min: 10, max: 3600, step: 5 },
    sellTimeoutPEQ_c0: { min: 0, max: 2.0 },
    sellTimeoutPEQ_c1: { min: -2, max: 2.0 },
    stoplossCheckTimeout: { min: 0, max: 3600, step: 5 },
    stoplossCheckTimeoutPEQ_c0: { min: 0, max: 2.0 },
    stoplossCheckTimeoutPEQ_c1: { min: -2, max: 2.0 },
    stoplossFailureTimeout: { min: 5, max: 3600, step: 5 },
    stoplossFailureTimeoutPEQ_c0: { min: 0, max: 2.0 },
    stoplossFailureTimeoutPEQ_c1: { min: -2, max: 2.0 },
};

// ============================================================================
// Quarterly Market Bounds (15-minute periods)
// ============================================================================

const quarterlyFirstCandleBounds: ParameterBounds = {
    targetDollars: { min: 5, max: 20, step: 1 },
    candleMinutes: { min: 1, max: 7, step: 1 },
    breakoutBuffer: { min: 0, max: 500 },
    pullbackBuffer: { min: 0, max: 500 },
    targetBuyPrice: { min: 0.02, max: 0.95 },
    targetSellPrice: { min: 0.05, max: 0.98 },
    cutoffMinute: { min: 5, max: 14, step: 1 },
};

const quarterlyMeanReversionBounds: ParameterBounds = {
    targetDollars: { min: 5, max: 20, step: 1 },
    lookbackPeriods: { min: 3, max: 25, step: 1 },
    entryThreshold: { min: 0.5, max: 3.0 },
    targetBuyPrice: { min: 0.02, max: 0.95 },
    targetSellPrice: { min: 0.05, max: 0.98 },
    cutoffMinute: { min: 5, max: 13, step: 1 },
};

const quarterlyTrendFollowingBounds: ParameterBounds = {
    targetDollars: { min: 5, max: 20, step: 1 },
    shortMaPeriod: { min: 1, max: 8, step: 1 },
    longMaPeriod: { min: 1, max: 20, step: 1 },
    adxPeriod: { min: 1, max: 15, step: 1 },
    adxThreshold: { min: 1, max: 50 },
    atrPeriod: { min: 1, max: 15, step: 1 },
    atrStopMultiple: { min: 1.0, max: 4.0 },
    targetBuyPrice: { min: 0.02, max: 0.95 },
    targetSellPrice: { min: 0.05, max: 0.98 },
    cutoffMinute: { min: 5, max: 13, step: 1 },
};

const quarterlyNCandleBounds: ParameterBounds = {
    targetDollars: { min: 5, max: 20, step: 5 },
    candleMinutes: { min: 1, max: 4, step: 1 },
    buyPriceBuffer: { min: 0.01, max: 0.05, step: .01 },
    buyPriceBufferPEQ_c0: { min: 0, max: 2.0 },
    buyPriceBufferPEQ_c1: { min: -2, max: 2.0 },
    sellPriceBuffer: { min: 0.01, max: 0.20, step: .01 },
    minProfitMargin: { min: 0.01, max: 0.50, step: .01 },
    minProfitMarginPEQ_c0: { min: 0, max: 2.0 },
    minProfitMarginPEQ_c1: { min: -2, max: 2.0 },
    stopLossMultiplier: { min: 0, max: 2.0 },
    stoplossTimeout: { min: 5, max: 900, step: 5 },
    stoplossTimeoutPEQ_c0: { min: 0, max: 2.0 },
    stoplossTimeoutPEQ_c1: { min: -2, max: 2.0 },
    sellTimeout: { min: 30, max: 900, step: 15 },
    sellTimeoutPEQ_c0: { min: 0, max: 2.0 },
    sellTimeoutPEQ_c1: { min: -2, max: 2.0 },
    stoplossFailureTimeout: { min: 5, max: 900, step: 5 },
    stoplossFailureTimeoutPEQ_c0: { min: 0, max: 2.0 },
    stoplossFailureTimeoutPEQ_c1: { min: -2, max: 2.0 },
    earlySellScalar: { min: -1, max: 1.0 },
    cutoffMinute: { min: 2, max: 14, step: 1 },
    maxTradesPerPeriod: { min: 1, max: 10, step: 1 },
};

const quarterlyEarlyBuyerV2Bounds: ParameterBounds = {
    targetBuyPrice: { min: 0.02, max: 0.95 },
    targetSellPrice: { min: 0.05, max: 0.98 },
    targetDollars: { min: 5, max: 25, step: 1 },
    cutoffMinute: { min: 4, max: 12, step: 1 },
    minFlops: { min: 1, max: 10 },
    flopsLookbackHours: { min: 2, max: 12, step: 1 },
    btcDirection: { min: 0, max: 1, step: 1 },
};

const quarterlyEsotericNormalizationBounds: ParameterBounds = {
    baseStdDev: { min: 0, max: 150 },
    minStdDevRatio: { min: 0.1, max: 0.5 },
    timeDecayPower: { min: 0.5, max: 3.0 },
    priceScaleMultiplier: { min: 0.5, max: 2.0 },
    priceScaleConstant: { min: -25, max: 25 },
    purchaseThreshold: { min: 0.04, max: 0.15 },
    sellPremium: { min: 0.02, max: 0.10 },
    targetDollars: { min: 5, max: 25, step: 1 },
    cutoffMinute: { min: 5, max: 12, step: 1 },
    maxTradesPerPeriod: { min: 1, max: 2, step: 1 },
};

const quarterlyMarketMakerBounds: ParameterBounds = {
    spreadSize: { min: 2, max: 10, step: 1 },
    minSpreadDistance: { min: 0, max: 0.10, step: 0.01 },
    profitMargin: { min: 0.02, max: 0.50 },
    minPrice: { min: 0.02, max: 0.90 },
    maxPrice: { min: 0.1, max: 0.98 },
    stopLossAmount: { min: 0.01, max: 0.30 },
    buyExpirySeconds: { min: 15, max: 120, step: 5 },
    totalActiveTrades: { min: 2, max: 10, step: 1 },
    maxVolatility: { min: 0.1, max: 5.0 },
    minVolatility: { min: 0, max: 1.0 },
    volatilityLookbackPeriods: { min: 1, max: 30, step: 1 },
    targetDollars: { min: 5, max: 15, step: 1 },
    cutoffMinute: { min: 2, max: 14, step: 1 },
    sellTimeout: { min: 5, max: 60, step: 5 },
    sellTimeoutPEQ_c0: { min: 0, max: 2.0 },
    sellTimeoutPEQ_c1: { min: -2, max: 2.0 },
    stoplossCheckTimeout: { min: 3, max: 30, step: 2 },
    stoplossCheckTimeoutPEQ_c0: { min: 0, max: 2.0 },
    stoplossCheckTimeoutPEQ_c1: { min: -2, max: 2.0 },
    stoplossFailureTimeout: { min: 3, max: 30, step: 2 },
    stoplossFailureTimeoutPEQ_c0: { min: 0, max: 2.0 },
    stoplossFailureTimeoutPEQ_c1: { min: -2, max: 2.0 },
};

// ============================================================================
// Multi-Signal PEQ Bounds
// ============================================================================

const firstCandleMSPEQBounds: ParameterBounds = {
    targetDollars: { min: 5, max: 20, step: 1 },
    candleMinutes: { min: 2, max: 20, step: 2 },
    breakoutBuffer: { min: 0, max: 300 },
    pullbackBuffer: { min: 0, max: 500 },
    cutoffMinute: { min: 5, max: 55, step: 5 },
    candleSizeReference: { min: 0, max: 1000},
    baseBuyPrice: { min: 0.10, max: 0.90, step: 0.01 },
    minProfitMargin: { min: 0.01, max: 0.50, step: 0.01 },
    ...generateMSPEQBounds('buyPrice', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.5, c0Max: 1.5 }),
    ...generateMSPEQBounds('sellPrice', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
    ...generateMSPEQBounds('earlySellTime', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 1 }, { min: -0.5, max: 0.5, c0Min: 0.1, c0Max: 0.4 }),
    ...generateMSPEQBounds('earlySellPrice', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
    ...generateMSPEQBounds('breakoutBuffer', [...MSPEQ_SIGNAL_NAMES], { min: 0.5, max: 2 }, { min: -0.5, max: 0.5, c0Min: 0.8, c0Max: 1.2 }),
    ...generateMSPEQBounds('pullbackBuffer', [...MSPEQ_SIGNAL_NAMES], { min: 0.5, max: 2 }, { min: -0.5, max: 0.5, c0Min: 0.8, c0Max: 1.2 }),
};

const quarterlyFirstCandleMSPEQBounds: ParameterBounds = {
    targetDollars: { min: 5, max: 20, step: 1 },
    candleMinutes: { min: 1, max: 7, step: 1 },
    breakoutBuffer: { min: 0, max: 200 },
    pullbackBuffer: { min: 0, max: 300 },
    cutoffMinute: { min: 5, max: 14, step: 1 },
    candleSizeReference: { min: 0, max: 2000, step: 100 },
    baseBuyPrice: { min: 0.30, max: 0.70, step: 0.02 },
    minProfitMargin: { min: 0.01, max: 0.50, step: 0.01 },
    ...generateMSPEQBounds('buyPrice', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.5, c0Max: 1.5 }),
    ...generateMSPEQBounds('sellPrice', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
    ...generateMSPEQBounds('earlySellTime', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 1 }, { min: -0.5, max: 0.5, c0Min: 0.1, c0Max: 0.4 }),
    ...generateMSPEQBounds('earlySellPrice', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
    ...generateMSPEQBounds('breakoutBuffer', [...MSPEQ_SIGNAL_NAMES], { min: 0.5, max: 2 }, { min: -0.5, max: 0.5, c0Min: 0.8, c0Max: 1.2 }),
    ...generateMSPEQBounds('pullbackBuffer', [...MSPEQ_SIGNAL_NAMES], { min: 0.5, max: 2 }, { min: -0.5, max: 0.5, c0Min: 0.8, c0Max: 1.2 }),
};


// EarlyBuyerMSPEQ Full Bounds (base params + MSPEQ coefficients)
const earlyBuyerMSPEQBounds: ParameterBounds = {
    // Base parameters
    targetDollars: { min: 5, max: 20, step: 1 },
    baseBuyPrice: { min: 0.10, max: 0.70, step: 0.02 },
    baseSellPrice: { min: 0.40, max: 0.95, step: 0.02 },
    baseCutoffMinute: { min: 5, max: 50, step: 5 },
    candleSizeReference: { min: 0, max: 500, step: 50 },
    minProfitMargin: { min: 0.01, max: 0.50, step: 0.01 },
    directionThreshold: { min: 0.3, max: 0.7, step: 0.02 },
    // MSPEQ coefficients
    ...generateMSPEQBounds('buyPrice', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.5, c0Max: 1.5 }),
    ...generateMSPEQBounds('sellPrice', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
    ...generateMSPEQBounds('cutoffMinute', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
    ...generateMSPEQBounds('btcDirection', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 1 }, { min: -0.5, max: 0.5, c0Min: 0.4, c0Max: 0.6 }),
    ...generateMSPEQBounds('earlySellTime', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 1 }, { min: -0.5, max: 0.5, c0Min: 0.1, c0Max: 0.4 }),
    ...generateMSPEQBounds('earlySellPrice', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
};

const quarterlyEarlyBuyerMSPEQBounds: ParameterBounds = {
    // Base parameters (quarterly-specific ranges)
    targetDollars: { min: 5, max: 20, step: 1 },
    baseBuyPrice: { min: 0.30, max: 0.60, step: 0.02 },
    baseSellPrice: { min: 0.60, max: 0.90, step: 0.02 },
    baseCutoffMinute: { min: 3, max: 12, step: 1 },
    candleSizeReference: { min: 0, max: 500, step: 50 },
    minProfitMargin: { min: 0.05, max: 0.25, step: 0.02 },
    directionThreshold: { min: 0.3, max: 0.7, step: 0.02 },
    // MSPEQ coefficients
    ...generateMSPEQBounds('buyPrice', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.5, c0Max: 1.5 }),
    ...generateMSPEQBounds('sellPrice', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
    ...generateMSPEQBounds('cutoffMinute', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
    ...generateMSPEQBounds('btcDirection', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 1 }, { min: -0.5, max: 0.5, c0Min: 0.4, c0Max: 0.6 }),
    ...generateMSPEQBounds('earlySellTime', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 1 }, { min: -0.5, max: 0.5, c0Min: 0.1, c0Max: 0.4 }),
    ...generateMSPEQBounds('earlySellPrice', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
};

// MarketMakerMSPEQ Full Bounds (base params + MSPEQ coefficients)
const marketMakerMSPEQBounds: ParameterBounds = {
    // Base parameters
    spreadSize: { min: 1, max: 5, step: 1 },
    baseSpreadDistance: { min: 0.01, max: 0.08, step: 0.01 },
    baseProfitMargin: { min: 0.05, max: 0.20, step: 0.02 },
    baseMinPrice: { min: 0.10, max: 0.30, step: 0.02 },
    baseMaxPrice: { min: 0.60, max: 0.85, step: 0.02 },
    baseStopLossAmount: { min: 0.05, max: 0.31, step: 0.02 },
    totalActiveTrades: { min: 2, max: 10, step: 1 },
    maxVolatility: { min: 0, max: 100, step: 1 },
    minVolatility: { min: 0, max: 100, step: 1 },
    volatilityLookbackPeriods: { min: 3, max: 60, step: 1 },
    targetDollars: { min: 5, max: 20, step: 1 },
    baseCutoffMinute: { min: 5, max: 50, step: 5 },
    candleSizeReference: { min: 0, max: 500, step: 50 },
    // MSPEQ coefficients
    ...generateMSPEQBounds('profitMargin', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
    ...generateMSPEQBounds('spreadDistance', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
    ...generateMSPEQBounds('stopLossAmount', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
    ...generateMSPEQBounds('cutoffMinute', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
    ...generateMSPEQBounds('minPrice', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
    ...generateMSPEQBounds('maxPrice', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
};

const quarterlyMarketMakerMSPEQBounds: ParameterBounds = {
    // Base parameters (quarterly-specific ranges)
    spreadSize: { min: 1, max: 5, step: 1 },
    baseSpreadDistance: { min: 0.02, max: 0.08, step: 0.01 },
    baseProfitMargin: { min: 0.05, max: 0.20, step: 0.02 },
    baseMinPrice: { min: 0.10, max: 0.30, step: 0.02 },
    baseMaxPrice: { min: 0.60, max: 0.85, step: 0.02 },
    baseStopLossAmount: { min: 0.05, max: 0.15, step: 0.02 },
    totalActiveTrades: { min: 2, max: 10, step: 1 },
    maxVolatility: { min: 0.05, max: 0.20, step: 0.02 },
    minVolatility: { min: 0.001, max: 0.02, step: 0.002 },
    volatilityLookbackPeriods: { min: 3, max: 10, step: 1 },
    targetDollars: { min: 5, max: 20, step: 1 },
    baseCutoffMinute: { min: 5, max: 12, step: 1 },
    candleSizeReference: { min: 100, max: 500, step: 50 },
    // MSPEQ coefficients
    ...generateMSPEQBounds('profitMargin', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
    ...generateMSPEQBounds('spreadDistance', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
    ...generateMSPEQBounds('stopLossAmount', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
    ...generateMSPEQBounds('cutoffMinute', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
    ...generateMSPEQBounds('minPrice', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
    ...generateMSPEQBounds('maxPrice', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
};

// NCandleMSPEQ Full Bounds (base params + MSPEQ coefficients)
const nCandleMSPEQBounds: ParameterBounds = {
    // Base parameters
    candleMinutes: { min: 2, max: 15, step: 1 },
    buyPriceBuffer: { min: 10, max: 200, step: 10 },
    sellPriceBuffer: { min: 10, max: 200, step: 10 },
    minProfitMargin: { min: 0.05, max: 0.25, step: 0.02 },
    stopLossMultiplier: { min: 0.5, max: 2.0, step: 0.1 },
    stoplossTimeout: { min: 5000, max: 30000, step: 5000 },
    sellTimeout: { min: 5000, max: 30000, step: 5000 },
    stoplossFailureTimeout: { min: 5000, max: 30000, step: 5000 },
    earlySellScalar: { min: 0.5, max: 1.5, step: 0.1 },
    targetDollars: { min: 5, max: 20, step: 1 },
    cutoffMinute: { min: 20, max: 55, step: 5 },
    maxTradesPerHour: { min: 1, max: 5, step: 1 },
    candleSizeReference: { min: 100, max: 500, step: 50 },
    // MSPEQ coefficients
    ...generateMSPEQBounds('buyPriceBuffer', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
    ...generateMSPEQBounds('minProfitMargin', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
    ...generateMSPEQBounds('stoplossTimeout', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
    ...generateMSPEQBounds('sellTimeout', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
    ...generateMSPEQBounds('stoplossFailureTimeout', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
};

const quarterlyNCandleMSPEQBounds: ParameterBounds = {
    // Base parameters (quarterly-specific ranges)
    candleMinutes: { min: 1, max: 5, step: 1 },
    buyPriceBuffer: { min: 10, max: 150, step: 10 },
    sellPriceBuffer: { min: 10, max: 150, step: 10 },
    minProfitMargin: { min: 0.05, max: 0.25, step: 0.02 },
    stopLossMultiplier: { min: 0.5, max: 2.0, step: 0.1 },
    stoplossTimeout: { min: 3000, max: 15000, step: 2000 },
    sellTimeout: { min: 3000, max: 15000, step: 2000 },
    stoplossFailureTimeout: { min: 3000, max: 15000, step: 2000 },
    earlySellScalar: { min: 0.5, max: 1.5, step: 0.1 },
    targetDollars: { min: 5, max: 20, step: 1 },
    cutoffMinute: { min: 5, max: 12, step: 1 },
    maxTradesPerHour: { min: 1, max: 5, step: 1 },
    candleSizeReference: { min: 100, max: 500, step: 50 },
    // MSPEQ coefficients
    ...generateMSPEQBounds('buyPriceBuffer', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
    ...generateMSPEQBounds('minProfitMargin', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
    ...generateMSPEQBounds('stoplossTimeout', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
    ...generateMSPEQBounds('sellTimeout', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
    ...generateMSPEQBounds('stoplossFailureTimeout', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
};

// CrossPeriodMomentumMSPEQ Full Bounds (base params + MSPEQ coefficients)
const crossPeriodMomentumMSPEQBounds: ParameterBounds = {
    // Base parameters
    targetDollars: { min: 5, max: 20, step: 1 },
    baseBuyPrice: { min: 0.40, max: 0.60, step: 0.02 },
    baseSellPrice: { min: 0.55, max: 0.75, step: 0.02 },
    baseCutoffMinute: { min: 10, max: 50, step: 5 },
    candleSizeReference: { min: 100, max: 500, step: 50 },
    minProfitMargin: { min: 0.03, max: 0.15, step: 0.02 },
    directionThreshold: { min: 0.3, max: 0.7, step: 0.05 },
    baseMomentumThreshold: { min: 0.05, max: 0.30, step: 0.05 },
    baseMinWinStreak: { min: 1, max: 4, step: 1 },
    // MSPEQ coefficients
    ...generateMSPEQBounds('buyPrice', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.5, c0Max: 1.5 }),
    ...generateMSPEQBounds('sellPrice', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
    ...generateMSPEQBounds('cutoffMinute', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
    ...generateMSPEQBounds('btcDirection', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 1 }, { min: -0.5, max: 0.5, c0Min: 0.4, c0Max: 0.6 }),
    ...generateMSPEQBounds('momentumThreshold', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
    ...generateMSPEQBounds('winStreakThreshold', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
    ...generateMSPEQBounds('earlySellTime', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 1 }, { min: -0.5, max: 0.5, c0Min: 0.1, c0Max: 0.4 }),
    ...generateMSPEQBounds('earlySellPrice', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
};

const quarterlyCrossPeriodMomentumMSPEQBounds: ParameterBounds = {
    // Base parameters (quarterly-specific ranges)
    targetDollars: { min: 5, max: 20, step: 1 },
    baseBuyPrice: { min: 0.40, max: 0.60, step: 0.02 },
    baseSellPrice: { min: 0.55, max: 0.75, step: 0.02 },
    baseCutoffMinute: { min: 3, max: 12, step: 1 },
    candleSizeReference: { min: 100, max: 500, step: 50 },
    minProfitMargin: { min: 0.03, max: 0.15, step: 0.02 },
    directionThreshold: { min: 0.3, max: 0.7, step: 0.05 },
    baseMomentumThreshold: { min: 0.05, max: 0.30, step: 0.05 },
    baseMinWinStreak: { min: 1, max: 4, step: 1 },
    // MSPEQ coefficients
    ...generateMSPEQBounds('buyPrice', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.5, c0Max: 1.5 }),
    ...generateMSPEQBounds('sellPrice', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
    ...generateMSPEQBounds('cutoffMinute', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
    ...generateMSPEQBounds('btcDirection', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 1 }, { min: -0.5, max: 0.5, c0Min: 0.4, c0Max: 0.6 }),
    ...generateMSPEQBounds('momentumThreshold', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
    ...generateMSPEQBounds('winStreakThreshold', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
    ...generateMSPEQBounds('earlySellTime', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 1 }, { min: -0.5, max: 0.5, c0Min: 0.1, c0Max: 0.4 }),
    ...generateMSPEQBounds('earlySellPrice', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
};

// ============================================================================
// MSPEQ-Only Bounds (for two-stage optimization - base params frozen)
// ============================================================================

const firstCandleMSPEQOnlyBounds: ParameterBounds = {
    ...generateMSPEQBounds('buyPrice', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.5, c0Max: 1.5 }),
    ...generateMSPEQBounds('sellPrice', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
    ...generateMSPEQBounds('earlySellTime', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 1 }, { min: -0.5, max: 0.5, c0Min: 0.1, c0Max: 0.4 }),
    ...generateMSPEQBounds('earlySellPrice', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
    ...generateMSPEQBounds('breakoutBuffer', [...MSPEQ_SIGNAL_NAMES], { min: 0.5, max: 2 }, { min: -0.5, max: 0.5, c0Min: 0.8, c0Max: 1.2 }),
    ...generateMSPEQBounds('pullbackBuffer', [...MSPEQ_SIGNAL_NAMES], { min: 0.5, max: 2 }, { min: -0.5, max: 0.5, c0Min: 0.8, c0Max: 1.2 }),
};

const quarterlyFirstCandleMSPEQOnlyBounds: ParameterBounds = {
    ...generateMSPEQBounds('buyPrice', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.5, c0Max: 1.5 }),
    ...generateMSPEQBounds('sellPrice', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
    ...generateMSPEQBounds('earlySellTime', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 1 }, { min: -0.5, max: 0.5, c0Min: 0.1, c0Max: 0.4 }),
    ...generateMSPEQBounds('earlySellPrice', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
    ...generateMSPEQBounds('breakoutBuffer', [...MSPEQ_SIGNAL_NAMES], { min: 0.5, max: 2 }, { min: -0.5, max: 0.5, c0Min: 0.8, c0Max: 1.2 }),
    ...generateMSPEQBounds('pullbackBuffer', [...MSPEQ_SIGNAL_NAMES], { min: 0.5, max: 2 }, { min: -0.5, max: 0.5, c0Min: 0.8, c0Max: 1.2 }),
};

const earlyBuyerMSPEQOnlyBounds: ParameterBounds = {
    ...generateMSPEQBounds('buyPrice', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.5, c0Max: 1.5 }),
    ...generateMSPEQBounds('sellPrice', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
    ...generateMSPEQBounds('cutoffMinute', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
    ...generateMSPEQBounds('btcDirection', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 1 }, { min: -0.5, max: 0.5, c0Min: 0.4, c0Max: 0.6 }),
    ...generateMSPEQBounds('earlySellTime', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 1 }, { min: -0.5, max: 0.5, c0Min: 0.1, c0Max: 0.4 }),
    ...generateMSPEQBounds('earlySellPrice', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
};

const quarterlyEarlyBuyerMSPEQOnlyBounds: ParameterBounds = {
    ...generateMSPEQBounds('buyPrice', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.5, c0Max: 1.5 }),
    ...generateMSPEQBounds('sellPrice', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
    ...generateMSPEQBounds('cutoffMinute', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
    ...generateMSPEQBounds('btcDirection', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 1 }, { min: -0.5, max: 0.5, c0Min: 0.4, c0Max: 0.6 }),
    ...generateMSPEQBounds('earlySellTime', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 1 }, { min: -0.5, max: 0.5, c0Min: 0.1, c0Max: 0.4 }),
    ...generateMSPEQBounds('earlySellPrice', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
};

const marketMakerMSPEQOnlyBounds: ParameterBounds = {
    ...generateMSPEQBounds('profitMargin', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
    ...generateMSPEQBounds('spreadDistance', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
    ...generateMSPEQBounds('stopLossAmount', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
    ...generateMSPEQBounds('cutoffMinute', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
    ...generateMSPEQBounds('minPrice', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
    ...generateMSPEQBounds('maxPrice', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
};

const quarterlyMarketMakerMSPEQOnlyBounds: ParameterBounds = {
    ...generateMSPEQBounds('profitMargin', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
    ...generateMSPEQBounds('spreadDistance', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
    ...generateMSPEQBounds('stopLossAmount', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
    ...generateMSPEQBounds('cutoffMinute', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
    ...generateMSPEQBounds('minPrice', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
    ...generateMSPEQBounds('maxPrice', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
};

const nCandleMSPEQOnlyBounds: ParameterBounds = {
    ...generateMSPEQBounds('buyPriceBuffer', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
    ...generateMSPEQBounds('minProfitMargin', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
    ...generateMSPEQBounds('stoplossTimeout', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
    ...generateMSPEQBounds('sellTimeout', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
    ...generateMSPEQBounds('stoplossFailureTimeout', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
};

const quarterlyNCandleMSPEQOnlyBounds: ParameterBounds = {
    ...generateMSPEQBounds('buyPriceBuffer', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
    ...generateMSPEQBounds('minProfitMargin', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
    ...generateMSPEQBounds('stoplossTimeout', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
    ...generateMSPEQBounds('sellTimeout', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
    ...generateMSPEQBounds('stoplossFailureTimeout', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
};

const crossPeriodMomentumMSPEQOnlyBounds: ParameterBounds = {
    ...generateMSPEQBounds('buyPrice', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.5, c0Max: 1.5 }),
    ...generateMSPEQBounds('sellPrice', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
    ...generateMSPEQBounds('cutoffMinute', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
    ...generateMSPEQBounds('btcDirection', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 1 }, { min: -0.5, max: 0.5, c0Min: 0.4, c0Max: 0.6 }),
    ...generateMSPEQBounds('momentumThreshold', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
    ...generateMSPEQBounds('winStreakThreshold', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
    ...generateMSPEQBounds('earlySellTime', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 1 }, { min: -0.5, max: 0.5, c0Min: 0.1, c0Max: 0.4 }),
    ...generateMSPEQBounds('earlySellPrice', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
};

const quarterlyCrossPeriodMomentumMSPEQOnlyBounds: ParameterBounds = {
    ...generateMSPEQBounds('buyPrice', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.5, c0Max: 1.5 }),
    ...generateMSPEQBounds('sellPrice', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
    ...generateMSPEQBounds('cutoffMinute', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
    ...generateMSPEQBounds('btcDirection', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 1 }, { min: -0.5, max: 0.5, c0Min: 0.4, c0Max: 0.6 }),
    ...generateMSPEQBounds('momentumThreshold', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
    ...generateMSPEQBounds('winStreakThreshold', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
    ...generateMSPEQBounds('earlySellTime', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 1 }, { min: -0.5, max: 0.5, c0Min: 0.1, c0Max: 0.4 }),
    ...generateMSPEQBounds('earlySellPrice', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
};

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Helper to build MSPEQ config from flat params
 */
function buildMSPEQConfig(
    prefix: string,
    params: Record<string, unknown>,
    signalNames: readonly string[]
): { signals: Array<{ name: string; weight: number; coefficients: { c0: number; c1: number }; normalize?: { min: number; max: number } }> } {
    const signals = signalNames.map(name => ({
        name,
        weight: params[`${prefix}_${name}_w`] as number ?? 1.0,
        coefficients: {
            c0: params[`${prefix}_${name}_c0`] as number ?? 1.0,
            c1: params[`${prefix}_${name}_c1`] as number ?? 0,
        },
        normalize: STANDARD_NORMALIZATIONS[name as keyof typeof STANDARD_NORMALIZATIONS],
    }));
    return { signals };
}

// ============================================================================
// Factory Functions
// ============================================================================

function createContrarianBot(botParams: BotParams): SimulatedBot {
    const { name, clock, marketInfo, cdMarketData, params, targetedMarket, shouldWriteLogs, logDirectory } = botParams;

    const bot = new ContrarianV2({
        name,
        hourlyDollarLimit: 10000,
        client: createMockClobClient(),
        marketInfo,
        cdMarketData,
        PROD_MODE: false,
        targetedMarket,
        clock,
        logDirectory: logDirectory ?? SIM_LOG_DIR,
        shouldWriteLogs: shouldWriteLogs ?? false,
        targetBuyPrice: params.targetBuyPrice as number ?? 0.48,
        targetSellPrice: params.targetSellPrice as number ?? 0.60,
        targetDollars: params.targetDollars as number ?? 10,
        cutoffMinute: params.cutoffMinute as number ?? 30,
        lookbackHours: params.lookbackHours as number ?? 3,
        cdLookbackHours: params.cdLookbackHours as number ?? 6,
    });

    return new QuantBotSimulationAdapter(bot, clock, marketInfo);
}

function createTrendFollowingBot(botParams: BotParams): SimulatedBot {
    const { name, clock, marketInfo, cdMarketData, params, targetedMarket, shouldWriteLogs, logDirectory } = botParams;

    const bot = new TrendFollowing({
        name,
        hourlyDollarLimit: 10000,
        client: createMockClobClient(),
        marketInfo,
        cdMarketData,
        PROD_MODE: false,
        targetedMarket,
        clock,
        logDirectory: logDirectory ?? SIM_LOG_DIR,
        shouldWriteLogs: shouldWriteLogs ?? false,
        shortMaPeriod: params.shortMaPeriod as number ?? 5,
        longMaPeriod: params.longMaPeriod as number ?? 20,
        adxPeriod: params.adxPeriod as number ?? 14,
        adxThreshold: params.adxThreshold as number ?? 25,
        atrPeriod: params.atrPeriod as number ?? 14,
        atrStopMultiple: params.atrStopMultiple as number ?? 2.0,
        targetBuyPrice: params.targetBuyPrice as number ?? 0.50,
        targetSellPrice: params.targetSellPrice as number ?? 0.60,
        targetDollars: params.targetDollars as number ?? 10,
        cutoffMinute: params.cutoffMinute as number ?? 45,
    });

    return new QuantBotSimulationAdapter(bot, clock, marketInfo);
}

function createFirstCandleBot(botParams: BotParams): SimulatedBot {
    const { name, clock, marketInfo, cdMarketData, params, targetedMarket, shouldWriteLogs, logDirectory } = botParams;

    const bot = new FirstCandle({
        name,
        hourlyDollarLimit: 10000,
        client: createMockClobClient(),
        marketInfo,
        cdMarketData,
        PROD_MODE: false,
        targetedMarket,
        clock,
        logDirectory: logDirectory ?? SIM_LOG_DIR,
        shouldWriteLogs: shouldWriteLogs ?? false,
        candleMinutes: params.candleMinutes as number ?? 15,
        breakoutBuffer: params.breakoutBuffer as number ?? 50,
        pullbackBuffer: params.pullbackBuffer as number ?? 100,
        targetDollars: params.targetDollars as number ?? 10,
        cutoffMinute: params.cutoffMinute as number ?? 45,
        candleSizeReference: params.candleSizeReference as number ?? 1000,
        baseBuyPrice: params.baseBuyPrice as number ?? 0.50,
        minProfitMargin: params.minProfitMargin as number ?? 0.05,
        targetBuyPricePEQ: (params.targetBuyPricePEQ as { c0: number; c1: number }) ?? { c0: 1, c1: 0 },
        targetSellPricePEQ: (params.targetSellPricePEQ as { c0: number; c1: number }) ?? { c0: 1, c1: 0 },
        earlySellTimePEQ: (params.earlySellTimePEQ as { c0: number; c1: number }) ?? { c0: 0.2, c1: 0 },
        earlySellPricePEQ: (params.earlySellPricePEQ as { c0: number; c1: number }) ?? { c0: 1, c1: 0 },
    });

    return new QuantBotSimulationAdapter(bot, clock, marketInfo);
}

function createFirstCandleV2Bot(botParams: BotParams): SimulatedBot {
    const { name, clock, marketInfo, cdMarketData, params, targetedMarket, shouldWriteLogs, logDirectory } = botParams;

    const bot = new FirstCandleV2({
        name,
        hourlyDollarLimit: 10000,
        client: createMockClobClient(),
        marketInfo,
        cdMarketData,
        PROD_MODE: false,
        targetedMarket,
        clock,
        logDirectory: logDirectory ?? SIM_LOG_DIR,
        shouldWriteLogs: shouldWriteLogs ?? false,
        candleMinutes: params.candleMinutes as number ?? 15,
        breakoutBuffer: params.breakoutBuffer as number ?? 50,
        pullbackBuffer: params.pullbackBuffer as number ?? 100,
        buyPriceBuffer: params.buyPriceBuffer as number ?? 0.02,
        sellPriceBuffer: params.sellPriceBuffer as number ?? 0.02,
        minProfitMargin: params.minProfitMargin as number ?? 0.05,
        targetDollars: params.targetDollars as number ?? 10,
        cutoffMinute: params.cutoffMinute as number ?? 45,
    });

    return new QuantBotSimulationAdapter(bot, clock, marketInfo);
}

function createEveningStarBot(botParams: BotParams): SimulatedBot {
    const { name, clock, marketInfo, cdMarketData, params, targetedMarket, shouldWriteLogs, logDirectory } = botParams;

    const bot = new EveningStar({
        name,
        hourlyDollarLimit: 10000,
        client: createMockClobClient(),
        marketInfo,
        cdMarketData,
        PROD_MODE: false,
        targetedMarket,
        clock,
        logDirectory: logDirectory ?? SIM_LOG_DIR,
        shouldWriteLogs: shouldWriteLogs ?? false,
        candleMinutes: params.candleMinutes as number ?? 10,
        minBullishMove: params.minBullishMove as number ?? 50,
        maxIndecisionRange: params.maxIndecisionRange as number ?? 30,
        minBearishMove: params.minBearishMove as number ?? 50,
        targetBuyPrice: params.targetBuyPrice as number ?? 0.50,
        targetSellPrice: params.targetSellPrice as number ?? 0.60,
        targetDollars: params.targetDollars as number ?? 10,
        cutoffMinute: params.cutoffMinute as number ?? 45,
    });

    return new QuantBotSimulationAdapter(bot, clock, marketInfo);
}

function createMorningStarBot(botParams: BotParams): SimulatedBot {
    const { name, clock, marketInfo, cdMarketData, params, targetedMarket, shouldWriteLogs, logDirectory } = botParams;

    const bot = new MorningStar({
        name,
        hourlyDollarLimit: 10000,
        client: createMockClobClient(),
        marketInfo,
        cdMarketData,
        PROD_MODE: false,
        targetedMarket,
        clock,
        logDirectory: logDirectory ?? SIM_LOG_DIR,
        shouldWriteLogs: shouldWriteLogs ?? false,
        candleMinutes: params.candleMinutes as number ?? 10,
        minBearishMove: params.minBearishMove as number ?? 50,
        maxIndecisionRange: params.maxIndecisionRange as number ?? 30,
        minBullishMove: params.minBullishMove as number ?? 50,
        targetBuyPrice: params.targetBuyPrice as number ?? 0.50,
        targetSellPrice: params.targetSellPrice as number ?? 0.60,
        targetDollars: params.targetDollars as number ?? 10,
        cutoffMinute: params.cutoffMinute as number ?? 45,
    });

    return new QuantBotSimulationAdapter(bot, clock, marketInfo);
}

function createMeanReversionBot(botParams: BotParams): SimulatedBot {
    const { name, clock, marketInfo, cdMarketData, params, targetedMarket, shouldWriteLogs, logDirectory } = botParams;

    const bot = new MeanReversion({
        name,
        hourlyDollarLimit: 10000,
        client: createMockClobClient(),
        marketInfo,
        cdMarketData,
        PROD_MODE: false,
        targetedMarket,
        clock,
        logDirectory: logDirectory ?? SIM_LOG_DIR,
        shouldWriteLogs: shouldWriteLogs ?? false,
        lookbackPeriods: params.lookbackPeriods as number ?? 20,
        entryThreshold: params.entryThreshold as number ?? 2.0,
        targetBuyPrice: params.targetBuyPrice as number ?? 0.50,
        targetSellPrice: params.targetSellPrice as number ?? 0.60,
        targetDollars: params.targetDollars as number ?? 10,
        cutoffMinute: params.cutoffMinute as number ?? 45,
    });

    return new QuantBotSimulationAdapter(bot, clock, marketInfo);
}

function createNCandleBot(botParams: BotParams): SimulatedBot {
    const { name, clock, marketInfo, cdMarketData, params, targetedMarket, shouldWriteLogs, logDirectory } = botParams;

    const bot = new NCandle({
        name,
        hourlyDollarLimit: 10000,
        client: createMockClobClient(),
        marketInfo,
        cdMarketData,
        PROD_MODE: false,
        targetedMarket,
        clock,
        logDirectory: logDirectory ?? SIM_LOG_DIR,
        shouldWriteLogs: shouldWriteLogs ?? false,
        candleMinutes: params.candleMinutes as number ?? 10,
        buyPriceBuffer: params.buyPriceBuffer as number ?? 0.02,
        buyPriceBufferPEQ: new ScalingPEQ({
            c0: params.buyPriceBufferPEQ_c0 as number ?? 1.0,
            c1: params.buyPriceBufferPEQ_c1 as number ?? 0,
        }),
        sellPriceBuffer: params.sellPriceBuffer as number ?? 0.02,
        minProfitMargin: params.minProfitMargin as number ?? 0.05,
        minProfitMarginPEQ: new ScalingPEQ({
            c0: params.minProfitMarginPEQ_c0 as number ?? 1.0,
            c1: params.minProfitMarginPEQ_c1 as number ?? 0,
        }),
        stopLossMultiplier: params.stopLossMultiplier as number ?? 1.5,
        stoplossTimeout: params.stoplossTimeout as number ?? 30,
        stoplossTimeoutPEQ: new ScalingPEQ({
            c0: params.stoplossTimeoutPEQ_c0 as number ?? 1.0,
            c1: params.stoplossTimeoutPEQ_c1 as number ?? 0,
        }),
        sellTimeout: params.sellTimeout as number ?? 300,
        sellTimeoutPEQ: new ScalingPEQ({
            c0: params.sellTimeoutPEQ_c0 as number ?? 1.0,
            c1: params.sellTimeoutPEQ_c1 as number ?? 0,
        }),
        stoplossFailureTimeout: params.stoplossFailureTimeout as number ?? 15,
        stoplossFailureTimeoutPEQ: new ScalingPEQ({
            c0: params.stoplossFailureTimeoutPEQ_c0 as number ?? 1.0,
            c1: params.stoplossFailureTimeoutPEQ_c1 as number ?? 0,
        }),
        earlySellScalar: params.earlySellScalar as number ?? 0.3,
        targetDollars: params.targetDollars as number ?? 10,
        cutoffMinute: params.cutoffMinute as number ?? 45,
        maxTradesPerHour: params.maxTradesPerHour as number ?? 2,
    });

    return new QuantBotSimulationAdapter(bot, clock, marketInfo);
}

function createEarlyBuyerV2Bot(botParams: BotParams): SimulatedBot {
    const { name, clock, marketInfo, cdMarketData, params, targetedMarket, shouldWriteLogs, logDirectory } = botParams;
    const directionParam = params.btcDirection as number ?? 1;
    const btcDirection = directionParam === 1 ? BtcDirection.UP : BtcDirection.DOWN;

    const bot = new EarlyBuyerV2({
        name,
        hourlyDollarLimit: 10000,
        client: createMockClobClient(),
        marketInfo,
        cdMarketData,
        PROD_MODE: false,
        targetedMarket,
        clock,
        logDirectory: logDirectory ?? SIM_LOG_DIR,
        shouldWriteLogs: shouldWriteLogs ?? false,
        targetBuyPrice: params.targetBuyPrice as number ?? 0.48,
        targetSellPrice: params.targetSellPrice as number ?? 0.60,
        targetDollars: params.targetDollars as number ?? 10,
        cutoffMinute: params.cutoffMinute as number ?? 30,
        minFlops: params.minFlops as number ?? 3,
        flopsLookbackHours: params.flopsLookbackHours as number ?? 6,
        btcDirection,
    });

    return new QuantBotSimulationAdapter(bot, clock, marketInfo);
}

function createEsotericNormalizationBot(botParams: BotParams): SimulatedBot {
    const { name, clock, marketInfo, cdMarketData, params, targetedMarket, shouldWriteLogs, logDirectory } = botParams;

    const bot = new EsotericNormalization({
        name,
        hourlyDollarLimit: 10000,
        client: createMockClobClient(),
        marketInfo,
        cdMarketData,
        PROD_MODE: false,
        targetedMarket,
        clock,
        logDirectory: logDirectory ?? SIM_LOG_DIR,
        shouldWriteLogs: shouldWriteLogs ?? false,
        baseStdDev: params.baseStdDev as number ?? 150,
        minStdDevRatio: params.minStdDevRatio as number ?? 0.25,
        timeDecayPower: params.timeDecayPower as number ?? 1.5,
        priceScaleMultiplier: params.priceScaleMultiplier as number ?? 1.0,
        priceScaleConstant: params.priceScaleConstant as number ?? 0,
        purchaseThreshold: params.purchaseThreshold as number ?? 0.08,
        sellPremium: params.sellPremium as number ?? 0.04,
        targetDollars: params.targetDollars as number ?? 10,
        cutoffMinute: params.cutoffMinute as number ?? 45,
        maxTradesPerPeriod: params.maxTradesPerPeriod as number ?? 2,
    });

    return new QuantBotSimulationAdapter(bot, clock, marketInfo);
}

function createMarketMakerBot(botParams: BotParams): SimulatedBot {
    const { name, clock, marketInfo, cdMarketData, params, targetedMarket, shouldWriteLogs, logDirectory } = botParams;

    const bot = new MarketMaker({
        name,
        hourlyDollarLimit: 10000,
        client: createMockClobClient(),
        marketInfo,
        cdMarketData,
        PROD_MODE: false,
        targetedMarket,
        clock,
        logDirectory: logDirectory ?? SIM_LOG_DIR,
        shouldWriteLogs: shouldWriteLogs ?? false,
        spreadSize: params.spreadSize as number ?? 5,
        minSpreadDistance: params.minSpreadDistance as number ?? 0,
        profitMargin: params.profitMargin as number ?? 0.10,
        minPrice: params.minPrice as number ?? 0.40,
        maxPrice: params.maxPrice as number ?? 0.60,
        stopLossAmount: params.stopLossAmount as number ?? 0.10,
        buyExpirySeconds: params.buyExpirySeconds as number ?? 120,
        totalActiveTrades: params.totalActiveTrades as number ?? 10,
        maxVolatility: params.maxVolatility as number ?? 1.0,
        minVolatility: params.minVolatility as number ?? 0,
        volatilityLookbackPeriods: params.volatilityLookbackPeriods as number ?? 15,
        targetDollars: params.targetDollars as number ?? 10,
        cutoffMinute: params.cutoffMinute as number ?? 45,
        sellTimeout: params.sellTimeout as number ?? 30,
        sellTimeoutPEQ: new ScalingPEQ({
            c0: params.sellTimeoutPEQ_c0 as number ?? 1.0,
            c1: params.sellTimeoutPEQ_c1 as number ?? 0,
        }),
        stoplossCheckTimeout: params.stoplossCheckTimeout as number ?? 10,
        stoplossCheckTimeoutPEQ: new ScalingPEQ({
            c0: params.stoplossCheckTimeoutPEQ_c0 as number ?? 1.0,
            c1: params.stoplossCheckTimeoutPEQ_c1 as number ?? 0,
        }),
        stoplossFailureTimeout: params.stoplossFailureTimeout as number ?? 15,
        stoplossFailureTimeoutPEQ: new ScalingPEQ({
            c0: params.stoplossFailureTimeoutPEQ_c0 as number ?? 1.0,
            c1: params.stoplossFailureTimeoutPEQ_c1 as number ?? 0,
        }),
    });

    return new QuantBotSimulationAdapter(bot, clock, marketInfo);
}

// ============================================================================
// Quarterly Market Factory Functions
// ============================================================================

function createQuarterlyFirstCandleBot(botParams: BotParams): SimulatedBot {
    const { name, clock, marketInfo, cdMarketData, params, targetedMarket, shouldWriteLogs, logDirectory } = botParams;

    const bot = new FirstCandle({
        name,
        hourlyDollarLimit: 10000,
        client: createMockClobClient(),
        marketInfo,
        cdMarketData,
        PROD_MODE: false,
        targetedMarket,
        clock,
        logDirectory: logDirectory ?? SIM_LOG_DIR,
        shouldWriteLogs: shouldWriteLogs ?? false,
        candleMinutes: params.candleMinutes as number ?? 5,
        breakoutBuffer: params.breakoutBuffer as number ?? 50,
        pullbackBuffer: params.pullbackBuffer as number ?? 100,
        targetDollars: params.targetDollars as number ?? 10,
        cutoffMinute: params.cutoffMinute as number ?? 12,
        candleSizeReference: params.candleSizeReference as number ?? 1000,
        baseBuyPrice: params.baseBuyPrice as number ?? 0.50,
        minProfitMargin: params.minProfitMargin as number ?? 0.05,
        targetBuyPricePEQ: (params.targetBuyPricePEQ as { c0: number; c1: number }) ?? { c0: 1, c1: 0 },
        targetSellPricePEQ: (params.targetSellPricePEQ as { c0: number; c1: number }) ?? { c0: 1, c1: 0 },
        earlySellTimePEQ: (params.earlySellTimePEQ as { c0: number; c1: number }) ?? { c0: 0.2, c1: 0 },
        earlySellPricePEQ: (params.earlySellPricePEQ as { c0: number; c1: number }) ?? { c0: 1, c1: 0 },
    });

    return new QuantBotSimulationAdapter(bot, clock, marketInfo);
}

function createQuarterlyMeanReversionBot(botParams: BotParams): SimulatedBot {
    const { name, clock, marketInfo, cdMarketData, params, targetedMarket, shouldWriteLogs, logDirectory } = botParams;

    const bot = new MeanReversion({
        name,
        hourlyDollarLimit: 10000,
        client: createMockClobClient(),
        marketInfo,
        cdMarketData,
        PROD_MODE: false,
        targetedMarket,
        clock,
        logDirectory: logDirectory ?? SIM_LOG_DIR,
        shouldWriteLogs: shouldWriteLogs ?? false,
        lookbackPeriods: params.lookbackPeriods as number ?? 10,
        entryThreshold: params.entryThreshold as number ?? 1.5,
        targetBuyPrice: params.targetBuyPrice as number ?? 0.50,
        targetSellPrice: params.targetSellPrice as number ?? 0.60,
        targetDollars: params.targetDollars as number ?? 10,
        cutoffMinute: params.cutoffMinute as number ?? 12,
    });

    return new QuantBotSimulationAdapter(bot, clock, marketInfo);
}

function createQuarterlyTrendFollowingBot(botParams: BotParams): SimulatedBot {
    const { name, clock, marketInfo, cdMarketData, params, targetedMarket, shouldWriteLogs, logDirectory } = botParams;

    const bot = new TrendFollowing({
        name,
        hourlyDollarLimit: 10000,
        client: createMockClobClient(),
        marketInfo,
        cdMarketData,
        PROD_MODE: false,
        targetedMarket,
        clock,
        logDirectory: logDirectory ?? SIM_LOG_DIR,
        shouldWriteLogs: shouldWriteLogs ?? false,
        shortMaPeriod: params.shortMaPeriod as number ?? 3,
        longMaPeriod: params.longMaPeriod as number ?? 10,
        adxPeriod: params.adxPeriod as number ?? 7,
        adxThreshold: params.adxThreshold as number ?? 20,
        atrPeriod: params.atrPeriod as number ?? 7,
        atrStopMultiple: params.atrStopMultiple as number ?? 2.0,
        targetBuyPrice: params.targetBuyPrice as number ?? 0.50,
        targetSellPrice: params.targetSellPrice as number ?? 0.60,
        targetDollars: params.targetDollars as number ?? 10,
        cutoffMinute: params.cutoffMinute as number ?? 12,
    });

    return new QuantBotSimulationAdapter(bot, clock, marketInfo);
}

function createQuarterlyNCandleBot(botParams: BotParams): SimulatedBot {
    const { name, clock, marketInfo, cdMarketData, params, targetedMarket, shouldWriteLogs, logDirectory } = botParams;

    const bot = new NCandle({
        name,
        hourlyDollarLimit: 10000,
        client: createMockClobClient(),
        marketInfo,
        cdMarketData,
        PROD_MODE: false,
        targetedMarket,
        clock,
        logDirectory: logDirectory ?? SIM_LOG_DIR,
        shouldWriteLogs: shouldWriteLogs ?? false,
        candleMinutes: params.candleMinutes as number ?? 3,
        buyPriceBuffer: params.buyPriceBuffer as number ?? 0.02,
        buyPriceBufferPEQ: new ScalingPEQ({
            c0: params.buyPriceBufferPEQ_c0 as number ?? 1.0,
            c1: params.buyPriceBufferPEQ_c1 as number ?? 0,
        }),
        sellPriceBuffer: params.sellPriceBuffer as number ?? 0.02,
        minProfitMargin: params.minProfitMargin as number ?? 0.05,
        minProfitMarginPEQ: new ScalingPEQ({
            c0: params.minProfitMarginPEQ_c0 as number ?? 1.0,
            c1: params.minProfitMarginPEQ_c1 as number ?? 0,
        }),
        stopLossMultiplier: params.stopLossMultiplier as number ?? 1.5,
        stoplossTimeout: params.stoplossTimeout as number ?? 15,
        stoplossTimeoutPEQ: new ScalingPEQ({
            c0: params.stoplossTimeoutPEQ_c0 as number ?? 1.0,
            c1: params.stoplossTimeoutPEQ_c1 as number ?? 0,
        }),
        sellTimeout: params.sellTimeout as number ?? 120,
        sellTimeoutPEQ: new ScalingPEQ({
            c0: params.sellTimeoutPEQ_c0 as number ?? 1.0,
            c1: params.sellTimeoutPEQ_c1 as number ?? 0,
        }),
        stoplossFailureTimeout: params.stoplossFailureTimeout as number ?? 15,
        stoplossFailureTimeoutPEQ: new ScalingPEQ({
            c0: params.stoplossFailureTimeoutPEQ_c0 as number ?? 1.0,
            c1: params.stoplossFailureTimeoutPEQ_c1 as number ?? 0,
        }),
        earlySellScalar: params.earlySellScalar as number ?? 0.3,
        targetDollars: params.targetDollars as number ?? 10,
        cutoffMinute: params.cutoffMinute as number ?? 12,
        maxTradesPerHour: params.maxTradesPerPeriod as number ?? 1,
    });

    return new QuantBotSimulationAdapter(bot, clock, marketInfo);
}

function createQuarterlyEarlyBuyerV2Bot(botParams: BotParams): SimulatedBot {
    const { name, clock, marketInfo, cdMarketData, params, targetedMarket, shouldWriteLogs, logDirectory } = botParams;
    const directionParam = params.btcDirection as number ?? 1;
    const btcDirection = directionParam === 1 ? BtcDirection.UP : BtcDirection.DOWN;

    const bot = new EarlyBuyerV2({
        name,
        hourlyDollarLimit: 10000,
        client: createMockClobClient(),
        marketInfo,
        cdMarketData,
        PROD_MODE: false,
        targetedMarket,
        clock,
        logDirectory: logDirectory ?? SIM_LOG_DIR,
        shouldWriteLogs: shouldWriteLogs ?? false,
        targetBuyPrice: params.targetBuyPrice as number ?? 0.48,
        targetSellPrice: params.targetSellPrice as number ?? 0.60,
        targetDollars: params.targetDollars as number ?? 10,
        cutoffMinute: params.cutoffMinute as number ?? 10,
        minFlops: params.minFlops as number ?? 3,
        flopsLookbackHours: params.flopsLookbackHours as number ?? 6,
        btcDirection,
    });

    return new QuantBotSimulationAdapter(bot, clock, marketInfo);
}

function createQuarterlyEsotericNormalizationBot(botParams: BotParams): SimulatedBot {
    const { name, clock, marketInfo, cdMarketData, params, targetedMarket, shouldWriteLogs, logDirectory } = botParams;

    const bot = new EsotericNormalization({
        name,
        hourlyDollarLimit: 10000,
        client: createMockClobClient(),
        marketInfo,
        cdMarketData,
        PROD_MODE: false,
        targetedMarket,
        clock,
        logDirectory: logDirectory ?? SIM_LOG_DIR,
        shouldWriteLogs: shouldWriteLogs ?? false,
        baseStdDev: params.baseStdDev as number ?? 75,
        minStdDevRatio: params.minStdDevRatio as number ?? 0.25,
        timeDecayPower: params.timeDecayPower as number ?? 1.5,
        priceScaleMultiplier: params.priceScaleMultiplier as number ?? 1.0,
        priceScaleConstant: params.priceScaleConstant as number ?? 0,
        purchaseThreshold: params.purchaseThreshold as number ?? 0.08,
        sellPremium: params.sellPremium as number ?? 0.04,
        targetDollars: params.targetDollars as number ?? 10,
        cutoffMinute: params.cutoffMinute as number ?? 10,
        maxTradesPerPeriod: params.maxTradesPerPeriod as number ?? 1,
    });

    return new QuantBotSimulationAdapter(bot, clock, marketInfo);
}

function createQuarterlyMarketMakerBot(botParams: BotParams): SimulatedBot {
    const { name, clock, marketInfo, cdMarketData, params, targetedMarket, shouldWriteLogs, logDirectory } = botParams;

    const bot = new MarketMaker({
        name,
        hourlyDollarLimit: 10000,
        client: createMockClobClient(),
        marketInfo,
        cdMarketData,
        PROD_MODE: false,
        targetedMarket,
        clock,
        logDirectory: logDirectory ?? SIM_LOG_DIR,
        shouldWriteLogs: shouldWriteLogs ?? false,
        spreadSize: params.spreadSize as number ?? 4,
        minSpreadDistance: params.minSpreadDistance as number ?? 0,
        profitMargin: params.profitMargin as number ?? 0.08,
        minPrice: params.minPrice as number ?? 0.35,
        maxPrice: params.maxPrice as number ?? 0.65,
        stopLossAmount: params.stopLossAmount as number ?? 0.08,
        buyExpirySeconds: params.buyExpirySeconds as number ?? 60,
        totalActiveTrades: params.totalActiveTrades as number ?? 6,
        maxVolatility: params.maxVolatility as number ?? 0.8,
        minVolatility: params.minVolatility as number ?? 0,
        volatilityLookbackPeriods: params.volatilityLookbackPeriods as number ?? 8,
        targetDollars: params.targetDollars as number ?? 10,
        cutoffMinute: params.cutoffMinute as number ?? 10,
        sellTimeout: params.sellTimeout as number ?? 15,
        sellTimeoutPEQ: new ScalingPEQ({
            c0: params.sellTimeoutPEQ_c0 as number ?? 1.0,
            c1: params.sellTimeoutPEQ_c1 as number ?? 0,
        }),
        stoplossCheckTimeout: params.stoplossCheckTimeout as number ?? 5,
        stoplossCheckTimeoutPEQ: new ScalingPEQ({
            c0: params.stoplossCheckTimeoutPEQ_c0 as number ?? 1.0,
            c1: params.stoplossCheckTimeoutPEQ_c1 as number ?? 0,
        }),
        stoplossFailureTimeout: params.stoplossFailureTimeout as number ?? 8,
        stoplossFailureTimeoutPEQ: new ScalingPEQ({
            c0: params.stoplossFailureTimeoutPEQ_c0 as number ?? 1.0,
            c1: params.stoplossFailureTimeoutPEQ_c1 as number ?? 0,
        }),
    });

    return new QuantBotSimulationAdapter(bot, clock, marketInfo);
}

// ============================================================================
// MSPEQ Factory Functions
// ============================================================================

function createFirstCandleMSPEQBot(botParams: BotParams): SimulatedBot {
    const { name, clock, marketInfo, cdMarketData, params, targetedMarket, shouldWriteLogs, logDirectory } = botParams;

    const bot = new FirstCandleMSPEQ({
        name,
        hourlyDollarLimit: 10000,
        client: createMockClobClient(),
        marketInfo,
        cdMarketData,
        PROD_MODE: false,
        targetedMarket,
        clock,
        logDirectory: logDirectory ?? SIM_LOG_DIR,
        shouldWriteLogs: shouldWriteLogs ?? false,
        candleMinutes: params.candleMinutes as number ?? 15,
        breakoutBuffer: params.breakoutBuffer as number ?? 50,
        pullbackBuffer: params.pullbackBuffer as number ?? 100,
        targetDollars: params.targetDollars as number ?? 10,
        cutoffMinute: params.cutoffMinute as number ?? 45,
        candleSizeReference: params.candleSizeReference as number ?? 1000,
        baseBuyPrice: params.baseBuyPrice as number ?? 0.50,
        minProfitMargin: params.minProfitMargin as number ?? 0.10,
        targetBuyPriceMSPEQ: buildMSPEQConfig('buyPrice', params, MSPEQ_SIGNAL_NAMES),
        targetSellPriceMSPEQ: buildMSPEQConfig('sellPrice', params, MSPEQ_SIGNAL_NAMES),
        earlySellTimeMSPEQ: buildMSPEQConfig('earlySellTime', params, MSPEQ_SIGNAL_NAMES),
        earlySellPriceMSPEQ: buildMSPEQConfig('earlySellPrice', params, MSPEQ_SIGNAL_NAMES),
        breakoutBufferMSPEQ: buildMSPEQConfig('breakoutBuffer', params, MSPEQ_SIGNAL_NAMES),
        pullbackBufferMSPEQ: buildMSPEQConfig('pullbackBuffer', params, MSPEQ_SIGNAL_NAMES),
    });

    return new QuantBotSimulationAdapter(bot, clock, marketInfo);
}

function createQuarterlyFirstCandleMSPEQBot(botParams: BotParams): SimulatedBot {
    const { name, clock, marketInfo, cdMarketData, params, targetedMarket, shouldWriteLogs, logDirectory } = botParams;

    const bot = new FirstCandleMSPEQ({
        name,
        hourlyDollarLimit: 10000,
        client: createMockClobClient(),
        marketInfo,
        cdMarketData,
        PROD_MODE: false,
        targetedMarket,
        clock,
        logDirectory: logDirectory ?? SIM_LOG_DIR,
        shouldWriteLogs: shouldWriteLogs ?? false,
        candleMinutes: params.candleMinutes as number ?? 5,
        breakoutBuffer: params.breakoutBuffer as number ?? 50,
        pullbackBuffer: params.pullbackBuffer as number ?? 100,
        targetDollars: params.targetDollars as number ?? 10,
        cutoffMinute: params.cutoffMinute as number ?? 12,
        candleSizeReference: params.candleSizeReference as number ?? 1000,
        baseBuyPrice: params.baseBuyPrice as number ?? 0.50,
        minProfitMargin: params.minProfitMargin as number ?? 0.10,
        targetBuyPriceMSPEQ: buildMSPEQConfig('buyPrice', params, MSPEQ_SIGNAL_NAMES),
        targetSellPriceMSPEQ: buildMSPEQConfig('sellPrice', params, MSPEQ_SIGNAL_NAMES),
        earlySellTimeMSPEQ: buildMSPEQConfig('earlySellTime', params, MSPEQ_SIGNAL_NAMES),
        earlySellPriceMSPEQ: buildMSPEQConfig('earlySellPrice', params, MSPEQ_SIGNAL_NAMES),
        breakoutBufferMSPEQ: buildMSPEQConfig('breakoutBuffer', params, MSPEQ_SIGNAL_NAMES),
        pullbackBufferMSPEQ: buildMSPEQConfig('pullbackBuffer', params, MSPEQ_SIGNAL_NAMES),
    });

    return new QuantBotSimulationAdapter(bot, clock, marketInfo);
}

function createEarlyBuyerMSPEQBot(botParams: BotParams): SimulatedBot {
    const { name, clock, marketInfo, cdMarketData, params, targetedMarket, shouldWriteLogs, logDirectory } = botParams;

    const bot = new EarlyBuyerMSPEQ({
        name,
        hourlyDollarLimit: 10000,
        client: createMockClobClient(),
        marketInfo,
        cdMarketData,
        PROD_MODE: false,
        targetedMarket,
        clock,
        logDirectory: logDirectory ?? SIM_LOG_DIR,
        shouldWriteLogs: shouldWriteLogs ?? false,
        targetDollars: params.targetDollars as number ?? 10,
        baseBuyPrice: params.baseBuyPrice as number ?? 0.40,
        baseSellPrice: params.baseSellPrice as number ?? 0.70,
        baseCutoffMinute: params.baseCutoffMinute as number ?? 30,
        candleSizeReference: params.candleSizeReference as number ?? 200,
        minProfitMargin: params.minProfitMargin as number ?? 0.20,
        directionThreshold: params.directionThreshold as number ?? 0.5,
        targetBuyPriceMSPEQ: buildMSPEQConfig('buyPrice', params, MSPEQ_SIGNAL_NAMES),
        targetSellPriceMSPEQ: buildMSPEQConfig('sellPrice', params, MSPEQ_SIGNAL_NAMES),
        cutoffMinuteMSPEQ: buildMSPEQConfig('cutoffMinute', params, MSPEQ_SIGNAL_NAMES),
        btcDirectionMSPEQ: buildMSPEQConfig('btcDirection', params, MSPEQ_SIGNAL_NAMES),
        earlySellTimeMSPEQ: buildMSPEQConfig('earlySellTime', params, MSPEQ_SIGNAL_NAMES),
        earlySellPriceMSPEQ: buildMSPEQConfig('earlySellPrice', params, MSPEQ_SIGNAL_NAMES),
    });

    return new QuantBotSimulationAdapter(bot, clock, marketInfo);
}

function createQuarterlyEarlyBuyerMSPEQBot(botParams: BotParams): SimulatedBot {
    const { name, clock, marketInfo, cdMarketData, params, targetedMarket, shouldWriteLogs, logDirectory } = botParams;

    const bot = new EarlyBuyerMSPEQ({
        name,
        hourlyDollarLimit: 10000,
        client: createMockClobClient(),
        marketInfo,
        cdMarketData,
        PROD_MODE: false,
        targetedMarket,
        clock,
        logDirectory: logDirectory ?? SIM_LOG_DIR,
        shouldWriteLogs: shouldWriteLogs ?? false,
        targetDollars: params.targetDollars as number ?? 10,
        baseBuyPrice: params.baseBuyPrice as number ?? 0.40,
        baseSellPrice: params.baseSellPrice as number ?? 0.70,
        baseCutoffMinute: params.baseCutoffMinute as number ?? 10,
        candleSizeReference: params.candleSizeReference as number ?? 200,
        minProfitMargin: params.minProfitMargin as number ?? 0.20,
        directionThreshold: params.directionThreshold as number ?? 0.5,
        targetBuyPriceMSPEQ: buildMSPEQConfig('buyPrice', params, MSPEQ_SIGNAL_NAMES),
        targetSellPriceMSPEQ: buildMSPEQConfig('sellPrice', params, MSPEQ_SIGNAL_NAMES),
        cutoffMinuteMSPEQ: buildMSPEQConfig('cutoffMinute', params, MSPEQ_SIGNAL_NAMES),
        btcDirectionMSPEQ: buildMSPEQConfig('btcDirection', params, MSPEQ_SIGNAL_NAMES),
        earlySellTimeMSPEQ: buildMSPEQConfig('earlySellTime', params, MSPEQ_SIGNAL_NAMES),
        earlySellPriceMSPEQ: buildMSPEQConfig('earlySellPrice', params, MSPEQ_SIGNAL_NAMES),
    });

    return new QuantBotSimulationAdapter(bot, clock, marketInfo);
}

function createMarketMakerMSPEQBot(botParams: BotParams): SimulatedBot {
    const { name, clock, marketInfo, cdMarketData, params, targetedMarket, shouldWriteLogs, logDirectory } = botParams;

    const bot = new MarketMakerMSPEQ({
        name,
        hourlyDollarLimit: 10000,
        client: createMockClobClient(),
        marketInfo,
        cdMarketData,
        PROD_MODE: false,
        targetedMarket,
        clock,
        logDirectory: logDirectory ?? SIM_LOG_DIR,
        shouldWriteLogs: shouldWriteLogs ?? false,
        spreadSize: params.spreadSize as number ?? 3,
        baseSpreadDistance: params.baseSpreadDistance as number ?? 0.03,
        baseProfitMargin: params.baseProfitMargin as number ?? 0.10,
        baseMinPrice: params.baseMinPrice as number ?? 0.40,
        baseMaxPrice: params.baseMaxPrice as number ?? 0.60,
        baseStopLossAmount: params.baseStopLossAmount as number ?? 0.10,
        buyExpirySeconds: params.buyExpirySeconds as number ?? 60,
        totalActiveTrades: params.totalActiveTrades as number ?? 6,
        maxVolatility: params.maxVolatility as number ?? 500,
        minVolatility: params.minVolatility as number ?? 50,
        volatilityLookbackPeriods: params.volatilityLookbackPeriods as number ?? 10,
        targetDollars: params.targetDollars as number ?? 10,
        baseCutoffMinute: params.baseCutoffMinute as number ?? 45,
        candleSizeReference: params.candleSizeReference as number ?? 200,
        profitMarginMSPEQ: buildMSPEQConfig('profitMargin', params, MSPEQ_SIGNAL_NAMES),
        spreadDistanceMSPEQ: buildMSPEQConfig('spreadDistance', params, MSPEQ_SIGNAL_NAMES),
        stopLossAmountMSPEQ: buildMSPEQConfig('stopLossAmount', params, MSPEQ_SIGNAL_NAMES),
        cutoffMinuteMSPEQ: buildMSPEQConfig('cutoffMinute', params, MSPEQ_SIGNAL_NAMES),
        minPriceMSPEQ: buildMSPEQConfig('minPrice', params, MSPEQ_SIGNAL_NAMES),
        maxPriceMSPEQ: buildMSPEQConfig('maxPrice', params, MSPEQ_SIGNAL_NAMES),
    });

    return new QuantBotSimulationAdapter(bot, clock, marketInfo);
}

function createQuarterlyMarketMakerMSPEQBot(botParams: BotParams): SimulatedBot {
    const { name, clock, marketInfo, cdMarketData, params, targetedMarket, shouldWriteLogs, logDirectory } = botParams;

    const bot = new MarketMakerMSPEQ({
        name,
        hourlyDollarLimit: 10000,
        client: createMockClobClient(),
        marketInfo,
        cdMarketData,
        PROD_MODE: false,
        targetedMarket,
        clock,
        logDirectory: logDirectory ?? SIM_LOG_DIR,
        shouldWriteLogs: shouldWriteLogs ?? false,
        spreadSize: params.spreadSize as number ?? 3,
        baseSpreadDistance: params.baseSpreadDistance as number ?? 0.03,
        baseProfitMargin: params.baseProfitMargin as number ?? 0.08,
        baseMinPrice: params.baseMinPrice as number ?? 0.40,
        baseMaxPrice: params.baseMaxPrice as number ?? 0.60,
        baseStopLossAmount: params.baseStopLossAmount as number ?? 0.08,
        buyExpirySeconds: params.buyExpirySeconds as number ?? 30,
        totalActiveTrades: params.totalActiveTrades as number ?? 4,
        maxVolatility: params.maxVolatility as number ?? 500,
        minVolatility: params.minVolatility as number ?? 50,
        volatilityLookbackPeriods: params.volatilityLookbackPeriods as number ?? 10,
        targetDollars: params.targetDollars as number ?? 10,
        baseCutoffMinute: params.baseCutoffMinute as number ?? 12,
        candleSizeReference: params.candleSizeReference as number ?? 200,
        profitMarginMSPEQ: buildMSPEQConfig('profitMargin', params, MSPEQ_SIGNAL_NAMES),
        spreadDistanceMSPEQ: buildMSPEQConfig('spreadDistance', params, MSPEQ_SIGNAL_NAMES),
        stopLossAmountMSPEQ: buildMSPEQConfig('stopLossAmount', params, MSPEQ_SIGNAL_NAMES),
        cutoffMinuteMSPEQ: buildMSPEQConfig('cutoffMinute', params, MSPEQ_SIGNAL_NAMES),
        minPriceMSPEQ: buildMSPEQConfig('minPrice', params, MSPEQ_SIGNAL_NAMES),
        maxPriceMSPEQ: buildMSPEQConfig('maxPrice', params, MSPEQ_SIGNAL_NAMES),
    });

    return new QuantBotSimulationAdapter(bot, clock, marketInfo);
}

function createNCandleMSPEQBot(botParams: BotParams): SimulatedBot {
    const { name, clock, marketInfo, cdMarketData, params, targetedMarket, shouldWriteLogs, logDirectory } = botParams;

    const bot = new NCandleMSPEQ({
        name,
        hourlyDollarLimit: 10000,
        client: createMockClobClient(),
        marketInfo,
        cdMarketData,
        PROD_MODE: false,
        targetedMarket,
        clock,
        logDirectory: logDirectory ?? SIM_LOG_DIR,
        shouldWriteLogs: shouldWriteLogs ?? false,
        candleMinutes: params.candleMinutes as number ?? 5,
        buyPriceBuffer: params.buyPriceBuffer as number ?? 0.01,
        sellPriceBuffer: params.sellPriceBuffer as number ?? 0.01,
        minProfitMargin: params.minProfitMargin as number ?? 0.20,
        stopLossMultiplier: params.stopLossMultiplier as number ?? 0.5,
        stoplossTimeout: params.stoplossTimeout as number ?? 30,
        sellTimeout: params.sellTimeout as number ?? 100,
        stoplossFailureTimeout: params.stoplossFailureTimeout as number ?? 15,
        earlySellScalar: params.earlySellScalar as number ?? 0.3,
        targetDollars: params.targetDollars as number ?? 10,
        cutoffMinute: params.cutoffMinute as number ?? 20,
        maxTradesPerHour: params.maxTradesPerHour as number ?? 5,
        candleSizeReference: params.candleSizeReference as number ?? 20,
        buyPriceBufferMSPEQ: buildMSPEQConfig('buyPriceBuffer', params, MSPEQ_SIGNAL_NAMES),
        minProfitMarginMSPEQ: buildMSPEQConfig('minProfitMargin', params, MSPEQ_SIGNAL_NAMES),
        stoplossTimeoutMSPEQ: buildMSPEQConfig('stoplossTimeout', params, MSPEQ_SIGNAL_NAMES),
        sellTimeoutMSPEQ: buildMSPEQConfig('sellTimeout', params, MSPEQ_SIGNAL_NAMES),
        stoplossFailureTimeoutMSPEQ: buildMSPEQConfig('stoplossFailureTimeout', params, MSPEQ_SIGNAL_NAMES),
    });

    return new QuantBotSimulationAdapter(bot, clock, marketInfo);
}

function createQuarterlyNCandleMSPEQBot(botParams: BotParams): SimulatedBot {
    const { name, clock, marketInfo, cdMarketData, params, targetedMarket, shouldWriteLogs, logDirectory } = botParams;

    const bot = new NCandleMSPEQ({
        name,
        hourlyDollarLimit: 10000,
        client: createMockClobClient(),
        marketInfo,
        cdMarketData,
        PROD_MODE: false,
        targetedMarket,
        clock,
        logDirectory: logDirectory ?? SIM_LOG_DIR,
        shouldWriteLogs: shouldWriteLogs ?? false,
        candleMinutes: params.candleMinutes as number ?? 3,
        buyPriceBuffer: params.buyPriceBuffer as number ?? 0.01,
        sellPriceBuffer: params.sellPriceBuffer as number ?? 0.01,
        minProfitMargin: params.minProfitMargin as number ?? 0.15,
        stopLossMultiplier: params.stopLossMultiplier as number ?? 0.5,
        stoplossTimeout: params.stoplossTimeout as number ?? 20,
        sellTimeout: params.sellTimeout as number ?? 60,
        stoplossFailureTimeout: params.stoplossFailureTimeout as number ?? 10,
        earlySellScalar: params.earlySellScalar as number ?? 0.3,
        targetDollars: params.targetDollars as number ?? 10,
        cutoffMinute: params.cutoffMinute as number ?? 10,
        maxTradesPerHour: params.maxTradesPerHour as number ?? 3,
        candleSizeReference: params.candleSizeReference as number ?? 20,
        buyPriceBufferMSPEQ: buildMSPEQConfig('buyPriceBuffer', params, MSPEQ_SIGNAL_NAMES),
        minProfitMarginMSPEQ: buildMSPEQConfig('minProfitMargin', params, MSPEQ_SIGNAL_NAMES),
        stoplossTimeoutMSPEQ: buildMSPEQConfig('stoplossTimeout', params, MSPEQ_SIGNAL_NAMES),
        sellTimeoutMSPEQ: buildMSPEQConfig('sellTimeout', params, MSPEQ_SIGNAL_NAMES),
        stoplossFailureTimeoutMSPEQ: buildMSPEQConfig('stoplossFailureTimeout', params, MSPEQ_SIGNAL_NAMES),
    });

    return new QuantBotSimulationAdapter(bot, clock, marketInfo);
}

function createCrossPeriodMomentumMSPEQBot(botParams: BotParams): SimulatedBot {
    const { name, clock, marketInfo, cdMarketData, params, targetedMarket, shouldWriteLogs, logDirectory } = botParams;

    const bot = new CrossPeriodMomentumMSPEQ({
        name,
        hourlyDollarLimit: 10000,
        client: createMockClobClient(),
        marketInfo,
        cdMarketData,
        PROD_MODE: false,
        targetedMarket,
        clock,
        logDirectory: logDirectory ?? SIM_LOG_DIR,
        shouldWriteLogs: shouldWriteLogs ?? false,
        targetDollars: params.targetDollars as number ?? 10,
        baseBuyPrice: params.baseBuyPrice as number ?? 0.52,
        baseSellPrice: params.baseSellPrice as number ?? 0.58,
        baseCutoffMinute: params.baseCutoffMinute as number ?? 30,
        candleSizeReference: params.candleSizeReference as number ?? 1000,
        minProfitMargin: params.minProfitMargin as number ?? 0.05,
        directionThreshold: params.directionThreshold as number ?? 0.5,
        baseMomentumThreshold: params.baseMomentumThreshold as number ?? 0.15,
        baseMinWinStreak: params.baseMinWinStreak as number ?? 1,
        targetBuyPriceMSPEQ: buildMSPEQConfig('buyPrice', params, MSPEQ_SIGNAL_NAMES),
        targetSellPriceMSPEQ: buildMSPEQConfig('sellPrice', params, MSPEQ_SIGNAL_NAMES),
        cutoffMinuteMSPEQ: buildMSPEQConfig('cutoffMinute', params, MSPEQ_SIGNAL_NAMES),
        btcDirectionMSPEQ: buildMSPEQConfig('btcDirection', params, MSPEQ_SIGNAL_NAMES),
        momentumThresholdMSPEQ: buildMSPEQConfig('momentumThreshold', params, MSPEQ_SIGNAL_NAMES),
        winStreakThresholdMSPEQ: buildMSPEQConfig('winStreakThreshold', params, MSPEQ_SIGNAL_NAMES),
        earlySellTimeMSPEQ: buildMSPEQConfig('earlySellTime', params, MSPEQ_SIGNAL_NAMES),
        earlySellPriceMSPEQ: buildMSPEQConfig('earlySellPrice', params, MSPEQ_SIGNAL_NAMES),
    });

    return new QuantBotSimulationAdapter(bot, clock, marketInfo);
}

function createQuarterlyCrossPeriodMomentumMSPEQBot(botParams: BotParams): SimulatedBot {
    const { name, clock, marketInfo, cdMarketData, params, targetedMarket, shouldWriteLogs, logDirectory } = botParams;

    const bot = new CrossPeriodMomentumMSPEQ({
        name,
        hourlyDollarLimit: 10000,
        client: createMockClobClient(),
        marketInfo,
        cdMarketData,
        PROD_MODE: false,
        targetedMarket,
        clock,
        logDirectory: logDirectory ?? SIM_LOG_DIR,
        shouldWriteLogs: shouldWriteLogs ?? false,
        targetDollars: params.targetDollars as number ?? 10,
        baseBuyPrice: params.baseBuyPrice as number ?? 0.52,
        baseSellPrice: params.baseSellPrice as number ?? 0.58,
        baseCutoffMinute: params.baseCutoffMinute as number ?? 10,
        candleSizeReference: params.candleSizeReference as number ?? 1000,
        minProfitMargin: params.minProfitMargin as number ?? 0.05,
        directionThreshold: params.directionThreshold as number ?? 0.5,
        baseMomentumThreshold: params.baseMomentumThreshold as number ?? 0.15,
        baseMinWinStreak: params.baseMinWinStreak as number ?? 1,
        targetBuyPriceMSPEQ: buildMSPEQConfig('buyPrice', params, MSPEQ_SIGNAL_NAMES),
        targetSellPriceMSPEQ: buildMSPEQConfig('sellPrice', params, MSPEQ_SIGNAL_NAMES),
        cutoffMinuteMSPEQ: buildMSPEQConfig('cutoffMinute', params, MSPEQ_SIGNAL_NAMES),
        btcDirectionMSPEQ: buildMSPEQConfig('btcDirection', params, MSPEQ_SIGNAL_NAMES),
        momentumThresholdMSPEQ: buildMSPEQConfig('momentumThreshold', params, MSPEQ_SIGNAL_NAMES),
        winStreakThresholdMSPEQ: buildMSPEQConfig('winStreakThreshold', params, MSPEQ_SIGNAL_NAMES),
        earlySellTimeMSPEQ: buildMSPEQConfig('earlySellTime', params, MSPEQ_SIGNAL_NAMES),
        earlySellPriceMSPEQ: buildMSPEQConfig('earlySellPrice', params, MSPEQ_SIGNAL_NAMES),
    });

    return new QuantBotSimulationAdapter(bot, clock, marketInfo);
}

// ============================================================================
// Genetic Strategies Array
// ============================================================================

export const geneticStrategies = [
    { name: 'Contrarian', factory: createContrarianBot, bounds: contrarianBounds },
    { name: 'TrendFollowing', factory: createTrendFollowingBot, bounds: trendFollowingBounds },
    { name: 'FirstCandle', factory: createFirstCandleBot, bounds: firstCandleBounds },
    { name: 'FirstCandleV2', factory: createFirstCandleV2Bot, bounds: firstCandleV2Bounds },
    { name: 'EveningStar', factory: createEveningStarBot, bounds: eveningStarBounds },
    { name: 'MorningStar', factory: createMorningStarBot, bounds: morningStarBounds },
    { name: 'MeanReversion', factory: createMeanReversionBot, bounds: meanReversionBounds },
    { name: 'NCandle', factory: createNCandleBot, bounds: nCandleBounds },
    // Quarterly Market Strategies
    { name: 'QuarterlyFirstCandle', factory: createQuarterlyFirstCandleBot, bounds: quarterlyFirstCandleBounds },
    { name: 'QuarterlyMeanReversion', factory: createQuarterlyMeanReversionBot, bounds: quarterlyMeanReversionBounds },
    { name: 'QuarterlyTrendFollowing', factory: createQuarterlyTrendFollowingBot, bounds: quarterlyTrendFollowingBounds },
    { name: 'QuarterlyNCandle', factory: createQuarterlyNCandleBot, bounds: quarterlyNCandleBounds },
    { name: 'QuarterlyEarlyBuyerV2', factory: createQuarterlyEarlyBuyerV2Bot, bounds: quarterlyEarlyBuyerV2Bounds },
    { name: 'QuarterlyEsotericNormalization', factory: createQuarterlyEsotericNormalizationBot, bounds: quarterlyEsotericNormalizationBounds },
    // Flops-based Strategies (Hourly)
    { name: 'EarlyBuyerV2', factory: createEarlyBuyerV2Bot, bounds: earlyBuyerV2Bounds },
    // Normal Distribution Strategies
    { name: 'EsotericNormalization', factory: createEsotericNormalizationBot, bounds: esotericNormalizationBounds },
    // Market Maker Strategies
    { name: 'MarketMaker', factory: createMarketMakerBot, bounds: marketMakerBounds },
    { name: 'QuarterlyMarketMaker', factory: createQuarterlyMarketMakerBot, bounds: quarterlyMarketMakerBounds },
    // Multi-Signal PEQ Strategies (Phase 1)
    { name: 'FirstCandleMSPEQ', factory: createFirstCandleMSPEQBot, bounds: firstCandleMSPEQBounds },
    { name: 'QuarterlyFirstCandleMSPEQ', factory: createQuarterlyFirstCandleMSPEQBot, bounds: quarterlyFirstCandleMSPEQBounds },
    // EarlyBuyerMSPEQ Strategies (6 MSPEQs)
    { name: 'EarlyBuyerMSPEQ', factory: createEarlyBuyerMSPEQBot, bounds: earlyBuyerMSPEQBounds },
    { name: 'QuarterlyEarlyBuyerMSPEQ', factory: createQuarterlyEarlyBuyerMSPEQBot, bounds: quarterlyEarlyBuyerMSPEQBounds },
    // MarketMakerMSPEQ Strategies (6 MSPEQs)
    { name: 'MarketMakerMSPEQ', factory: createMarketMakerMSPEQBot, bounds: marketMakerMSPEQBounds },
    { name: 'QuarterlyMarketMakerMSPEQ', factory: createQuarterlyMarketMakerMSPEQBot, bounds: quarterlyMarketMakerMSPEQBounds },
    // NCandleMSPEQ Strategies (5 MSPEQs)
    { name: 'NCandleMSPEQ', factory: createNCandleMSPEQBot, bounds: nCandleMSPEQBounds },
    { name: 'QuarterlyNCandleMSPEQ', factory: createQuarterlyNCandleMSPEQBot, bounds: quarterlyNCandleMSPEQBounds },
    // CrossPeriodMomentumMSPEQ Strategies (8 MSPEQs)
    { name: 'CrossPeriodMomentumMSPEQ', factory: createCrossPeriodMomentumMSPEQBot, bounds: crossPeriodMomentumMSPEQBounds },
    { name: 'QuarterlyCrossPeriodMomentumMSPEQ', factory: createQuarterlyCrossPeriodMomentumMSPEQBot, bounds: quarterlyCrossPeriodMomentumMSPEQBounds },
];

// ============================================================================
// Additional Exports for Two-Stage Optimization
// ============================================================================

// Re-export ParameterBounds type
export type { ParameterBounds } from './GeneticOptimizer.js';

// MSPEQ-only bounds exports (for two-stage optimization)
export {
    firstCandleMSPEQOnlyBounds,
    quarterlyFirstCandleMSPEQOnlyBounds,
    earlyBuyerMSPEQOnlyBounds,
    quarterlyEarlyBuyerMSPEQOnlyBounds,
    marketMakerMSPEQOnlyBounds,
    quarterlyMarketMakerMSPEQOnlyBounds,
    nCandleMSPEQOnlyBounds,
    quarterlyNCandleMSPEQOnlyBounds,
    crossPeriodMomentumMSPEQOnlyBounds,
    quarterlyCrossPeriodMomentumMSPEQOnlyBounds,
};

// Full bounds exports (base params + MSPEQ coefficients)
export {
    earlyBuyerMSPEQBounds,
    quarterlyEarlyBuyerMSPEQBounds,
    marketMakerMSPEQBounds,
    quarterlyMarketMakerMSPEQBounds,
    nCandleMSPEQBounds,
    quarterlyNCandleMSPEQBounds,
    crossPeriodMomentumMSPEQBounds,
    quarterlyCrossPeriodMomentumMSPEQBounds,
};

// Factory function exports
export {
    createFirstCandleMSPEQBot,
    createQuarterlyFirstCandleMSPEQBot,
    createEarlyBuyerMSPEQBot,
    createQuarterlyEarlyBuyerMSPEQBot,
    createMarketMakerMSPEQBot,
    createQuarterlyMarketMakerMSPEQBot,
    createNCandleMSPEQBot,
    createQuarterlyNCandleMSPEQBot,
    createCrossPeriodMomentumMSPEQBot,
    createQuarterlyCrossPeriodMomentumMSPEQBot,
};
