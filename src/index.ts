import { Arbitrage98 } from "./bots/Arbitrage98.js";
import { Credentials } from "./nonBots/Credentials.js";
import { EarlyBuyer } from "./bots/EarlyBuyer.js";
import { BtcDirection } from "./types/interfaces.js";
import { MarketInfo } from "./nonBots/MarketInfo.js";
import { QuantBotRun } from "./bots/QuantBot.js";
import { Contrarian } from "./bots/Contrarian.js";
import { EarlyLimit } from "./bots/EarlyLimit.js";
import { CDMarketData } from "./nonBots/CDMarketData.js";
import { EsotericNormal } from "./bots/EsotericNormal.js";
import { MarketContrarian } from "./bots/MarketContrarian.js";
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


const credentials = new Credentials();
const clobClient = await credentials.initClobClient();

const marketInfo = new MarketInfo({
  client: clobClient,
});

const commonProps = {
  client: clobClient,
  marketInfo,
}

console.log('intitializing bots...')

const cdMarketData = CDMarketData.getInstance();

const prodBots: QuantBotRun[] = [
  new Contrarian({
    name: 'contrarian-5h-b50-s80',
    PROD_MODE: true,
    lookbackHours: 5,
    hourlyDollarLimit: 2.5,
    targetBuyPrice: .50,
    targetSellPrice: .80,
    targetSize: 5,
    cutoffMinute: 10,
    ...commonProps,
  }),
  new TrendFollowing({
    name: 'trend-sm5-lm-20-adx25-b55-s85',
    PROD_MODE: true,
    hourlyDollarLimit: 5,
    shortMaPeriod: 5,
    longMaPeriod: 20,
    adxPeriod: 14,
    adxThreshold: 25,
    atrPeriod: 14,
    atrStopMultiple: 2.0,
    targetBuyPrice: 0.55,
    targetSellPrice: 0.85,
    targetSize: 5,
    cutoffMinute: 45,
    ...commonProps,
  }),
  new FirstCandle({
    name: 'firstcandle-10m-bb50-pp100-b60-s90',
    PROD_MODE: true,
    hourlyDollarLimit: 5,
    candleMinutes: 10,
    breakoutBuffer: 50,
    pullbackBuffer: 100,
    targetBuyPrice: 0.60,
    targetSellPrice: 0.90,
    targetSize: 5,
    cutoffMinute: 50,
    ...commonProps,
  }),
  new FirstCandle({
    name: 'firstcandle-10m-bb25-pp50-b60-s90',
    PROD_MODE: true,
    hourlyDollarLimit: 5,
    candleMinutes: 10,
    breakoutBuffer: 25,
    pullbackBuffer: 50,
    targetBuyPrice: 0.60,
    targetSellPrice: 0.90,
    targetSize: 5,
    cutoffMinute: 50,
    ...commonProps,
  }),
  new FirstCandle({
    name: 'firstcandle-10m-bb10-pp20-b60-s90',
    PROD_MODE: true,
    hourlyDollarLimit: 5,
    candleMinutes: 10,
    breakoutBuffer: 10,
    pullbackBuffer: 20,
    targetBuyPrice: 0.60,
    targetSellPrice: 0.90,
    targetSize: 5,
    cutoffMinute: 50,
    ...commonProps,
  }),
]

