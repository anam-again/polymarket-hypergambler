import { Arbitrage98 } from "./bots/Arbitrage98.js";
import { Credentials } from "./nonBots/Credentials.js";
import { EarlyBuyer } from "./bots/EarlyBuyer.js";
import { BtcDirection, TargetedMarket } from "./types/interfaces.js";
import { MarketInfo } from "./nonBots/MarketInfo.js";
import { OrderBatcher, QuantBotRun, runBotsWithRestartOnFailure } from "./bots/QuantBot.js";
import { Contrarian } from "./bots/Contrarian.js";
import { CDMarketData } from "./nonBots/CDMarketData.js";
import { ContrarianV2 } from "./bots/ContrarianV2.js";
import { EarlyBuyerV2 } from "./bots/EarlyBuyerV2.js";
import { EarlyLimitV2 } from "./bots/EarlyLimitV2.js";
import { FirstCandle } from "./bots/FirstCandle.js";
import { FirstCandleV2 } from "./bots/FirstCandleV2.js";
import { MeanReversion } from "./bots/MeanReversion.js";
import { TrendFollowing } from "./bots/TrendFollowing.js";
import { LogCleaner } from "./nonBots/LogCleaner.js";
import { EveningStar } from "./bots/EveningStar.js";
import { MorningStar } from "./bots/MorningStar.js";
import { NCandle } from "./bots/NCandle.js";
import { EsotericNormalization } from "./bots/EsotericNormalization.js";
import { Redeemer } from "./nonBots/Redeemer.js";
import { RedemptionSolver } from "./nonBots/RedemptionSolver.js";
import { exit } from "process";
import { checkIfBotsHaveMatchingNames, formatDuration, getMsUntilNextHour, targetMarketToShortname } from "./utils/utils.js";
import { MarketMaker } from "./bots/MarketMaker.js";
import { GeneticOptimizedReader } from "./genetic/GeneticOptimizedReader.js";
import { GeneticBotManager } from "./genetic/GeneticBotManager.js";
import { YOLOMLBot } from "./bots/YOLOMLBot.js";
import { PredictionStyle } from "./ml/types.js";
import { ScalingPEQ, ScalingPEQCoefficients } from "./utils/ScalingPEQ.js";


const credentials = new Credentials();
const clobClient = await credentials.initClobClient();

const marketInfo = new MarketInfo({
  client: clobClient,
});

const commonProps = {
  client: clobClient,
  marketInfo,
}
const commonTestProps = {
  ...commonProps,
  PROD_MODE: false,
  hourlyDollarLimit: 100000,
  targetDollars: 20,
}

const commonProdProps = {
  ...commonProps,
  PROD_MODE: true,
}

const logCleaner = new LogCleaner({
  logsDirectory: './logs',
  retentionDays: 60,
});

const redemptionSolver = new RedemptionSolver(marketInfo);

console.log('intitializing bots...')

const cdMarketData = CDMarketData.getInstance();

OrderBatcher.initialize(clobClient, 200);

// const redeemer = new Redeemer({
//   intervalHours: 1,
// });

// await redeemer.redeemAll();

// exit(1);

