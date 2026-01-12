import { Arbitrage98 } from "./bots/Arbitrage98.js";
import { Credentials } from "./nonBots/Credentials.js";
import { EarlyBuyer } from "./bots/EarlyBuyer.js";
import { BtcDirection, TargetedMarket } from "./types/interfaces.js";
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
    targetedMarket: TargetedMarket.BITCOIN_HOURLY,
    lookbackHours: 5,
    hourlyDollarLimit: 2.5,
    targetBuyPrice: .50,
    targetSellPrice: .80,
    targetSize: 5,
    cutoffMinute: 10,
    ...commonProps,
  }),
  new FirstCandle({
    name: 'firstcandle-10m-bb50-pp100-b60-s90',
    PROD_MODE: true,
    targetedMarket: TargetedMarket.BITCOIN_HOURLY,
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
    targetedMarket: TargetedMarket.BITCOIN_HOURLY,
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
    targetedMarket: TargetedMarket.BITCOIN_HOURLY,
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
    name: 'gen-firstcandleV2-1',
    PROD_MODE: true,
    targetedMarket: TargetedMarket.BITCOIN_HOURLY,
    hourlyDollarLimit: 5,
    targetSize: 5,
    candleMinutes: 6,
    breakoutBuffer: 182,
    pullbackBuffer: 322,
    buyPriceBuffer: .02,
    sellPriceBuffer: .34,
    minProfitMargin: .57,
    cutoffMinute: 35,
    ...commonProps,
  })
]

