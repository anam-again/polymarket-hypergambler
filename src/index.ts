import { Arbitrage98 } from "./bots/Arbitrage98.js";
import { Credentials } from "./nonBots/Credentials.js";
import { BtcDirection, TargetedMarket } from "./types/interfaces.js";
import { MarketInfo } from "./nonBots/MarketInfo.js";
import { OrderBatcher, QuantBotRun, runBotsWithRestartOnFailure } from "./bots/QuantBot.js";
import { Contrarian } from "./bots/Contrarian.js";
import { CDMarketData } from "./nonBots/CDMarketData.js";
import { EarlyBuyerV2 } from "./bots/EarlyBuyerV2.js";
import { EarlyLimitV2 } from "./bots/EarlyLimitV2.js";
import { FirstCandle } from "./bots/FirstCandle.js";
import { FirstCandleV2 } from "./bots/FirstCandleV2.js";
import { MeanReversion } from "./bots/MeanReversion.js";
import { LogCleaner } from "./nonBots/LogCleaner.js";
import { NCandle } from "./bots/NCandle.js";
import { RedemptionSolver } from "./nonBots/RedemptionSolver.js";
import { checkIfBotsHaveMatchingNames, formatDuration, getMsUntilNextHour, targetMarketToShortname } from "./utils/utils.js";
import { MarketMaker } from "./bots/MarketMaker.js";
import { GeneticBotManager } from "./genetic/GeneticBotManager.js";
import { YOLOMLBot } from "./bots/YOLOMLBot.js";
import { PredictionStyle } from "./ml/types.js";
import { ScalingPEQ, ScalingPEQCoefficients } from "./utils/ScalingPEQ.js";
import { TradingDatabase } from "./db/TradingDatabase.js";
import { loadBotsFromYamlDir, MLBotConfig } from "./adapters/SimulatorParamsAdapter.js";
import { SuddenArb } from "./bots/SuddenArb.js";

// Initialize database on startup
console.log('[SYSTEM] Initializing database...');
const tradingDb = TradingDatabase.getInstance();
console.log(`[SYSTEM] Database initialized at ${process.env.DB_PATH || './data/trading.db'}`);


const credentials = new Credentials();
const clobClient = await credentials.initClobClient();

const marketInfo = new MarketInfo({
  client: clobClient,
});

const commonProps = {
  client: clobClient,
  marketInfo,
}

// ML configuration for MSPEQ bots
// Enable ML gating to reject trades below confidence threshold
const mlConfig: MLBotConfig = {
  useMLGating: true,           // Enable ML-powered trade gating
  minMLConfidence: 0.5,        // Minimum confidence to proceed with trade
  mlPositionMultiplier: 1.0,   // Base position multiplier (adjusted by confidence)
  mlModelBasePath: './models', // Per-strategy model storage
};

const commonTestProps = {
  ...commonProps,
  PROD_MODE: false,
  hourlyDollarLimit: 100000,
  targetDollars: 20,
}

// Test props with ML enabled for MSPEQ bots
const commonTestPropsWithML = {
  ...commonTestProps,
  ml: mlConfig,
}

const commonProdProps = {
  ...commonProps,
  PROD_MODE: true,
}

// Prod props with ML enabled for MSPEQ bots
const commonProdPropsWithML = {
  ...commonProdProps,
  ml: mlConfig,
}

const logCleaner = new LogCleaner({
  logsDirectory: './logs',
  retentionDays: 60,
});

const redemptionSolver = new RedemptionSolver(marketInfo);

console.log('intitializing bots...')

const cdMarketData = CDMarketData.getInstance();

OrderBatcher.initialize(clobClient, 200);

const prodBots: QuantBotRun[] = []

