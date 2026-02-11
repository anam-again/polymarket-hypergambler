import * as fs from 'fs';
import * as YAML from 'yaml';
import {
    HistoricalSimulator,
    BotParams,
    SimulatedBot,
    SimulationResult,
    CoinType,
} from './HistoricalSimulator.js';
import { BtcDirection, TargetedMarket } from '../types/interfaces.js';
import { SimulatorLogger } from './SimulatorLogger.js';
import { createMockClobClient, QuantBotSimulationAdapter } from './QuantBotSimulationAdapter.js';
import { ParameterBounds } from './GeneticOptimizer.js';

// Import real bot classes
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
import { ScalingPEQ } from '../utils/ScalingPEQ.js';
import { MultiSignalPEQ, generateMSPEQBounds, SIGNAL_NAMES, STANDARD_NORMALIZATIONS } from '../utils/MultiSignalPEQ.js';

// Re-export adapter utilities for external use
export { createSimulatedBot, createMockClobClient, QuantBotSimulationAdapter } from './QuantBotSimulationAdapter.js';

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
    // buyPriceBufferPEQ coefficients (flat params for optimizer)
    buyPriceBufferPEQ_c0: { min: 0, max: 2.0 },
    buyPriceBufferPEQ_c1: { min: -2, max: 2.0 },
    buyPriceBufferPEQ_c2: { min: -2, max: 2.0 },
    buyPriceBufferPEQ_c3: { min: -2, max: 2.0 },
    sellPriceBuffer: { min: 0.01, max: 0.10, step: .01 },
    minProfitMargin: { min: 0.01, max: 1, step: .01 },
    // minProfitMarginPEQ coefficients
    minProfitMarginPEQ_c0: { min: 0, max: 2.0 },
    minProfitMarginPEQ_c1: { min: -2, max: 2.0 },
    minProfitMarginPEQ_c2: { min: -2, max: 2.0 },
    minProfitMarginPEQ_c3: { min: -2, max: 2.0 },
    stopLossMultiplier: { min: 0, max: 5 },
    stoplossTimeout: { min: 10, max: 3600, step: 5 },
    // stoplossTimeoutPEQ coefficients
    stoplossTimeoutPEQ_c0: { min: 0, max: 2.0 },
    stoplossTimeoutPEQ_c1: { min: -2, max: 2.0 },
    stoplossTimeoutPEQ_c2: { min: -2, max: 2.0 },
    stoplossTimeoutPEQ_c3: { min: -2, max: 2.0 },
    sellTimeout: { min: 30, max: 3600, step: 30 },
    // sellTimeoutPEQ coefficients
    sellTimeoutPEQ_c0: { min: 0, max: 2.0 },
    sellTimeoutPEQ_c1: { min: -2, max: 2.0 },
    sellTimeoutPEQ_c2: { min: -2, max: 2.0 },
    sellTimeoutPEQ_c3: { min: -2, max: 2.0 },
    stoplossFailureTimeout: { min: 5, max: 3600, step: 5 },
    // stoplossFailureTimeoutPEQ coefficients
    stoplossFailureTimeoutPEQ_c0: { min: 0, max: 2.0 },
    stoplossFailureTimeoutPEQ_c1: { min: -2, max: 2.0 },
    stoplossFailureTimeoutPEQ_c2: { min: -2, max: 2.0 },
    stoplossFailureTimeoutPEQ_c3: { min: -2, max: 2.0 },
    earlySellScalar: { min: -1, max: 1.0 },
    cutoffMinute: { min: 10, max: 55, step: 5 },
    maxTradesPerHour: { min: 1, max: 20, step: 1 },
};

// ============================================================================
// Quarterly Market Bounds (15-minute periods)
// ============================================================================

const quarterlyFirstCandleBounds: ParameterBounds = {
    targetDollars: { min: 5, max: 20, step: 1 },
    candleMinutes: { min: 1, max: 7, step: 1 },  // Smaller for 15-min period
    breakoutBuffer: { min: 0, max: 500 },
    pullbackBuffer: { min: 0, max: 500 },
    targetBuyPrice: { min: 0.02, max: 0.95 },
    targetSellPrice: { min: 0.05, max: 0.98 },
    cutoffMinute: { min: 5, max: 14, step: 1 },  // Within 15-min period
};

const quarterlyMeanReversionBounds: ParameterBounds = {
    targetDollars: { min: 5, max: 20, step: 1 },
    lookbackPeriods: { min: 3, max: 25, step: 1 },
    entryThreshold: { min: 0.5, max: 3.0 },  // Tighter for faster markets
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
    candleMinutes: { min: 1, max: 4, step: 1 },  // Short candles (1-4 min) for 15-min period
    buyPriceBuffer: { min: 0.01, max: 0.05, step: .01 },
    // buyPriceBufferPEQ coefficients (flat params for optimizer)
    buyPriceBufferPEQ_c0: { min: 0, max: 2.0 },
    buyPriceBufferPEQ_c1: { min: -2, max: 2.0 },
    buyPriceBufferPEQ_c2: { min: -2, max: 2.0 },
    buyPriceBufferPEQ_c3: { min: -2, max: 2.0 },
    sellPriceBuffer: { min: 0.01, max: 0.20, step: .01 },
    minProfitMargin: { min: 0.01, max: 0.50, step: .01 },
    // minProfitMarginPEQ coefficients
    minProfitMarginPEQ_c0: { min: 0, max: 2.0 },
    minProfitMarginPEQ_c1: { min: -2, max: 2.0 },
    minProfitMarginPEQ_c2: { min: -2, max: 2.0 },
    minProfitMarginPEQ_c3: { min: -2, max: 2.0 },
    stopLossMultiplier: { min: 0, max: 2.0 },
    stoplossTimeout: { min: 5, max: 900, step: 5 },      // Shorter for 15-min period
    // stoplossTimeoutPEQ coefficients
    stoplossTimeoutPEQ_c0: { min: 0, max: 2.0 },
    stoplossTimeoutPEQ_c1: { min: -2, max: 2.0 },
    stoplossTimeoutPEQ_c2: { min: -2, max: 2.0 },
    stoplossTimeoutPEQ_c3: { min: -2, max: 2.0 },
    sellTimeout: { min: 30, max: 900, step: 15 },       // Shorter for 15-min period
    // sellTimeoutPEQ coefficients
    sellTimeoutPEQ_c0: { min: 0, max: 2.0 },
    sellTimeoutPEQ_c1: { min: -2, max: 2.0 },
    sellTimeoutPEQ_c2: { min: -2, max: 2.0 },
    sellTimeoutPEQ_c3: { min: -2, max: 2.0 },
    stoplossFailureTimeout: { min: 5, max: 900, step: 5 },
    // stoplossFailureTimeoutPEQ coefficients
    stoplossFailureTimeoutPEQ_c0: { min: 0, max: 2.0 },
    stoplossFailureTimeoutPEQ_c1: { min: -2, max: 2.0 },
    stoplossFailureTimeoutPEQ_c2: { min: -2, max: 2.0 },
    stoplossFailureTimeoutPEQ_c3: { min: -2, max: 2.0 },
    earlySellScalar: { min: -1, max: 1.0 },
    cutoffMinute: { min: 2, max: 14, step: 1 },
    maxTradesPerPeriod: { min: 1, max: 10, step: 1 },
};

const earlyBuyerV2Bounds: ParameterBounds = {
    targetBuyPrice: { min: 0.02, max: 0.90 },    // Target buying below fair value
    targetSellPrice: { min: 0.1, max: 0.98 },   // Target selling above fair value
    targetDollars: { min: 5, max: 25, step: 1 },
    cutoffMinute: { min: 15, max: 45, step: 1 }, // For hourly markets, how late to enter
    minFlops: { min: 1, max: 6 },                // Minimum market volatility to trade
    flopsLookbackHours: { min: 2, max: 12, step: 1 },  // Hours of flops data to average
    btcDirection: { min: 0, max: 1, step: 1 },   // 0 = DOWN, 1 = UP (will be converted to string)
};

const quarterlyEarlyBuyerV2Bounds: ParameterBounds = {
    targetBuyPrice: { min: 0.02, max: 0.95 },    // Target buying below fair value
    targetSellPrice: { min: 0.05, max: 0.98 },   // Target selling above fair value
    targetDollars: { min: 5, max: 25, step: 1 },
    cutoffMinute: { min: 4, max: 12, step: 1 },  // Within 15-min period
    minFlops: { min: 1, max: 10 },                // Minimum market volatility to trade
    flopsLookbackHours: { min: 2, max: 12, step: 1 },  // Hours of flops data to average
    btcDirection: { min: 0, max: 1, step: 1 },   // 0 = DOWN, 1 = UP (will be converted to string)
};

const esotericNormalizationBounds: ParameterBounds = {
    // Distribution shape parameters
    baseStdDev: { min: 0, max: 300 },              // Initial std dev in $ at period start
    minStdDevRatio: { min: 0.1, max: 0.5 },         // Min std dev as ratio of base at period end
    timeDecayPower: { min: 0.5, max: 3.0 },         // How fast std dev shrinks (higher = faster)
    priceScaleMultiplier: { min: 0.5, max: 2.0 },   // Multiplier for price sensitivity
    priceScaleConstant: { min: -50, max: 50 },      // Constant offset for price calc
    // Trading parameters
    purchaseThreshold: { min: 0.04, max: 0.15 },    // Min diff to trigger buy
    sellPremium: { min: 0.02, max: 0.10 },          // Sell this much above expected
    targetDollars: { min: 5, max: 25, step: 1 },
    cutoffMinute: { min: 30, max: 50, step: 1 },    // For hourly markets
    maxTradesPerPeriod: { min: 1, max: 3, step: 1 },
};

