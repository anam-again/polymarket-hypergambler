import { ClobClient, OpenOrder, OrderResponse, OrderType, Side } from "@polymarket/clob-client";
import { appendFileSync } from "fs";

import { MarketInfo } from "./MarketInfo.js";

export interface QuantBotProps {
  name: string;
  hourlyDollarLimit: number;
  client: ClobClient;
  marketInfo: MarketInfo;
  PROD_MODE: boolean;
}

enum LogLevel {
  INFO = "INFO",
  ERROR = "ERROR",
  TEST = "TEST",
  ORDER = "ORDER",
  COMPLETED = "COMPLETED",
  UPDATE = 'UPDATE',
}

export enum TradeStatus {
  LIVE = 'LIVE',
  EXECUTED = 'EXECUTED',
  EXPIRED = 'EXPIRED',
  CANCELED = 'CANCELED',
}


export interface QuantBotRun {
  run(): void;
}

interface TradeOrder {
  orderId: string,
  createdAt: number,
  targetBuyPrice?: number,
  finalValue?: number,
  targetSellPrice?: number,
  amount: number,
  totalCost: number,
  isProd: boolean,
  clobTokenId: string,
  tradeStatus: TradeStatus,
  side: Side,
}

export class QuantBot {
  private name!: string;
  private hourlyDollarLimit!: number;
  private PROD_MODE!: boolean;

  public marketInfo!: MarketInfo;
  public client!: ClobClient;

  // Rate limiter state
  private spentThisHour: number = 0;
  private currentHour: number = new Date().getHours();

  // Used for auditing, should only read in other funcs
  public tradeResults: TradeOrder[] = [];

  // Track last hour when dead trades were cleaned up
  private lastCleanupHour: number = new Date().getHours();

  private liveClobIdAmounts: Record<string, number>;

  // Mutex for auditOrders
  private auditPending: Promise<void> | null = null;

  constructor(props: QuantBotProps) {
    this.PROD_MODE = props.PROD_MODE;
    this.name = props.name;
    this.hourlyDollarLimit = props.hourlyDollarLimit;
    this.marketInfo = props.marketInfo;
    this.client = props.client;
    const now = new Date();
    this.currentHour = now.getHours();
    this.lastCleanupHour = now.getHours();
    this.liveClobIdAmounts = {}
    console.log(`[${this.PROD_MODE ? "PROD" : "TEST"}]${this.name} initialized...`)
    this.writeLog('Initialized...', LogLevel.INFO);
  }

  /**
   * Resets the rate limiter if the current hour has changed.
   * Called automatically before checking or recording spend.
   * Also audits orders
   */
  private async resetIfNewHour(): Promise<void> {
    const now = new Date();
    const hour = now.getHours();
    if (hour !== this.currentHour) {
      await this.auditOrders();
      this.spentThisHour = 0;
      this.currentHour = hour;
      this.writeLog(`Rate limiter reset at hour ${hour}:00, usingUrl=${this.marketInfo.getBitcoinHourlyUrl(this.marketInfo.getCurrentEstTimestamp())}`);
    }
  }