const prodBots: QuantBotRun[] = [
  ...([
    { targetedMarket: TargetedMarket.BITCOIN_QUARTERLY, candleMinutes: 4, breakoutBuffer: 50, pullbackBuffer: 10, baseBuyPrice: .52, minProfitMargin: .38, cutoffMinute: 12, targetDollars: 5, hourlyDollarLimit: 5 },
    { targetedMarket: TargetedMarket.BITCOIN_QUARTERLY, candleMinutes: 4, breakoutBuffer: 50, pullbackBuffer: 5, baseBuyPrice: .52, minProfitMargin: .38, cutoffMinute: 12, targetDollars: 5, hourlyDollarLimit: 5 },
  ]).map((v) => {
    return new FirstCandle({
      ...v,
      name: `fcandle-${targetMarketToShortname(v.targetedMarket)}-${v.candleMinutes}m-bb${v.breakoutBuffer}-pp${v.pullbackBuffer}-b${v.baseBuyPrice}-mpm${v.minProfitMargin}-co${v.cutoffMinute}`,
      ...commonProdProps,
      candleSizeReference: 1000,
      targetBuyPricePEQ: { c0: 1, c1: 0, c2: 0, c3: 0 },
      targetSellPricePEQ: { c0: 1, c1: 0, c2: 0, c3: 0 },
      earlySellTimePEQ: { c0: 0.2, c1: 0, c2: 0, c3: 0 },
      earlySellPricePEQ: { c0: 1, c1: 0, c2: 0, c3: 0 },
    })
  }),
  // ...([
  //   { targetedMarket: TargetedMarket.BITCOIN_QUARTERLY, cutoffMinute: 8, spreadSize: 5, minSpreadDistance: .01, profitMargin: .50, minPrice: .45, maxPrice: .86, stopLossAmount: .04, totalActiveTrades: 9, maxVolatility: 5, minVolatility: 0, volatilityLookbackPeriods: 1, buyExpirySeconds: 85, targetDollars: 6,  hourlyDollarLimit: 30 },
  // ]).map((v) => {
  //   return new MarketMaker({
  //     name: `mmaker-${targetMarketToShortname(v.targetedMarket)}-ss${v.spreadSize}-msd${v.minSpreadDistance}-pm${v.profitMargin}-min${v.minPrice}-max${v.maxPrice}-sl${v.stopLossAmount}-maxv${v.maxVolatility}-minv${v.minVolatility}-vlp${v.volatilityLookbackPeriods}-bes${v.buyExpirySeconds}`,
  //     ...v,
  //     ...commonProdProps,
  //   })
  // }),
  // ...([
  //   { hourlyDollarLimit: 10, targetedMarket: TargetedMarket.BITCOIN_HOURLY, candleMinutes: 10, breakoutBuffer: 50, pullbackBuffer: 100, targetDollars: 10, cutoffMinute: 50, buyPriceBuffer: .02, sellPriceBuffer: .34, minProfitMargin: .57 },
  // ]).map((v) => {
  //   return new FirstCandleV2({
  //     ...v,
  //     name: `fcandleV2-${targetMarketToShortname(v.targetedMarket)}-cm${v.candleMinutes}-bb${v.breakoutBuffer}-pp${v.pullbackBuffer}-bpb${v.buyPriceBuffer}-spb${v.sellPriceBuffer}-mpm${v.minProfitMargin}`,
  //     ...commonProdProps,
  //   })
  // }),
  // ...([
  //   { hourlyDollarLimit: 10, targetedMarket: TargetedMarket.BITCOIN_QUARTERLY, shortMaPeriod: 5, longMaPeriod: 13, adxPeriod: 6, adxThreshold: 26.4, atrPeriod: 13, atrStopMultiple: 3.59, targetBuyPrice: .07, targetSellPrice: .95, targetDollars: 15, cutoffMinute: 9 },
  //   { hourlyDollarLimit: 10, targetedMarket: TargetedMarket.ETHEREUM_QUARTERLY, shortMaPeriod: 8, longMaPeriod: 18, adxPeriod: 15, adxThreshold: 21.65, atrPeriod: 6, atrStopMultiple: 1.51, targetBuyPrice: .23, targetSellPrice: .95, targetDollars: 6, cutoffMinute: 9 },
  //   { hourlyDollarLimit: 10, targetedMarket: TargetedMarket.XRP_QUARTERLY, shortMaPeriod: 4, longMaPeriod: 19, adxPeriod: 13, adxThreshold: 33.9, atrPeriod: 13, atrStopMultiple: 3.5, targetBuyPrice: .35, targetSellPrice: .63, targetDollars: 6, cutoffMinute: 12 },
  // ]).map((v) => {
  //   return new TrendFollowing({
  //     ...v,
  //     name: `trendfollowing-${targetMarketToShortname(v.targetedMarket)}-smp${v.shortMaPeriod}-lmp${v.longMaPeriod}-co${v.cutoffMinute}-b${v.targetBuyPrice}-s${v.targetSellPrice}`,
  //     ...commonProdProps,
  //   })
  // }),
]

