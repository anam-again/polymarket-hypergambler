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

// Re-export adapter utilities for external use
export { createSimulatedBot, createMockClobClient, QuantBotSimulationAdapter } from './QuantBotSimulationAdapter.js';

// ============================================================================
// Parameter Bounds for Genetic Optimization
// ============================================================================

const contrarianBounds: ParameterBounds = {
    targetSize: { min: 5, max: 20, step: 1 },
    targetBuyPrice: { min: 0.02, max: 0.98 },
    targetSellPrice: { min: 0.02, max: 0.98 },
    lookbackHours: { min: 1, max: 12, step: 1 },
    cutoffMinute: { min: 15, max: 45, step: 5 },
};

const trendFollowingBounds: ParameterBounds = {
    targetSize: { min: 5, max: 20, step: 1 },
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
    targetSize: { min: 5, max: 20, step: 1 },
    candleMinutes: { min: 5, max: 30, step: 2 },
    breakoutBuffer: { min: 0, max: 1000 },
    pullbackBuffer: { min: 0, max: 1000 },
    targetBuyPrice: { min: 0.02, max: 0.98 },
    targetSellPrice: { min: 0.02, max: 0.98 },
    cutoffMinute: { min: 5, max: 55, step: 5 },
};

const firstCandleV2Bounds: ParameterBounds = {
    targetSize: { min: 5, max: 20, step: 1 },
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
    targetSize: { min: 5, max: 20, step: 1 },
    candleMinutes: { min: 3, max: 20, step: 1 },
    minBullishMove: { min: 20, max: 150 },
    maxIndecisionRange: { min: 10, max: 75 },
    minBearishMove: { min: 20, max: 150 },
    targetBuyPrice: { min: 0.02, max: 0.9 },
    targetSellPrice: { min: 0.1, max: 0.98 },
    cutoffMinute: { min: 30, max: 55, step: 5 },
};

const morningStarBounds: ParameterBounds = {
    targetSize: { min: 5, max: 20, step: 1 },
    candleMinutes: { min: 3, max: 20, step: 1 },
    minBearishMove: { min: 20, max: 150 },
    maxIndecisionRange: { min: 10, max: 75 },
    minBullishMove: { min: 20, max: 150 },
    targetBuyPrice: { min: 0.02, max: 0.98 },
    targetSellPrice: { min: 0.02, max: 0.98 },
    cutoffMinute: { min: 30, max: 55, step: 5 },
};

const meanReversionBounds: ParameterBounds = {
    targetSize: { min: 5, max: 20, step: 1 },
    lookbackPeriods: { min: 5, max: 50, step: 1 },
    entryThreshold: { min: 1.0, max: 4.0 },
    targetBuyPrice: { min: 0.02, max: 0.95 },
    targetSellPrice: { min: 0.05, max: 0.98 },
    cutoffMinute: { min: 30, max: 55, step: 5 },
};

const nCandleBounds: ParameterBounds = {
    targetSize: { min: 5, max: 20, step: 1 },
    candleMinutes: { min: 3, max: 20, step: 1 },
    breakoutBuffer: { min: 0, max: 200 },
    pullbackBuffer: { min: 0, max: 250 },
    buyPriceBuffer: { min: 0.01, max: 0.10 },
    sellPriceBuffer: { min: 0.01, max: 0.10 },
    minProfitMargin: { min: 0.02, max: 0.15 },
    stopLossMultiplier: { min: 0.5, max: 3.0 },
    cutoffMinute: { min: 10, max: 55, step: 5 },
    maxTradesPerHour: { min: 1, max: 5, step: 1 },
};

// ============================================================================
// Quarterly Market Bounds (15-minute periods)
// ============================================================================

const quarterlyFirstCandleBounds: ParameterBounds = {
    targetSize: { min: 5, max: 20, step: 1 },
    candleMinutes: { min: 1, max: 12, step: 1 },  // Smaller for 15-min period
    breakoutBuffer: { min: 0, max: 500 },
    pullbackBuffer: { min: 0, max: 500 },
    targetBuyPrice: { min: 0.02, max: 0.95 },
    targetSellPrice: { min: 0.05, max: 0.98 },
    cutoffMinute: { min: 5, max: 13, step: 1 },  // Within 15-min period
};