const testBots: QuantBotRun[] = [
  // MSPEQ bots with ML features enabled
  ...loadBotsFromYamlDir('./MSPEQSYamls', {
    ...commonTestPropsWithML,
  }, {
    pattern: /\.yaml$/,
  }),
  ...([
    { targetedMarket: TargetedMarket.BITCOIN_HOURLY },
  ]).map((v) => {
    return new Arbitrage98({
      name: `arbitrage98-${targetMarketToShortname(v.targetedMarket)}`,
      ...v,
      ...commonTestProps,
    })
  }),
  ...([
    { targetedMarket: TargetedMarket.BITCOIN_HOURLY, cutoffMinute: 30, spreadSize: 5, minSpreadDistance: 0, profitMargin: .15, minPrice: .45, maxPrice: .57, stopLossAmount: .2, totalActiveTrades: 5, maxVolatility: 2.1, minVolatility: 0, volatilityLookbackPeriods: 20, buyExpirySeconds: 40, sellTimeout: 10, stoplossCheckTimeout: 2550, stoplossFailureTimeout: 764, sellTimeoutPEQ: ScalingPEQ.default(), stoplossCheckTimeoutPEQ: ScalingPEQ.default(), stoplossFailureTimeoutPEQ: ScalingPEQ.default() },
    { targetedMarket: TargetedMarket.BITCOIN_HOURLY, cutoffMinute: 10, spreadSize: 8, minSpreadDistance: 0, profitMargin: .43, minPrice: .38, maxPrice: .51, stopLossAmount: .02, totalActiveTrades: 5, maxVolatility: 6.9, minVolatility: 0, volatilityLookbackPeriods: 20, buyExpirySeconds: 40, sellTimeout: 10, stoplossCheckTimeout: 2550, stoplossFailureTimeout: 764, sellTimeoutPEQ: ScalingPEQ.default(), stoplossCheckTimeoutPEQ: ScalingPEQ.default(), stoplossFailureTimeoutPEQ: ScalingPEQ.default() },
    { targetedMarket: TargetedMarket.BITCOIN_HOURLY, cutoffMinute: 15, spreadSize: 6, minSpreadDistance: 0.06, profitMargin: .44, minPrice: .29, maxPrice: .68, stopLossAmount: .01, totalActiveTrades: 5, maxVolatility: 67.3, minVolatility: 32, volatilityLookbackPeriods: 7, buyExpirySeconds: 200, sellTimeout: 10, stoplossCheckTimeout: 2550, stoplossFailureTimeout: 764, sellTimeoutPEQ: ScalingPEQ.default(), stoplossCheckTimeoutPEQ: ScalingPEQ.default(), stoplossFailureTimeoutPEQ: ScalingPEQ.default() },
    { targetedMarket: TargetedMarket.BITCOIN_HOURLY, cutoffMinute: 20, spreadSize: 8, minSpreadDistance: 0.05, profitMargin: .32, minPrice: .17, maxPrice: .42, stopLossAmount: 1, totalActiveTrades: 5, maxVolatility: 96.5, minVolatility: 73.3, volatilityLookbackPeriods: 53, buyExpirySeconds: 2160, sellTimeout: 10, stoplossCheckTimeout: 2550, stoplossFailureTimeout: 764, sellTimeoutPEQ: ScalingPEQ.default(), stoplossCheckTimeoutPEQ: ScalingPEQ.default(), stoplossFailureTimeoutPEQ: ScalingPEQ.default() },
    { targetedMarket: TargetedMarket.BITCOIN_HOURLY, cutoffMinute: 20, spreadSize: 8, minSpreadDistance: 0.05, profitMargin: .32, minPrice: .17, maxPrice: .42, stopLossAmount: 1, totalActiveTrades: 5, maxVolatility: 96.5, minVolatility: 20, volatilityLookbackPeriods: 53, buyExpirySeconds: 2160, sellTimeout: 10, stoplossCheckTimeout: 2550, stoplossFailureTimeout: 764, sellTimeoutPEQ: ScalingPEQ.default(), stoplossCheckTimeoutPEQ: ScalingPEQ.default(), stoplossFailureTimeoutPEQ: ScalingPEQ.default() },
    { targetedMarket: TargetedMarket.BITCOIN_HOURLY, cutoffMinute: 5, spreadSize: 6, minSpreadDistance: 0.09, profitMargin: .45, minPrice: .17, maxPrice: .58, stopLossAmount: .37, totalActiveTrades: 13, maxVolatility: 68.13, minVolatility: 39.92, volatilityLookbackPeriods: 65, buyExpirySeconds: 2960, sellTimeout: 3515, stoplossCheckTimeout: 2295, stoplossFailureTimeout: 3400, sellTimeoutPEQ: ScalingPEQ.default(), stoplossCheckTimeoutPEQ: ScalingPEQ.default(), stoplossFailureTimeoutPEQ: ScalingPEQ.default() },
    { targetedMarket: TargetedMarket.BITCOIN_HOURLY, cutoffMinute: 25, spreadSize: 4, minSpreadDistance: 0.07, profitMargin: .12, minPrice: .65, maxPrice: .85, stopLossAmount: .70, totalActiveTrades: 14, maxVolatility: 95, minVolatility: 36, volatilityLookbackPeriods: 68, buyExpirySeconds: 2080, sellTimeout: 2450, stoplossCheckTimeout: 3555, stoplossFailureTimeout: 1690, sellTimeoutPEQ: ScalingPEQ.default(), stoplossCheckTimeoutPEQ: ScalingPEQ.default(), stoplossFailureTimeoutPEQ: ScalingPEQ.default() },
  ]).map((v) => {
    return new MarketMaker({
      name: `mmaker-${targetMarketToShortname(v.targetedMarket)}-ss${v.spreadSize}-pm${v.profitMargin}-min${v.minPrice}-max${v.maxPrice}-sl${v.stopLossAmount}-maxv${v.maxVolatility}-minv${v.minVolatility}-vlp${v.volatilityLookbackPeriods}-bes${v.buyExpirySeconds}`,
      ...v,
      ...commonTestProps,

    })
  }),
  ...([
    { targetedMarket: TargetedMarket.ETHEREUM_HOURLY, lookbackHours: 5, targetBuyPrice: .50, targetSellPrice: .80, cutoffMinute: 10 },
  ]).map((v) => {
    return new Contrarian({
      name: `contrarianV2-${targetMarketToShortname(v.targetedMarket)}-${v.lookbackHours}h-b${v.targetBuyPrice}-s${v.targetSellPrice}`,
      ...v,
      ...commonTestProps,
    })
  }),
  ...([
    { targetedMarket: TargetedMarket.BITCOIN_HOURLY, cutoffMinute: 20, targetBuyPrice: .4, targetSellPrice: .6, flopsLookbackHours: 5, minFlops: 1 },
  ]).map((v) => {
    return [BtcDirection.UP, BtcDirection.DOWN].map((d) => {
      return new EarlyBuyerV2({
        name: `earlyV2-${targetMarketToShortname(v.targetedMarket)}-${d.toLowerCase()}-b${v.targetBuyPrice}-s${v.targetSellPrice}-f${v.minFlops}`,
        btcDirection: d,
        ...v,
        ...commonTestProps,
      })
    })
  }).flat(1),
  ...([
    { targetedMarket: TargetedMarket.BITCOIN_HOURLY, cutoffMinute: 55, targetAmount: 5, triggerPrice: .75, targetBuyPrice: .78, targetSellPrice: .90, flopsLookbackHours: 5, maxFlops: 1 },
  ]).map((v) => {
    return new EarlyLimitV2({
      name: `elimV2-${targetMarketToShortname(v.targetedMarket)}-l${v.triggerPrice}-b${v.targetBuyPrice}-s${v.targetSellPrice}`,
      ...v,
      ...commonTestProps,
    })
  }),
  ...([
    { targetedMarket: TargetedMarket.BITCOIN_QUARTERLY, candleMinutes: 4, breakoutBuffer: 20, pullbackBuffer: 5, baseBuyPrice: .52, minProfitMargin: .38, cutoffMinute: 12 },
    { targetedMarket: TargetedMarket.BITCOIN_QUARTERLY, candleMinutes: 4, breakoutBuffer: 50, pullbackBuffer: 10, baseBuyPrice: .52, minProfitMargin: .38, cutoffMinute: 12 },
    { targetedMarket: TargetedMarket.BITCOIN_HOURLY, candleMinutes: 10, breakoutBuffer: 187, pullbackBuffer: 669, baseBuyPrice: .36, minProfitMargin: .50, cutoffMinute: 20 },
    { targetedMarket: TargetedMarket.BITCOIN_HOURLY, candleMinutes: 10, breakoutBuffer: 148, pullbackBuffer: 355, baseBuyPrice: .59, minProfitMargin: .36, cutoffMinute: 12, targetDollars: 5, hourlyDollarLimit: 10 },
  ]).map((v) => {
    return new FirstCandle({
      ...v,
      name: `fcandle-${targetMarketToShortname(v.targetedMarket)}-${v.candleMinutes}m-bb${v.candleMinutes}-pp${v.pullbackBuffer}-b${v.baseBuyPrice}-mpm${v.minProfitMargin}-co${v.cutoffMinute}`,
      ...commonTestProps,
      candleSizeReference: 1000,
      targetBuyPricePEQ: { c0: 1, c1: 0 },
      targetSellPricePEQ: { c0: 1, c1: 0 },
      earlySellTimePEQ: { c0: 0.2, c1: 0 },
      earlySellPricePEQ: { c0: 1, c1: 0 },
    })
  }),
  ...([
    { targetedMarket: TargetedMarket.BITCOIN_HOURLY, candleMinutes: 5, breakoutBuffer: 50, pullbackBuffer: 50, buyPriceBuffer: .01, sellPriceBuffer: .01, minProfitMargin: .05, stopLossMultiplier: 1, stoplossTimeout: 30, sellTimeout: 300, stoplossFailureTimeout: 15, earlySellScalar: 0.3, cutoffMinute: 20, maxTradesPerHour: 10 },
    { targetedMarket: TargetedMarket.BITCOIN_QUARTERLY, candleMinutes: 5, breakoutBuffer: 50, pullbackBuffer: 50, buyPriceBuffer: .01, sellPriceBuffer: .01, minProfitMargin: .05, stopLossMultiplier: 1, stoplossTimeout: 15, sellTimeout: 120, stoplossFailureTimeout: 15, earlySellScalar: 0.3, cutoffMinute: 20, maxTradesPerHour: 10 },
  ]).map((v) => {
    return new NCandle({
      ...v,
      name: `ncandle-${targetMarketToShortname(v.targetedMarket)}-cm${v.candleMinutes}-bb${v.breakoutBuffer}-pbb${v.pullbackBuffer}-mpm${v.minProfitMargin}-slm${v.stopLossMultiplier}-com${v.cutoffMinute}`,
      ...commonTestProps,
      // Default PEQ configs (constant 1.0 multiplier)
      buyPriceBufferPEQ: ScalingPEQ.default(),
      minProfitMarginPEQ: ScalingPEQ.default(),
      stoplossTimeoutPEQ: ScalingPEQ.default(),
      sellTimeoutPEQ: ScalingPEQ.default(),
      stoplossFailureTimeoutPEQ: ScalingPEQ.default(),
    })
  }),
  new NCandle({
    candleMinutes: 3,
    buyPriceBuffer: .03,
    buyPriceBufferPEQ: new ScalingPEQ({ c0: 0.07, c1: 1.207 }),
    sellPriceBuffer: .09,
    minProfitMargin: .36,
    minProfitMarginPEQ: new ScalingPEQ({ c0: 0.395, c1: -1.791 }),
    stopLossMultiplier: .695,
    stoplossTimeout: 50,
    stoplossTimeoutPEQ: new ScalingPEQ({ c0: 0, c1: .201 }),
    sellTimeout: 1350,
    sellTimeoutPEQ: new ScalingPEQ({ c0: .58, c1: .66 }),
    stoplossFailureTimeout: 1595,
    stoplossFailureTimeoutPEQ: new ScalingPEQ({ c0: .802, c1: 2.0 }),
    earlySellScalar: -.32,
    cutoffMinute: 10,
    maxTradesPerHour: 5,
    name: 'ncandlepeq-1',
    targetedMarket: TargetedMarket.BITCOIN_HOURLY,
    ...commonTestProps,
  }),
  ...([
    {
      targetedMarket: TargetedMarket.BITCOIN_QUARTERLY,
      candleMinutes: 1,
      buyPriceBuffer: .04,
      buyPriceBufferPEQ: new ScalingPEQ({ c0: 1.72, c1: -1.46 }),
      sellPriceBuffer: .03,
      minProfitMargin: .38,
      minProfitMarginPEQ: new ScalingPEQ({ c0: .35, c1: -1.24 }),
      stopLossMultiplier: .75,
      stoplossTimeout: 55.0,
      stoplossTimeoutPEQ: new ScalingPEQ({ c0: .27, c1: .20 }),
      sellTimeout: 285,
      sellTimeoutPEQ: new ScalingPEQ({ c0: 1.98, c1: .0394 }),
      stoplossFailureTimeout: 365,
      stoplossFailureTimeoutPEQ: new ScalingPEQ({ c0: .72, c1: 1.6 }),
      earlySellScalar: .373,
      cutoffMinute: 9.0,
      maxTradesPerHour: 3,
      maxTradesPerPeriod: 3,
    }
  ]).map((v) => {
    return new NCandle({
      ...v,
      name: `ncandlepeq-${targetMarketToShortname(v.targetedMarket)}`,
      ...commonTestProps,
    })
  }),
  ...([
    { targetedMarket: TargetedMarket.BITCOIN_HOURLY, candleMinutes: 10, breakoutBuffer: 50, pullbackBuffer: 100, targetDollars: 10, cutoffMinute: 50, buyPriceBuffer: .02, sellPriceBuffer: .10, minProfitMargin: .05 },
  ]).map((v) => {
    return new FirstCandleV2({
      ...v,
      name: `fcandleV2-${targetMarketToShortname(v.targetedMarket)}-cm${v.candleMinutes}-bb${v.breakoutBuffer}-pp${v.pullbackBuffer}-bpb${v.buyPriceBuffer}-spb${v.sellPriceBuffer}-mpm${v.minProfitMargin}`,
      ...commonTestProps,
    })
  }),
  ...([
    { targetedMarket: TargetedMarket.BITCOIN_HOURLY, lookbackPeriods: 15, entryThreshold: 2, targetBuyPrice: .55, targetSellPrice: .85, cutoffMinute: 45 },
    { targetedMarket: TargetedMarket.BITCOIN_QUARTERLY, lookbackPeriods: 8, entryThreshold: 2.45, targetBuyPrice: .07, targetSellPrice: .75, cutoffMinute: 10 },
  ]).map((v) => {
    return new MeanReversion({
      ...v,
      name: `mrev-${targetMarketToShortname(v.targetedMarket)}-${v.lookbackPeriods}p-et${v.entryThreshold}-b${v.targetBuyPrice}-s${v.targetSellPrice}`,
      ...commonTestProps,
    })
  }),
  // YOLOMLBot - ML-powered trading bot
  ...([
    { targetedMarket: TargetedMarket.BITCOIN_HOURLY, predictionStyle: PredictionStyle.HOURLY_10M_20M, tradeSize: 10, pnlThresholdPercent: 10, minConfidenceThreshold: 0.005, minProfitMargin: 0.05 },
    { targetedMarket: TargetedMarket.BITCOIN_HOURLY, predictionStyle: PredictionStyle.HOURLY_10M_30M, tradeSize: 10, pnlThresholdPercent: 10, minConfidenceThreshold: 0.005, minProfitMargin: 0.05 },
    { targetedMarket: TargetedMarket.BITCOIN_HOURLY, predictionStyle: PredictionStyle.HOURLY_10M_40M, tradeSize: 10, pnlThresholdPercent: 10, minConfidenceThreshold: 0.005, minProfitMargin: 0.05 },
    { targetedMarket: TargetedMarket.BITCOIN_HOURLY, predictionStyle: PredictionStyle.HOURLY_10M_50M, tradeSize: 10, pnlThresholdPercent: 10, minConfidenceThreshold: 0.005, minProfitMargin: 0.05 },
    { targetedMarket: TargetedMarket.BITCOIN_HOURLY, predictionStyle: PredictionStyle.HOURLY_10M_EOP, tradeSize: 10, pnlThresholdPercent: 10, minConfidenceThreshold: 0.005, minProfitMargin: 0.05 },
    { targetedMarket: TargetedMarket.BITCOIN_HOURLY, predictionStyle: PredictionStyle.HOURLY_20M_30M, tradeSize: 10, pnlThresholdPercent: 10, minConfidenceThreshold: 0.005, minProfitMargin: 0.05 },
    { targetedMarket: TargetedMarket.BITCOIN_HOURLY, predictionStyle: PredictionStyle.HOURLY_20M_40M, tradeSize: 10, pnlThresholdPercent: 10, minConfidenceThreshold: 0.005, minProfitMargin: 0.05 },
    { targetedMarket: TargetedMarket.BITCOIN_HOURLY, predictionStyle: PredictionStyle.HOURLY_20M_50M, tradeSize: 10, pnlThresholdPercent: 10, minConfidenceThreshold: 0.005, minProfitMargin: 0.05 },
    { targetedMarket: TargetedMarket.BITCOIN_HOURLY, predictionStyle: PredictionStyle.HOURLY_20M_EOP, tradeSize: 10, pnlThresholdPercent: 10, minConfidenceThreshold: 0.005, minProfitMargin: 0.05 },
    { targetedMarket: TargetedMarket.BITCOIN_HOURLY, predictionStyle: PredictionStyle.HOURLY_30M_40M, tradeSize: 10, pnlThresholdPercent: 10, minConfidenceThreshold: 0.005, minProfitMargin: 0.05 },
    { targetedMarket: TargetedMarket.BITCOIN_HOURLY, predictionStyle: PredictionStyle.HOURLY_30M_50M, tradeSize: 10, pnlThresholdPercent: 10, minConfidenceThreshold: 0.005, minProfitMargin: 0.05 },
    { targetedMarket: TargetedMarket.BITCOIN_HOURLY, predictionStyle: PredictionStyle.HOURLY_30M_EOP, tradeSize: 10, pnlThresholdPercent: 10, minConfidenceThreshold: 0.005, minProfitMargin: 0.05 },
    { targetedMarket: TargetedMarket.BITCOIN_HOURLY, predictionStyle: PredictionStyle.HOURLY_40M_50M, tradeSize: 10, pnlThresholdPercent: 10, minConfidenceThreshold: 0.005, minProfitMargin: 0.05 },
    { targetedMarket: TargetedMarket.BITCOIN_HOURLY, predictionStyle: PredictionStyle.HOURLY_40M_EOP, tradeSize: 10, pnlThresholdPercent: 10, minConfidenceThreshold: 0.005, minProfitMargin: 0.05 },
    { targetedMarket: TargetedMarket.BITCOIN_HOURLY, predictionStyle: PredictionStyle.HOURLY_50M_EOP, tradeSize: 10, pnlThresholdPercent: 10, minConfidenceThreshold: 0.005, minProfitMargin: 0.05 },

    { targetedMarket: TargetedMarket.BITCOIN_QUARTERLY, predictionStyle: PredictionStyle.QUARTERLY_10M_EOP, tradeSize: 10, pnlThresholdPercent: 10, minConfidenceThreshold: 0.005, minProfitMargin: 0.05 },
    { targetedMarket: TargetedMarket.BITCOIN_QUARTERLY, predictionStyle: PredictionStyle.QUARTERLY_3M_5M, tradeSize: 10, pnlThresholdPercent: 10, minConfidenceThreshold: 0.005, minProfitMargin: 0.05 },
    { targetedMarket: TargetedMarket.BITCOIN_QUARTERLY, predictionStyle: PredictionStyle.QUARTERLY_3M_8M, tradeSize: 10, pnlThresholdPercent: 10, minConfidenceThreshold: 0.005, minProfitMargin: 0.05 },
    { targetedMarket: TargetedMarket.BITCOIN_QUARTERLY, predictionStyle: PredictionStyle.QUARTERLY_3M_EOP, tradeSize: 10, pnlThresholdPercent: 10, minConfidenceThreshold: 0.005, minProfitMargin: 0.05 },
    { targetedMarket: TargetedMarket.BITCOIN_QUARTERLY, predictionStyle: PredictionStyle.QUARTERLY_5M_10M, tradeSize: 10, pnlThresholdPercent: 10, minConfidenceThreshold: 0.005, minProfitMargin: 0.05 },
    { targetedMarket: TargetedMarket.BITCOIN_QUARTERLY, predictionStyle: PredictionStyle.QUARTERLY_5M_8M, tradeSize: 10, pnlThresholdPercent: 10, minConfidenceThreshold: 0.005, minProfitMargin: 0.05 },
    { targetedMarket: TargetedMarket.BITCOIN_QUARTERLY, predictionStyle: PredictionStyle.QUARTERLY_5M_EOP, tradeSize: 10, pnlThresholdPercent: 10, minConfidenceThreshold: 0.005, minProfitMargin: 0.05 },
    { targetedMarket: TargetedMarket.BITCOIN_QUARTERLY, predictionStyle: PredictionStyle.QUARTERLY_8M_EOP, tradeSize: 10, pnlThresholdPercent: 10, minConfidenceThreshold: 0.005, minProfitMargin: 0.05 },


  ]).map((v) => {
    return new YOLOMLBot({
      name: `yoloml-${targetMarketToShortname(v.targetedMarket)}-${v.predictionStyle}`,
      ...v,
      ...commonTestProps,
    })
  }),
  // SuddenArb - ML-powered arbitrage bot using real-time price feeds
  ...([
    {
      targetedMarket: TargetedMarket.BITCOIN_HOURLY,
      mispricingThreshold: 0.05,    // 5% divergence (wider for test)
      targetProfitMargin: 0.03,     // 3% profit target
      maxPositionDollars: 5,        // Small positions for testing
      learningRate: 0.01,
      modelId: 'btc-hourly-1',
      binanceSymbol: 'BTCUSDT' as const,
      simulationOrderDelayMs: 2000, // Reduced delay for arb testing
    },
    {
      targetedMarket: TargetedMarket.BITCOIN_QUARTERLY,
      mispricingThreshold: 0.05,
      targetProfitMargin: 0.03,
      maxPositionDollars: 5,
      learningRate: 0.01,
      modelId: 'btc-quarterly-1',
      binanceSymbol: 'BTCUSDT' as const,
      simulationOrderDelayMs: 2000,
    },
  ]).map((v) => {
    return new SuddenArb({
      name: `suddenarb-${targetMarketToShortname(v.targetedMarket)}-${v.modelId}`,
      ...v,
      ...commonTestProps,
    })
  }),
]