const testBots: QuantBotRun[] = [
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
    // Feb7
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
    // { targetedMarket: TargetedMarket.SOLANA_HOURLY, lookbackHours: 5, targetBuyPrice: .50, targetSellPrice: .80, cutoffMinute: 10 },
    // { targetedMarket: TargetedMarket.XRP_HOURLY, lookbackHours: 5, targetBuyPrice: .50, targetSellPrice: .80, cutoffMinute: 10 },
    // { targetedMarket: TargetedMarket.BITCOIN_QUARTERLY, lookbackHours: 1, targetBuyPrice: .50, targetSellPrice: .80, cutoffMinute: 10 },
    // { targetedMarket: TargetedMarket.ETHEREUM_QUARTERLY, lookbackHours: 1, targetBuyPrice: .50, targetSellPrice: .80, cutoffMinute: 10 },
    // { targetedMarket: TargetedMarket.SOLANA_QUARTERLY, lookbackHours: 1, targetBuyPrice: .50, targetSellPrice: .80, cutoffMinute: 10 },
    // { targetedMarket: TargetedMarket.XRP_QUARTERLY, lookbackHours: 1, targetBuyPrice: .50, targetSellPrice: .80, cutoffMinute: 10 },
  ]).map((v) => {
    return new Contrarian({
      name: `contrarianV2-${targetMarketToShortname(v.targetedMarket)}-${v.lookbackHours}h-b${v.targetBuyPrice}-s${v.targetSellPrice}`,
      ...v,
      ...commonTestProps,
    })
  }),
  // ...([
  //   { targetedMarket: TargetedMarket.BITCOIN_HOURLY, lookbackHours: 5, cdLookbackHours: 5, targetBuyPrice: .50, targetSellPrice: .99, cutoffMinute: 10 },
  // ]).map((v) => {
  //   return new ContrarianV2({
  //     name: `contrarianV2-${targetMarketToShortname(v.targetedMarket)}-${v.lookbackHours}h-b${v.targetBuyPrice}-s${v.targetSellPrice}`,
  //     ...v,
  //     ...commonTestProps,
  //   })
  // }),
  ...([
    { targetedMarket: TargetedMarket.BITCOIN_HOURLY, cutoffMinute: 20, targetBuyPrice: .4, targetSellPrice: .6, flopsLookbackHours: 5, minFlops: 1 },
    // { targetedMarket: TargetedMarket.BITCOIN_HOURLY, cutoffMinute: 20, targetBuyPrice: .4, targetSellPrice: .6, flopsLookbackHours: 5, minFlops: 2 },
    // { targetedMarket: TargetedMarket.BITCOIN_QUARTERLY, cutoffMinute: 6, targetBuyPrice: .4, targetSellPrice: .6, flopsLookbackHours: 5, minFlops: 2 },
    // { targetedMarket: TargetedMarket.BITCOIN_QUARTERLY, cutoffMinute: 6, targetBuyPrice: .12, targetSellPrice: .46, flopsLookbackHours: 5, minFlops: 2 },
    // { targetedMarket: TargetedMarket.ETHEREUM_QUARTERLY, cutoffMinute: 6, targetBuyPrice: .4, targetSellPrice: .6, flopsLookbackHours: 5, minFlops: 2 },
    // { targetedMarket: TargetedMarket.ETHEREUM_QUARTERLY, cutoffMinute: 6, targetBuyPrice: .12, targetSellPrice: .46, flopsLookbackHours: 5, minFlops: 2 },
    // { targetedMarket: TargetedMarket.SOLANA_QUARTERLY, cutoffMinute: 6, targetBuyPrice: .4, targetSellPrice: .6, flopsLookbackHours: 5, minFlops: 2 },
    // { targetedMarket: TargetedMarket.SOLANA_QUARTERLY, cutoffMinute: 6, targetBuyPrice: .12, targetSellPrice: .46, flopsLookbackHours: 5, minFlops: 2 },
    // { targetedMarket: TargetedMarket.XRP_QUARTERLY, cutoffMinute: 6, targetBuyPrice: .4, targetSellPrice: .6, flopsLookbackHours: 5, minFlops: 2 },
    // { targetedMarket: TargetedMarket.XRP_QUARTERLY, cutoffMinute: 6, targetBuyPrice: .12, targetSellPrice: .46, flopsLookbackHours: 5, minFlops: 2 },
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
    // { targetedMarket: TargetedMarket.BITCOIN_HOURLY, cutoffMinute: 55, targetAmount: 5, triggerPrice: .65, targetBuyPrice: .68, targetSellPrice: .85, flopsLookbackHours: 5, maxFlops: 1 },
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
    // new optimizer
    { targetedMarket: TargetedMarket.BITCOIN_HOURLY, candleMinutes: 10, breakoutBuffer: 148, pullbackBuffer: 355, baseBuyPrice: .59, minProfitMargin: .36, cutoffMinute: 12, targetDollars: 5, hourlyDollarLimit: 10 },
  ]).map((v) => {
    return new FirstCandle({
      ...v,
      name: `fcandle-${targetMarketToShortname(v.targetedMarket)}-${v.candleMinutes}m-bb${v.candleMinutes}-pp${v.pullbackBuffer}-b${v.baseBuyPrice}-mpm${v.minProfitMargin}-co${v.cutoffMinute}`,
      ...commonTestProps,
      candleSizeReference: 1000,
      targetBuyPricePEQ: { c0: 1, c1: 0, c2: 0, c3: 0 },
      targetSellPricePEQ: { c0: 1, c1: 0, c2: 0, c3: 0 },
      earlySellTimePEQ: { c0: 0.2, c1: 0, c2: 0, c3: 0 },
      earlySellPricePEQ: { c0: 1, c1: 0, c2: 0, c3: 0 },
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
    buyPriceBufferPEQ: new ScalingPEQ({ c0: 0.07, c1: 1.207, c2: -0.64, c3: -0.973 }),
    sellPriceBuffer: .09,
    minProfitMargin: .36,
    minProfitMarginPEQ: new ScalingPEQ({ c0: 0.395, c1: -1.791, c2: -1.7592, c3: -1.665 }),
    stopLossMultiplier: .695,
    stoplossTimeout: 50,
    stoplossTimeoutPEQ: new ScalingPEQ({ c0: 0, c1: .201, c2: -0.724, c3: 1.038 }),
    sellTimeout: 1350,
    sellTimeoutPEQ: new ScalingPEQ({ c0: .58, c1: .66, c2: .17, c3: .533 }),
    stoplossFailureTimeout: 1595,
    stoplossFailureTimeoutPEQ: new ScalingPEQ({ c0: .802, c1: 2.0, c2: 1.12, c3: .746 }),
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
      buyPriceBufferPEQ: new ScalingPEQ({ c0: 1.72, c1: -1.46, c2: 1.337, c3: 1.48 } as ScalingPEQCoefficients),
      sellPriceBuffer: .03,
      minProfitMargin: .38,
      minProfitMarginPEQ: new ScalingPEQ({ c0: .35, c1: -1.24, c2: -.4, c3: .74 } as ScalingPEQCoefficients),
      stopLossMultiplier: .75,
      stoplossTimeout: 55.0,
      stoplossTimeoutPEQ: new ScalingPEQ({ c0: .27, c1: .20, c2: 1.35, c3: -1.9 } as ScalingPEQCoefficients),
      sellTimeout: 285,
      sellTimeoutPEQ: new ScalingPEQ({ c0: 1.98, c1: .0394, c2: -1.852, c3: 1.117 } as ScalingPEQCoefficients),
      stoplossFailureTimeout: 365,
      stoplossFailureTimeoutPEQ: new ScalingPEQ({ c0: .72, c1: 1.6, c2: -.96, c3: .974 } as ScalingPEQCoefficients),
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
    // { targetedMarket: TargetedMarket.BITCOIN_HOURLY, candleMinutes: 10, breakoutBuffer: 25, pullbackBuffer: 50, cutoffMinute: 50, buyPriceBuffer: .02, sellPriceBuffer: .10, minProfitMargin: .05 },
    // { targetedMarket: TargetedMarket.BITCOIN_HOURLY, candleMinutes: 10, breakoutBuffer: 10, pullbackBuffer: 20, cutoffMinute: 50, buyPriceBuffer: .02, sellPriceBuffer: .10, minProfitMargin: .05 },
    // { targetedMarket: TargetedMarket.BITCOIN_HOURLY, candleMinutes: 8, breakoutBuffer: 10, pullbackBuffer: 353, cutoffMinute: 50, buyPriceBuffer: .04, sellPriceBuffer: .45, minProfitMargin: .9 },
    // { targetedMarket: TargetedMarket.BITCOIN_HOURLY, candleMinutes: 8, breakoutBuffer: 30, pullbackBuffer: 109, cutoffMinute: 45, buyPriceBuffer: .04, sellPriceBuffer: .01, minProfitMargin: .8 },
    // { targetedMarket: TargetedMarket.BITCOIN_HOURLY, candleMinutes: 8, breakoutBuffer: 183, pullbackBuffer: 290, cutoffMinute: 55, buyPriceBuffer: .01, sellPriceBuffer: .57, minProfitMargin: .9 },
    // { targetedMarket: TargetedMarket.ETHEREUM_HOURLY, candleMinutes: 6, breakoutBuffer: 182, pullbackBuffer: 322, cutoffMinute: 35, buyPriceBuffer: .02, sellPriceBuffer: .34, minProfitMargin: .4 },
    // { targetedMarket: TargetedMarket.SOLANA_HOURLY, candleMinutes: 6, breakoutBuffer: 5, pullbackBuffer: 3, cutoffMinute: 35, buyPriceBuffer: .02, sellPriceBuffer: .02, minProfitMargin: .4 },
    // { targetedMarket: TargetedMarket.XRP_HOURLY, candleMinutes: 6, breakoutBuffer: .05, pullbackBuffer: .02, cutoffMinute: 35, buyPriceBuffer: .02, sellPriceBuffer: .02, minProfitMargin: .4 },
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
    // { targetedMarket: TargetedMarket.BITCOIN_HOURLY, lookbackPeriods: 30, entryThreshold: 1.0, exitThreshold: 2.5, targetBuyPrice: .50, targetSellPrice: .89, cutoffMinute: 45 },
    // { targetedMarket: TargetedMarket.BITCOIN_HOURLY, lookbackPeriods: 60, entryThreshold: 2.0, exitThreshold: 0.5, targetBuyPrice: .55, targetSellPrice: .85, cutoffMinute: 45 },
    // { targetedMarket: TargetedMarket.BITCOIN_HOURLY, lookbackPeriods: 60, entryThreshold: 2.5, exitThreshold: 1, targetBuyPrice: .26, targetSellPrice: .95, cutoffMinute: 50 },
    // { targetedMarket: TargetedMarket.BITCOIN_QUARTERLY, lookbackPeriods: 7, entryThreshold: 2.3, exitThreshold: 1, targetBuyPrice: .06, targetSellPrice: .78, cutoffMinute: 8 },
    // { targetedMarket: TargetedMarket.BITCOIN_QUARTERLY, lookbackPeriods: 7, entryThreshold: 2.3, exitThreshold: 1, targetBuyPrice: .06, targetSellPrice: .98, cutoffMinute: 8 },
    // { targetedMarket: TargetedMarket.ETHEREUM_QUARTERLY, lookbackPeriods: 7, entryThreshold: 2.3, exitThreshold: 1, targetBuyPrice: .06, targetSellPrice: .98, cutoffMinute: 8 },
    // { targetedMarket: TargetedMarket.SOLANA_QUARTERLY, lookbackPeriods: 7, entryThreshold: 2.3, exitThreshold: 1, targetBuyPrice: .06, targetSellPrice: .98, cutoffMinute: 8 },
    // { targetedMarket: TargetedMarket.XRP_QUARTERLY, lookbackPeriods: 7, entryThreshold: 2.3, exitThreshold: 1, targetBuyPrice: .06, targetSellPrice: .98, cutoffMinute: 8 },
  ]).map((v) => {
    return new MeanReversion({
      ...v,
      name: `mrev-${targetMarketToShortname(v.targetedMarket)}-${v.lookbackPeriods}p-et${v.entryThreshold}-b${v.targetBuyPrice}-s${v.targetSellPrice}`,
      ...commonTestProps,
    })
  }),
  // ...([
  // { targetedMarket: TargetedMarket.BITCOIN_HOURLY, shortMaPeriod: 5, longMaPeriod: 20, adxPeriod: 14, adxThreshold: 25, atrPeriod: 14, atrStopMultiple: 2.0, targetBuyPrice: .55, targetSellPrice: .95, cutoffMinute: 45 },
  // { targetedMarket: TargetedMarket.BITCOIN_HOURLY, shortMaPeriod: 10, longMaPeriod: 40, adxPeriod: 28, adxThreshold: 25, atrPeriod: 14, atrStopMultiple: 2.0, targetBuyPrice: .55, targetSellPrice: .85, cutoffMinute: 45 },
  // { targetedMarket: TargetedMarket.BITCOIN_HOURLY, shortMaPeriod: 5, longMaPeriod: 20, adxPeriod: 20, adxThreshold: 20, atrPeriod: 20, atrStopMultiple: 1.0, targetBuyPrice: .52, targetSellPrice: .93, cutoffMinute: 45 },
  // { targetedMarket: TargetedMarket.BITCOIN_HOURLY, shortMaPeriod: 5, longMaPeriod: 22, adxPeriod: 22, adxThreshold: 18.5, atrPeriod: 14, atrStopMultiple: 1.0, targetBuyPrice: .16, targetSellPrice: .65, cutoffMinute: 40 },
  // { targetedMarket: TargetedMarket.BITCOIN_QUARTERLY, shortMaPeriod: 2, longMaPeriod: 5, adxPeriod: 3, adxThreshold: 6, atrPeriod: 4, atrStopMultiple: 2.0, targetBuyPrice: .52, targetSellPrice: .95, cutoffMinute: 10 },
  // { targetedMarket: TargetedMarket.BITCOIN_QUARTERLY, shortMaPeriod: 4, longMaPeriod: 10, adxPeriod: 6, adxThreshold: 12, atrPeriod: 8, atrStopMultiple: 2.0, targetBuyPrice: .52, targetSellPrice: .95, cutoffMinute: 10 },
  // Jan23
  // { hourlyDollarLimit: 10, targetedMarket: TargetedMarket.BITCOIN_QUARTERLY, shortMaPeriod: 3, longMaPeriod: 12, adxPeriod: 5, adxThreshold: 39.5, atrPeriod: 6, atrStopMultiple: 2.25, targetBuyPrice: .10, targetSellPrice: .25, targetDollars: 10, cutoffMinute: 8 },
  // { hourlyDollarLimit: 10, targetedMarket: TargetedMarket.ETHEREUM_QUARTERLY, shortMaPeriod: 3, longMaPeriod: 12, adxPeriod: 5, adxThreshold: 39.5, atrPeriod: 6, atrStopMultiple: 2.25, targetBuyPrice: .10, targetSellPrice: .25, targetDollars: 10, cutoffMinute: 8 },
  // { hourlyDollarLimit: 10, targetedMarket: TargetedMarket.SOLANA_QUARTERLY, shortMaPeriod: 3, longMaPeriod: 12, adxPeriod: 5, adxThreshold: 39.5, atrPeriod: 6, atrStopMultiple: 2.25, targetBuyPrice: .10, targetSellPrice: .25, targetDollars: 10, cutoffMinute: 8 },
  // { hourlyDollarLimit: 10, targetedMarket: TargetedMarket.XRP_QUARTERLY, shortMaPeriod: 3, longMaPeriod: 12, adxPeriod: 5, adxThreshold: 39.5, atrPeriod: 6, atrStopMultiple: 2.25, targetBuyPrice: .10, targetSellPrice: .25, targetDollars: 10, cutoffMinute: 8 },
  // { hourlyDollarLimit: 10, targetedMarket: TargetedMarket.BITCOIN_QUARTERLY, shortMaPeriod: 3, longMaPeriod: 12, adxPeriod: 5, adxThreshold: 39.5, atrPeriod: 6, atrStopMultiple: 2.25, targetBuyPrice: .08, targetSellPrice: .20, targetDollars: 10, cutoffMinute: 8 },
  // { hourlyDollarLimit: 10, targetedMarket: TargetedMarket.ETHEREUM_QUARTERLY, shortMaPeriod: 3, longMaPeriod: 12, adxPeriod: 5, adxThreshold: 39.5, atrPeriod: 6, atrStopMultiple: 2.25, targetBuyPrice: .08, targetSellPrice: .20, targetDollars: 10, cutoffMinute: 8 },
  // { hourlyDollarLimit: 10, targetedMarket: TargetedMarket.SOLANA_QUARTERLY, shortMaPeriod: 3, longMaPeriod: 12, adxPeriod: 5, adxThreshold: 39.5, atrPeriod: 6, atrStopMultiple: 2.25, targetBuyPrice: .08, targetSellPrice: .20, targetDollars: 10, cutoffMinute: 8 },
  // { hourlyDollarLimit: 10, targetedMarket: TargetedMarket.XRP_QUARTERLY, shortMaPeriod: 3, longMaPeriod: 12, adxPeriod: 5, adxThreshold: 39.5, atrPeriod: 6, atrStopMultiple: 2.25, targetBuyPrice: .08, targetSellPrice: .20, targetDollars: 10, cutoffMinute: 8 },

  // ]).map((v) => {
  //   return new TrendFollowing({
  //     ...v,
  //     name: `trendfollowing-${targetMarketToShortname(v.targetedMarket)}-smp${v.shortMaPeriod}-lmp${v.longMaPeriod}-co${v.cutoffMinute}-b${v.targetBuyPrice}-s${v.targetSellPrice}`,
  //     ...commonTestProps,
  //   })
  // }),
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

// Start all services
startAllServices();