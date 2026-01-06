import { Arbitrage98 } from "./bots/Arbitrage98.js";
import { Credentials } from "./nonBots/Credentials.js";
import { BtcDirection, EarlyBuyer } from "./bots/EarlyBuyer.js";
import { MarketInfo } from "./nonBots/MarketInfo.js";
import { QuantBotRun } from "./bots/QuantBot.js";
import { Contrarian } from "./bots/Contrarian.js";
import { EarlyLimit } from "./bots/EarlyLimit.js";
import { CDMarketData } from "./nonBots/CDMarketData.js";
import { EsotericNormal } from "./bots/EsotericNormal.js";
import { MarketContrarian } from "./bots/MarketContrarian.js";


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

const cdMarketData = new CDMarketData();

// const prodBots: QuantBotRun[] = [
//   new EarlyBuyer({
//     name: 'early-down-b10-s30',
//     PROD_MODE: true,
//     hourlyDollarLimit: 2.0,
//     cutoffMinute: 20,
//     targetBuyPrice: .10,
//     targetSize: 20,
//     targetSellPrice: .30,
//     btcDirection: BtcDirection.DOWN,
//     ...commonProps,
//   }),
//   new EarlyBuyer({ // PROD
//     name: 'early-up-b40-s60',
//     PROD_MODE: true,
//     hourlyDollarLimit: 2.0,
//     cutoffMinute: 20,
//     targetBuyPrice: .40,
//     targetSize: 5,
//     targetSellPrice: .60,
//     btcDirection: BtcDirection.UP,
//     ...commonProps,
//   }),
//   new Contrarian({
//     name: 'contrarian-5h-b50-s99', // PROD
//     PROD_MODE: true,
//     lookbackHours: 5,
//     hourlyDollarLimit: 2.5,
//     targetBuyPrice: .50,
//     targetSellPrice: .99,
//     targetSize: 5,
//     cutoffMinute: 10,
//     ...commonProps,
//   }),
// ]