const quarterlyEsotericNormalizationBounds: ParameterBounds = {
    // Distribution shape parameters (adjusted for 15-min period)
    baseStdDev: { min: 0, max: 150 },              // Smaller for shorter period
    minStdDevRatio: { min: 0.1, max: 0.5 },
    timeDecayPower: { min: 0.5, max: 3.0 },
    priceScaleMultiplier: { min: 0.5, max: 2.0 },
    priceScaleConstant: { min: -25, max: 25 },
    // Trading parameters
    purchaseThreshold: { min: 0.04, max: 0.15 },
    sellPremium: { min: 0.02, max: 0.10 },
    targetDollars: { min: 5, max: 25, step: 1 },
    cutoffMinute: { min: 5, max: 12, step: 1 },     // Within 15-min period
    maxTradesPerPeriod: { min: 1, max: 2, step: 1 },
};

const marketMakerBounds: ParameterBounds = {
    spreadSize: { min: 1, max: 10, step: 1 },
    minSpreadDistance: { min: 0, max: 0.10, step: 0.01 },  // Distance from market to start spread
    profitMargin: { min: 0.01, max: 0.50 },         // 2-20 cents
    minPrice: { min: 0.02, max: 0.90 },
    maxPrice: { min: 0.1, max: 0.98 },
    stopLossAmount: { min: 0.01, max: 1.0 },
    buyExpirySeconds: { min: 10, max: 3600, step: 10 },  // 30s to 5min
    totalActiveTrades: { min: 1, max: 15, step: 1 },
    maxVolatility: { min: 0.5, max: 100 },
    minVolatility: { min: 0, max: 100 },
    volatilityLookbackPeriods: { min: 1, max: 100, step: 1 },
    targetDollars: { min: 5, max: 20, step: 5 },
    cutoffMinute: { min: 5, max: 55, step: 5 },
    sellTimeout: { min: 10, max: 3600, step: 5 },
    // sellTimeoutPEQ coefficients
    sellTimeoutPEQ_c0: { min: 0, max: 2.0 },
    sellTimeoutPEQ_c1: { min: -2, max: 2.0 },
    sellTimeoutPEQ_c2: { min: -2, max: 2.0 },
    sellTimeoutPEQ_c3: { min: -2, max: 2.0 },
    stoplossCheckTimeout: { min: 0, max: 3600, step: 5 },
    // stoplossCheckTimeoutPEQ coefficients
    stoplossCheckTimeoutPEQ_c0: { min: 0, max: 2.0 },
    stoplossCheckTimeoutPEQ_c1: { min: -2, max: 2.0 },
    stoplossCheckTimeoutPEQ_c2: { min: -2, max: 2.0 },
    stoplossCheckTimeoutPEQ_c3: { min: -2, max: 2.0 },
    stoplossFailureTimeout: { min: 5, max: 3600, step: 5 },
    // stoplossFailureTimeoutPEQ coefficients
    stoplossFailureTimeoutPEQ_c0: { min: 0, max: 2.0 },
    stoplossFailureTimeoutPEQ_c1: { min: -2, max: 2.0 },
    stoplossFailureTimeoutPEQ_c2: { min: -2, max: 2.0 },
    stoplossFailureTimeoutPEQ_c3: { min: -2, max: 2.0 },
};

const quarterlyMarketMakerBounds: ParameterBounds = {
    spreadSize: { min: 2, max: 10, step: 1 },
    minSpreadDistance: { min: 0, max: 0.10, step: 0.01 },  // Distance from market to start spread
    profitMargin: { min: 0.02, max: 0.50 },
    minPrice: { min: 0.02, max: 0.90 },
    maxPrice: { min: 0.1, max: 0.98 },
    stopLossAmount: { min: 0.01, max: 0.30 },
    buyExpirySeconds: { min: 15, max: 120, step: 5 },  // 15s to 2min for faster markets
    totalActiveTrades: { min: 2, max: 10, step: 1 },
    maxVolatility: { min: 0.1, max: 5.0 },
    minVolatility: { min: 0, max: 1.0 },
    volatilityLookbackPeriods: { min: 1, max: 30, step: 1 },
    targetDollars: { min: 5, max: 15, step: 1 },
    cutoffMinute: { min: 2, max: 14, step: 1 },
    // Timeout parameters (shorter for quarterly markets)
    sellTimeout: { min: 5, max: 60, step: 5 },
    // sellTimeoutPEQ coefficients
    sellTimeoutPEQ_c0: { min: 0, max: 2.0 },
    sellTimeoutPEQ_c1: { min: -2, max: 2.0 },
    sellTimeoutPEQ_c2: { min: -2, max: 2.0 },
    sellTimeoutPEQ_c3: { min: -2, max: 2.0 },
    stoplossCheckTimeout: { min: 3, max: 30, step: 2 },
    // stoplossCheckTimeoutPEQ coefficients
    stoplossCheckTimeoutPEQ_c0: { min: 0, max: 2.0 },
    stoplossCheckTimeoutPEQ_c1: { min: -2, max: 2.0 },
    stoplossCheckTimeoutPEQ_c2: { min: -2, max: 2.0 },
    stoplossCheckTimeoutPEQ_c3: { min: -2, max: 2.0 },
    stoplossFailureTimeout: { min: 3, max: 30, step: 2 },
    // stoplossFailureTimeoutPEQ coefficients
    stoplossFailureTimeoutPEQ_c0: { min: 0, max: 2.0 },
    stoplossFailureTimeoutPEQ_c1: { min: -2, max: 2.0 },
    stoplossFailureTimeoutPEQ_c2: { min: -2, max: 2.0 },
    stoplossFailureTimeoutPEQ_c3: { min: -2, max: 2.0 },
};

// ============================================================================
// Multi-Signal PEQ Bounds (Phase 1)
// ============================================================================

// Signal names for MSPEQ: candleSize, volatility, momentum (3 signals per MSPEQ)
const MSPEQ_SIGNAL_NAMES = ['candleSize', 'volatility', 'momentum'] as const;

// FirstCandleMSPEQ bounds with multi-signal PEQs for dynamic decision making
const firstCandleMSPEQBounds: ParameterBounds = {
    // Base parameters (static, genetically optimized)
    targetDollars: { min: 5, max: 20, step: 1 },
    candleMinutes: { min: 5, max: 30, step: 2 },
    breakoutBuffer: { min: 10, max: 300 },
    pullbackBuffer: { min: 0, max: 500 },
    cutoffMinute: { min: 5, max: 55, step: 5 },

    // Reference values
    candleSizeReference: { min: 500, max: 2000, step: 100 },
    baseBuyPrice: { min: 0.30, max: 0.70, step: 0.02 },
    minProfitMargin: { min: 0.05, max: 0.40, step: 0.02 },

    // TargetBuyPrice MSPEQ: 3 signals × 5 params = 15
    ...generateMSPEQBounds('buyPrice', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.5, c0Max: 1.5 }),

    // TargetSellPrice MSPEQ: 3 signals × 5 params = 15
    ...generateMSPEQBounds('sellPrice', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),

    // EarlySellTime MSPEQ: 3 signals × 5 params = 15
    ...generateMSPEQBounds('earlySellTime', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 1 }, { min: -0.5, max: 0.5, c0Min: 0.1, c0Max: 0.4 }),

    // EarlySellPrice MSPEQ: 3 signals × 5 params = 15
    ...generateMSPEQBounds('earlySellPrice', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
};

// Quarterly version with adjusted bounds for 15-minute periods
const quarterlyFirstCandleMSPEQBounds: ParameterBounds = {
    // Base parameters
    targetDollars: { min: 5, max: 20, step: 1 },
    candleMinutes: { min: 1, max: 7, step: 1 },
    breakoutBuffer: { min: 10, max: 200 },
    pullbackBuffer: { min: 0, max: 300 },
    cutoffMinute: { min: 5, max: 14, step: 1 },

    // Reference values
    candleSizeReference: { min: 500, max: 2000, step: 100 },
    baseBuyPrice: { min: 0.30, max: 0.70, step: 0.02 },
    minProfitMargin: { min: 0.05, max: 0.40, step: 0.02 },

    // MSPEQs (same structure as hourly)
    ...generateMSPEQBounds('buyPrice', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.5, c0Max: 1.5 }),
    ...generateMSPEQBounds('sellPrice', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
    ...generateMSPEQBounds('earlySellTime', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 1 }, { min: -0.5, max: 0.5, c0Min: 0.1, c0Max: 0.4 }),
    ...generateMSPEQBounds('earlySellPrice', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
};

// ============================================================================
// Two-Stage Optimization Bounds (Stage 2: MSPEQ-only, base params frozen)
// ============================================================================

// Stage 2 bounds - only MSPEQ parameters, base params will be injected from Stage 1
const firstCandleMSPEQStage2Bounds: ParameterBounds = {
    // TargetBuyPrice MSPEQ: 3 signals × 5 params = 15
    ...generateMSPEQBounds('buyPrice', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.5, c0Max: 1.5 }),

    // TargetSellPrice MSPEQ: 3 signals × 5 params = 15
    ...generateMSPEQBounds('sellPrice', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),

    // EarlySellTime MSPEQ: 3 signals × 5 params = 15
    ...generateMSPEQBounds('earlySellTime', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 1 }, { min: -0.5, max: 0.5, c0Min: 0.1, c0Max: 0.4 }),

    // EarlySellPrice MSPEQ: 3 signals × 5 params = 15
    ...generateMSPEQBounds('earlySellPrice', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
};

const quarterlyFirstCandleMSPEQStage2Bounds: ParameterBounds = {
    ...generateMSPEQBounds('buyPrice', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.5, c0Max: 1.5 }),
    ...generateMSPEQBounds('sellPrice', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
    ...generateMSPEQBounds('earlySellTime', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 1 }, { min: -0.5, max: 0.5, c0Min: 0.1, c0Max: 0.4 }),
    ...generateMSPEQBounds('earlySellPrice', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
};