// Genetic bot manager - loads bots from YAML and refreshes them hourly
const geneticBotManager = new GeneticBotManager({
  client: clobClient,
  marketInfo,
  refreshIntervalHours: 1,
});

// Configure which genetic bots to load (these will be refreshed hourly with new YAML params)
geneticBotManager
  // Trend  Following
  .addTestBot({
    botStyle: 'QuarterlyTrendFollowing',
    market: TargetedMarket.BITCOIN_QUARTERLY,
    overrides: { name: 'trendfollowing-btc15-gen1', ...commonTestProps },
  })
  .addTestBot({
    botStyle: 'QuarterlyTrendFollowing',
    market: TargetedMarket.ETHEREUM_QUARTERLY,
    overrides: { name: 'trendfollowing-eth15-gen1', ...commonTestProps },
  })
  .addTestBot({
    botStyle: 'QuarterlyTrendFollowing',
    market: TargetedMarket.SOLANA_QUARTERLY,
    overrides: { name: 'trendfollowing-sol15-gen1', ...commonTestProps },
  })
  .addTestBot({
    botStyle: 'QuarterlyTrendFollowing',
    market: TargetedMarket.XRP_QUARTERLY,
    overrides: { name: 'trendfollowing-xrp15-gen1', ...commonTestProps },
  })
  // Early Buyer V2
  .addTestBot({
    botStyle: 'QuarterlyEarlyBuyerV2',
    market: TargetedMarket.BITCOIN_QUARTERLY,
    overrides: { name: 'earlyv2-btc15-gen1', ...commonTestProps },
  })
  .addTestBot({
    botStyle: 'QuarterlyEarlyBuyerV2',
    market: TargetedMarket.ETHEREUM_QUARTERLY,
    overrides: { name: 'earlyv2-eth15-gen1', ...commonTestProps },
  })
  .addTestBot({
    botStyle: 'QuarterlyEarlyBuyerV2',
    market: TargetedMarket.SOLANA_QUARTERLY,
    overrides: { name: 'earlyv2-sol15-gen1', ...commonTestProps },
  })
  .addTestBot({
    botStyle: 'QuarterlyEarlyBuyerV2',
    market: TargetedMarket.XRP_QUARTERLY,
    overrides: { name: 'earlyv2-xrp15-gen1', ...commonTestProps },
  })
  // First Candle
  .addTestBot({
    botStyle: 'QuarterlyFirstCandle',
    market: TargetedMarket.BITCOIN_QUARTERLY,
    overrides: { name: 'fcandle-btc15-gen1', ...commonTestProps },
  })
  .addTestBot({
    botStyle: 'QuarterlyFirstCandle',
    market: TargetedMarket.ETHEREUM_QUARTERLY,
    overrides: { name: 'fcandle-eth15-gen1', ...commonTestProps },
  })
  .addTestBot({
    botStyle: 'QuarterlyFirstCandle',
    market: TargetedMarket.SOLANA_QUARTERLY,
    overrides: { name: 'fcandle-sol15-gen1', ...commonTestProps },
  })
  .addTestBot({
    botStyle: 'QuarterlyFirstCandle',
    market: TargetedMarket.XRP_QUARTERLY,
    overrides: { name: 'fcandle-xrp15-gen1', ...commonTestProps },
  })
  // Mean Reversion
  .addTestBot({
    botStyle: 'QuarterlyMeanReversion',
    market: TargetedMarket.BITCOIN_QUARTERLY,
    overrides: { name: 'mrev-btc15-gen1', ...commonTestProps },
  })
  .addTestBot({
    botStyle: 'QuarterlyMeanReversion',
    market: TargetedMarket.ETHEREUM_QUARTERLY,
    overrides: { name: 'mrev-eth15-gen1', ...commonTestProps },
  })
  .addTestBot({
    botStyle: 'QuarterlyMeanReversion',
    market: TargetedMarket.SOLANA_QUARTERLY,
    overrides: { name: 'mrev-sol15-gen1', ...commonTestProps },
  })
  .addTestBot({
    botStyle: 'QuarterlyMeanReversion',
    market: TargetedMarket.XRP_QUARTERLY,
    overrides: { name: 'mrev-xrp15-gen1', ...commonTestProps },
  })
  .addTestBot({
    botStyle: 'MarketMaker',
    market: TargetedMarket.BITCOIN_HOURLY,
    overrides: { name: 'mmaker-btc-gen1', ...commonTestProps },
  })