const bots: QuantBotRun[] = [
  // new Arbitrage98({
  //   name: 'arbitrage-98',
  //   PROD_MODE: false,
  //   hourlyDollarLimit: 10.0,
  //   ...commonProps,
  // }),
  new EarlyBuyer({
    name: 'early-up-b20-s49',
    PROD_MODE: false,
    hourlyDollarLimit: 2.0,
    cutoffMinute: 20,
    targetBuyPrice: .2,
    targetSize: 10,
    targetSellPrice: .49,
    btcDirection: BtcDirection.UP,
    ...commonProps,
  }),
  new EarlyBuyer({
    name: 'early-down-b20-s49',
    PROD_MODE: false,
    hourlyDollarLimit: 2.0,
    cutoffMinute: 20,
    targetBuyPrice: .2,
    targetSize: 10,
    targetSellPrice: .49,
    btcDirection: BtcDirection.DOWN,
    ...commonProps,
  }),
  new EarlyBuyer({
    name: 'early-up-b40-s60',
    PROD_MODE: false,
    hourlyDollarLimit: 2.0,
    cutoffMinute: 20,
    targetBuyPrice: .40,
    targetSize: 5,
    targetSellPrice: .60,
    btcDirection: BtcDirection.UP,
    ...commonProps,
  }),
  new EarlyBuyer({
    name: 'early-down-b40-s60',
    PROD_MODE: false,
    hourlyDollarLimit: 2.0,
    cutoffMinute: 20,
    targetBuyPrice: .40,
    targetSize: 5,
    targetSellPrice: .60,
    btcDirection: BtcDirection.DOWN,
    ...commonProps,
  }),
  // new EarlyBuyer({
  //   name: 'early-down-b40-s60',
  //   PROD_MODE: true,
  //   hourlyDollarLimit: 2.0,
  //   cutoffMinute: 20,
  //   targetBuyPrice: .40,
  //   targetSize: 5,
  //   targetSellPrice: .60,
  //   btcDirection: BtcDirection.DOWN,
  //   ...commonProps,
  // }),
  // new EarlyBuyer({
  //   name: 'early-up-b10-s30',
  //   PROD_MODE: false,
  //   hourlyDollarLimit: 2.0,
  //   cutoffMinute: 20,
  //   targetBuyPrice: .10,
  //   targetSize: 20,
  //   targetSellPrice: .30,
  //   btcDirection: BtcDirection.UP,
  //   ...commonProps,
  // }),
  // new EarlyBuyer({
  //   name: 'early-down-b10-s30',
  //   PROD_MODE: false,
  //   hourlyDollarLimit: 2.0,
  //   cutoffMinute: 20,
  //   targetBuyPrice: .10,
  //   targetSize: 20,
  //   targetSellPrice: .30,
  //   btcDirection: BtcDirection.DOWN,
  //   ...commonProps,
  // }),
  // new Contrarian({
  //   name: 'contrarian-1h-b50-s74',
  //   PROD_MODE: false,
  //   lookbackHours: 1,
  //   hourlyDollarLimit: 2.5,
  //   targetBuyPrice: .50,
  //   targetSellPrice: .74,
  //   targetSize: 5,
  //   cutoffMinute: 10,
  //   ...commonProps,
  // }),
  // new Contrarian({
  //   name: 'contrarian-1h-b50-s99',
  //   PROD_MODE: false,
  //   lookbackHours: 1,
  //   hourlyDollarLimit: 2.5,
  //   targetBuyPrice: .50,
  //   targetSellPrice: .99,
  //   targetSize: 5,
  //   cutoffMinute: 10,
  //   ...commonProps,
  // }),
  // new Contrarian({
  //   name: 'contrarian-2h-b50-s74',
  //   PROD_MODE: false,
  //   lookbackHours: 2,
  //   hourlyDollarLimit: 2.5,
  //   targetBuyPrice: .50,
  //   targetSellPrice: .74,
  //   targetSize: 5,
  //   cutoffMinute: 10,
  //   ...commonProps,
  // }),
  // new Contrarian({
  //   name: 'contrarian-2h-b50-s99',
  //   PROD_MODE: false,
  //   lookbackHours: 2,
  //   hourlyDollarLimit: 2.5,
  //   targetBuyPrice: .50,
  //   targetSellPrice: .99,
  //   targetSize: 5,
  //   cutoffMinute: 10,
  //   ...commonProps,
  // }),
  // new Contrarian({
  //   name: 'contrarian-3h-b50-s74',
  //   PROD_MODE: false,
  //   lookbackHours: 3,
  //   hourlyDollarLimit: 2.5,
  //   targetBuyPrice: .50,
  //   targetSellPrice: .74,
  //   targetSize: 5,
  //   cutoffMinute: 10,
  //   ...commonProps,
  // }),
  // new Contrarian({
  //   name: 'contrarian-3h-b50-s99',
  //   PROD_MODE: false,
  //   lookbackHours: 3,
  //   hourlyDollarLimit: 2.5,
  //   targetBuyPrice: .50,
  //   targetSellPrice: .99,
  //   targetSize: 5,
  //   cutoffMinute: 10,
  //   ...commonProps,
  // }),
  // new Contrarian({
  //   name: 'contrarian-5h-b50-s74',
  //   PROD_MODE: false,
  //   lookbackHours: 5,
  //   hourlyDollarLimit: 2.5,
  //   targetBuyPrice: .50,
  //   targetSellPrice: .74,
  //   targetSize: 5,
  //   cutoffMinute: 10,
  //   ...commonProps,
  // }),
  new Contrarian({
    name: 'contrarian-5h-b50-s99',
    PROD_MODE: false,
    lookbackHours: 5,
    hourlyDollarLimit: 2.5,
    targetBuyPrice: .50,
    targetSellPrice: .99,
    targetSize: 5,
    cutoffMinute: 10,
    ...commonProps,
  }),
  // new EarlyLimit({
  //   name: 'earlylim-up-l90-b85-s99',
  //   PROD_MODE: false,
  //   cutoffMinute: 30,
  //   hourlyDollarLimit: 5,
  //   targetAmount: 5,
  //   triggerPrice: .9,
  //   targetBuyPrice: .85,
  //   targetSellPrice: .99,
  //   btcDirection: BtcDirection.UP,
  //   ...commonProps,
  // }),
  // new EarlyLimit({
  //   name: 'earlylim-down-l90-b85-s99',
  //   PROD_MODE: false,
  //   cutoffMinute: 30,
  //   hourlyDollarLimit: 5,
  //   targetAmount: 5,
  //   triggerPrice: .9,
  //   targetBuyPrice: .85,
  //   targetSellPrice: .99,
  //   btcDirection: BtcDirection.DOWN,
  //   ...commonProps,
  // }),
  // new EarlyLimit({
  //   name: 'earlylim-up-l75-b75-s90',
  //   PROD_MODE: false,
  //   cutoffMinute: 30,
  //   hourlyDollarLimit: 5,
  //   targetAmount: 5,
  //   triggerPrice: .75,
  //   targetBuyPrice: .75,
  //   targetSellPrice: .90,
  //   btcDirection: BtcDirection.UP,
  //   ...commonProps,
  // }),
  // new EarlyLimit({
  //   name: 'earlylim-down-l75-b75-s90',
  //   PROD_MODE: false,
  //   cutoffMinute: 30,
  //   hourlyDollarLimit: 5,
  //   targetAmount: 5,
  //   triggerPrice: .75,
  //   targetBuyPrice: .75,
  //   targetSellPrice: .90,
  //   btcDirection: BtcDirection.DOWN,
  //   ...commonProps,
  // }),
  // new EarlyLimit({
  //   name: 'earlylim-down-l64-b65-s80',
  //   PROD_MODE: false,
  //   cutoffMinute: 30,
  //   hourlyDollarLimit: 5,
  //   targetAmount: 5,
  //   triggerPrice: .64,
  //   targetBuyPrice: .65,
  //   targetSellPrice: .80,
  //   btcDirection: BtcDirection.DOWN,
  //   ...commonProps,
  // }),
  // new EarlyLimit({
  //   name: 'earlylim-up-l64-b65-s80',
  //   PROD_MODE: false,
  //   cutoffMinute: 30,
  //   hourlyDollarLimit: 5,
  //   targetAmount: 5,
  //   triggerPrice: .64,
  //   targetBuyPrice: .65,
  //   targetSellPrice: .80,
  //   btcDirection: BtcDirection.UP,
  //   ...commonProps,
  // }),
  // new EarlyLimit({
  //   name: 'earlylim-up-l79-b80-s90',
  //   PROD_MODE: false,
  //   cutoffMinute: 30,
  //   hourlyDollarLimit: 5,
  //   targetAmount: 5,
  //   triggerPrice: .79,
  //   targetBuyPrice: .80,
  //   targetSellPrice: .90,
  //   btcDirection: BtcDirection.UP,
  //   ...commonProps,
  // }),
  // new EarlyLimit({
  //   name: 'earlylim-down-l79-b80-s90',
  //   PROD_MODE: false,
  //   cutoffMinute: 30,
  //   hourlyDollarLimit: 5,
  //   targetAmount: 5,
  //   triggerPrice: .79,
  //   targetBuyPrice: .80,
  //   targetSellPrice: .90,
  //   btcDirection: BtcDirection.DOWN,
  //   ...commonProps,
  // }),
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
  // new MarketContrarian({
  //   name: 'mcontrarian-1h-b50-s99',
  //   cutoffMinute: 15,
  //   PROD_MODE: false,
  //   hourlyDollarLimit: 2.5,
  //   lookbackHours: 1,
  //   targetBuyPrice: .50,
  //   targetSellPrice: .99,
  //   targetSize: 5,
  //   cdMarketData: cdMarketData,
  //   ...commonProps,
  // }),
  // new MarketContrarian({
  //   name: 'mcontrarian-5h-b50-s99',
  //   cutoffMinute: 15,
  //   PROD_MODE: false,
  //   hourlyDollarLimit: 2.5,
  //   lookbackHours: 5,
  //   targetBuyPrice: .50,
  //   targetSellPrice: .99,
  //   targetSize: 5,
  //   cdMarketData: cdMarketData,
  //   ...commonProps,
  // }),
  // new MarketContrarian({
  //   name: 'mcontrarian-1h-b50-s74',
  //   cutoffMinute: 15,
  //   PROD_MODE: false,
  //   hourlyDollarLimit: 2.5,
  //   lookbackHours: 1,
  //   targetBuyPrice: .50,
  //   targetSellPrice: .74,
  //   targetSize: 5,
  //   cdMarketData: cdMarketData,
  //   ...commonProps,
  // }),
  // new MarketContrarian({
  //   name: 'mcontrarian-5h-b50-s74',
  //   cutoffMinute: 15,
  //   PROD_MODE: false,
  //   hourlyDollarLimit: 2.5,
  //   lookbackHours: 5,
  //   targetBuyPrice: .50,
  //   targetSellPrice: .74,
  //   targetSize: 5,
  //   cdMarketData: cdMarketData,
  //   ...commonProps,
  // }),
]