// EarlyBuyerMSPEQ Stage 2 bounds - 6 MSPEQs (buyPrice, sellPrice, cutoffMinute, btcDirection, earlySellTime, earlySellPrice)
const earlyBuyerMSPEQStage2Bounds: ParameterBounds = {
    // TargetBuyPrice MSPEQ: 3 signals × 5 params = 15
    ...generateMSPEQBounds('buyPrice', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.5, c0Max: 1.5 }),

    // TargetSellPrice MSPEQ: 3 signals × 5 params = 15
    ...generateMSPEQBounds('sellPrice', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),

    // CutoffMinute MSPEQ: 3 signals × 5 params = 15
    ...generateMSPEQBounds('cutoffMinute', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),

    // BtcDirection MSPEQ: 3 signals × 5 params = 15
    ...generateMSPEQBounds('btcDirection', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 1 }, { min: -0.5, max: 0.5, c0Min: 0.4, c0Max: 0.6 }),

    // EarlySellTime MSPEQ: 3 signals × 5 params = 15
    ...generateMSPEQBounds('earlySellTime', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 1 }, { min: -0.5, max: 0.5, c0Min: 0.1, c0Max: 0.4 }),

    // EarlySellPrice MSPEQ: 3 signals × 5 params = 15
    ...generateMSPEQBounds('earlySellPrice', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
};

const quarterlyEarlyBuyerMSPEQStage2Bounds: ParameterBounds = {
    ...generateMSPEQBounds('buyPrice', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.5, c0Max: 1.5 }),
    ...generateMSPEQBounds('sellPrice', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
    ...generateMSPEQBounds('cutoffMinute', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
    ...generateMSPEQBounds('btcDirection', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 1 }, { min: -0.5, max: 0.5, c0Min: 0.4, c0Max: 0.6 }),
    ...generateMSPEQBounds('earlySellTime', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 1 }, { min: -0.5, max: 0.5, c0Min: 0.1, c0Max: 0.4 }),
    ...generateMSPEQBounds('earlySellPrice', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
};