const testBots: QuantBotRun[] = [
  new Arbitrage98({
    name: 'arbitrage-98',
    PROD_MODE: false,
    targetedMarket: TargetedMarket.BITCOIN_HOURLY,
    hourlyDollarLimit: 10.0,
    ...commonProps,
  }),
  new ContrarianV2({
    name: 'contrarianV2-5h-b50-s99',
    PROD_MODE: false,
    targetedMarket: TargetedMarket.BITCOIN_HOURLY,
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
    targetedMarket: TargetedMarket.BITCOIN_HOURLY,
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
    targetedMarket: TargetedMarket.BITCOIN_HOURLY,
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
    targetedMarket: TargetedMarket.BITCOIN_HOURLY,
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
    targetedMarket: TargetedMarket.BITCOIN_HOURLY,
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
    targetedMarket: TargetedMarket.BITCOIN_HOURLY,
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
    targetedMarket: TargetedMarket.BITCOIN_HOURLY,
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
    targetedMarket: TargetedMarket.BITCOIN_HOURLY,
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
    targetedMarket: TargetedMarket.BITCOIN_HOURLY,
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
    targetedMarket: TargetedMarket.BITCOIN_HOURLY,
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
    targetedMarket: TargetedMarket.BITCOIN_HOURLY,
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
    targetedMarket: TargetedMarket.BITCOIN_HOURLY,
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
    targetedMarket: TargetedMarket.BITCOIN_HOURLY,
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
    targetedMarket: TargetedMarket.BITCOIN_HOURLY,
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
  new TrendFollowing({
    name: 'trend-sm5-lm-20-adx25-b55-s95',
    PROD_MODE: false,
    targetedMarket: TargetedMarket.BITCOIN_HOURLY,
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
    targetedMarket: TargetedMarket.BITCOIN_HOURLY,
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
    targetedMarket: TargetedMarket.BITCOIN_HOURLY,
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

  //Jan9
  new FirstCandleV2({
    name: 'gen-fcandleV2-1',
    PROD_MODE: false,
    targetedMarket: TargetedMarket.BITCOIN_HOURLY,
    hourlyDollarLimit: 5,
    targetSize: 5,
    candleMinutes: 8,
    breakoutBuffer: 10,
    pullbackBuffer: 353,
    buyPriceBuffer: .0317,
    sellPriceBuffer: .45,
    minProfitMargin: .9,
    cutoffMinute: 20,
    ...commonProps,
  }),
  new FirstCandleV2({
    name: 'gen-fcandleV2-2',
    PROD_MODE: false,
    targetedMarket: TargetedMarket.BITCOIN_HOURLY,
    hourlyDollarLimit: 5,
    targetSize: 5,
    candleMinutes: 8,
    breakoutBuffer: 30,
    pullbackBuffer: 109,
    buyPriceBuffer: .04,
    sellPriceBuffer: .01,
    minProfitMargin: .80,
    cutoffMinute: 45,
    ...commonProps,
  }),
  new FirstCandleV2({
    name: 'gen-fcandleV2-3',
    PROD_MODE: false,
    targetedMarket: TargetedMarket.BITCOIN_HOURLY,
    hourlyDollarLimit: 5,
    targetSize: 5,
    candleMinutes: 8,
    breakoutBuffer: 183,
    pullbackBuffer: 290,
    buyPriceBuffer: .01,
    sellPriceBuffer: .57,
    minProfitMargin: .9,
    cutoffMinute: 55,
    ...commonProps,
  }),
  new FirstCandle({
    name: 'gen-fcandle-1',
    PROD_MODE: false,
    targetedMarket: TargetedMarket.BITCOIN_HOURLY,
    hourlyDollarLimit: 5,
    targetSize: 5,
    candleMinutes: 8,
    breakoutBuffer: 34,
    pullbackBuffer: 400,
    targetBuyPrice: .58,
    targetSellPrice: .98,
    cutoffMinute: 35,
    ...commonProps,
  }),
  new FirstCandle({
    name: 'gen-fcandle-2',
    PROD_MODE: false,
    targetedMarket: TargetedMarket.BITCOIN_HOURLY,
    hourlyDollarLimit: 5,
    targetSize: 5,
    candleMinutes: 6,
    breakoutBuffer: 189,
    pullbackBuffer: 315,
    targetBuyPrice: .27,
    targetSellPrice: .68,
    cutoffMinute: 45,
    ...commonProps,
  }),
  new MeanReversion({
    name: 'gen-mrev-1',
    PROD_MODE: false,
    targetedMarket: TargetedMarket.BITCOIN_HOURLY,
    exitThreshold: 1, // unused
    targetSize: 5,
    hourlyDollarLimit: 5,
    lookbackPeriods: 15,
    entryThreshold: 2.53,
    targetBuyPrice: .26,
    targetSellPrice: .95,
    cutoffMinute: 50,
    ...commonProps,
  }),
  new MorningStar({
    name: 'gen-mstar-1',
    PROD_MODE: false,
    targetedMarket: TargetedMarket.BITCOIN_HOURLY,
    targetSize: 5,
    hourlyDollarLimit: 5,
    candleMinutes: 10,
    minBearishMove: 150,
    maxIndecisionRange: 74,
    minBullishMove: 35,
    targetBuyPrice: .22,
    targetSellPrice: .48,
    cutoffMinute: 50,
    ...commonProps,
  }),
  new EveningStar({
    name: 'gen-estar-1',
    PROD_MODE: false,
    targetedMarket: TargetedMarket.BITCOIN_HOURLY,
    targetSize: 5,
    hourlyDollarLimit: 5,
    candleMinutes: 14,
    minBullishMove: 75,
    maxIndecisionRange: 55,
    minBearishMove: 51.5,
    targetBuyPrice: .25,
    targetSellPrice: .73,
    cutoffMinute: 50,
    ...commonProps,
  }),
  new TrendFollowing({
    name: 'gen-tfollow-1',
    PROD_MODE: false,
    targetedMarket: TargetedMarket.BITCOIN_HOURLY,
    targetSize: 10,
    hourlyDollarLimit: 5,
    shortMaPeriod: 5,
    longMaPeriod: 22,
    adxPeriod: 22,
    adxThreshold: 18.5,
    atrPeriod: 14,
    atrStopMultiple: 1, // unused;
    targetBuyPrice: .16,
    targetSellPrice: .65,
    cutoffMinute: 40,
    ...commonProps,
  }),
  ////// Ethereum Hourly
  new Contrarian({
    name: 'eth1h-contrarian-5h-b50-s80',
    PROD_MODE: false,
    targetedMarket: TargetedMarket.ETHEREUM_HOURLY,
    lookbackHours: 5,
    hourlyDollarLimit: 2.5,
    targetBuyPrice: .50,
    targetSellPrice: .80,
    targetSize: 5,
    cutoffMinute: 10,
    ...commonProps,
  }),
  new FirstCandle({
    name: 'eth1h-firstcandle-10m-bb50-pp100-b60-s90',
    PROD_MODE: false,
    targetedMarket: TargetedMarket.ETHEREUM_HOURLY,
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
    name: 'eth1h-firstcandle-10m-bb25-pp50-b60-s90',
    PROD_MODE: false,
    targetedMarket: TargetedMarket.ETHEREUM_HOURLY,
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
    name: 'eth1h-firstcandle-10m-bb10-pp20-b60-s90',
    PROD_MODE: false,
    targetedMarket: TargetedMarket.ETHEREUM_HOURLY,
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
    name: 'eth1h-gen-firstcandleV2-1',
    PROD_MODE: false,
    targetedMarket: TargetedMarket.ETHEREUM_HOURLY,
    hourlyDollarLimit: 5,
    targetSize: 5,
    candleMinutes: 6,
    breakoutBuffer: 182,
    pullbackBuffer: 322,
    buyPriceBuffer: .02,
    sellPriceBuffer: .34,
    minProfitMargin: .57,
    cutoffMinute: 35,
    ...commonProps,
  }),
  ////// Solana Hourly
  new Contrarian({
    name: 'sol1h-contrarian-5h-b50-s80',
    PROD_MODE: false,
    targetedMarket: TargetedMarket.SOLANA_HOURLY,
    lookbackHours: 5,
    hourlyDollarLimit: 2.5,
    targetBuyPrice: .50,
    targetSellPrice: .80,
    targetSize: 5,
    cutoffMinute: 10,
    ...commonProps,
  }),
  new FirstCandle({
    name: 'sol1h-firstcandle-10m-bb50-pp100-b60-s90',
    PROD_MODE: false,
    targetedMarket: TargetedMarket.SOLANA_HOURLY,
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
    name: 'sol1h-firstcandle-10m-bb25-pp50-b60-s90',
    PROD_MODE: false,
    targetedMarket: TargetedMarket.SOLANA_HOURLY,
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
    name: 'sol1h-firstcandle-10m-bb10-pp20-b60-s90',
    PROD_MODE: false,
    targetedMarket: TargetedMarket.SOLANA_HOURLY,
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
    name: 'sol1h-gen-firstcandleV2-1',
    PROD_MODE: false,
    targetedMarket: TargetedMarket.SOLANA_HOURLY,
    hourlyDollarLimit: 5,
    targetSize: 5,
    candleMinutes: 6,
    breakoutBuffer: 182,
    pullbackBuffer: 322,
    buyPriceBuffer: .02,
    sellPriceBuffer: .34,
    minProfitMargin: .57,
    cutoffMinute: 35,
    ...commonProps,
  }),
  ////// XRP Hourly
  new Contrarian({
    name: 'xrp1h-contrarian-5h-b50-s80',
    PROD_MODE: false,
    targetedMarket: TargetedMarket.XRP_HOURLY,
    lookbackHours: 5,
    hourlyDollarLimit: 2.5,
    targetBuyPrice: .50,
    targetSellPrice: .80,
    targetSize: 5,
    cutoffMinute: 10,
    ...commonProps,
  }),
  new FirstCandle({
    name: 'xrp1h-firstcandle-10m-bb50-pp100-b60-s90',
    PROD_MODE: false,
    targetedMarket: TargetedMarket.XRP_HOURLY,
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
    name: 'xrp1h-firstcandle-10m-bb25-pp50-b60-s90',
    PROD_MODE: false,
    targetedMarket: TargetedMarket.XRP_HOURLY,
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
    name: 'xrp1h-firstcandle-10m-bb10-pp20-b60-s90',
    PROD_MODE: false,
    targetedMarket: TargetedMarket.XRP_HOURLY,
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
    name: 'xrp1h-gen-firstcandleV2-1',
    PROD_MODE: false,
    targetedMarket: TargetedMarket.XRP_HOURLY,
    hourlyDollarLimit: 5,
    targetSize: 5,
    candleMinutes: 6,
    breakoutBuffer: 182,
    pullbackBuffer: 322,
    buyPriceBuffer: .02,
    sellPriceBuffer: .34,
    minProfitMargin: .57,
    cutoffMinute: 35,
    ...commonProps,
  }),
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
 * Write sell orders for partially filled BUY orders
 * For prod, only have it start running on the hour
 * Start collecting other markets data NOW.
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

/**
 * Calculates milliseconds until the next hour boundary.
 * @returns Milliseconds until the start of the next hour.
 */
function getMsUntilNextHour(): number {
  const now = new Date();
  const nextHour = new Date(now);
  nextHour.setHours(now.getHours() + 1, 0, 0, 0);
  return nextHour.getTime() - now.getTime();
}

/**
 * Formats milliseconds as a human-readable duration string.
 */
function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${minutes}m ${seconds}s`;
}

// Start prod bots at the beginning of the next hour
const msUntilNextHour = getMsUntilNextHour();
console.log(`[PROD] Scheduling ${prodBots.length} prod bots to start in ${formatDuration(msUntilNextHour)} (at the next hour)`);

setTimeout(() => {
  console.log('[PROD] Starting prod bots at hour boundary');
  prodBots.forEach((bot) => {
    bot.run();
  });
}, msUntilNextHour);

// Start test bots immediately
testBots.forEach((bot) => {
  bot.run();
})