  public async auditOrders(): Promise<void> {
    // If audit is already in progress, wait for it to complete
    if (this.auditPending) {
      return this.auditPending;
    }

    const auditPromise = (async () => {
      for (const tradeResult of this.tradeResults) {

        let liveResult: OpenOrder | undefined = undefined;

        if (this.PROD_MODE) {
          liveResult = await this.client.getOrder(tradeResult.orderId);
        }

        if (this.PROD_MODE && tradeResult.tradeStatus === TradeStatus.LIVE && liveResult && liveResult.status === 'MATCHED') {
          this.writeTradeUpdate(tradeResult, `${tradeResult.tradeStatus} -> ${TradeStatus.EXECUTED}`)
          tradeResult.tradeStatus = TradeStatus.EXECUTED;
          // Track position only when order is matched
          this.insertOrAddToLiveClobIdAmounts(tradeResult.clobTokenId, tradeResult.amount, tradeResult.side);
          const livePrice = parseFloat(liveResult.price);
          if (tradeResult.side === Side.BUY) {
            if (tradeResult.targetBuyPrice && livePrice) {
              tradeResult.finalValue = -(tradeResult.amount * livePrice)
            } else {
              this.writeError(`trade: ${tradeResult.orderId} does not have targetBuyPrice/livePrice but is BUY order, livePrice: ${livePrice}`)
            }
          } else {
            // SELL order
            if (tradeResult.targetSellPrice && livePrice) {
              tradeResult.finalValue = tradeResult.amount * livePrice
            } else {
              this.writeError(`trade: ${tradeResult.orderId} does not have targetSellPrice/livePrice but is SELL order, livePrice: ${livePrice}`)
            }
          }
        }

        if (!this.PROD_MODE && tradeResult.tradeStatus === TradeStatus.LIVE) {
          if (tradeResult.side === Side.BUY) {
            if (tradeResult.targetBuyPrice) {
              const liveSellPrice = await this.marketInfo.getPrice(tradeResult.clobTokenId, tradeResult.side);
              if (liveSellPrice <= tradeResult.targetBuyPrice) {
                this.writeTradeUpdate(tradeResult, `${tradeResult.tradeStatus} -> ${TradeStatus.EXECUTED}`)
                tradeResult.tradeStatus = TradeStatus.EXECUTED;
                // Track position only when order is matched
                this.insertOrAddToLiveClobIdAmounts(tradeResult.clobTokenId, tradeResult.amount, tradeResult.side);
                tradeResult.finalValue = -(tradeResult.amount * tradeResult.targetBuyPrice);
              }
            } else {
              this.writeError(`trade: ${tradeResult.orderId} does not have targetBuyPrice but is BUY order`)
            }
          } else {
            // Side === SELL
            if (tradeResult.targetSellPrice) {
              const liveBuyPrice = await this.marketInfo.getPrice(tradeResult.clobTokenId, tradeResult.side);
              if (liveBuyPrice >= tradeResult.targetSellPrice) {
                this.writeTradeUpdate(tradeResult, `${tradeResult.tradeStatus} -> ${TradeStatus.EXECUTED}`)
                tradeResult.tradeStatus = TradeStatus.EXECUTED;
                // Track position only when order is matched
                this.insertOrAddToLiveClobIdAmounts(tradeResult.clobTokenId, tradeResult.amount, tradeResult.side);
                tradeResult.finalValue = tradeResult.amount * tradeResult.targetSellPrice;
              }
            } else {
              this.writeError(`trade: ${tradeResult.orderId} does not have targetSellPrice but is SELL order`)
            }
          }
        }

      }

      // Only remove dead trades once at the start of each hour (e.g., 13:00)
      const currentHour = new Date().getHours();
      if (currentHour !== this.lastCleanupHour) {
        this.writeLog('Doing hourly cleanup audit')
        this.lastCleanupHour = currentHour;
        // Every hour
        // Expire still living trades
        this.tradeResults = this.tradeResults.sort((a, b) => {
          return a.createdAt - b.createdAt;
        })
        for (const tradeResult of this.tradeResults) {
          if (tradeResult.tradeStatus === TradeStatus.LIVE) {
            this.writeTradeUpdate(tradeResult, `${tradeResult.tradeStatus} -> ${TradeStatus.EXPIRED} `)
            tradeResult.tradeStatus = TradeStatus.EXPIRED;
          }
        }
        const previousHourUrl = this.marketInfo.getBitcoinHourlyUrl(this.marketInfo.getCurrentEstTimestamp() - (60 * 30 * 1000));
        const previousMarket = await this.marketInfo.getMarketInfo(previousHourUrl);
        const winningIndex = previousMarket.outcomePrices.reduce((maxIdx, curr, idx, arr) =>
          parseFloat(curr) > parseFloat(arr[maxIdx]) ? idx : maxIdx,
          0);
        const winningClob = previousMarket.clobTokenIds[winningIndex];
        Object.entries(this.liveClobIdAmounts).forEach(([k, v]) => {
          if (k === winningClob) {
            this.writeLog(`${k} expired (win) with ${v} units for $${v}`)
            this.writeAuditedTrade({
              amount: v,
              clobTokenId: k,
              createdAt: Date.now(),
              isProd: this.PROD_MODE,
              orderId: 'undefined',
              side: Side.BUY,
              totalCost: -1,
              tradeStatus: TradeStatus.EXPIRED,
              finalValue: v,
            })
          } else {
            this.writeLog(`${k} expired (loss) with ${v} units for $0`)
            this.writeAuditedTrade({
              amount: v,
              clobTokenId: k,
              createdAt: Date.now(),
              isProd: this.PROD_MODE,
              orderId: 'expiry',
              side: Side.BUY,
              totalCost: -1,
              tradeStatus: TradeStatus.EXPIRED,
              finalValue: 0,
            })
          }
        })
        this.liveClobIdAmounts = {};
        // Write value of succeeded trades
        for (const tradeResult of this.tradeResults) {
          if (tradeResult.tradeStatus !== TradeStatus.EXECUTED) continue;
          this.writeAuditedTrade(tradeResult);
        }
        // Done with hourly audit writing, clear all trades.
        this.tradeResults = [];
      }
    })();

    // Use .finally() to ensure cleanup happens AFTER assignment
    this.auditPending = auditPromise.finally(() => {
      this.auditPending = null;
    });
    return this.auditPending;
  }