// MarketMakerMSPEQ Stage 2 bounds - 6 MSPEQs (profitMargin, spreadDistance, stopLossAmount, cutoffMinute, minPrice, maxPrice)
const marketMakerMSPEQStage2Bounds: ParameterBounds = {
    // ProfitMargin MSPEQ: 3 signals × 5 params = 15
    ...generateMSPEQBounds('profitMargin', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),

    // SpreadDistance MSPEQ: 3 signals × 5 params = 15
    ...generateMSPEQBounds('spreadDistance', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),

    // StopLossAmount MSPEQ: 3 signals × 5 params = 15
    ...generateMSPEQBounds('stopLossAmount', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),

    // CutoffMinute MSPEQ: 3 signals × 5 params = 15
    ...generateMSPEQBounds('cutoffMinute', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),

    // MinPrice MSPEQ: 3 signals × 5 params = 15
    ...generateMSPEQBounds('minPrice', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),

    // MaxPrice MSPEQ: 3 signals × 5 params = 15
    ...generateMSPEQBounds('maxPrice', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
};

const quarterlyMarketMakerMSPEQStage2Bounds: ParameterBounds = {
    ...generateMSPEQBounds('profitMargin', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
    ...generateMSPEQBounds('spreadDistance', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
    ...generateMSPEQBounds('stopLossAmount', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
    ...generateMSPEQBounds('cutoffMinute', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
    ...generateMSPEQBounds('minPrice', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
    ...generateMSPEQBounds('maxPrice', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
};

// NCandleMSPEQ Stage 2 bounds - 5 MSPEQs (buyPriceBuffer, minProfitMargin, stoplossTimeout, sellTimeout, stoplossFailureTimeout)
const nCandleMSPEQStage2Bounds: ParameterBounds = {
    // BuyPriceBuffer MSPEQ: 3 signals × 5 params = 15
    ...generateMSPEQBounds('buyPriceBuffer', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),

    // MinProfitMargin MSPEQ: 3 signals × 5 params = 15
    ...generateMSPEQBounds('minProfitMargin', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),

    // StoplossTimeout MSPEQ: 3 signals × 5 params = 15
    ...generateMSPEQBounds('stoplossTimeout', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),

    // SellTimeout MSPEQ: 3 signals × 5 params = 15
    ...generateMSPEQBounds('sellTimeout', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),

    // StoplossFailureTimeout MSPEQ: 3 signals × 5 params = 15
    ...generateMSPEQBounds('stoplossFailureTimeout', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
};

const quarterlyNCandleMSPEQStage2Bounds: ParameterBounds = {
    ...generateMSPEQBounds('buyPriceBuffer', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
    ...generateMSPEQBounds('minProfitMargin', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
    ...generateMSPEQBounds('stoplossTimeout', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
    ...generateMSPEQBounds('sellTimeout', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
    ...generateMSPEQBounds('stoplossFailureTimeout', [...MSPEQ_SIGNAL_NAMES], { min: 0, max: 2 }, { min: -1, max: 1, c0Min: 0.8, c0Max: 1.2 }),
};

/** Base parameter names that get frozen in Stage 2 for FirstCandleMSPEQ */
const MSPEQ_BASE_PARAM_NAMES = [
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
const EARLYBUYER_MSPEQ_BASE_PARAM_NAMES = [
    'targetDollars',
    'baseBuyPrice',
    'baseSellPrice',
    'baseCutoffMinute',
    'candleSizeReference',
    'minProfitMargin',
    'directionThreshold',
] as const;

/** Base parameter names that get frozen in Stage 2 for MarketMakerMSPEQ */
const MARKETMAKER_MSPEQ_BASE_PARAM_NAMES = [
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
const NCANDLE_MSPEQ_BASE_PARAM_NAMES = [
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

// ============================================================================
// Factory Functions - Using Real Bot Classes
// ============================================================================

const SIM_LOG_DIR = './logs/simulator/bots';

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
        targetBuyPricePEQ: (params.targetBuyPricePEQ as { c0: number; c1: number; c2: number; c3: number }) ?? { c0: 1, c1: 0, c2: 0, c3: 0 },
        targetSellPricePEQ: (params.targetSellPricePEQ as { c0: number; c1: number; c2: number; c3: number }) ?? { c0: 1, c1: 0, c2: 0, c3: 0 },
        earlySellTimePEQ: (params.earlySellTimePEQ as { c0: number; c1: number; c2: number; c3: number }) ?? { c0: 0.2, c1: 0, c2: 0, c3: 0 },
        earlySellPricePEQ: (params.earlySellPricePEQ as { c0: number; c1: number; c2: number; c3: number }) ?? { c0: 1, c1: 0, c2: 0, c3: 0 },
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
            c2: params.buyPriceBufferPEQ_c2 as number ?? 0,
            c3: params.buyPriceBufferPEQ_c3 as number ?? 0,
        }),
        sellPriceBuffer: params.sellPriceBuffer as number ?? 0.02,
        minProfitMargin: params.minProfitMargin as number ?? 0.05,
        minProfitMarginPEQ: new ScalingPEQ({
            c0: params.minProfitMarginPEQ_c0 as number ?? 1.0,
            c1: params.minProfitMarginPEQ_c1 as number ?? 0,
            c2: params.minProfitMarginPEQ_c2 as number ?? 0,
            c3: params.minProfitMarginPEQ_c3 as number ?? 0,
        }),
        stopLossMultiplier: params.stopLossMultiplier as number ?? 1.5,
        stoplossTimeout: params.stoplossTimeout as number ?? 30,
        stoplossTimeoutPEQ: new ScalingPEQ({
            c0: params.stoplossTimeoutPEQ_c0 as number ?? 1.0,
            c1: params.stoplossTimeoutPEQ_c1 as number ?? 0,
            c2: params.stoplossTimeoutPEQ_c2 as number ?? 0,
            c3: params.stoplossTimeoutPEQ_c3 as number ?? 0,
        }),
        sellTimeout: params.sellTimeout as number ?? 300,
        sellTimeoutPEQ: new ScalingPEQ({
            c0: params.sellTimeoutPEQ_c0 as number ?? 1.0,
            c1: params.sellTimeoutPEQ_c1 as number ?? 0,
            c2: params.sellTimeoutPEQ_c2 as number ?? 0,
            c3: params.sellTimeoutPEQ_c3 as number ?? 0,
        }),
        stoplossFailureTimeout: params.stoplossFailureTimeout as number ?? 15,
        stoplossFailureTimeoutPEQ: new ScalingPEQ({
            c0: params.stoplossFailureTimeoutPEQ_c0 as number ?? 1.0,
            c1: params.stoplossFailureTimeoutPEQ_c1 as number ?? 0,
            c2: params.stoplossFailureTimeoutPEQ_c2 as number ?? 0,
            c3: params.stoplossFailureTimeoutPEQ_c3 as number ?? 0,
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
        targetBuyPricePEQ: (params.targetBuyPricePEQ as { c0: number; c1: number; c2: number; c3: number }) ?? { c0: 1, c1: 0, c2: 0, c3: 0 },
        targetSellPricePEQ: (params.targetSellPricePEQ as { c0: number; c1: number; c2: number; c3: number }) ?? { c0: 1, c1: 0, c2: 0, c3: 0 },
        earlySellTimePEQ: (params.earlySellTimePEQ as { c0: number; c1: number; c2: number; c3: number }) ?? { c0: 0.2, c1: 0, c2: 0, c3: 0 },
        earlySellPricePEQ: (params.earlySellPricePEQ as { c0: number; c1: number; c2: number; c3: number }) ?? { c0: 1, c1: 0, c2: 0, c3: 0 },
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
            c2: params.buyPriceBufferPEQ_c2 as number ?? 0,
            c3: params.buyPriceBufferPEQ_c3 as number ?? 0,
        }),
        sellPriceBuffer: params.sellPriceBuffer as number ?? 0.02,
        minProfitMargin: params.minProfitMargin as number ?? 0.05,
        minProfitMarginPEQ: new ScalingPEQ({
            c0: params.minProfitMarginPEQ_c0 as number ?? 1.0,
            c1: params.minProfitMarginPEQ_c1 as number ?? 0,
            c2: params.minProfitMarginPEQ_c2 as number ?? 0,
            c3: params.minProfitMarginPEQ_c3 as number ?? 0,
        }),
        stopLossMultiplier: params.stopLossMultiplier as number ?? 1.5,
        stoplossTimeout: params.stoplossTimeout as number ?? 15,
        stoplossTimeoutPEQ: new ScalingPEQ({
            c0: params.stoplossTimeoutPEQ_c0 as number ?? 1.0,
            c1: params.stoplossTimeoutPEQ_c1 as number ?? 0,
            c2: params.stoplossTimeoutPEQ_c2 as number ?? 0,
            c3: params.stoplossTimeoutPEQ_c3 as number ?? 0,
        }),
        sellTimeout: params.sellTimeout as number ?? 120,
        sellTimeoutPEQ: new ScalingPEQ({
            c0: params.sellTimeoutPEQ_c0 as number ?? 1.0,
            c1: params.sellTimeoutPEQ_c1 as number ?? 0,
            c2: params.sellTimeoutPEQ_c2 as number ?? 0,
            c3: params.sellTimeoutPEQ_c3 as number ?? 0,
        }),
        stoplossFailureTimeout: params.stoplossFailureTimeout as number ?? 15,
        stoplossFailureTimeoutPEQ: new ScalingPEQ({
            c0: params.stoplossFailureTimeoutPEQ_c0 as number ?? 1.0,
            c1: params.stoplossFailureTimeoutPEQ_c1 as number ?? 0,
            c2: params.stoplossFailureTimeoutPEQ_c2 as number ?? 0,
            c3: params.stoplossFailureTimeoutPEQ_c3 as number ?? 0,
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
        // Timeout parameters with polynomial scaling
        sellTimeout: params.sellTimeout as number ?? 30,
        sellTimeoutPEQ: new ScalingPEQ({
            c0: params.sellTimeoutPEQ_c0 as number ?? 1.0,
            c1: params.sellTimeoutPEQ_c1 as number ?? 0,
            c2: params.sellTimeoutPEQ_c2 as number ?? 0,
            c3: params.sellTimeoutPEQ_c3 as number ?? 0,
        }),
        stoplossCheckTimeout: params.stoplossCheckTimeout as number ?? 10,
        stoplossCheckTimeoutPEQ: new ScalingPEQ({
            c0: params.stoplossCheckTimeoutPEQ_c0 as number ?? 1.0,
            c1: params.stoplossCheckTimeoutPEQ_c1 as number ?? 0,
            c2: params.stoplossCheckTimeoutPEQ_c2 as number ?? 0,
            c3: params.stoplossCheckTimeoutPEQ_c3 as number ?? 0,
        }),
        stoplossFailureTimeout: params.stoplossFailureTimeout as number ?? 15,
        stoplossFailureTimeoutPEQ: new ScalingPEQ({
            c0: params.stoplossFailureTimeoutPEQ_c0 as number ?? 1.0,
            c1: params.stoplossFailureTimeoutPEQ_c1 as number ?? 0,
            c2: params.stoplossFailureTimeoutPEQ_c2 as number ?? 0,
            c3: params.stoplossFailureTimeoutPEQ_c3 as number ?? 0,
        }),
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
        // Timeout parameters with polynomial scaling (shorter defaults for quarterly)
        sellTimeout: params.sellTimeout as number ?? 15,
        sellTimeoutPEQ: new ScalingPEQ({
            c0: params.sellTimeoutPEQ_c0 as number ?? 1.0,
            c1: params.sellTimeoutPEQ_c1 as number ?? 0,
            c2: params.sellTimeoutPEQ_c2 as number ?? 0,
            c3: params.sellTimeoutPEQ_c3 as number ?? 0,
        }),
        stoplossCheckTimeout: params.stoplossCheckTimeout as number ?? 5,
        stoplossCheckTimeoutPEQ: new ScalingPEQ({
            c0: params.stoplossCheckTimeoutPEQ_c0 as number ?? 1.0,
            c1: params.stoplossCheckTimeoutPEQ_c1 as number ?? 0,
            c2: params.stoplossCheckTimeoutPEQ_c2 as number ?? 0,
            c3: params.stoplossCheckTimeoutPEQ_c3 as number ?? 0,
        }),
        stoplossFailureTimeout: params.stoplossFailureTimeout as number ?? 8,
        stoplossFailureTimeoutPEQ: new ScalingPEQ({
            c0: params.stoplossFailureTimeoutPEQ_c0 as number ?? 1.0,
            c1: params.stoplossFailureTimeoutPEQ_c1 as number ?? 0,
            c2: params.stoplossFailureTimeoutPEQ_c2 as number ?? 0,
            c3: params.stoplossFailureTimeoutPEQ_c3 as number ?? 0,
        }),
    });

    return new QuantBotSimulationAdapter(bot, clock, marketInfo);
}

// ============================================================================
// FirstCandleMSPEQ Factory Functions
// ============================================================================

/**
 * Helper to build MSPEQ config from flat params
 */
function buildMSPEQConfig(
    prefix: string,
    params: Record<string, unknown>,
    signalNames: readonly string[]
): { signals: Array<{ name: string; weight: number; coefficients: { c0: number; c1: number; c2: number; c3: number }; normalize?: { min: number; max: number } }> } {
    const signals = signalNames.map(name => ({
        name,
        weight: params[`${prefix}_${name}_w`] as number ?? 1.0,
        coefficients: {
            c0: params[`${prefix}_${name}_c0`] as number ?? 1.0,
            c1: params[`${prefix}_${name}_c1`] as number ?? 0,
            c2: params[`${prefix}_${name}_c2`] as number ?? 0,
            c3: params[`${prefix}_${name}_c3`] as number ?? 0,
        },
        normalize: STANDARD_NORMALIZATIONS[name as keyof typeof STANDARD_NORMALIZATIONS],
    }));
    return { signals };
}

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
        // Base parameters
        candleMinutes: params.candleMinutes as number ?? 15,
        breakoutBuffer: params.breakoutBuffer as number ?? 50,
        pullbackBuffer: params.pullbackBuffer as number ?? 100,
        targetDollars: params.targetDollars as number ?? 10,
        cutoffMinute: params.cutoffMinute as number ?? 45,
        candleSizeReference: params.candleSizeReference as number ?? 1000,
        baseBuyPrice: params.baseBuyPrice as number ?? 0.50,
        minProfitMargin: params.minProfitMargin as number ?? 0.10,
        // Multi-Signal PEQ configs
        targetBuyPriceMSPEQ: buildMSPEQConfig('buyPrice', params, MSPEQ_SIGNAL_NAMES),
        targetSellPriceMSPEQ: buildMSPEQConfig('sellPrice', params, MSPEQ_SIGNAL_NAMES),
        earlySellTimeMSPEQ: buildMSPEQConfig('earlySellTime', params, MSPEQ_SIGNAL_NAMES),
        earlySellPriceMSPEQ: buildMSPEQConfig('earlySellPrice', params, MSPEQ_SIGNAL_NAMES),
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
        // Base parameters
        candleMinutes: params.candleMinutes as number ?? 5,
        breakoutBuffer: params.breakoutBuffer as number ?? 50,
        pullbackBuffer: params.pullbackBuffer as number ?? 100,
        targetDollars: params.targetDollars as number ?? 10,
        cutoffMinute: params.cutoffMinute as number ?? 12,
        candleSizeReference: params.candleSizeReference as number ?? 1000,
        baseBuyPrice: params.baseBuyPrice as number ?? 0.50,
        minProfitMargin: params.minProfitMargin as number ?? 0.10,
        // Multi-Signal PEQ configs
        targetBuyPriceMSPEQ: buildMSPEQConfig('buyPrice', params, MSPEQ_SIGNAL_NAMES),
        targetSellPriceMSPEQ: buildMSPEQConfig('sellPrice', params, MSPEQ_SIGNAL_NAMES),
        earlySellTimeMSPEQ: buildMSPEQConfig('earlySellTime', params, MSPEQ_SIGNAL_NAMES),
        earlySellPriceMSPEQ: buildMSPEQConfig('earlySellPrice', params, MSPEQ_SIGNAL_NAMES),
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
        // Base parameters
        targetDollars: params.targetDollars as number ?? 10,
        baseBuyPrice: params.baseBuyPrice as number ?? 0.40,
        baseSellPrice: params.baseSellPrice as number ?? 0.70,
        baseCutoffMinute: params.baseCutoffMinute as number ?? 30,
        candleSizeReference: params.candleSizeReference as number ?? 200,
        minProfitMargin: params.minProfitMargin as number ?? 0.20,
        directionThreshold: params.directionThreshold as number ?? 0.5,
        // Multi-Signal PEQ configs (6 MSPEQs)
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
        // Base parameters (quarterly defaults)
        targetDollars: params.targetDollars as number ?? 10,
        baseBuyPrice: params.baseBuyPrice as number ?? 0.40,
        baseSellPrice: params.baseSellPrice as number ?? 0.70,
        baseCutoffMinute: params.baseCutoffMinute as number ?? 10,
        candleSizeReference: params.candleSizeReference as number ?? 200,
        minProfitMargin: params.minProfitMargin as number ?? 0.20,
        directionThreshold: params.directionThreshold as number ?? 0.5,
        // Multi-Signal PEQ configs (6 MSPEQs)
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
        // Base parameters
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
        // Multi-Signal PEQ configs (6 MSPEQs)
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
        // Base parameters (quarterly defaults)
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
        // Multi-Signal PEQ configs (6 MSPEQs)
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
        // Base parameters
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
        // Multi-Signal PEQ configs (5 MSPEQs)
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
        // Base parameters (quarterly defaults)
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
        // Multi-Signal PEQ configs (5 MSPEQs)
        buyPriceBufferMSPEQ: buildMSPEQConfig('buyPriceBuffer', params, MSPEQ_SIGNAL_NAMES),
        minProfitMarginMSPEQ: buildMSPEQConfig('minProfitMargin', params, MSPEQ_SIGNAL_NAMES),
        stoplossTimeoutMSPEQ: buildMSPEQConfig('stoplossTimeout', params, MSPEQ_SIGNAL_NAMES),
        sellTimeoutMSPEQ: buildMSPEQConfig('sellTimeout', params, MSPEQ_SIGNAL_NAMES),
        stoplossFailureTimeoutMSPEQ: buildMSPEQConfig('stoplossFailureTimeout', params, MSPEQ_SIGNAL_NAMES),
    });

    return new QuantBotSimulationAdapter(bot, clock, marketInfo);
}

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
    { name: 'EarlyBuyerMSPEQ', factory: createEarlyBuyerMSPEQBot, bounds: earlyBuyerMSPEQStage2Bounds },
    { name: 'QuarterlyEarlyBuyerMSPEQ', factory: createQuarterlyEarlyBuyerMSPEQBot, bounds: quarterlyEarlyBuyerMSPEQStage2Bounds },
    // MarketMakerMSPEQ Strategies (6 MSPEQs)
    { name: 'MarketMakerMSPEQ', factory: createMarketMakerMSPEQBot, bounds: marketMakerMSPEQStage2Bounds },
    { name: 'QuarterlyMarketMakerMSPEQ', factory: createQuarterlyMarketMakerMSPEQBot, bounds: quarterlyMarketMakerMSPEQStage2Bounds },
    // NCandleMSPEQ Strategies (5 MSPEQs)
    { name: 'NCandleMSPEQ', factory: createNCandleMSPEQBot, bounds: nCandleMSPEQStage2Bounds },
    { name: 'QuarterlyNCandleMSPEQ', factory: createQuarterlyNCandleMSPEQBot, bounds: quarterlyNCandleMSPEQStage2Bounds },
];

// ============================================================================
// YAML Configuration Interface
// ============================================================================

interface YamlConfig {
    strategy: string;
    market?: string;
    coin?: string;
    days?: number;
    params: Record<string, number>;
}

// ============================================================================
// YAML-Based Custom Parameter Simulation
// ============================================================================

async function runYamlSimulation(yamlPath: string): Promise<void> {
    // 1. Read and parse YAML file
    let yamlContent: string;
    try {
        yamlContent = fs.readFileSync(yamlPath, 'utf-8');
    } catch (error) {
        console.error(`Error reading YAML file: ${yamlPath}`);
        console.error(error);
        process.exit(1);
    }

    let config: YamlConfig;
    try {
        config = YAML.parse(yamlContent) as YamlConfig;
    } catch (error) {
        console.error(`Error parsing YAML file: ${yamlPath}`);
        console.error(error);
        process.exit(1);
    }

    // 2. Validate required fields
    if (!config.strategy) {
        console.error('Error: YAML file must specify a "strategy" field');
        process.exit(1);
    }
    if (!config.params || Object.keys(config.params).length === 0) {
        console.error('Error: YAML file must specify "params" with at least one parameter');
        process.exit(1);
    }

    // 3. Look up strategy factory
    const strategy = geneticStrategies.find(
        s => s.name.toLowerCase() === config.strategy.toLowerCase()
    );
    if (!strategy) {
        console.error(`Error: Unknown strategy "${config.strategy}"`);
        console.log('Available strategies: ' + geneticStrategies.map(s => s.name).join(', '));
        process.exit(1);
    }

    // 4. Determine market and coin type
    let targetedMarket = TargetedMarket.BITCOIN_HOURLY;
    let coinType = CoinType.BTC;

    if (config.market) {
        const marketArg = config.market.toLowerCase();
        if (marketArg === 'btc-hourly' || marketArg === 'bitcoin-hourly') {
            targetedMarket = TargetedMarket.BITCOIN_HOURLY;
            coinType = CoinType.BTC;
        } else if (marketArg === 'btc-quarterly' || marketArg === 'bitcoin-quarterly') {
            targetedMarket = TargetedMarket.BITCOIN_QUARTERLY;
            coinType = CoinType.BTC;
        } else if (marketArg === 'eth-hourly' || marketArg === 'ethereum-hourly') {
            targetedMarket = TargetedMarket.ETHEREUM_HOURLY;
            coinType = CoinType.ETH;
        } else if (marketArg === 'eth-quarterly' || marketArg === 'ethereum-quarterly') {
            targetedMarket = TargetedMarket.ETHEREUM_QUARTERLY;
            coinType = CoinType.ETH;
        } else if (marketArg === 'sol-quarterly' || marketArg === 'solana-quarterly') {
            targetedMarket = TargetedMarket.SOLANA_QUARTERLY;
            coinType = CoinType.SOL;
        } else if (marketArg === 'sol-hourly' || marketArg === 'solana-hourly') {
            targetedMarket = TargetedMarket.SOLANA_HOURLY;
            coinType = CoinType.SOL;
        } else if (marketArg === 'xrp-hourly') {
            targetedMarket = TargetedMarket.XRP_HOURLY;
            coinType = CoinType.XRP;
        } else if (marketArg === 'xrp-quarterly') {
            targetedMarket = TargetedMarket.XRP_QUARTERLY;
            coinType = CoinType.XRP;
        } else {
            console.error(`Invalid market: ${config.market}`);
            process.exit(1);
        }
    }

    // Override coin if explicitly specified
    if (config.coin) {
        const coinArg = config.coin.toLowerCase();
        if (coinArg === 'btc') coinType = CoinType.BTC;
        else if (coinArg === 'eth') coinType = CoinType.ETH;
        else if (coinArg === 'sol') coinType = CoinType.SOL;
        else if (coinArg === 'xrp') coinType = CoinType.XRP;
        else {
            console.error(`Invalid coin type: ${config.coin}`);
            process.exit(1);
        }
    }

    const lookbackDays = config.days ?? 7;

    // 5. Print header
    console.log('');
    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║         CUSTOM PARAMETER SIMULATION - Historical Sim       ║');
    console.log('╚════════════════════════════════════════════════════════════╝');

    console.log('\nConfiguration:');
    console.log(`  YAML File: ${yamlPath}`);
    console.log(`  Strategy: ${strategy.name}`);
    console.log(`  Coin Type: ${coinType.toUpperCase()}`);
    console.log(`  Market: ${targetedMarket}`);
    console.log(`  Lookback Days: ${lookbackDays}`);

    console.log('\nParameters:');
    for (const [key, value] of Object.entries(config.params)) {
        console.log(`  ${key}: ${value}`);
    }

    // 6. Create simulator
    const simulator = new HistoricalSimulator({
        lookbackDays,
        tickIntervalMs: 5 * 1000,
        coinType,
        targetedMarket,
    });

    console.log('\nRunning simulation...');

    // 7. Run single simulation
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const logDirectory = `./logs/simulator/audit/yaml-${strategy.name.toLowerCase()}-${timestamp}`;

    const { result, trades } = await simulator.runSingleSimulation(
        strategy.name,
        strategy.factory,
        config.params,
        { shouldWriteLogs: true, logDirectory }
    );

    // 8. Print results
    console.log('\nResults:');
    console.log(`  Total Trades: ${result.totalTrades}`);
    console.log(`  Matched Trades: ${result.matchedTrades}`);
    console.log(`  Expired Trades: ${result.expiredTrades}`);
    console.log(`  Total PnL: $${result.totalPnl.toFixed(2)}`);
    console.log(`  Win Rate: ${result.winRate.toFixed(2)}%`);
    console.log(`  Avg PnL: $${result.avgPnl.toFixed(2)}`);
    console.log(`  Max Drawdown: $${result.maxDrawdown.toFixed(2)}`);
    console.log(`  Sharpe Ratio: ${result.sharpeRatio.toFixed(2)}`);

    // 9. Generate trade audit
    const logger = new SimulatorLogger(`yaml-${strategy.name.toLowerCase()}`);
    logger.writeSimulatedTradeAudits(strategy.name, trades, logDirectory);

    console.log(`\nTrade audit written to: ${logDirectory}`);
    console.log('\n✓ Simulation complete\n');
}

// ============================================================================
// Two-Stage Optimization for MSPEQ Strategies
// ============================================================================

interface TwoStageConfig {
    lookbackDays: number;
    populationSize: number;
    maxGenerations: number;
    convergenceThreshold: number;
    coinType: CoinType;
    targetedMarket: TargetedMarket;
    auditTradesCount: number;
    isQuarterly: boolean;
}

/**
 * Runs two-stage optimization for MSPEQ strategies:
 * Stage 1: Optimize base parameters using FirstCandle (fast, ~12 params)
 * Stage 2: Freeze base params, optimize only MSPEQ coefficients (~60 params)
 */
async function runTwoStageOptimization(config: TwoStageConfig): Promise<void> {
    const logger = new SimulatorLogger(`two-stage-${config.coinType}`);

    logger.log('');
    logger.log('╔════════════════════════════════════════════════════════════╗');
    logger.log('║     TWO-STAGE MSPEQ OPTIMIZATION - Historical Sim          ║');
    logger.log('╚════════════════════════════════════════════════════════════╝');
    logger.log('');
    logger.log('Stage 1: Optimize base parameters with FirstCandle');
    logger.log('Stage 2: Freeze base params, optimize MSPEQ coefficients');
    logger.log('');

    // ========== STAGE 1: Optimize base parameters ==========
    logger.log('═══════════════════════════════════════════════════════════════');
    logger.log('STAGE 1: Base Parameter Optimization (FirstCandle)');
    logger.log('═══════════════════════════════════════════════════════════════');

    const stage1Simulator = new HistoricalSimulator({
        lookbackDays: config.lookbackDays,
        tickIntervalMs: 5 * 1000,
        coinType: config.coinType,
        targetedMarket: config.targetedMarket,
        auditTradesCount: 0, // No audit in Stage 1
    });

    // Use FirstCandle or QuarterlyFirstCandle based on market type
    const stage1Strategy = config.isQuarterly
        ? geneticStrategies.find(s => s.name === 'QuarterlyFirstCandle')!
        : geneticStrategies.find(s => s.name === 'FirstCandle')!;

    const stage1GeneticConfig = {
        populationSize: Math.min(config.populationSize, 100), // Cap Stage 1 population
        maxGenerations: Math.min(config.maxGenerations, 50),  // Cap Stage 1 generations
        convergenceThreshold: config.convergenceThreshold,
        convergenceGenerations: 5,
        mutationRate: 0.25,
        mutationStrength: 0.3,
        eliteCount: 2,
        crossoverRate: 0.7,
    };

    logger.log(`\nConfiguration:`);
    logger.log(`  Strategy: ${stage1Strategy.name}`);
    logger.log(`  Population: ${stage1GeneticConfig.populationSize}`);
    logger.log(`  Max Generations: ${stage1GeneticConfig.maxGenerations}`);
    logger.log(`  Parameters: ~12 (base only)`);

    const stage1Result = await stage1Simulator.runGeneticOptimization(
        stage1Strategy.name,
        stage1Strategy.factory,
        stage1Strategy.bounds,
        stage1GeneticConfig
    );

    const stage1BestParams = stage1Result.bestIndividual.params;
    const stage1Fitness = stage1Result.bestIndividual.fitness;

    logger.log(`\nStage 1 Complete!`);
    logger.log(`  Best Fitness: $${stage1Fitness.toFixed(2)}`);
    logger.log(`  Generations: ${stage1Result.totalGenerations}`);
    logger.log(`  Converged: ${stage1Result.converged} (${stage1Result.convergenceReason})`);
    logger.log(`\nFrozen Base Parameters:`);
    for (const paramName of MSPEQ_BASE_PARAM_NAMES) {
        if (stage1BestParams[paramName] !== undefined) {
            logger.log(`  ${paramName}: ${stage1BestParams[paramName]}`);
        }
    }

    // ========== STAGE 2: Optimize MSPEQ coefficients ==========
    logger.log('\n═══════════════════════════════════════════════════════════════');
    logger.log('STAGE 2: MSPEQ Coefficient Optimization (base params frozen)');
    logger.log('═══════════════════════════════════════════════════════════════');

    const stage2Simulator = new HistoricalSimulator({
        lookbackDays: config.lookbackDays,
        tickIntervalMs: 5 * 1000,
        coinType: config.coinType,
        targetedMarket: config.targetedMarket,
        auditTradesCount: config.auditTradesCount,
    });

    // Get Stage 2 bounds (MSPEQ only)
    const stage2Bounds = config.isQuarterly
        ? quarterlyFirstCandleMSPEQStage2Bounds
        : firstCandleMSPEQStage2Bounds;

    // Create a factory that injects frozen base params
    const stage2StrategyName = config.isQuarterly ? 'QuarterlyFirstCandleMSPEQ' : 'FirstCandleMSPEQ';
    const stage2Factory = config.isQuarterly ? createQuarterlyFirstCandleMSPEQBot : createFirstCandleMSPEQBot;

    // Create wrapper factory that merges frozen base params with MSPEQ params
    const stage2FactoryWithFrozenParams = (botParams: BotParams): SimulatedBot => {
        // Merge frozen base params from Stage 1 with MSPEQ params from Stage 2
        const mergedParams = {
            ...botParams,
            params: {
                ...stage1BestParams,  // Frozen base params
                ...botParams.params,   // MSPEQ params being optimized
            }
        };
        return stage2Factory(mergedParams);
    };

    const stage2GeneticConfig = {
        populationSize: config.populationSize,
        maxGenerations: config.maxGenerations,
        convergenceThreshold: config.convergenceThreshold,
        convergenceGenerations: 5,
        mutationRate: 0.25,
        mutationStrength: 0.3,
        eliteCount: 2,
        crossoverRate: 0.7,
    };

    const stage2ParamCount = Object.keys(stage2Bounds).length;
    logger.log(`\nConfiguration:`);
    logger.log(`  Strategy: ${stage2StrategyName}`);
    logger.log(`  Population: ${stage2GeneticConfig.populationSize}`);
    logger.log(`  Max Generations: ${stage2GeneticConfig.maxGenerations}`);
    logger.log(`  Parameters: ${stage2ParamCount} (MSPEQ only)`);

    const stage2Result = await stage2Simulator.runGeneticOptimization(
        stage2StrategyName + '-Stage2',
        stage2FactoryWithFrozenParams,
        stage2Bounds,
        stage2GeneticConfig
    );

    const stage2BestParams = stage2Result.bestIndividual.params;
    const stage2Fitness = stage2Result.bestIndividual.fitness;

    // ========== FINAL RESULTS ==========
    logger.log('\n═══════════════════════════════════════════════════════════════');
    logger.log('TWO-STAGE OPTIMIZATION COMPLETE');
    logger.log('═══════════════════════════════════════════════════════════════');

    logger.log(`\nPerformance Comparison:`);
    logger.log(`  Stage 1 (FirstCandle base):     $${stage1Fitness.toFixed(2)}`);
    logger.log(`  Stage 2 (with MSPEQ):           $${stage2Fitness.toFixed(2)}`);
    logger.log(`  Improvement:                    $${(stage2Fitness - stage1Fitness).toFixed(2)} (${((stage2Fitness / stage1Fitness - 1) * 100).toFixed(1)}%)`);

    // Combine all params for final output
    const finalParams = {
        ...stage1BestParams,
        ...stage2BestParams,
    };

    logger.log(`\nFinal Combined Parameters:`);
    logger.log('--- Base Parameters (from Stage 1) ---');
    for (const paramName of MSPEQ_BASE_PARAM_NAMES) {
        if (finalParams[paramName] !== undefined) {
            logger.log(`  ${paramName}: ${finalParams[paramName]}`);
        }
    }

    logger.log('\n--- MSPEQ Parameters (from Stage 2) ---');
    for (const [key, value] of Object.entries(stage2BestParams)) {
        logger.log(`  ${key}: ${value}`);
    }

    // Save combined params to YAML
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const yamlOutput = {
        strategy: stage2StrategyName,
        market: config.isQuarterly ? 'btc-quarterly' : 'btc-hourly',
        coin: config.coinType,
        days: config.lookbackDays,
        twoStageOptimization: {
            stage1Fitness: stage1Fitness,
            stage2Fitness: stage2Fitness,
            improvement: stage2Fitness - stage1Fitness,
        },
        params: finalParams,
    };

    const yamlPath = `./logs/simulator/two-stage-${stage2StrategyName.toLowerCase()}-${timestamp}.yaml`;
    fs.writeFileSync(yamlPath, YAML.stringify(yamlOutput));
    logger.log(`\nParameters saved to: ${yamlPath}`);

    // Copy logs to audit directory if audit mode was used
    const auditLogDir = stage2Simulator.getLastAuditLogDir();
    if (auditLogDir) {
        logger.copyLogsToDirectory(auditLogDir);
        logger.log(`\nAll logs consolidated to: ${auditLogDir}`);
    }

    logger.log('\n✓ Two-stage optimization complete\n');
    logger.log(`Results saved to: ${logger.getLogFilePath()}`);
}

// ============================================================================
// Stage 2 Only Optimization (with user-supplied base params)
// ============================================================================

interface Stage2OnlyConfig {
    lookbackDays: number;
    populationSize: number;
    maxGenerations: number;
    convergenceThreshold: number;
    coinType: CoinType;
    targetedMarket: TargetedMarket;
    auditTradesCount: number;
    isQuarterly: boolean;
    baseParamsFile: string;
    strategyFilter?: string;  // Optional: 'EarlyBuyerMSPEQ', 'FirstCandleMSPEQ', etc.
}

/**
 * Runs Stage 2 only optimization using user-supplied base parameters.
 * Useful for experimenting with MSPEQ coefficients after finding good base params.
 */
async function runStage2OnlyOptimization(config: Stage2OnlyConfig): Promise<void> {
    const logger = new SimulatorLogger(`stage2-only-${config.coinType}`);

    logger.log('');
    logger.log('╔════════════════════════════════════════════════════════════╗');
    logger.log('║     STAGE 2 ONLY - MSPEQ Coefficient Optimization          ║');
    logger.log('╚════════════════════════════════════════════════════════════╝');
    logger.log('');

    // Load base params from YAML file
    let baseParams: Record<string, number>;
    try {
        const yamlContent = fs.readFileSync(config.baseParamsFile, 'utf-8');
        const parsed = YAML.parse(yamlContent) as { params?: Record<string, number> } | Record<string, number>;

        // Support both flat format and nested { params: {...} } format
        if (parsed.params && typeof parsed.params === 'object') {
            baseParams = parsed.params as Record<string, number>;
        } else {
            baseParams = parsed as Record<string, number>;
        }

        logger.log(`Loaded base parameters from: ${config.baseParamsFile}`);
    } catch (error) {
        logger.error(`Failed to load base params from ${config.baseParamsFile}: ${error}`);
        process.exit(1);
    }

    // Detect strategy type from filter or base params file path
    const isEarlyBuyerMSPEQ = config.strategyFilter?.toLowerCase().includes('earlybuyermspeq') ||
        config.baseParamsFile.toLowerCase().includes('earlybuyer');
    const isMarketMakerMSPEQ = config.strategyFilter?.toLowerCase().includes('marketmakermspeq') ||
        config.baseParamsFile.toLowerCase().includes('marketmaker');
    const isNCandleMSPEQ = config.strategyFilter?.toLowerCase().includes('ncandlemspeq') ||
        config.baseParamsFile.toLowerCase().includes('ncandle');

    // Select appropriate base param names based on strategy
    let baseParamNames: readonly string[];
    if (isMarketMakerMSPEQ) {
        baseParamNames = MARKETMAKER_MSPEQ_BASE_PARAM_NAMES;
    } else if (isNCandleMSPEQ) {
        baseParamNames = NCANDLE_MSPEQ_BASE_PARAM_NAMES;
    } else if (isEarlyBuyerMSPEQ) {
        baseParamNames = EARLYBUYER_MSPEQ_BASE_PARAM_NAMES;
    } else {
        baseParamNames = MSPEQ_BASE_PARAM_NAMES;
    }

    // Extract and validate base params
    const frozenBaseParams: Record<string, number> = {};
    logger.log('\nFrozen Base Parameters:');
    for (const paramName of baseParamNames) {
        if (baseParams[paramName] !== undefined) {
            frozenBaseParams[paramName] = baseParams[paramName];
            logger.log(`  ${paramName}: ${baseParams[paramName]}`);
        }
    }

    if (Object.keys(frozenBaseParams).length === 0) {
        logger.error('\nNo valid base parameters found in file!');
        logger.log('Expected parameters: ' + baseParamNames.join(', '));
        process.exit(1);
    }

    // ========== STAGE 2: Optimize MSPEQ coefficients ==========
    logger.log('\n═══════════════════════════════════════════════════════════════');
    logger.log('STAGE 2: MSPEQ Coefficient Optimization (base params frozen)');
    logger.log('═══════════════════════════════════════════════════════════════');

    const simulator = new HistoricalSimulator({
        lookbackDays: config.lookbackDays,
        tickIntervalMs: 5 * 1000,
        coinType: config.coinType,
        targetedMarket: config.targetedMarket,
        auditTradesCount: config.auditTradesCount,
    });

    // Get Stage 2 bounds and factory based on strategy type
    let stage2Bounds: ParameterBounds;
    let stage2StrategyName: string;
    let stage2Factory: (params: BotParams) => SimulatedBot;

    if (isMarketMakerMSPEQ) {
        stage2Bounds = config.isQuarterly
            ? quarterlyMarketMakerMSPEQStage2Bounds
            : marketMakerMSPEQStage2Bounds;
        stage2StrategyName = config.isQuarterly ? 'QuarterlyMarketMakerMSPEQ' : 'MarketMakerMSPEQ';
        stage2Factory = config.isQuarterly ? createQuarterlyMarketMakerMSPEQBot : createMarketMakerMSPEQBot;
        logger.log(`  Strategy Type: MarketMakerMSPEQ (6 MSPEQs, 90 parameters)`);
    } else if (isNCandleMSPEQ) {
        stage2Bounds = config.isQuarterly
            ? quarterlyNCandleMSPEQStage2Bounds
            : nCandleMSPEQStage2Bounds;
        stage2StrategyName = config.isQuarterly ? 'QuarterlyNCandleMSPEQ' : 'NCandleMSPEQ';
        stage2Factory = config.isQuarterly ? createQuarterlyNCandleMSPEQBot : createNCandleMSPEQBot;
        logger.log(`  Strategy Type: NCandleMSPEQ (5 MSPEQs, 75 parameters)`);
    } else if (isEarlyBuyerMSPEQ) {
        stage2Bounds = config.isQuarterly
            ? quarterlyEarlyBuyerMSPEQStage2Bounds
            : earlyBuyerMSPEQStage2Bounds;
        stage2StrategyName = config.isQuarterly ? 'QuarterlyEarlyBuyerMSPEQ' : 'EarlyBuyerMSPEQ';
        stage2Factory = config.isQuarterly ? createQuarterlyEarlyBuyerMSPEQBot : createEarlyBuyerMSPEQBot;
        logger.log(`  Strategy Type: EarlyBuyerMSPEQ (6 MSPEQs, 90 parameters)`);
    } else {
        stage2Bounds = config.isQuarterly
            ? quarterlyFirstCandleMSPEQStage2Bounds
            : firstCandleMSPEQStage2Bounds;
        stage2StrategyName = config.isQuarterly ? 'QuarterlyFirstCandleMSPEQ' : 'FirstCandleMSPEQ';
        stage2Factory = config.isQuarterly ? createQuarterlyFirstCandleMSPEQBot : createFirstCandleMSPEQBot;
        logger.log(`  Strategy Type: FirstCandleMSPEQ (4 MSPEQs, 60 parameters)`);
    }

    // Create wrapper factory that merges frozen base params with MSPEQ params
    const stage2FactoryWithFrozenParams = (botParams: BotParams): SimulatedBot => {
        const mergedParams = {
            ...botParams,
            params: {
                ...frozenBaseParams,
                ...botParams.params,
            }
        };
        return stage2Factory(mergedParams);
    };

    const geneticConfig = {
        populationSize: config.populationSize,
        maxGenerations: config.maxGenerations,
        convergenceThreshold: config.convergenceThreshold,
        convergenceGenerations: 5,
        mutationRate: 0.25,
        mutationStrength: 0.3,
        eliteCount: 2,
        crossoverRate: 0.7,
    };

    const paramCount = Object.keys(stage2Bounds).length;
    logger.log(`\nConfiguration:`);
    logger.log(`  Strategy: ${stage2StrategyName}`);
    logger.log(`  Population: ${geneticConfig.populationSize}`);
    logger.log(`  Max Generations: ${geneticConfig.maxGenerations}`);
    logger.log(`  Parameters: ${paramCount} (MSPEQ only)`);

    const result = await simulator.runGeneticOptimization(
        stage2StrategyName + '-Stage2Only',
        stage2FactoryWithFrozenParams,
        stage2Bounds,
        geneticConfig
    );

    const bestMSPEQParams = result.bestIndividual.params;
    const bestFitness = result.bestIndividual.fitness;

    // ========== RESULTS ==========
    logger.log('\n═══════════════════════════════════════════════════════════════');
    logger.log('STAGE 2 OPTIMIZATION COMPLETE');
    logger.log('═══════════════════════════════════════════════════════════════');

    logger.log(`\nBest Fitness: $${bestFitness.toFixed(2)}`);
    logger.log(`Generations: ${result.totalGenerations}`);
    logger.log(`Converged: ${result.converged} (${result.convergenceReason})`);

    // Combine all params for final output
    const finalParams = {
        ...frozenBaseParams,
        ...bestMSPEQParams,
    };

    logger.log(`\nFinal Combined Parameters:`);
    logger.log('--- Base Parameters (frozen from input) ---');
    for (const paramName of MSPEQ_BASE_PARAM_NAMES) {
        if (finalParams[paramName] !== undefined) {
            logger.log(`  ${paramName}: ${finalParams[paramName]}`);
        }
    }

    logger.log('\n--- MSPEQ Parameters (optimized) ---');
    for (const [key, value] of Object.entries(bestMSPEQParams)) {
        logger.log(`  ${key}: ${value}`);
    }

    // Save combined params to YAML
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const yamlOutput = {
        strategy: stage2StrategyName,
        market: config.isQuarterly ? 'btc-quarterly' : 'btc-hourly',
        coin: config.coinType,
        days: config.lookbackDays,
        stage2Only: {
            baseParamsFile: config.baseParamsFile,
            fitness: bestFitness,
        },
        params: finalParams,
    };

    const yamlPath = `./logs/simulator/stage2-${stage2StrategyName.toLowerCase()}-${timestamp}.yaml`;
    fs.writeFileSync(yamlPath, YAML.stringify(yamlOutput));
    logger.log(`\nParameters saved to: ${yamlPath}`);

    // Copy logs to audit directory if audit mode was used
    const auditLogDir = simulator.getLastAuditLogDir();
    if (auditLogDir) {
        logger.copyLogsToDirectory(auditLogDir);
        logger.log(`\nAll logs consolidated to: ${auditLogDir}`);
    }

    logger.log('\n✓ Stage 2 optimization complete\n');
    logger.log(`Results saved to: ${logger.getLogFilePath()}`);
}

// ============================================================================
// Main Entry Point
// ============================================================================

async function main() {
    // Parse command line arguments
    const args = process.argv.slice(2);
    let lookbackDays = 7;
    let maxGenerations = 50;
    let convergenceThreshold = 1.0;
    let populationSize = 15;
    let strategyFilter: string | null = null;
    let coinType: CoinType = CoinType.BTC;
    let twoStageMode = false;
    let baseParamsFile: string | null = null;
    let auditTradesCount = 0; // Number of top trades to audit (0 = disabled)
    let targetedMarket: TargetedMarket = TargetedMarket.BITCOIN_HOURLY;
    let yamlFilePath: string | null = null;

    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case '--yaml':
            case '-y':
                yamlFilePath = args[i + 1] || null;
                break;
            case '--days':
            case '-d':
                lookbackDays = parseInt(args[i + 1]) || 7;
                break;
            case '--max-gen':
            case '-m':
                maxGenerations = parseInt(args[i + 1]) || 50;
                break;
            case '--threshold':
            case '-t':
                convergenceThreshold = parseFloat(args[i + 1]) || 1.0;
                break;
            case '--population':
            case '-p':
                populationSize = parseInt(args[i + 1]) || 15;
                break;
            case '--strategy':
            case '-s':
                strategyFilter = args[i + 1] || null;
                break;
            case '--coin':
            case '-c':
                {
                    const coinArg = (args[i + 1] || '').toLowerCase();
                    if (coinArg === 'btc') coinType = CoinType.BTC;
                    else if (coinArg === 'eth') coinType = CoinType.ETH;
                    else if (coinArg === 'sol') coinType = CoinType.SOL;
                    else if (coinArg === 'xrp') coinType = CoinType.XRP;
                    else {
                        console.error(`Invalid coin type: ${args[i + 1]}. Valid options: btc, eth, sol, xrp`);
                        process.exit(1);
                    }
                    break;
                }
            case '--audit-trades':
            case '-a':
                auditTradesCount = parseInt(args[i + 1]) || 10;
                break;
            case '--market':
            case '-M':
                {
                    const marketArg = (args[i + 1] || '').toLowerCase();
                    if (marketArg === 'btc-hourly' || marketArg === 'bitcoin-hourly') {
                        targetedMarket = TargetedMarket.BITCOIN_HOURLY;
                    } else if (marketArg === 'btc-quarterly' || marketArg === 'bitcoin-quarterly') {
                        targetedMarket = TargetedMarket.BITCOIN_QUARTERLY;
                    } else if (marketArg === 'eth-hourly' || marketArg === 'ethereum-hourly') {
                        targetedMarket = TargetedMarket.ETHEREUM_HOURLY;
                    } else if (marketArg === 'eth-quarterly' || marketArg === 'ethereum-quarterly') {
                        targetedMarket = TargetedMarket.ETHEREUM_QUARTERLY;
                    } else if (marketArg === 'sol-quarterly' || marketArg === 'solana-quarterly') {
                        targetedMarket = TargetedMarket.SOLANA_QUARTERLY;
                    } else if (marketArg === 'solana-hourly' || marketArg === 'sol-hourly') {
                        targetedMarket = TargetedMarket.SOLANA_HOURLY
                    } else if (marketArg === 'xrp-hourly') {
                        targetedMarket = TargetedMarket.XRP_HOURLY;
                    } else if (marketArg === 'xrp-quarterly') {
                        targetedMarket = TargetedMarket.XRP_QUARTERLY;
                    } else {
                        console.error(`Invalid market: ${args[i + 1]}. Valid options: btc-hourly, btc-quarterly, eth-hourly, eth-quarterly, sol-quarterly,  sol-hourly, xrp-hourly, xrp-quarterly`);
                        process.exit(1);
                    }
                    break;
                }
            case '--base-params':
            case '-b':
                baseParamsFile = args[i + 1] || null;
                break;
            case '--two-stage':
            case '-2':
                twoStageMode = true;
                break;
            case '--help':
            case '-h':
                printHelp();
                process.exit(0);
        }
    }

    // Check for Stage 2 only mode (with user-supplied base params)
    if (baseParamsFile) {
        const isQuarterly = targetedMarket.includes('QUARTERLY') ||
            (strategyFilter?.toLowerCase().includes('quarterly') ?? false);

        await runStage2OnlyOptimization({
            lookbackDays,
            populationSize,
            maxGenerations,
            convergenceThreshold,
            coinType,
            targetedMarket,
            auditTradesCount,
            isQuarterly,
            baseParamsFile,
            strategyFilter: strategyFilter ?? undefined,
        });
        return;
    }

    // Check for two-stage MSPEQ optimization mode
    if (twoStageMode) {
        const isQuarterly = targetedMarket.includes('QUARTERLY') ||
            (strategyFilter?.toLowerCase().includes('quarterly') ?? false);

        await runTwoStageOptimization({
            lookbackDays,
            populationSize,
            maxGenerations,
            convergenceThreshold,
            coinType,
            targetedMarket,
            auditTradesCount,
            isQuarterly,
        });
        return;
    }

    // Check for YAML mode first
    if (yamlFilePath) {
        await runYamlSimulation(yamlFilePath);
        return;
    }

    // Create logger and simulator
    const logger = new SimulatorLogger(`genetic-${coinType}`);
    logger.log(`Log file: ${logger.getLogFilePath()}`);

    const simulator = new HistoricalSimulator({
        lookbackDays,
        tickIntervalMs: 5 * 1000,
        coinType,
        auditTradesCount,
        targetedMarket,
    });

    logger.log('');
    logger.log('╔════════════════════════════════════════════════════════════╗');
    logger.log('║      GENETIC ALGORITHM OPTIMIZATION - Historical Sim       ║');
    logger.log('╚════════════════════════════════════════════════════════════╝');

    logger.log(`\nConfiguration:`);
    logger.log(`  Coin Type: ${coinType.toUpperCase()}`);
    logger.log(`  Lookback Days: ${lookbackDays}`);
    logger.log(`  Max Generations: ${maxGenerations}`);
    logger.log(`  Convergence Threshold: $${convergenceThreshold.toFixed(2)} (absolute fallback)`);
    logger.log(`  Relative Convergence: enabled (1% of best fitness, min $0.10)`);
    logger.log(`  Population Size: ${populationSize}`);

    const geneticConfig = {
        populationSize,
        maxGenerations,
        convergenceThreshold,
        convergenceGenerations: 5,
        mutationRate: 0.25,
        mutationStrength: 0.3,
        eliteCount: 2,
        crossoverRate: 0.7,
    };

    // Filter strategies if specified
    let strategies = geneticStrategies;
    if (strategyFilter) {
        strategies = geneticStrategies.filter(s =>
            s.name.toLowerCase() == strategyFilter!.toLowerCase()
        );
        if (strategies.length === 0) {
            logger.error(`\nNo strategies matching '${strategyFilter}' found.`);
            logger.log('Available strategies: ' + geneticStrategies.map(s => s.name).join(', '));
            process.exit(1);
        }
        logger.log(`  Strategy Filter: ${strategyFilter} (${strategies.length} matched)`);
    }

    try {
        await simulator.runMultiStrategyGeneticOptimization(strategies, geneticConfig);
    } catch (error) {
        logger.error(`\nGenetic optimization failed: ${error}`);
        process.exit(1);
    }

    // Copy genetic log to audit directory if audit mode was used
    const auditLogDir = simulator.getLastAuditLogDir();
    if (auditLogDir) {
        logger.copyLogsToDirectory(auditLogDir);
        logger.log(`\nAll logs consolidated to: ${auditLogDir}`);
    }

    logger.log('\n✓ Simulation complete\n');
    logger.log(`Results saved to: ${logger.getLogFilePath()}`);
}

function printHelp(): void {
    console.log(`
Historical Simulation & Genetic Optimization

Usage: npm run histSim -- [options]

Options:
  -y, --yaml <file>     Run custom parameter simulation from YAML file
  -d, --days <n>        Lookback days for simulation (default: 7)
  -c, --coin <type>     Coin type to simulate: btc, eth, sol, xrp (default: btc)
  -M, --market <type>   Target market: btc-hourly, btc-quarterly, eth-hourly, eth-quarterly (default: btc-hourly)
  -g, --genetic         Use genetic algorithm optimization instead of parameter sweep
  -m, --max-gen <n>     Maximum generations for genetic optimization (default: 50)
  -t, --threshold <n>   Convergence threshold - stop if improvement < n (default: 1.0)
  -p, --population <n>  Population size per generation (default: 15)
  -s, --strategy <name> Only optimize specific strategy (e.g., "FirstCandle", "QuarterlyFirstCandle")
  -a, --audit-trades <n> Write top N and avg trades with parameters to audit file (default: 10 when enabled)
  -2, --two-stage       Two-stage MSPEQ optimization: Stage 1 optimizes base params with FirstCandle,
                        Stage 2 freezes base params and optimizes MSPEQ coefficients (much faster)
  -b, --base-params <file> Stage 2 only: Load base params from YAML file and optimize only MSPEQ coefficients
  -h, --help            Show this help message

Available Strategies:
  Hourly Markets (60-min periods):
    Contrarian, TrendFollowing, FirstCandle, FirstCandleV2,
    EveningStar, MorningStar, MeanReversion, EarlyBuyerV2,
    EsotericNormalization, MarketMaker, FirstCandleMSPEQ, EarlyBuyerMSPEQ

  Quarterly Markets (15-min periods):
    QuarterlyFirstCandle, QuarterlyMeanReversion, QuarterlyTrendFollowing,
    QuarterlyEarlyBuyerV2, QuarterlyEsotericNormalization, QuarterlyMarketMaker,
    QuarterlyFirstCandleMSPEQ, QuarterlyEarlyBuyerMSPEQ

YAML File Format:
  strategy: QuarterlyTrendFollowing
  market: btc-quarterly
  coin: btc
  days: 4
  params:
    shortMaPeriod: 3
    longMaPeriod: 10
    ...

Examples:
  npm run histSim -- --days 14
  npm run histSim -- --coin eth --days 7
  npm run histSim -- --genetic --days 7 --max-gen 30
  npm run histSim -- -g -c sol -d 14 -m 100 -t 0.5 -p 20
  npm run histSim -- -g -s FirstCandle --max-gen 50
  npm run histSim -- -g -s QuarterlyFirstCandle --max-gen 30
  npm run histSim -- -y params.yaml

Two-Stage MSPEQ Optimization:
  npm run histSim -- --two-stage -p 100 -m 50 -c btc
  npm run histSim -- -2 -M btc-quarterly -p 75 -m 40 -c btc

Stage 2 Only (with pre-optimized base params):
  npm run histSim -- --base-params ./logs/simulator/firstcandle-params.yaml -p 150 -m 75
  npm run histSim -- -b base-params.yaml -M btc-quarterly -p 100 -m 50
`);
}

// Only run main when this file is the entry point (not when imported as a module)
const currentFile = import.meta.url;
const entryPoint = `file:///${process.argv[1].replace(/\\/g, '/')}`;
if (currentFile === entryPoint) {
    main();
}