const quarterlyMeanReversionBounds: ParameterBounds = {
    targetSize: { min: 5, max: 20, step: 1 },
    lookbackPeriods: { min: 3, max: 25, step: 1 },
    entryThreshold: { min: 0.5, max: 3.0 },  // Tighter for faster markets
    targetBuyPrice: { min: 0.02, max: 0.95 },
    targetSellPrice: { min: 0.05, max: 0.98 },
    cutoffMinute: { min: 5, max: 13, step: 1 },
};

const quarterlyTrendFollowingBounds: ParameterBounds = {
    targetSize: { min: 5, max: 20, step: 1 },
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
    targetSize: { min: 5, max: 20, step: 1 },
    candleMinutes: { min: 1, max: 4, step: 1 },  // Short candles (1-4 min) to leave time for breakout/pullback
    breakoutBuffer: { min: 20, max: 150 },       // BTC price movement in $ to confirm breakout
    pullbackBuffer: { min: 50, max: 200 },       // Must be >= breakoutBuffer for pattern to work
    buyPriceBuffer: { min: 0.01, max: 0.05 },
    sellPriceBuffer: { min: 0.01, max: 0.05 },
    minProfitMargin: { min: 0.02, max: 0.08 },
    stopLossMultiplier: { min: 0.5, max: 2.0 },
    cutoffMinute: { min: 8, max: 13, step: 1 },  // Leave time after candle forms (min 8 ensures candle + pattern time)
    maxTradesPerPeriod: { min: 1, max: 2, step: 1 },
};

const earlyBuyerV2Bounds: ParameterBounds = {
    targetBuyPrice: { min: 0.02, max: 0.90 },    // Target buying below fair value
    targetSellPrice: { min: 0.1, max: 0.98 },   // Target selling above fair value
    targetSize: { min: 5, max: 25, step: 1 },
    cutoffMinute: { min: 15, max: 45, step: 1 }, // For hourly markets, how late to enter
    minFlops: { min: 1, max: 6 },                // Minimum market volatility to trade
    flopsLookbackHours: { min: 2, max: 12, step: 1 },  // Hours of flops data to average
    btcDirection: { min: 0, max: 1, step: 1 },   // 0 = DOWN, 1 = UP (will be converted to string)
};

const quarterlyEarlyBuyerV2Bounds: ParameterBounds = {
    targetBuyPrice: { min: 0.02, max: 0.95 },    // Target buying below fair value
    targetSellPrice: { min: 0.05, max: 0.98 },   // Target selling above fair value
    targetSize: { min: 5, max: 25, step: 1 },
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
    targetSize: { min: 5, max: 25, step: 1 },
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
    targetSize: { min: 5, max: 25, step: 1 },
    cutoffMinute: { min: 5, max: 12, step: 1 },     // Within 15-min period
    maxTradesPerPeriod: { min: 1, max: 2, step: 1 },
};