  /**
   * Checks if spending the given amount would exceed the hourly limit.
   * @param amount - The dollar amount to check.
   * @returns true if the spend is allowed, false otherwise.
   */
  public async canSpend(amount: number): Promise<boolean> {
    await this.resetIfNewHour();
    return (this.spentThisHour + amount) <= this.hourlyDollarLimit;
  }

  /**
   * Records a spend amount against the hourly limit.
   * @param amount - The dollar amount spent.
   * @returns true if the spend was recorded, false if it would exceed the limit.
   */
  public async recordSpend(amount: number): Promise<boolean> {
    await this.resetIfNewHour();
    if ((this.spentThisHour + amount) > this.hourlyDollarLimit) {
      this.writeLog(`Rate limit exceeded: tried to spend $${amount}, already spent $${this.spentThisHour}/${this.hourlyDollarLimit}`);
      return false;
    }
    this.spentThisHour += amount;
    this.writeLog(`Spent $${amount}, total this hour: $${this.spentThisHour}/${this.hourlyDollarLimit}`);
    return true;
  }

  /**
   * Returns the remaining budget for the current hour.
   */
  public async getRemainingBudget(): Promise<number> {
    await this.resetIfNewHour();
    return Math.max(0, this.hourlyDollarLimit - this.spentThisHour);
  }

  /**
   * Returns the amount spent in the current hour.
   */
  public async getSpentThisHour(): Promise<number> {
    await this.resetIfNewHour();
    return this.spentThisHour;
  }

  public writeLog(message: string, logLevel = LogLevel.INFO): void {
    const timestamp = new Date().toISOString();
    const logLine = `[${logLevel}] ${timestamp}\t ${message}\n`;
    appendFileSync(`./logs/${this.name}.log`, logLine);
  }

  public writeOrder(message: string): void {
    this.writeLog(message, LogLevel.ORDER);
  }

  public writeError(e: unknown): void {
    if (typeof e === "string") {
      this.writeLog(e, LogLevel.ERROR);
    } else if (e instanceof Error) {
      this.writeLog(e.message, LogLevel.ERROR);
    } else {
      this.writeLog(`Unknown error`, LogLevel.ERROR);
    }
  }

  public writeAuditedTrade(trade: TradeOrder) {
    const message = [
      Date.now(),
      this.name,
      trade.orderId,
      trade.tradeStatus,
      trade.createdAt,
      trade.amount,
      trade.targetBuyPrice || -1,
      trade.targetSellPrice || -1,
      trade.totalCost,
      trade.finalValue ?? 0,
      trade.isProd ? 'PROD' : 'TEST',
      trade.clobTokenId,
      trade.side,
    ].join(', ') + "\n";

    this.writeOrder(message);
    appendFileSync(`./logs/tradeAudit.log`, message);
    this.writeLog(message, this.PROD_MODE ? LogLevel.COMPLETED : LogLevel.TEST);
  }

  public writeTradeUpdate(trade: TradeOrder, updateMessage: string) {
    const message = `${trade.orderId} ${updateMessage}`;
    this.writeLog(message, this.PROD_MODE ? LogLevel.UPDATE : LogLevel.TEST);
  }

  public checkIfOrderIsValid(price: number, amount: number) {
    if (amount < 5) {
      this.writeLog(`Unable to make order, order size: ${amount} is too small.`);
      return false;
    } else if (price * amount < 1.00) {
      this.writeLog(`Unable to make order, order price: ${price * amount} is too small.`);
    }
    return true;
  }

  public insertOrAddToLiveClobIdAmounts(clobId: string, amount: number, side: Side) {
    if (this.liveClobIdAmounts[clobId]) {
      this.liveClobIdAmounts[clobId] += side === Side.BUY ? amount : -amount;
    } else {
      this.liveClobIdAmounts[clobId] = side === Side.BUY ? amount : -amount;
    }
  }