checkIfBotsHaveMatchingNames([...testBots, ...prodBots]);

console.log('running...')

// Track scheduled timeouts so we can cancel them on restart
let prodBotsTimeout: ReturnType<typeof setTimeout> | null = null;
let restartTimeout: ReturnType<typeof setTimeout> | null = null;

/**
 * Stops all services and bots.
 */
function stopAllServices(): void {
  console.log('[SYSTEM] Stopping all services...');

  // Stop scheduled timeouts
  if (prodBotsTimeout) {
    clearTimeout(prodBotsTimeout);
    prodBotsTimeout = null;
  }
  if (restartTimeout) {
    clearTimeout(restartTimeout);
    restartTimeout = null;
  }

  // Stop core services
  try {
    cdMarketData.stop();
  } catch (e) {
    console.error('[SYSTEM] Error stopping cdMarketData:', e);
  }

  try {
    marketInfo.stopPriceLogging();
  } catch (e) {
    console.error('[SYSTEM] Error stopping marketInfo:', e);
  }

  try {
    logCleaner.stop();
  } catch (e) {
    console.error('[SYSTEM] Error stopping logCleaner:', e);
  }

  try {
    redemptionSolver.stop();
  } catch (e) {
    console.error('[SYSTEM] Error stopping redemptionSolver:', e);
  }

  // Stop genetic bot manager (stops all genetic bots)
  try {
    geneticBotManager.stop();
  } catch (e) {
    console.error('[SYSTEM] Error stopping geneticBotManager:', e);
  }

  // Stop all manual bots
  [...testBots, ...prodBots].forEach((bot) => {
    try {
      bot.stop();
    } catch (e) {
      console.log(e);
      // Ignore stop errors
    }
  });

  // Close database connection
  try {
    tradingDb.close();
    console.log('[SYSTEM] Database closed');
  } catch (e) {
    console.error('[SYSTEM] Error closing database:', e);
  }
}

