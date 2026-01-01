import { Side } from "@polymarket/clob-client";
import { Arbitrage98 } from "./bots/Arbitrage98.js";
import { Credentials } from "./bots/Credentials.js";
import { BtcDirection, EarlyBuyer } from "./bots/EarlyBuyer.js";
import { MarketInfo } from "./bots/MarketInfo.js";
import { QuantBotRun } from "./bots/QuantBot.js";
import { Contrarian } from "./bots/Contrarian.js";

const PROD_MODE = false;

const credentials = new Credentials();
const client = await credentials.initClient();

const marketInfo = new MarketInfo({
  client,
});

const commonProps = {
  client,
  marketInfo,
  PROD_MODE,
}

// const clobs = await marketInfo.getCurrentClobTokenIds();

// const res = (await client.getPrice(clobs[0], Side.BUY)) as { price: string };

// console.log(parseFloat(res.price))

console.log('intitializing bots...')

const bots: QuantBotRun[] = [
  new Arbitrage98({
    name: 'arbitrage-98',
    hourlyDollarLimit: 10.0,
    ...commonProps,
  }),
  new EarlyBuyer({
    name: 'early-up-b20-s49',
    hourlyDollarLimit: 2.0,
    cutoffMinute: 20, // return to 20
    targetBuyPrice: .2,
    targetSize: 10,
    targetSellPrice: .49,
    btcDirection: BtcDirection.UP,
    ...commonProps,
  }),
  new EarlyBuyer({
    name: 'early-down-b20-s49',
    hourlyDollarLimit: 2.0,
    cutoffMinute: 20, // return to 20
    targetBuyPrice: .2,
    targetSize: 10,
    targetSellPrice: .49,
    btcDirection: BtcDirection.DOWN,
    ...commonProps,
  }),
  new EarlyBuyer({
    name: 'early-up-b40-s60',
    hourlyDollarLimit: 2.0,
    cutoffMinute: 20, // return to 20
    targetBuyPrice: .40,
    targetSize: 5,
    targetSellPrice: .60,
    btcDirection: BtcDirection.UP,
    ...commonProps,
  }),
  new EarlyBuyer({
    name: 'early-down-b40-s60',
    hourlyDollarLimit: 2.0,
    cutoffMinute: 20, // return to 20
    targetBuyPrice: .40,
    targetSize: 5,
    targetSellPrice: .60,
    btcDirection: BtcDirection.DOWN,
    ...commonProps,
  }),
  new EarlyBuyer({
    name: 'early-up-b10-s30',
    hourlyDollarLimit: 2.0,
    cutoffMinute: 20, // return to 20
    targetBuyPrice: .10,
    targetSize: 20,
    targetSellPrice: .30,
    btcDirection: BtcDirection.UP,
    ...commonProps,
  }),
  new EarlyBuyer({
    name: 'early-down-b10-s30',
    hourlyDollarLimit: 2.0,
    cutoffMinute: 20, // return to 20
    targetBuyPrice: .10,
    targetSize: 20,
    targetSellPrice: .30,
    btcDirection: BtcDirection.DOWN,
    ...commonProps,
  }),
  new Contrarian({
    name: 'contrarian-1h-b50-s74',
    lookbackHours: 1,
    hourlyDollarLimit: 2.5,
    targetBuyPrice: .50,
    targetSellPrice: .74,
    targetSize: 5,
    cutoffMinute: 10,
    ...commonProps,
  }),
  new Contrarian({
    name: 'contrarian-1h-b50-s99',
    lookbackHours: 1,
    hourlyDollarLimit: 2.5,
    targetBuyPrice: .50,
    targetSellPrice: .99,
    targetSize: 5,
    cutoffMinute: 10,
    ...commonProps,
  }),
  new Contrarian({
    name: 'contrarian-2h-b50-s74',
    lookbackHours: 2,
    hourlyDollarLimit: 2.5,
    targetBuyPrice: .50,
    targetSellPrice: .74,
    targetSize: 5,
    cutoffMinute: 10,
    ...commonProps,
  }),
  new Contrarian({
    name: 'contrarian-2h-b50-s99',
    lookbackHours: 2,
    hourlyDollarLimit: 2.5,
    targetBuyPrice: .50,
    targetSellPrice: .99,
    targetSize: 5,
    cutoffMinute: 10,
    ...commonProps,
  }),
  new Contrarian({
    name: 'contrarian-3h-b50-s74',
    lookbackHours: 3,
    hourlyDollarLimit: 2.5,
    targetBuyPrice: .50,
    targetSellPrice: .74,
    targetSize: 5,
    cutoffMinute: 10,
    ...commonProps,
  }),
  new Contrarian({
    name: 'contrarian-3h-b50-s99',
    lookbackHours: 3,
    hourlyDollarLimit: 2.5,
    targetBuyPrice: .50,
    targetSellPrice: .99,
    targetSize: 5,
    cutoffMinute: 10,
    ...commonProps,
  }),
  new Contrarian({
    name: 'contrarian-5h-b50-s74',
    lookbackHours: 5,
    hourlyDollarLimit: 2.5,
    targetBuyPrice: .50,
    targetSellPrice: .74,
    targetSize: 5,
    cutoffMinute: 10,
    ...commonProps,
  }),
  new Contrarian({
    name: 'contrarian-5h-b50-s99',
    lookbackHours: 5,
    hourlyDollarLimit: 2.5,
    targetBuyPrice: .50,
    targetSellPrice: .99,
    targetSize: 5,
    cutoffMinute: 10,
    ...commonProps,
  })
]

/**
 * Bots to write
 * Bet against - bet the opposite of whatever happened last hour
 * Bet against 5 - bet the opposite of what happened in the last five hours[]
 * StopLimit order
 * Limit99 - Just puts a limit order at 99 for whole hour
 * 95->99 Buys at 95 and tries to sell at 99
 * LookbackAverage - Bets towards the average price (higher or lower than current) of the last N hours.
 * Bot that just collects market  data
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
 */

console.log('running...')

bots.forEach((bot) => {
  bot.run();
})