const testBots: QuantBotRun[] = [
  new Arbitrage98({
    name: 'arbitrage-98',
    PROD_MODE: false,
    hourlyDollarLimit: 10.0,
    ...commonProps,
  }),
  new Contrarian({
    name: 'contrarian-1h-b50-s97',
    PROD_MODE: false,
    lookbackHours: 1,
    hourlyDollarLimit: 2.5,
    targetBuyPrice: .50,
    targetSellPrice: .97,
    targetSize: 5,
    cutoffMinute: 10,
    ...commonProps,
  }),
  new Contrarian({
    name: 'contrarian-5h-b50-s97',
    PROD_MODE: false,
    lookbackHours: 5,
    hourlyDollarLimit: 2.5,
    targetBuyPrice: .50,
    targetSellPrice: .97,
    targetSize: 5,
    cutoffMinute: 10,
    ...commonProps,
  }),
  new EarlyLimit({
    name: 'earlylim-up-l79-b80-s90',
    PROD_MODE: false,
    cutoffMinute: 30,
    hourlyDollarLimit: 5,
    targetAmount: 5,
    triggerPrice: .79,
    targetBuyPrice: .80,
    targetSellPrice: .90,
    btcDirection: BtcDirection.UP,
    ...commonProps,
  }),
  new EarlyLimit({
    name: 'earlylim-down-l79-b80-s90',
    PROD_MODE: false,
    cutoffMinute: 30,
    hourlyDollarLimit: 5,
    targetAmount: 5,
    triggerPrice: .79,
    targetBuyPrice: .80,
    targetSellPrice: .90,
    btcDirection: BtcDirection.DOWN,
    ...commonProps,
  }),
  // new EsotericNormal({
  //   name: 'esonormal-p200-t6-sd2',
  //   hourlyDollarLimit: 4,
  //   standardPriceDiff: 200,
  //   timeElapsedLinearBound: .6,
  //   sdevMagic: 2,
  //   PROD_MODE: false,
  //   cdMarketData,
  //   ...commonProps,
  // }),
  new MarketContrarian({
    name: 'mcontrarian-1h-b50-s90',
    cutoffMinute: 15,
    PROD_MODE: false,
    hourlyDollarLimit: 2.5,
    lookbackHours: 1,
    targetBuyPrice: .50,
    targetSellPrice: .90,
    targetSize: 5,
    cdMarketData: cdMarketData,
    ...commonProps,
  }),
  new MarketContrarian({
    name: 'mcontrarian-5h-b50-s90',
    cutoffMinute: 15,
    PROD_MODE: false,
    hourlyDollarLimit: 2.5,
    lookbackHours: 5,
    targetBuyPrice: .50,
    targetSellPrice: .90,
    targetSize: 5,
    cdMarketData: cdMarketData,
    ...commonProps,
  }),
  new ContrarianV2({
    name: 'contrarianV2-5h-b50-s99',
    PROD_MODE: false,
    lookbackHours: 5,
    cdLookbackHours: 5,
    hourlyDollarLimit: 2.5,
    targetBuyPrice: .50,
    targetSellPrice: .99,
    targetSize: 5,
    cutoffMinute: 10,
    ...commonProps,
  }),
  new EarlyBuyerV2({
    name: 'earlyV2-up-b40-s60-f1',
    PROD_MODE: false,
    hourlyDollarLimit: 2.0,
    cutoffMinute: 20,
    targetBuyPrice: .40,
    targetSize: 5,
    targetSellPrice: .60,
    flopsLookbackHours: 5,
    minFlops: 1,
    btcDirection: BtcDirection.UP,
    ...commonProps,
  }),
  new EarlyBuyerV2({
    name: 'earlyV2-up-b40-s60-f2',
    PROD_MODE: false,
    hourlyDollarLimit: 2.0,
    cutoffMinute: 20,
    targetBuyPrice: .40,
    targetSize: 5,
    targetSellPrice: .60,
    flopsLookbackHours: 5,
    minFlops: 2,
    btcDirection: BtcDirection.UP,
    ...commonProps,
  }),
  new EarlyLimitV2({
    name: 'elimV2-l75-b78-s90',
    PROD_MODE: false,
    cutoffMinute: 55,
    hourlyDollarLimit: 5,
    targetAmount: 5,
    triggerPrice: .75,
    targetBuyPrice: .78,
    targetSellPrice: .90,
    flopsLookbackHours: 5,
    maxFlops: 1,
    ...commonProps,
  }),
  new EarlyLimitV2({
    name: 'elimV2-l65-b68-s85',
    PROD_MODE: false,
    cutoffMinute: 55,
    hourlyDollarLimit: 5,
    targetAmount: 5,
    triggerPrice: .65,
    targetBuyPrice: .68,
    targetSellPrice: .85,
    flopsLookbackHours: 5,
    maxFlops: 1,
    ...commonProps,
  }),
  new FirstCandle({
    name: 'firstcandle-10m-bb50-pp100-b60-s90',
    PROD_MODE: false,
    hourlyDollarLimit: 5,
    candleMinutes: 10,
    breakoutBuffer: 50,
    pullbackBuffer: 100,
    targetBuyPrice: 0.60,
    targetSellPrice: 0.90,
    targetSize: 5,
    cutoffMinute: 50,
    ...commonProps,
  }),
  new FirstCandle({
    name: 'firstcandle-10m-bb25-pp50-b60-s90',
    PROD_MODE: false,
    hourlyDollarLimit: 5,
    candleMinutes: 10,
    breakoutBuffer: 25,
    pullbackBuffer: 50,
    targetBuyPrice: 0.60,
    targetSellPrice: 0.90,
    targetSize: 5,
    cutoffMinute: 50,
    ...commonProps,
  }),
  new FirstCandle({
    name: 'firstcandle-10m-bb10-pp20-b60-s90',
    PROD_MODE: false,
    hourlyDollarLimit: 5,
    candleMinutes: 10,
    breakoutBuffer: 10,
    pullbackBuffer: 20,
    targetBuyPrice: 0.60,
    targetSellPrice: 0.90,
    targetSize: 5,
    cutoffMinute: 50,
    ...commonProps,
  }),
  new FirstCandleV2({
    name: 'fcv2-10m-bb50-pp100-bbuf2-sbuf2-mp5',
    PROD_MODE: false,
    hourlyDollarLimit: 5,
    candleMinutes: 10,
    breakoutBuffer: 50,
    pullbackBuffer: 100,
    buyPriceBuffer: 0.02,
    sellPriceBuffer: 0.10,
    minProfitMargin: 0.05,
    targetSize: 5,
    cutoffMinute: 50,
    ...commonProps,
  }),
  new FirstCandleV2({
    name: 'fcv2-10m-bb25-pp50-bbuf2-sbuf2-mp5',
    PROD_MODE: false,
    hourlyDollarLimit: 5,
    candleMinutes: 10,
    breakoutBuffer: 25,
    pullbackBuffer: 50,
    buyPriceBuffer: 0.02,
    sellPriceBuffer: 0.10,
    minProfitMargin: 0.05,
    targetSize: 5,
    cutoffMinute: 50,
    ...commonProps,
  }),
  new FirstCandleV2({
    name: 'fcv2-10m-bb10-pp20-bbuf2-sbuf2-mp5',
    PROD_MODE: false,
    hourlyDollarLimit: 5,
    candleMinutes: 10,
    breakoutBuffer: 10,
    pullbackBuffer: 20,
    buyPriceBuffer: 0.02,
    sellPriceBuffer: 0.10,
    minProfitMargin: 0.05,
    targetSize: 5,
    cutoffMinute: 50,
    ...commonProps,
  }),
  new MeanReversion({
    name: 'meanrev-15p-z2',
    PROD_MODE: false,
    hourlyDollarLimit: 5,
    lookbackPeriods: 15,
    entryThreshold: 2.0,
    exitThreshold: 0.5,
    targetBuyPrice: 0.55,
    targetSellPrice: 0.85,
    targetSize: 5,
    cutoffMinute: 45,
    ...commonProps,
  }),
  new MeanReversion({
    name: 'meanrev-30p-z2',
    PROD_MODE: false,
    hourlyDollarLimit: 5,
    lookbackPeriods: 30,
    entryThreshold: 1.0,
    exitThreshold: 2.5,
    targetBuyPrice: 0.50,
    targetSellPrice: 0.89,
    targetSize: 5,
    cutoffMinute: 45,
    ...commonProps,
  }),
  new MeanReversion({
    name: 'meanrev-60p-z2',
    PROD_MODE: false,
    hourlyDollarLimit: 5,
    lookbackPeriods: 60,
    entryThreshold: 2.0,
    exitThreshold: 0.5,
    targetBuyPrice: 0.55,
    targetSellPrice: 0.85,
    targetSize: 5,
    cutoffMinute: 45,
    ...commonProps,
  }),
  // I have  no idea what these do
  new TrendFollowing({
    name: 'trend-sm5-lm-20-adx25-b55-s95',
    PROD_MODE: false,
    hourlyDollarLimit: 5,
    shortMaPeriod: 5,
    longMaPeriod: 20,
    adxPeriod: 14,
    adxThreshold: 25,
    atrPeriod: 14,
    atrStopMultiple: 2.0,
    targetBuyPrice: 0.55,
    targetSellPrice: 0.95,
    targetSize: 5,
    cutoffMinute: 45,
    ...commonProps,
  }),
  new TrendFollowing({
    name: 'trend-sm10-lm40-adx25-b55-s85',
    PROD_MODE: false,
    hourlyDollarLimit: 5,
    shortMaPeriod: 10,
    longMaPeriod: 40,
    adxPeriod: 28,
    adxThreshold: 25,
    atrPeriod: 24,
    atrStopMultiple: 2.0,
    targetBuyPrice: 0.55,
    targetSellPrice: 0.85,
    targetSize: 5,
    cutoffMinute: 45,
    ...commonProps,
  }),
  new TrendFollowing({
    name: 'trend-sm5-lm20-adx20-b52-s93',
    PROD_MODE: false,
    hourlyDollarLimit: 5,
    shortMaPeriod: 5,
    longMaPeriod: 20,
    adxPeriod: 20,
    adxThreshold: 20,
    atrPeriod: 20,
    atrStopMultiple: 1.0,
    targetBuyPrice: 0.52,
    targetSellPrice: 0.93,
    targetSize: 5,
    cutoffMinute: 45,
    ...commonProps,
  }),
  // new MorningStar({
  //   name: 'mstar-',
  //   PROD_MODE: false,
  //   candleMinutes: 10,
  //   cutoffMinute: 55,
  //   hourlyDollarLimit: 5,
  //   targetSize: 5,

  //   ...commonProps,
  // })
]
// implement and adjust mstar
/**
 * Bots to write
 * Esoteric normalization bot, makes a spread of what  prices 'should'  be based off of time and relative price to start. arbs the diff
 * Morning Star Reversal Pattern
 * bard.fx bearish/bullish candle
 * Fair value gap
 * 
 * Short Term:
 * batch orders
 * v3: include late sellofs for shitty trades
 * Remove some logs from busy trades
 * Clone to test mode and have it run on different  ports, so we can edit while letting prod run.
 * Once we collect enough data, have it able to run on historical data.
 * Write sell orders for partially filled BUY orders
 * For prod, only have it start running on the hour
 * Add wrapper in Trades so that trades can't happen while hourly audits etc are running.
 * 
 * 
 * Long term:
 * Devops for putting this onto  hetzner vps
 * Set up ngninx server ig , use auth_request module to access webpage data
 * expand to other markets, eth, 15m,  daily  markets, etc.
 * 
 * Automatically redeem trades?
 * https://docs.polymarket.com/developers/builders/relayer-client#redeem-positions
 */

console.log('running...')

cdMarketData.run();
marketInfo.run();

const logCleaner = new LogCleaner({
  logsDirectory: './logs',
  retentionDays: 60,
});
logCleaner.run();

prodBots.forEach((bot) => {
  bot.run();
})

testBots.forEach((bot) => {
  bot.run();
})