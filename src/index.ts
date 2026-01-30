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
import { exit } from "process";
import { checkIfBotsHaveMatchingNames, formatDuration, getMsUntilNextHour, targetMarketToShortname } from "./utils/utils.js";
import { MarketMaker } from "./bots/MarketMaker.js";


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
  targetSize: 20,
}

const commonProdProps = {
  ...commonProps,
  PROD_MODE: true,
}

console.log('intitializing bots...')

const cdMarketData = CDMarketData.getInstance();

OrderBatcher.initialize(clobClient, 200);

// const redeemer = new Redeemer({
//   intervalHours: 1,
// });

// await redeemer.redeemAll();

// exit(1);

const prodBots: QuantBotRun[] = [
  // ...([
  //   // { hourlyDollarLimit: 10, targetedMarket: TargetedMarket.BITCOIN_HOURLY, candleMinutes: 10, breakoutBuffer: 50, pullbackBuffer: 100, targetBuyPrice: .60, targetSellPrice: .90, targetSize: 10, cutoffMinute: 50 },
  //   // { hourlyDollarLimit: 10, targetedMarket: TargetedMarket.BITCOIN_HOURLY, candleMinutes: 10, breakoutBuffer: 25, pullbackBuffer: 50, targetBuyPrice: .60, targetSellPrice: .90, targetSize: 10, cutoffMinute: 50 },
  //   // { hourlyDollarLimit: 10, targetedMarket: TargetedMarket.BITCOIN_HOURLY, candleMinutes: 10, breakoutBuffer: 10, pullbackBuffer: 20, targetBuyPrice: .60, targetSellPrice: .90, targetSize: 10, cutoffMinute: 50 },
  //   // { hourlyDollarLimit: 10, targetedMarket: TargetedMarket.ETHEREUM_HOURLY, candleMinutes: 10, breakoutBuffer: 50, pullbackBuffer: 100, targetBuyPrice: .60, targetSellPrice: .90, targetSize: 10, cutoffMinute: 50 },
  //   // { hourlyDollarLimit: 10, targetedMarket: TargetedMarket.ETHEREUM_HOURLY, candleMinutes: 10, breakoutBuffer: 25, pullbackBuffer: 50, targetBuyPrice: .60, targetSellPrice: .90, targetSize: 10, cutoffMinute: 50 },
  //   // fcandle-btc15-4m-bb4-pp5-b0.52-s0.9
  //   { hourlyDollarLimit: 10, targetedMarket: TargetedMarket.BITCOIN_QUARTERLY, candleMinutes: 4, breakoutBuffer: 50, pullbackBuffer: 20, targetBuyPrice: .60, targetSellPrice: .90, targetSize: 10, cutoffMinute: 10 },
  //   { hourlyDollarLimit: 10, targetedMarket: TargetedMarket.BITCOIN_QUARTERLY, candleMinutes: 4, breakoutBuffer: 4, pullbackBuffer: 5, targetBuyPrice: .52, targetSellPrice: .90, targetSize: 10, cutoffMinute: 12 },
  // ]).map((v) => {
  //   return new FirstCandle({
  //     ...v,
  //     name: `fcandle-${targetMarketToShortname(v.targetedMarket)}-${v.candleMinutes}m-bb${v.breakoutBuffer}-pp${v.pullbackBuffer}-b${v.targetBuyPrice}-s${v.targetSellPrice}-co${v.cutoffMinute}`,
  //     ...commonProdProps,
  //   })
  // }),
  // ...([
    // { targetedMarket: TargetedMarket.BITCOIN_HOURLY, cutoffMinute: 55, spreadSize: 8, profitMargin: .02, minPrice: .2, maxPrice: .8, stopLossAmount: .05, totalActiveTrades: 11, requiredVolatility: 2.4, volatilityLookbackPeriods: 25, buyExpirySeconds: 190, targetSize: 6,  hourlyDollarLimit: 50 },
    // { targetedMarket: TargetedMarket.ETHEREUM_HOURLY, cutoffMinute: 35, spreadSize: 10, profitMargin: .06, minPrice: .27, maxPrice: .79, stopLossAmount: .2, totalActiveTrades: 13, requiredVolatility: 2.6, volatilityLookbackPeriods: 16, buyExpirySeconds: 270, targetSize: 6, hourlyDollarLimit: 50 },
    // { targetedMarket: TargetedMarket.BITCOIN_QUARTERLY, cutoffMinute: 8, spreadSize: 4, profitMargin: .20, minPrice: .45, maxPrice: .55, stopLossAmount: .40, totalActiveTrades: 10, requiredVolatility: 1.7, volatilityLookbackPeriods: 10, buyExpirySeconds: 30, targetSize: 6, hourlyDollarLimit: 100 },
  // ]).map((v) => {
  //   return new MarketMaker({
  //     name: `mmaker-${targetMarketToShortname(v.targetedMarket)}-ss${v.spreadSize}-pm${v.profitMargin}-min${v.minPrice}-max${v.maxPrice}-sl${v.stopLossAmount}-rv${v.requiredVolatility}-vlp${v.volatilityLookbackPeriods}-bes${v.buyExpirySeconds}`,
  //     ...v,
  //     ...commonProdProps,
  //   })
  // }),
  // ...([
  //   { hourlyDollarLimit: 10, targetedMarket: TargetedMarket.BITCOIN_HOURLY, candleMinutes: 10, breakoutBuffer: 50, pullbackBuffer: 100, targetSize: 10, cutoffMinute: 50, buyPriceBuffer: .02, sellPriceBuffer: .34, minProfitMargin: .57 },
  // ]).map((v) => {
  //   return new FirstCandleV2({
  //     ...v,
  //     name: `fcandleV2-${targetMarketToShortname(v.targetedMarket)}-cm${v.candleMinutes}-bb${v.breakoutBuffer}-pp${v.pullbackBuffer}-bpb${v.buyPriceBuffer}-spb${v.sellPriceBuffer}-mpm${v.minProfitMargin}`,
  //     ...commonProdProps,
  //   })
  // }),
  ...([
  //   { hourlyDollarLimit: 10, targetedMarket: TargetedMarket.BITCOIN_QUARTERLY, shortMaPeriod: 3, longMaPeriod: 12, adxPeriod: 5, adxThreshold: 39.5, atrPeriod: 6, atrStopMultiple: 2.25, targetBuyPrice: .13, targetSellPrice: .80, targetSize: 10, cutoffMinute: 9 },
  //   { hourlyDollarLimit: 10, targetedMarket: TargetedMarket.BITCOIN_QUARTERLY, shortMaPeriod: 1, longMaPeriod: 5, adxPeriod: 12, adxThreshold: 1.25, atrPeriod: 1, atrStopMultiple: 3.7, targetBuyPrice: .05, targetSellPrice: .48, targetSize: 20, cutoffMinute: 5 },
  //   { hourlyDollarLimit: 10, targetedMarket: TargetedMarket.ETHEREUM_QUARTERLY, shortMaPeriod: 8, longMaPeriod: 1, adxPeriod: 5, adxThreshold: 1, atrPeriod: 11, atrStopMultiple: 2.3, targetBuyPrice: .05, targetSellPrice: .51, targetSize: 20, cutoffMinute: 5 },
  //   { hourlyDollarLimit: 10, targetedMarket: TargetedMarket.XRP_QUARTERLY, shortMaPeriod: 7, longMaPeriod: 1, adxPeriod: 9, adxThreshold: 1, atrPeriod: 9, atrStopMultiple: 2, targetBuyPrice: .05, targetSellPrice: .52, targetSize: 20, cutoffMinute: 5 },
  //   { hourlyDollarLimit: 10, targetedMarket: TargetedMarket.SOLANA_QUARTERLY, shortMaPeriod: 1, longMaPeriod: 7, adxPeriod: 14, adxThreshold: 6.9, atrPeriod: 10, atrStopMultiple: 1.06, targetBuyPrice: .05, targetSellPrice: .48, targetSize: 20, cutoffMinute: 9 },
    { hourlyDollarLimit: 10, targetedMarket: TargetedMarket.SOLANA_HOURLY, shortMaPeriod: 20, longMaPeriod: 13, adxPeriod: 4, adxThreshold: 38.5, atrPeriod: 16, atrStopMultiple: 2.75, targetBuyPrice: .4, targetSellPrice: .79, targetSize: 20, cutoffMinute: 45 },
    { hourlyDollarLimit: 10, targetedMarket: TargetedMarket.XRP_HOURLY, shortMaPeriod: 14, longMaPeriod: 20, adxPeriod: 4, adxThreshold: 60.9, atrPeriod: 14, atrStopMultiple: 2, targetBuyPrice: .46, targetSellPrice: .83, targetSize: 20, cutoffMinute: 30 },
  ]).map((v) => {
    return new TrendFollowing({
      ...v,
      name: `trendfollowing-${targetMarketToShortname(v.targetedMarket)}-smp${v.shortMaPeriod}-lmp${v.longMaPeriod}-co${v.cutoffMinute}-b${v.targetBuyPrice}-s${v.targetSellPrice}`,
      ...commonProdProps,
    })
  }),
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
    { targetedMarket: TargetedMarket.BITCOIN_HOURLY, cutoffMinute: 30, spreadSize: 5, profitMargin: .15, minPrice: .45, maxPrice: .57, stopLossAmount: .2, totalActiveTrades: 5, requiredVolatility: 2.1, volatilityLookbackPeriods: 20, buyExpirySeconds: 40 },
    { targetedMarket: TargetedMarket.BITCOIN_HOURLY, cutoffMinute: 55, spreadSize: 8, profitMargin: .02, minPrice: .2, maxPrice: .8, stopLossAmount: .05, totalActiveTrades: 11, requiredVolatility: 2.4, volatilityLookbackPeriods: 25, buyExpirySeconds: 190 },
    { targetedMarket: TargetedMarket.BITCOIN_QUARTERLY, cutoffMinute: 12, spreadSize: 4, profitMargin: .02, minPrice: .21, maxPrice: .8, stopLossAmount: .03, totalActiveTrades: 6, requiredVolatility: 2, volatilityLookbackPeriods: 9, buyExpirySeconds: 45 },
    // L:ast try
    { targetedMarket: TargetedMarket.BITCOIN_HOURLY, cutoffMinute: 30, spreadSize: 9, profitMargin: .09, minPrice: .41, maxPrice: .6655, stopLossAmount: .13, totalActiveTrades: 4, requiredVolatility: 2.6, volatilityLookbackPeriods: 20, buyExpirySeconds: 130 },
    { targetedMarket: TargetedMarket.BITCOIN_QUARTERLY, cutoffMinute: 8, spreadSize: 2, profitMargin: .02, minPrice: .41, maxPrice: .66, stopLossAmount: .13, totalActiveTrades: 2, requiredVolatility: 1.7, volatilityLookbackPeriods: 10, buyExpirySeconds: 120 },
    // Goobas
    { targetedMarket: TargetedMarket.BITCOIN_HOURLY, cutoffMinute: 30, spreadSize: 3, profitMargin: .09, minPrice: .45, maxPrice: .57, stopLossAmount: .18, totalActiveTrades: 3, requiredVolatility: 1.1, volatilityLookbackPeriods: 20, buyExpirySeconds: 140 },
    { targetedMarket: TargetedMarket.SOLANA_HOURLY, cutoffMinute: 50, spreadSize: 6, profitMargin: .11, minPrice: .25, maxPrice: .62, stopLossAmount: .11, totalActiveTrades: 12, requiredVolatility: 1.3, volatilityLookbackPeriods: 25, buyExpirySeconds: 130 },
    { targetedMarket: TargetedMarket.ETHEREUM_HOURLY, cutoffMinute: 35, spreadSize: 10, profitMargin: .06, minPrice: .27, maxPrice: .79, stopLossAmount: .2, totalActiveTrades: 13, requiredVolatility: 2.6, volatilityLookbackPeriods: 16, buyExpirySeconds: 270 },
  ]).map((v) => {
    return new MarketMaker({
      name: `mmaker-${targetMarketToShortname(v.targetedMarket)}-ss${v.spreadSize}-pm${v.profitMargin}-min${v.minPrice}-max${v.maxPrice}-sl${v.stopLossAmount}-rv${v.requiredVolatility}-vlp${v.volatilityLookbackPeriods}-bes${v.buyExpirySeconds}`,
      ...v,
      ...commonTestProps,
    })
  }),
  ...([
    { targetedMarket: TargetedMarket.ETHEREUM_HOURLY, lookbackHours: 5, targetBuyPrice: .50, targetSellPrice: .80, cutoffMinute: 10 },
    { targetedMarket: TargetedMarket.SOLANA_HOURLY, lookbackHours: 5, targetBuyPrice: .50, targetSellPrice: .80, cutoffMinute: 10 },
    { targetedMarket: TargetedMarket.XRP_HOURLY, lookbackHours: 5, targetBuyPrice: .50, targetSellPrice: .80, cutoffMinute: 10 },
    { targetedMarket: TargetedMarket.BITCOIN_QUARTERLY, lookbackHours: 1, targetBuyPrice: .50, targetSellPrice: .80, cutoffMinute: 10 },
    { targetedMarket: TargetedMarket.ETHEREUM_QUARTERLY, lookbackHours: 1, targetBuyPrice: .50, targetSellPrice: .80, cutoffMinute: 10 },
    { targetedMarket: TargetedMarket.SOLANA_QUARTERLY, lookbackHours: 1, targetBuyPrice: .50, targetSellPrice: .80, cutoffMinute: 10 },
    { targetedMarket: TargetedMarket.XRP_QUARTERLY, lookbackHours: 1, targetBuyPrice: .50, targetSellPrice: .80, cutoffMinute: 10 },
  ]).map((v) => {
    return new Contrarian({
      name: `contrarianV2-${targetMarketToShortname(v.targetedMarket)}-${v.lookbackHours}h-b${v.targetBuyPrice}-s${v.targetSellPrice}`,
      ...v,
      ...commonTestProps,
    })
  }),
  ...([
    { targetedMarket: TargetedMarket.BITCOIN_HOURLY, lookbackHours: 5, cdLookbackHours: 5, targetBuyPrice: .50, targetSellPrice: .99, cutoffMinute: 10 },
  ]).map((v) => {
    return new ContrarianV2({
      name: `contrarianV2-${targetMarketToShortname(v.targetedMarket)}-${v.lookbackHours}h-b${v.targetBuyPrice}-s${v.targetSellPrice}`,
      ...v,
      ...commonTestProps,
    })
  }),
  ...([
    { targetedMarket: TargetedMarket.BITCOIN_HOURLY, cutoffMinute: 20, targetBuyPrice: .4, targetSellPrice: .6, flopsLookbackHours: 5, minFlops: 1 },
    { targetedMarket: TargetedMarket.BITCOIN_HOURLY, cutoffMinute: 20, targetBuyPrice: .4, targetSellPrice: .6, flopsLookbackHours: 5, minFlops: 2 },
    { targetedMarket: TargetedMarket.BITCOIN_QUARTERLY, cutoffMinute: 6, targetBuyPrice: .4, targetSellPrice: .6, flopsLookbackHours: 5, minFlops: 2 },
    { targetedMarket: TargetedMarket.BITCOIN_QUARTERLY, cutoffMinute: 6, targetBuyPrice: .12, targetSellPrice: .46, flopsLookbackHours: 5, minFlops: 2 },
    { targetedMarket: TargetedMarket.ETHEREUM_QUARTERLY, cutoffMinute: 6, targetBuyPrice: .4, targetSellPrice: .6, flopsLookbackHours: 5, minFlops: 2 },
    { targetedMarket: TargetedMarket.ETHEREUM_QUARTERLY, cutoffMinute: 6, targetBuyPrice: .12, targetSellPrice: .46, flopsLookbackHours: 5, minFlops: 2 },
    { targetedMarket: TargetedMarket.SOLANA_QUARTERLY, cutoffMinute: 6, targetBuyPrice: .4, targetSellPrice: .6, flopsLookbackHours: 5, minFlops: 2 },
    { targetedMarket: TargetedMarket.SOLANA_QUARTERLY, cutoffMinute: 6, targetBuyPrice: .12, targetSellPrice: .46, flopsLookbackHours: 5, minFlops: 2 },
    { targetedMarket: TargetedMarket.XRP_QUARTERLY, cutoffMinute: 6, targetBuyPrice: .4, targetSellPrice: .6, flopsLookbackHours: 5, minFlops: 2 },
    { targetedMarket: TargetedMarket.XRP_QUARTERLY, cutoffMinute: 6, targetBuyPrice: .12, targetSellPrice: .46, flopsLookbackHours: 5, minFlops: 2 },
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
    { targetedMarket: TargetedMarket.BITCOIN_HOURLY, cutoffMinute: 55, targetAmount: 5, triggerPrice: .65, targetBuyPrice: .68, targetSellPrice: .85, flopsLookbackHours: 5, maxFlops: 1 },
  ]).map((v) => {
    return new EarlyLimitV2({
      name: `elimV2-${targetMarketToShortname(v.targetedMarket)}-l${v.triggerPrice}-b${v.targetBuyPrice}-s${v.targetSellPrice}`,
      ...v,
      ...commonTestProps,
    })
  }),
  ...([
    { targetedMarket: TargetedMarket.BITCOIN_HOURLY, candleMinutes: 10, breakoutBuffer: 50, pullbackBuffer: 100, targetBuyPrice: .60, targetSellPrice: .90, cutoffMinute: 50 },
    { targetedMarket: TargetedMarket.BITCOIN_HOURLY, candleMinutes: 10, breakoutBuffer: 25, pullbackBuffer: 50, targetBuyPrice: .60, targetSellPrice: .90, cutoffMinute: 50 },
    { targetedMarket: TargetedMarket.BITCOIN_HOURLY, candleMinutes: 10, breakoutBuffer: 10, pullbackBuffer: 20, targetBuyPrice: .60, targetSellPrice: .90, cutoffMinute: 50 },
    { targetedMarket: TargetedMarket.BITCOIN_HOURLY, candleMinutes: 8, breakoutBuffer: 34, pullbackBuffer: 400, targetBuyPrice: .58, targetSellPrice: .98, cutoffMinute: 35 },
    { targetedMarket: TargetedMarket.BITCOIN_HOURLY, candleMinutes: 6, breakoutBuffer: 189, pullbackBuffer: 315, targetBuyPrice: .27, targetSellPrice: .68, cutoffMinute: 45 },
    { targetedMarket: TargetedMarket.ETHEREUM_HOURLY, candleMinutes: 10, breakoutBuffer: 50, pullbackBuffer: 100, targetBuyPrice: .60, targetSellPrice: .90, cutoffMinute: 50 },
    { targetedMarket: TargetedMarket.ETHEREUM_HOURLY, candleMinutes: 10, breakoutBuffer: 25, pullbackBuffer: 50, targetBuyPrice: .60, targetSellPrice: .90, cutoffMinute: 50 },
    { targetedMarket: TargetedMarket.ETHEREUM_HOURLY, candleMinutes: 10, breakoutBuffer: 10, pullbackBuffer: 20, targetBuyPrice: .60, targetSellPrice: .90, cutoffMinute: 50 },
    { targetedMarket: TargetedMarket.SOLANA_HOURLY, candleMinutes: 10, breakoutBuffer: 5, pullbackBuffer: 2, targetBuyPrice: .60, targetSellPrice: .90, cutoffMinute: 50 },
    { targetedMarket: TargetedMarket.SOLANA_HOURLY, candleMinutes: 10, breakoutBuffer: 2, pullbackBuffer: 1, targetBuyPrice: .60, targetSellPrice: .90, cutoffMinute: 50 },
    { targetedMarket: TargetedMarket.SOLANA_HOURLY, candleMinutes: 10, breakoutBuffer: 10, pullbackBuffer: 5, targetBuyPrice: .60, targetSellPrice: .90, cutoffMinute: 50 },
    { targetedMarket: TargetedMarket.XRP_HOURLY, candleMinutes: 10, breakoutBuffer: .1, pullbackBuffer: .05, targetBuyPrice: .60, targetSellPrice: .90, cutoffMinute: 50 },
    { targetedMarket: TargetedMarket.XRP_HOURLY, candleMinutes: 10, breakoutBuffer: .2, pullbackBuffer: .1, targetBuyPrice: .60, targetSellPrice: .90, cutoffMinute: 50 },
    { targetedMarket: TargetedMarket.XRP_HOURLY, candleMinutes: 10, breakoutBuffer: .03, pullbackBuffer: .02, targetBuyPrice: .60, targetSellPrice: .90, cutoffMinute: 50 },
    { targetedMarket: TargetedMarket.BITCOIN_QUARTERLY, candleMinutes: 4, breakoutBuffer: 20, pullbackBuffer: 5, targetBuyPrice: .52, targetSellPrice: .90, cutoffMinute: 12 },
    { targetedMarket: TargetedMarket.BITCOIN_QUARTERLY, candleMinutes: 4, breakoutBuffer: 50, pullbackBuffer: 10, targetBuyPrice: .52, targetSellPrice: .90, cutoffMinute: 12 },
    { targetedMarket: TargetedMarket.ETHEREUM_QUARTERLY, candleMinutes: 4, breakoutBuffer: 10, pullbackBuffer: 4, targetBuyPrice: .52, targetSellPrice: .90, cutoffMinute: 12 },
    { targetedMarket: TargetedMarket.ETHEREUM_QUARTERLY, candleMinutes: 4, breakoutBuffer: 20, pullbackBuffer: 6, targetBuyPrice: .52, targetSellPrice: .90, cutoffMinute: 12 },
    { targetedMarket: TargetedMarket.SOLANA_QUARTERLY, candleMinutes: 4, breakoutBuffer: 1, pullbackBuffer: .5, targetBuyPrice: .52, targetSellPrice: .90, cutoffMinute: 12 },
    { targetedMarket: TargetedMarket.SOLANA_QUARTERLY, candleMinutes: 4, breakoutBuffer: 2, pullbackBuffer: .7, targetBuyPrice: .52, targetSellPrice: .90, cutoffMinute: 12 },
    { targetedMarket: TargetedMarket.XRP_QUARTERLY, candleMinutes: 4, breakoutBuffer: .1, pullbackBuffer: .02, targetBuyPrice: .52, targetSellPrice: .90, cutoffMinute: 12 },
    { targetedMarket: TargetedMarket.XRP_QUARTERLY, candleMinutes: 4, breakoutBuffer: .2, pullbackBuffer: .04, targetBuyPrice: .52, targetSellPrice: .90, cutoffMinute: 12 },
  ]).map((v) => {
    return new FirstCandle({
      ...v,
      name: `fcandle-${targetMarketToShortname(v.targetedMarket)}-${v.candleMinutes}m-bb${v.candleMinutes}-pp${v.pullbackBuffer}-b${v.targetBuyPrice}-s${v.targetSellPrice}-co${v.cutoffMinute}`,
      ...commonTestProps,
    })
  }),
  ...([
    { targetedMarket: TargetedMarket.BITCOIN_HOURLY, candleMinutes: 10, breakoutBuffer: 50, pullbackBuffer: 100, targetSize: 10, cutoffMinute: 50, buyPriceBuffer: .02, sellPriceBuffer: .10, minProfitMargin: .05 },
    { targetedMarket: TargetedMarket.BITCOIN_HOURLY, candleMinutes: 10, breakoutBuffer: 25, pullbackBuffer: 50, cutoffMinute: 50, buyPriceBuffer: .02, sellPriceBuffer: .10, minProfitMargin: .05 },
    { targetedMarket: TargetedMarket.BITCOIN_HOURLY, candleMinutes: 10, breakoutBuffer: 10, pullbackBuffer: 20, cutoffMinute: 50, buyPriceBuffer: .02, sellPriceBuffer: .10, minProfitMargin: .05 },
    { targetedMarket: TargetedMarket.BITCOIN_HOURLY, candleMinutes: 8, breakoutBuffer: 10, pullbackBuffer: 353, cutoffMinute: 50, buyPriceBuffer: .04, sellPriceBuffer: .45, minProfitMargin: .9 },
    { targetedMarket: TargetedMarket.BITCOIN_HOURLY, candleMinutes: 8, breakoutBuffer: 30, pullbackBuffer: 109, cutoffMinute: 45, buyPriceBuffer: .04, sellPriceBuffer: .01, minProfitMargin: .8 },
    { targetedMarket: TargetedMarket.BITCOIN_HOURLY, candleMinutes: 8, breakoutBuffer: 183, pullbackBuffer: 290, cutoffMinute: 55, buyPriceBuffer: .01, sellPriceBuffer: .57, minProfitMargin: .9 },
    { targetedMarket: TargetedMarket.ETHEREUM_HOURLY, candleMinutes: 6, breakoutBuffer: 182, pullbackBuffer: 322, cutoffMinute: 35, buyPriceBuffer: .02, sellPriceBuffer: .34, minProfitMargin: .4 },
    { targetedMarket: TargetedMarket.SOLANA_HOURLY, candleMinutes: 6, breakoutBuffer: 5, pullbackBuffer: 3, cutoffMinute: 35, buyPriceBuffer: .02, sellPriceBuffer: .02, minProfitMargin: .4 },
    { targetedMarket: TargetedMarket.XRP_HOURLY, candleMinutes: 6, breakoutBuffer: .05, pullbackBuffer: .02, cutoffMinute: 35, buyPriceBuffer: .02, sellPriceBuffer: .02, minProfitMargin: .4 },
  ]).map((v) => {
    return new FirstCandleV2({
      ...v,
      name: `fcandleV2-${targetMarketToShortname(v.targetedMarket)}-cm${v.candleMinutes}-bb${v.breakoutBuffer}-pp${v.pullbackBuffer}-bpb${v.buyPriceBuffer}-spb${v.sellPriceBuffer}-mpm${v.minProfitMargin}`,
      ...commonTestProps,
    })
  }),
  ...([
    { targetedMarket: TargetedMarket.BITCOIN_HOURLY, lookbackPeriods: 15, entryThreshold: 2, exitThreshold: .5, targetBuyPrice: .55, targetSellPrice: .85, cutoffMinute: 45 },
    { targetedMarket: TargetedMarket.BITCOIN_HOURLY, lookbackPeriods: 30, entryThreshold: 1.0, exitThreshold: 2.5, targetBuyPrice: .50, targetSellPrice: .89, cutoffMinute: 45 },
    { targetedMarket: TargetedMarket.BITCOIN_HOURLY, lookbackPeriods: 60, entryThreshold: 2.0, exitThreshold: 0.5, targetBuyPrice: .55, targetSellPrice: .85, cutoffMinute: 45 },
    { targetedMarket: TargetedMarket.BITCOIN_HOURLY, lookbackPeriods: 60, entryThreshold: 2.5, exitThreshold: 1, targetBuyPrice: .26, targetSellPrice: .95, cutoffMinute: 50 },
    { targetedMarket: TargetedMarket.BITCOIN_QUARTERLY, lookbackPeriods: 7, entryThreshold: 2.3, exitThreshold: 1, targetBuyPrice: .06, targetSellPrice: .78, cutoffMinute: 8 },
    { targetedMarket: TargetedMarket.BITCOIN_QUARTERLY, lookbackPeriods: 7, entryThreshold: 2.3, exitThreshold: 1, targetBuyPrice: .06, targetSellPrice: .98, cutoffMinute: 8 },
    { targetedMarket: TargetedMarket.ETHEREUM_QUARTERLY, lookbackPeriods: 7, entryThreshold: 2.3, exitThreshold: 1, targetBuyPrice: .06, targetSellPrice: .98, cutoffMinute: 8 },
    { targetedMarket: TargetedMarket.SOLANA_QUARTERLY, lookbackPeriods: 7, entryThreshold: 2.3, exitThreshold: 1, targetBuyPrice: .06, targetSellPrice: .98, cutoffMinute: 8 },
    { targetedMarket: TargetedMarket.XRP_QUARTERLY, lookbackPeriods: 7, entryThreshold: 2.3, exitThreshold: 1, targetBuyPrice: .06, targetSellPrice: .98, cutoffMinute: 8 },
  ]).map((v) => {
    return new MeanReversion({
      ...v,
      name: `mrev-${targetMarketToShortname(v.targetedMarket)}-${v.lookbackPeriods}p-et${v.entryThreshold}-b${v.targetBuyPrice}-s${v.targetSellPrice}`,
      ...commonTestProps,
    })
  }),
  ...([
    { targetedMarket: TargetedMarket.BITCOIN_HOURLY, shortMaPeriod: 5, longMaPeriod: 20, adxPeriod: 14, adxThreshold: 25, atrPeriod: 14, atrStopMultiple: 2.0, targetBuyPrice: .55, targetSellPrice: .95, cutoffMinute: 45 },
    { targetedMarket: TargetedMarket.BITCOIN_HOURLY, shortMaPeriod: 10, longMaPeriod: 40, adxPeriod: 28, adxThreshold: 25, atrPeriod: 14, atrStopMultiple: 2.0, targetBuyPrice: .55, targetSellPrice: .85, cutoffMinute: 45 },
    { targetedMarket: TargetedMarket.BITCOIN_HOURLY, shortMaPeriod: 5, longMaPeriod: 20, adxPeriod: 20, adxThreshold: 20, atrPeriod: 20, atrStopMultiple: 1.0, targetBuyPrice: .52, targetSellPrice: .93, cutoffMinute: 45 },
    { targetedMarket: TargetedMarket.BITCOIN_HOURLY, shortMaPeriod: 5, longMaPeriod: 22, adxPeriod: 22, adxThreshold: 18.5, atrPeriod: 14, atrStopMultiple: 1.0, targetBuyPrice: .16, targetSellPrice: .65, cutoffMinute: 40 },
    { targetedMarket: TargetedMarket.BITCOIN_QUARTERLY, shortMaPeriod: 2, longMaPeriod: 5, adxPeriod: 3, adxThreshold: 6, atrPeriod: 4, atrStopMultiple: 2.0, targetBuyPrice: .52, targetSellPrice: .95, cutoffMinute: 10 },
    { targetedMarket: TargetedMarket.BITCOIN_QUARTERLY, shortMaPeriod: 4, longMaPeriod: 10, adxPeriod: 6, adxThreshold: 12, atrPeriod: 8, atrStopMultiple: 2.0, targetBuyPrice: .52, targetSellPrice: .95, cutoffMinute: 10 },
    // Jan23
    { hourlyDollarLimit: 10, targetedMarket: TargetedMarket.BITCOIN_QUARTERLY, shortMaPeriod: 3, longMaPeriod: 12, adxPeriod: 5, adxThreshold: 39.5, atrPeriod: 6, atrStopMultiple: 2.25, targetBuyPrice: .10, targetSellPrice: .25, targetSize: 10, cutoffMinute: 8 },
    { hourlyDollarLimit: 10, targetedMarket: TargetedMarket.ETHEREUM_QUARTERLY, shortMaPeriod: 3, longMaPeriod: 12, adxPeriod: 5, adxThreshold: 39.5, atrPeriod: 6, atrStopMultiple: 2.25, targetBuyPrice: .10, targetSellPrice: .25, targetSize: 10, cutoffMinute: 8 },
    { hourlyDollarLimit: 10, targetedMarket: TargetedMarket.SOLANA_QUARTERLY, shortMaPeriod: 3, longMaPeriod: 12, adxPeriod: 5, adxThreshold: 39.5, atrPeriod: 6, atrStopMultiple: 2.25, targetBuyPrice: .10, targetSellPrice: .25, targetSize: 10, cutoffMinute: 8 },
    { hourlyDollarLimit: 10, targetedMarket: TargetedMarket.XRP_QUARTERLY, shortMaPeriod: 3, longMaPeriod: 12, adxPeriod: 5, adxThreshold: 39.5, atrPeriod: 6, atrStopMultiple: 2.25, targetBuyPrice: .10, targetSellPrice: .25, targetSize: 10, cutoffMinute: 8 },
    { hourlyDollarLimit: 10, targetedMarket: TargetedMarket.BITCOIN_QUARTERLY, shortMaPeriod: 3, longMaPeriod: 12, adxPeriod: 5, adxThreshold: 39.5, atrPeriod: 6, atrStopMultiple: 2.25, targetBuyPrice: .08, targetSellPrice: .20, targetSize: 10, cutoffMinute: 8 },
    { hourlyDollarLimit: 10, targetedMarket: TargetedMarket.ETHEREUM_QUARTERLY, shortMaPeriod: 3, longMaPeriod: 12, adxPeriod: 5, adxThreshold: 39.5, atrPeriod: 6, atrStopMultiple: 2.25, targetBuyPrice: .08, targetSellPrice: .20, targetSize: 10, cutoffMinute: 8 },
    { hourlyDollarLimit: 10, targetedMarket: TargetedMarket.SOLANA_QUARTERLY, shortMaPeriod: 3, longMaPeriod: 12, adxPeriod: 5, adxThreshold: 39.5, atrPeriod: 6, atrStopMultiple: 2.25, targetBuyPrice: .08, targetSellPrice: .20, targetSize: 10, cutoffMinute: 8 },
    { hourlyDollarLimit: 10, targetedMarket: TargetedMarket.XRP_QUARTERLY, shortMaPeriod: 3, longMaPeriod: 12, adxPeriod: 5, adxThreshold: 39.5, atrPeriod: 6, atrStopMultiple: 2.25, targetBuyPrice: .08, targetSellPrice: .20, targetSize: 10, cutoffMinute: 8 },

  ]).map((v) => {
    return new TrendFollowing({
      ...v,
      name: `trendfollowing-${targetMarketToShortname(v.targetedMarket)}-smp${v.shortMaPeriod}-lmp${v.longMaPeriod}-co${v.cutoffMinute}-b${v.targetBuyPrice}-s${v.targetSellPrice}`,
      ...commonTestProps,
    })
  }),
]

checkIfBotsHaveMatchingNames([...testBots, ...prodBots]);

console.log('running...')

const logCleaner = new LogCleaner({
  logsDirectory: './logs',
  retentionDays: 30,
});

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

  // Stop all bots
  [...prodBots, ...testBots].forEach((bot) => {
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

  // Start test bots immediately with restart on failure
  runBotsWithRestartOnFailure(testBots, 'TEST');
}

// Start all services
startAllServices();