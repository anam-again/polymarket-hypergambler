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
  hourlyDollarLimit: 20,
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
  ...([
    { hourlyDollarLimit: 10, targetedMarket: TargetedMarket.BITCOIN_HOURLY, candleMinutes: 10, breakoutBuffer: 50, pullbackBuffer: 100, targetBuyPrice: .60, targetSellPrice: .90, targetSize: 10, cutoffMinute: 50 },
    { hourlyDollarLimit: 10, targetedMarket: TargetedMarket.BITCOIN_HOURLY, candleMinutes: 10, breakoutBuffer: 25, pullbackBuffer: 50, targetBuyPrice: .60, targetSellPrice: .90, targetSize: 10, cutoffMinute: 50 },
    { hourlyDollarLimit: 10, targetedMarket: TargetedMarket.BITCOIN_HOURLY, candleMinutes: 10, breakoutBuffer: 10, pullbackBuffer: 20, targetBuyPrice: .60, targetSellPrice: .90, targetSize: 10, cutoffMinute: 50 },
    { hourlyDollarLimit: 10, targetedMarket: TargetedMarket.ETHEREUM_HOURLY, candleMinutes: 10, breakoutBuffer: 50, pullbackBuffer: 100, targetBuyPrice: .60, targetSellPrice: .90, targetSize: 10, cutoffMinute: 50 },
    { hourlyDollarLimit: 10, targetedMarket: TargetedMarket.ETHEREUM_HOURLY, candleMinutes: 10, breakoutBuffer: 25, pullbackBuffer: 50, targetBuyPrice: .60, targetSellPrice: .90, targetSize: 10, cutoffMinute: 50 },
    { hourlyDollarLimit: 10, targetedMarket: TargetedMarket.BITCOIN_QUARTERLY, candleMinutes: 4, breakoutBuffer: 50, pullbackBuffer: 20, targetBuyPrice: .60, targetSellPrice: .90, targetSize: 10, cutoffMinute: 10 },
  ]).map((v) => {
    return new FirstCandle({
      ...v,
      name: `fcandle-${targetMarketToShortname(v.targetedMarket)}-${v.candleMinutes}m-bb${v.breakoutBuffer}-pp${100}-b${v.targetBuyPrice}-s${v.targetSellPrice}`,
      ...commonProdProps,
    })
  }),
  ...([
    { hourlyDollarLimit: 10, targetedMarket: TargetedMarket.BITCOIN_HOURLY, candleMinutes: 10, breakoutBuffer: 50, pullbackBuffer: 100, targetSize: 10, cutoffMinute: 50, buyPriceBuffer: .02, sellPriceBuffer: .34, minProfitMargin: .57 },
  ]).map((v) => {
    return new FirstCandleV2({
      ...v,
      name: `fcandleV2-${targetMarketToShortname(v.targetedMarket)}-cm${v.candleMinutes}-bb${v.breakoutBuffer}-pp${v.pullbackBuffer}-bpb${v.buyPriceBuffer}-spb${v.sellPriceBuffer}-mpm${v.minProfitMargin}`,
      ...commonProdProps,
    })
  }),
  ...([
    { hourlyDollarLimit: 10, targetedMarket: TargetedMarket.BITCOIN_QUARTERLY, shortMaPeriod: 3, longMaPeriod: 12, adxPeriod: 5, adxThreshold: 39.5, atrPeriod: 6, atrStopMultiple: 2.25, targetBuyPrice: .13, targetSellPrice: .80, targetSize: 10, cutoffMinute: 9 },
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
      name: `fcandle-${targetMarketToShortname(v.targetedMarket)}-${v.candleMinutes}m-bb${v.candleMinutes}-pp${v.pullbackBuffer}-b${v.targetBuyPrice}-s${v.targetSellPrice}`,
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

cdMarketData.run();
marketInfo.run();

const logCleaner = new LogCleaner({
  logsDirectory: './logs',
  retentionDays: 60,
});
logCleaner.run();

// Start prod bots at the beginning of the next hour with restart on failure
const msUntilNextHour = getMsUntilNextHour() + 5 * 1000;
console.log(`[PROD] Scheduling ${prodBots.length} prod bots to start in ${formatDuration(msUntilNextHour)} (at the next hour)`);

setTimeout(() => {
  console.log('[PROD] Starting prod bots at hour boundary');
  runBotsWithRestartOnFailure(prodBots, 'PROD');
}, msUntilNextHour);

// Start test bots immediately with restart on failure
runBotsWithRestartOnFailure(testBots, 'TEST');