/**
 * Starts all core services and bots with error handling.
 * If any service fails, schedules a restart at the next hour.
 */
function startAllServices(): void {
  let hasScheduledRestart = false;

  const scheduleSystemRestart = (reason: string) => {
    if (hasScheduledRestart) return;
    hasScheduledRestart = true;

    console.error(`[SYSTEM] ${reason}. Scheduling full system restart at next hour boundary.`);

    stopAllServices();

    const msUntilRestart = getMsUntilNextHour() + 5 * 1000;
    console.log(`[SYSTEM] Will restart in ${formatDuration(msUntilRestart)}`);

    restartTimeout = setTimeout(() => {
      hasScheduledRestart = false;
      console.log('[SYSTEM] Restarting all services...');
      startAllServices();
    }, msUntilRestart);
  };

  // Start core services with error handling
  try {
    cdMarketData.run();
  } catch (e) {
    console.error('[SYSTEM] cdMarketData.run() failed:', e);
    scheduleSystemRestart('cdMarketData failed to start');
    return;
  }

  try {
    marketInfo.run();
  } catch (e) {
    console.error('[SYSTEM] marketInfo.run() failed:', e);
    scheduleSystemRestart('marketInfo failed to start');
    return;
  }

  // Start logCleaner with its own restart logic (doesn't affect the rest of the system)
  const startLogCleanerWithRestart = () => {
    try {
      logCleaner.run();
    } catch (e) {
      console.error('[SYSTEM] logCleaner.run() failed:', e);
      const msUntilRestart = getMsUntilNextHour() + 5 * 1000;
      console.log(`[SYSTEM] logCleaner will restart independently in ${formatDuration(msUntilRestart)}`);
      setTimeout(startLogCleanerWithRestart, msUntilRestart);
    }
  };
  startLogCleanerWithRestart();

  // Start redemption solver (verifies and corrects redemption entries every 6 hours)
  try {
    redemptionSolver.run();
  } catch (e) {
    console.error('[SYSTEM] redemptionSolver.run() failed:', e);
    // Don't restart the whole system for redemption solver failures
  }

  // Set up global error handler for uncaught exceptions
  const handleUncaughtError = (error: Error | unknown, origin: string) => {
    console.error(`[SYSTEM] Uncaught error (${origin}):`, error);
    scheduleSystemRestart(`Uncaught error: ${origin}`);
  };

  process.removeAllListeners('uncaughtException');
  process.removeAllListeners('unhandledRejection');

  process.on('uncaughtException', (error) => {
    handleUncaughtError(error, 'uncaughtException');
  });

  process.on('unhandledRejection', (reason) => {
    handleUncaughtError(reason, 'unhandledRejection');
  });

  // Start prod bots at the beginning of the hour
  // If we're within the first 5 minutes of the hour, start immediately
  // Otherwise, wait until the next hour
  const now = new Date();
  const minuteOfHour = now.getMinutes();
  const isNearHourStart = minuteOfHour < 5;

  if (isNearHourStart) {
    console.log(`[PROD] Starting ${prodBots.length} prod bots immediately (within first 5 minutes of hour)`);
    runBotsWithRestartOnFailure(prodBots, 'PROD');
  } else {
    const msUntilNextHour = getMsUntilNextHour() + 5 * 1000;
    console.log(`[PROD] Scheduling ${prodBots.length} prod bots to start in ${formatDuration(msUntilNextHour)} (at the next hour)`);

    prodBotsTimeout = setTimeout(() => {
      console.log('[PROD] Starting prod bots at hour boundary');
      runBotsWithRestartOnFailure(prodBots, 'PROD');
    }, msUntilNextHour);
  }

  // Start manual test bots immediately with restart on failure
  runBotsWithRestartOnFailure(testBots, 'TEST');

  // Start genetic bot manager (loads bots from YAML and refreshes hourly)
  try {
    geneticBotManager.start();
  } catch (e) {
    console.error('[SYSTEM] geneticBotManager.start() failed:', e);
    // Don't restart the whole system for genetic bot failures
  }
}

// Handle graceful shutdown on Ctrl+C (SIGINT) and SIGTERM
let isShuttingDown = false;

async function gracefulShutdown(signal: string): Promise<void> {
  if (isShuttingDown) {
    console.log('[SYSTEM] Shutdown already in progress...');
    return;
  }
  isShuttingDown = true;

  console.log(`\n[SYSTEM] Received ${signal}. Initiating graceful shutdown...`);
  console.log('[SYSTEM] Stopping all bots and cancelling active trades...');

  stopAllServices();

  // Give some time for trade cancellations to complete
  console.log('[SYSTEM] Waiting for trade cancellations to complete...');
  await new Promise(resolve => setTimeout(resolve, 3000));

  console.log('[SYSTEM] Shutdown complete. Exiting.');
  process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// Start all services
startAllServices();