/**
 * Bots to write
 * StopLimit order
 * Limit99 - Just puts a limit order at 99 for whole hour
 * 95->99 Buys at 95 and tries to sell at 99
 * LookbackAverage - Bets towards the average price (higher or lower than current) of the last N hours.
 * Bot that just collects market  data
 * Esoteric normalization bot, makes a spread of what  prices 'should'  be based off of time and relative price to start. arbs the diff
 * Market  Stalker - Checks for recent large changes in price, buys  in that direction, then immediately sells a little higher
 * Buyer/Limit2 add on to previous  bots such  that it sells  itself off at market price in the final ten minutes
 * 
 * figure out why insertOrAddToLiveClobIdAmounts  isn't working  correctly
 * Expired is  appearing incorrectly
 * Script that graphs  our metrics a bit better, maybe using asciichart 
 * writeAuditedTrade isn't getting called ; may want to remove (and write) dead trades earlier.
 * Add mutex lock to audit
 * Add amount earned to TradeObject datastruct
 * Remove uses of client that aren't through (cached ) marketInfo
 * change usage of tradeResults.forEach in Buyer and Contrarian to just do a simple buy check using the orderId
 * batch orders
 * change SOLD to  EXECUTED
 * replace -1 in audit  log with 0
 * adjust arbitrage to a simple getPrice
 * fix: 
 * // [INFO] 2026-01-01T18:00:04.429Z	 {"id":"0xeab7c38de81d01adf870ca99a4c203eb929e7abfd5bf581c4fd0b27c6764df34","status":"MATCHED","owner":"c55ed40d-2c12-2e72-cf91-c87b4d82b01a","maker_address":"0x63C434e2dc5c8b165017E5FAF6339ADEe5Bd814c","market":"0xb261ebd89cd8dc908306669c8315748280dd90eea266e37e1a859317f6e2943d","asset_id":"104215595539104662702664962311718491959495949015904975141686938146035952066160","side":"BUY","original_size":"5","size_matched":"5","price":"0.5","outcome":"Down","expiration":"0","order_type":"GTC","associate_trades":["1027fbfa-08c6-4ea7-b725-42c94103c627"],"created_at":1767290405}
 * Using sizjeMatched when we getOrder
 /// [CLOB Client] request error {"status":400,"statusText":"Bad Request","data":{"error":"Invalid orderID"},"config":{"transitional":{"silentJSONParsing":true,"forcedJSONParsing":
 // true,"clarifyTimeoutError":false},"adapter":["xhr","http","fetch"],"transformRequest":[null],"transformResponse":[null],"timeout":0,"xsrfCookieName":"XSRF-TOKEN","xsrfHeaderName":
 // "X-XSRF-TOKEN","maxContentLength":-1,"maxBodyLength":-1,"env":{},"headers":{"Accept":"","Content-Type":"application/json","POLY_ADDRESS":"",
 // "POLY_SIGNATURE":"","POLY_TIMESTAMP":"","POLY_API_KEY":"",
 // "POLY_PASSPHRASE":"","User-Agent":"@polymarket/clob-client","Connection":"keep-alive","Accept-Encoding":"gzip"},
 // "method":"get","url":"https://clob.polymarket.com/data/order/undefined","params":{},"allowAbsoluteUrls":true}}

 * rename cutoff minute to buycutoff minute
 * fix expiry  winner section
 * 
 * v2: include late sellofs for shitty trades
 * v3: include 'volatility' measurements
 * 
 * 
 * 
 * rder with id "followup-sell" already exists, skipping FIX TODO NEXT
 * https://docs.polymarket.com/developers/builders/relayer-client#redeem-positions
 */

console.log('running...')

bots.forEach((bot) => {
  bot.run();
})