const marketMakerBounds: ParameterBounds = {
    spreadSize: { min: 2, max: 10, step: 1 },
    minSpreadDistance: { min: 0, max: 0.10, step: 0.01 },  // Distance from market to start spread
    profitMargin: { min: 0.01, max: 0.50 },         // 2-20 cents
    minPrice: { min: 0.05, max: 0.90 },
    maxPrice: { min: 0.1, max: 0.98 },
    stopLossAmount: { min: 0.01, max: 0.30 },       // 5-20 cents
    buyExpirySeconds: { min: 30, max: 300, step: 10 },  // 30s to 5min
    totalActiveTrades: { min: 3, max: 15, step: 1 },
    requiredVolatility: { min: 0.5, max: 8.0 },
    volatilityLookbackPeriods: { min: 1, max: 30, step: 1 },
    targetSize: { min: 5, max: 20, step: 1 },
    cutoffMinute: { min: 10, max: 55, step: 5 },
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
    requiredVolatility: { min: 0.1, max: 5.0 },
    volatilityLookbackPeriods: { min: 1, max: 30, step: 1 },
    targetSize: { min: 5, max: 15, step: 1 },
    cutoffMinute: { min: 2, max: 14, step: 1 },
};

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
        targetSize: params.targetSize as number ?? 10,
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
        targetSize: params.targetSize as number ?? 10,
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
        targetBuyPrice: params.targetBuyPrice as number ?? 0.50,
        targetSellPrice: params.targetSellPrice as number ?? 0.60,
        targetSize: params.targetSize as number ?? 10,
        cutoffMinute: params.cutoffMinute as number ?? 45,
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
        targetSize: params.targetSize as number ?? 10,
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
        targetSize: params.targetSize as number ?? 10,
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
        targetSize: params.targetSize as number ?? 10,
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
        exitThreshold: params.exitThreshold as number ?? 0.5,
        targetBuyPrice: params.targetBuyPrice as number ?? 0.50,
        targetSellPrice: params.targetSellPrice as number ?? 0.60,
        targetSize: params.targetSize as number ?? 10,
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
        breakoutBuffer: params.breakoutBuffer as number ?? 50,
        pullbackBuffer: params.pullbackBuffer as number ?? 100,
        buyPriceBuffer: params.buyPriceBuffer as number ?? 0.02,
        sellPriceBuffer: params.sellPriceBuffer as number ?? 0.02,
        minProfitMargin: params.minProfitMargin as number ?? 0.05,
        stopLossMultiplier: params.stopLossMultiplier as number ?? 1.5,
        targetSize: params.targetSize as number ?? 10,
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
        targetSize: params.targetSize as number ?? 10,
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
        targetSize: params.targetSize as number ?? 10,
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
        targetBuyPrice: params.targetBuyPrice as number ?? 0.50,
        targetSellPrice: params.targetSellPrice as number ?? 0.60,
        targetSize: params.targetSize as number ?? 10,
        cutoffMinute: params.cutoffMinute as number ?? 12,
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
        exitThreshold: params.exitThreshold as number ?? 0.5,
        targetBuyPrice: params.targetBuyPrice as number ?? 0.50,
        targetSellPrice: params.targetSellPrice as number ?? 0.60,
        targetSize: params.targetSize as number ?? 10,
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
        targetSize: params.targetSize as number ?? 10,
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
        breakoutBuffer: params.breakoutBuffer as number ?? 50,
        pullbackBuffer: params.pullbackBuffer as number ?? 100,
        buyPriceBuffer: params.buyPriceBuffer as number ?? 0.02,
        sellPriceBuffer: params.sellPriceBuffer as number ?? 0.02,
        minProfitMargin: params.minProfitMargin as number ?? 0.05,
        stopLossMultiplier: params.stopLossMultiplier as number ?? 1.5,
        targetSize: params.targetSize as number ?? 10,
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
        targetSize: params.targetSize as number ?? 10,
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
        targetSize: params.targetSize as number ?? 10,
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
        requiredVolatility: params.requiredVolatility as number ?? 1.0,
        volatilityLookbackPeriods: params.volatilityLookbackPeriods as number ?? 15,
        targetSize: params.targetSize as number ?? 10,
        cutoffMinute: params.cutoffMinute as number ?? 45,
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
        requiredVolatility: params.requiredVolatility as number ?? 0.8,
        volatilityLookbackPeriods: params.volatilityLookbackPeriods as number ?? 8,
        targetSize: params.targetSize as number ?? 10,
        cutoffMinute: params.cutoffMinute as number ?? 10,
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
            case '--help':
            case '-h':
                printHelp();
                process.exit(0);
        }
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
    logger.log(`  Convergence Threshold: $${convergenceThreshold.toFixed(2)}`);
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
  -h, --help            Show this help message

Available Strategies:
  Hourly Markets (60-min periods):
    Contrarian, TrendFollowing, FirstCandle, FirstCandleV2,
    EveningStar, MorningStar, MeanReversion, EarlyBuyerV2,
    EsotericNormalization, MarketMaker

  Quarterly Markets (15-min periods):
    QuarterlyFirstCandle, QuarterlyMeanReversion, QuarterlyTrendFollowing,
    QuarterlyEarlyBuyerV2, QuarterlyEsotericNormalization, QuarterlyMarketMaker

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
`);
}

// Only run main when this file is the entry point (not when imported as a module)
const currentFile = import.meta.url;
const entryPoint = `file:///${process.argv[1].replace(/\\/g, '/')}`;
if (currentFile === entryPoint) {
    main();
}