  public async makeOrder(orderId: string, clobTokenId: string, price: number, amount: number, side: Side): Promise<TradeOrder | null> {
    const totalCost = price * amount;

    // Only BUY orders cost money - record spend BEFORE placing order to prevent race conditions
    if (side === Side.BUY) {
      if (!(await this.recordSpend(totalCost))) {
        this.writeLog(`Not enough budget to spend: ${totalCost}+${this.spentThisHour}/${this.hourlyDollarLimit}`);
        return null;
      }
    }

    if (this.PROD_MODE) {
      try {
        const result: OrderResponse = await this.client.createAndPostOrder(
          {
            tokenID: clobTokenId,
            price: price,
            side: side,
            size: amount,
            feeRateBps: 0,

          },
          { tickSize: "0.01", negRisk: false },
          OrderType.GTC,
        );
        this.writeLog(JSON.stringify(result));
        const tradeResult = {
          amount,
          clobTokenId: clobTokenId,
          createdAt: Date.now(),
          isProd: this.PROD_MODE,
          orderId: result.orderID,
          tradeStatus: TradeStatus.LIVE,
          totalCost,
          side,
          targetBuyPrice: side === Side.BUY ? price : undefined,
          targetSellPrice: side === Side.SELL ? price : undefined,
          finalValue: undefined,
        }
        this.tradeResults.push(tradeResult);
        this.writeLog(`${orderId}, ${side}, ${clobTokenId}, ${result.orderID}, ${amount}, ${price}`, LogLevel.ORDER);
        await this.auditOrders();
        return tradeResult;
      } catch (e) {
        // Rollback spend on failure for BUY orders
        if (side === Side.BUY) {
          this.spentThisHour -= totalCost;
          this.writeLog(`Rolled back spend of $${totalCost} due to order failure`);
        }
        this.writeError(e);
        return null;
      }
    } else {
      // test mode
      const result: OrderResponse = {
        errorMsg: 'test',
        makingAmount: 'test',
        orderID: `test-${Math.random().toString(36).substring(2, 22)}`,
        status: 'LIVE',
        success: true,
        takingAmount: 'test',
        transactionsHashes: ['test'],
      };
      const tradeResult = {
        amount,
        targetBuyPrice: side === Side.BUY ? price : undefined,
        targetSellPrice: side === Side.SELL ? price : undefined,
        finalValue: undefined,
        clobTokenId: clobTokenId,
        createdAt: Date.now(),
        isProd: this.PROD_MODE,
        orderId: result.orderID,
        totalCost,
        tradeStatus: TradeStatus.LIVE,
        side,
      }
      this.tradeResults.push(tradeResult);
      this.writeLog(`${orderId}, ${side}, ${clobTokenId}, ${result.orderID}, ${amount}, ${price}`, LogLevel.TEST);
      await this.auditOrders();
      return tradeResult;
    }
  }

  public async cancelTrade(tradeOrder: TradeOrder): Promise<boolean> {

    try {
      if (this.PROD_MODE) {
        await this.client.cancelOrder({
          orderID: tradeOrder.orderId
        });
      }

      // Update trade status
      tradeOrder.tradeStatus = TradeStatus.CANCELED;

      // Refund the spend (order was never filled)
      this.spentThisHour -= tradeOrder.totalCost;
      if (this.spentThisHour < 0) {
        this.spentThisHour = 0;
      }

      this.writeLog(`Cancelled order ${tradeOrder.orderId}, refunded $${tradeOrder.totalCost}`);
      return true;
    } catch (e) {
      this.writeError(e);
      return false;
    }
  }

  /**
   * Executes a function repeatedly with a delay and optional jitter.
   * @param sleepMs - Base delay between executions in milliseconds.
   * @param jitterMs - Random jitter added to each delay (0 to jitterMs).
   * @param f - The function to execute on each tick.
   * @returns A function to stop the ticker.
   */
  public tickWrapper(sleepMs: number, jitterMs: number, f: () => void | Promise<void>): () => void {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    const tick = async () => {
      if (stopped) return;
      try {
        await f();
      } catch (e) {
        this.writeError(`tickWrapper error: ${e}`);
      }
      if (stopped) return;
      const jitteredDelay = sleepMs + Math.random() * jitterMs;
      timeoutId = setTimeout(tick, jitteredDelay);
    };

    tick();

    return () => {
      stopped = true;
      if (timeoutId) clearTimeout(timeoutId);
    };
  }

}
