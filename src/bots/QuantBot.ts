import { ClobClient, OpenOrder, OrderResponse, OrderType, Side } from "@polymarket/clob-client";

import { appendFileSync, Stats } from "fs";
import cron from 'node-cron';

import { MarketInfo } from "../nonBots/MarketInfo.js";

// ============================================================================
// Enums
// ============================================================================

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
  MATCHED = 'MATCHED',
  EXPIRED = 'EXPIRED',
  CANCELED = 'CANCELED',
  PARTIAL = 'PARTIAL',
}

// ============================================================================
// Interfaces
// ============================================================================

export interface QuantBotProps {
  name: string;
  hourlyDollarLimit: number;
  client: ClobClient;
  marketInfo: MarketInfo;
  PROD_MODE: boolean;
}

export interface QuantBotRun {
  run(): void;
}

export interface TradeOrderProps {
  orderId: string;
  name: string;
  createdAt: number;
  targetBuyPrice?: number;
  finalValue?: number;
  targetSellPrice?: number;
  amount: number;
  totalCost: number;
  isProd: boolean;
  clobTokenId: string;
  status: TradeStatus;
  side: Side;
}

// ============================================================================
// TradeOrder Class
// ============================================================================

type TradeOrderEvents = {
  audited: () => void;
  tradeMatched: () => void;
  tradePartial: () => void;
  tradeLive: () => void;
  tradeExpired: () => void;
  tradeCanceled: () => void;
}

export class TradeOrder {
  orderId: string;
  name: string;
  createdAt: number;
  targetBuyPrice?: number;
  finalValue?: number;
  targetSellPrice?: number;
  amount: number;
  totalCost: number;
  isProd: boolean;
  clobTokenId: string;
  status: TradeStatus;
  side: Side;

  private listeners: { [K in keyof TradeOrderEvents]?: TradeOrderEvents[K][] } = {};

  constructor(props: TradeOrderProps) {
    this.orderId = props.orderId;
    this.name = props.name;
    this.createdAt = props.createdAt;
    this.targetBuyPrice = props.targetBuyPrice;
    this.finalValue = props.finalValue;
    this.targetSellPrice = props.targetSellPrice;
    this.amount = props.amount;
    this.totalCost = props.totalCost;
    this.isProd = props.isProd;
    this.clobTokenId = props.clobTokenId;
    this.status = props.status;
    this.side = props.side;
  }

  // --- Event Methods ---

  on<K extends keyof TradeOrderEvents>(event: K, listener: TradeOrderEvents[K]) {
    if (!this.listeners[event]) {
      this.listeners[event] = [];
    }
    this.listeners[event]!.push(listener);
  }

  emit<K extends keyof TradeOrderEvents>(event: K, ...args: Parameters<TradeOrderEvents[K]>) {
    this.listeners[event]?.forEach(listener => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (listener as any)(...args);
    });
  }

  off<K extends keyof TradeOrderEvents>(event: K, listener: TradeOrderEvents[K]) {
    const list = this.listeners[event];
    if (list) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.listeners[event] = list.filter(l => l !== listener) as any;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  once<K extends keyof TradeOrderEvents>(event: K, listener: Function) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wrapper = (...args: any[]) => {
      listener(...args);
      this.off(event, wrapper);
    };
    this.on(event, wrapper);
  }
}

// ============================================================================
// QuantBot Class
// ============================================================================

type QuantBotEvents = {
  hourly: () => void;
}

export class QuantBot {

  // --- Properties ---

  private name!: string;
  private hourlyDollarLimit!: number;
  private PROD_MODE!: boolean;

  public marketInfo!: MarketInfo;
  public client!: ClobClient;
  public trades: TradeOrder[] = [];

  private spentThisHour: number = 0;
  private orderOperationPending: Promise<void> | null = null;
  private makeOrderPending: Promise<TradeOrder | undefined> | null = null;
  private listeners: { [K in keyof QuantBotEvents]?: QuantBotEvents[K][] } = {};

  // --- Constructor ---

  constructor(props: QuantBotProps) {
    this.PROD_MODE = props.PROD_MODE;
    this.name = props.name;
    this.hourlyDollarLimit = props.hourlyDollarLimit;
    this.marketInfo = props.marketInfo;
    this.client = props.client;

    console.log(`[${this.PROD_MODE ? "PROD" : "TEST"}] ${this.name} initialized...`);
    this.writeLog('Initialized...', LogLevel.INFO);

    cron.schedule('0 * * * *', () => {
      this.emit('hourly');
    });
  }

  // -------------------------------------------------------------------------
  // Event Methods
  // -------------------------------------------------------------------------

  on<K extends keyof QuantBotEvents>(event: K, listener: QuantBotEvents[K]) {
    if (!this.listeners[event]) {
      this.listeners[event] = [];
    }
    this.listeners[event]!.push(listener);
  }

  emit<K extends keyof QuantBotEvents>(event: K, ...args: Parameters<QuantBotEvents[K]>) {
    this.listeners[event]?.forEach(listener => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (listener as any)(...args);
    });
  }

  off<K extends keyof QuantBotEvents>(event: K, listener: QuantBotEvents[K]) {
    const list = this.listeners[event];
    if (list) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.listeners[event] = list.filter(l => l !== listener) as any;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  once<K extends keyof QuantBotEvents>(event: K, listener: Function) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wrapper = (...args: any[]) => {
      listener(...args);
      this.off(event, wrapper);
    };
    this.on(event, wrapper);
  }

  // -------------------------------------------------------------------------
  // Order Management
  // -------------------------------------------------------------------------

  public async makeOrder(
    name: string,
    clobTokenId: string,
    price: number,
    amount: number,
    side: Side
  ): Promise<TradeOrder | undefined> {
    // Wait for any pending makeOrder to complete
    if (this.makeOrderPending) {
      await this.makeOrderPending;
    }

    const orderPromise = (async (): Promise<TradeOrder | undefined> => {
      const matchedTrade = this.trades.find((trade) => {
        return trade.name === name;
      });
      if (matchedTrade) {
        return matchedTrade;
      }

      const totalCost = price * amount;

      if (side === Side.BUY && !this.canSpend(totalCost)) {
        this.writeLog(`Not enough budget to spend: ${totalCost}+${this.spentThisHour}/${this.hourlyDollarLimit}`);
        return undefined;
      }

      const result = await this.createOrder(clobTokenId, price, amount, side);

      const errRes = result as unknown as { error: string; status: number };
      if ((result.errorMsg && result.errorMsg.length > 0) || result.success === false || result.status === '400' || errRes.error || errRes.status === 400) {
        this.writeError(`Order error: ${JSON.stringify(result)}`);
        return undefined;
      }

      this.writeLog(JSON.stringify(result));

      const trade = new TradeOrder({
        amount,
        name: name,
        clobTokenId,
        createdAt: Date.now(),
        isProd: this.PROD_MODE,
        orderId: result.orderID,
        status: TradeStatus.LIVE,
        totalCost,
        side,
        targetBuyPrice: side === Side.BUY ? price : undefined,
        targetSellPrice: side === Side.SELL ? price : undefined,
        finalValue: undefined,
      });

      this.recordSpend(totalCost, side);
      this.trades.push(trade);
      this.writeLog(`${trade.orderId}, ${name}, ${side}, ${clobTokenId}, ${result.orderID}, ${amount}, ${price}`, LogLevel.ORDER);

      console.log('order created: ', trade.name)
      return trade;
    })();

    this.makeOrderPending = orderPromise.finally(() => {
      this.makeOrderPending = null;
    }) as Promise<TradeOrder | undefined>;

    return this.makeOrderPending;
  }

  public async cancelTrade(trade: TradeOrder): Promise<boolean> {
    try {
      if (this.PROD_MODE) {
        await this.client.cancelOrder({ orderID: trade.orderId });
      }

      this.updateTradeStatus(trade, TradeStatus.CANCELED);
      this.recordSpend(-trade.totalCost, trade.side);

      this.spentThisHour -= trade.totalCost;
      if (this.spentThisHour < 0) {
        this.spentThisHour = 0;
      }

      return true;
    } catch (e) {
      this.writeError(e);
      return false;
    }
  }

  public async updateOrders(): Promise<void> {
    if (this.orderOperationPending) {
      await this.orderOperationPending;
    }

    const updatePromise = (async () => {
      for (const trade of this.trades) {
        if (this.PROD_MODE) {
          await this.updateProdOrder(trade);
        } else {
          await this.updateTestOrder(trade);
        }
      }
    })();

    this.orderOperationPending = updatePromise.finally(() => {
      this.orderOperationPending = null;
    });

    return this.orderOperationPending;
  }

  public checkIfOrderIsValid(price: number, amount: number): boolean {
    if (amount < 5) {
      this.writeLog(`Unable to make order, order size: ${amount} is too small.`);
      return false;
    }
    if (price * amount < 1.00) {
      this.writeLog(`Unable to make order, order price: ${price * amount} is too small.`);
      return false;
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // Audit & Reset
  // -------------------------------------------------------------------------

  public async auditAndReset(): Promise<void> {
    if (this.orderOperationPending) {
      await this.orderOperationPending;
    }

    const auditPromise = (async () => {
      const now = new Date();
      this.spentThisHour = 0;
      this.writeLog(`Doing reset at hour ${now.getHours()}:${now.getMinutes()}, usingUrl=${this.marketInfo.getBitcoinHourlyUrl(this.marketInfo.getCurrentEstTimestamp())}`);

      // Expire still living trades
      this.trades.sort((a, b) => a.createdAt - b.createdAt);
      for (const trade of this.trades) {
        if (trade.status === TradeStatus.LIVE) {
          this.updateTradeStatus(trade, TradeStatus.EXPIRED);
        }
      }

      // Determine winning clob from previous hour
      const previousHourUrl = this.marketInfo.getBitcoinHourlyUrl(
        this.marketInfo.getCurrentEstTimestamp() - (60 * 30 * 1000)
      );
      const previousMarket = await this.marketInfo.getMarketInfo(previousHourUrl);
      const winningIndex = previousMarket.outcomePrices.reduce(
        (maxIdx, curr, idx, arr) => (parseFloat(curr) > parseFloat(arr[maxIdx]) ? idx : maxIdx),
        0
      );
      const winningClob = previousMarket.clobTokenIds[winningIndex];

      // Settle expired positions
      this.settleExpiredPositions(winningClob);

      // Write completed trades
      for (const trade of this.trades) {
        if (trade.status === TradeStatus.MATCHED) {
          this.writeCompletedTrade(trade);
        }
      }

      this.trades = [];
    })();

    this.orderOperationPending = auditPromise.finally(() => {
      this.orderOperationPending = null;
    });

    return this.orderOperationPending;
  }

  // -------------------------------------------------------------------------
  // Budget Management
  // -------------------------------------------------------------------------

  public canSpend(amount: number): boolean {
    return (this.spentThisHour + amount) <= this.hourlyDollarLimit;
  }

  public recordSpend(amount: number, side: Side): boolean {
    if (side === Side.SELL) return true;
    if ((this.spentThisHour + amount) > this.hourlyDollarLimit) {
      this.writeLog(`Rate limit exceeded: tried to spend $${amount}, already spent $${this.spentThisHour}/${this.hourlyDollarLimit}`);
      return false;
    }
    this.spentThisHour += amount;
    this.writeLog(`Spent $${amount}, total this hour: $${this.spentThisHour}/${this.hourlyDollarLimit}`);
    return true;
  }

  // -------------------------------------------------------------------------
  // Logging
  // -------------------------------------------------------------------------

  public writeLog(message: string, logLevel = LogLevel.INFO): void {
    const timestamp = new Date().toISOString();
    const logLine = `[${logLevel}] ${timestamp}\t ${message}\n`;
    const prodTest = this.PROD_MODE ? 'prod' : 'test';
    appendFileSync(`./logs/${prodTest}-${this.name}.log`, logLine);
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

  public writeCompletedTrade(trade: TradeOrder): void {
    const message = [
      Date.now(),
      this.name,
      trade.orderId,
      trade.status,
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

    appendFileSync(`./logs/tradeAudit.log`, message);
    this.writeLog(message, LogLevel.COMPLETED);
  }

  // -------------------------------------------------------------------------
  // Utilities
  // -------------------------------------------------------------------------

  /**
   * Executes a function repeatedly with a delay and optional jitter.
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

  // -------------------------------------------------------------------------
  // Private Helpers
  // -------------------------------------------------------------------------

  private async createOrder(clobTokenId: string, price: number, amount: number, side: Side): Promise<OrderResponse> {
    if (this.PROD_MODE) {
      return await this.client.createAndPostOrder(
        {
          tokenID: clobTokenId,
          price: price,
          side: side,
          size: amount,
          feeRateBps: 0,
        },
        { tickSize: "0.01", negRisk: false },
        OrderType.GTC
      );
    }

    return {
      errorMsg: '',
      makingAmount: 'test',
      orderID: `test-${Math.random().toString(36).substring(2, 22)}`,
      status: 'LIVE',
      success: true,
      takingAmount: 'test',
      transactionsHashes: ['test'],
    };
  }

  private async updateProdOrder(trade: TradeOrder): Promise<void> {
    if (trade.status !== TradeStatus.LIVE) return;

    const liveResult: OpenOrder | undefined = await this.client.getOrder(trade.orderId);
    if (!liveResult || liveResult.status !== 'MATCHED') return;

    this.writeLog(`LiveResult: ${JSON.stringify(liveResult)}`);

    if (parseFloat(liveResult.size_matched) < trade.amount) {
      this.updateTradeStatus(trade, TradeStatus.PARTIAL);
      return;
    }

    this.updateTradeStatus(trade, TradeStatus.MATCHED);

    const livePrice = parseFloat(liveResult.price);
    if (trade.side === Side.BUY) {
      if (trade.targetBuyPrice && livePrice) {
        trade.finalValue = -(trade.amount * livePrice);
      } else {
        this.writeError(`trade: ${trade.orderId} does not have targetBuyPrice/livePrice but is BUY order, livePrice: ${livePrice}`);
      }
    } else {
      if (trade.targetSellPrice && livePrice) {
        trade.finalValue = trade.amount * livePrice;
      } else {
        this.writeError(`trade: ${trade.orderId} does not have targetSellPrice/livePrice but is SELL order, livePrice: ${livePrice}`);
      }
    }
  }

  private async updateTestOrder(trade: TradeOrder): Promise<void> {
    if (trade.status !== TradeStatus.LIVE) return;

    if (trade.side === Side.BUY) {
      if (!trade.targetBuyPrice) {
        this.writeError(`trade: ${trade.orderId} does not have targetBuyPrice but is BUY order`);
        return;
      }
      const liveSellPrice = await this.marketInfo.getPrice(trade.clobTokenId, trade.side);
      if (liveSellPrice <= trade.targetBuyPrice) {
        this.updateTradeStatus(trade, TradeStatus.MATCHED);
        trade.finalValue = -(trade.amount * trade.targetBuyPrice);
      }
    } else {
      if (!trade.targetSellPrice) {
        this.writeError(`trade: ${trade.orderId} does not have targetSellPrice but is SELL order`);
        return;
      }
      const liveBuyPrice = await this.marketInfo.getPrice(trade.clobTokenId, trade.side);
      if (liveBuyPrice >= trade.targetSellPrice) {
        this.updateTradeStatus(trade, TradeStatus.MATCHED);
        trade.finalValue = trade.amount * trade.targetSellPrice;
      }
    }
  }

  private updateTradeStatus(trade: TradeOrder, newStatus: TradeStatus): void {
    const message = `${trade.orderId}, ${trade.name}, ${trade.status} -> ${newStatus}`;
    this.writeLog(message, LogLevel.UPDATE);
    trade.status = newStatus;

    switch (newStatus) {
      case TradeStatus.EXPIRED:
        trade.emit('tradeExpired');
        break;
      case TradeStatus.CANCELED:
        trade.emit('tradeCanceled');
        break;
      case TradeStatus.MATCHED:
        trade.emit('tradeMatched');
        break;
      case TradeStatus.LIVE:
        trade.emit('tradeLive');
        break;
      case TradeStatus.PARTIAL:
        trade.emit('tradePartial');
        break;
      default:
        throw Error(`Unexpected tradestatus submitted: ${newStatus}`);
    }
  }

  private settleExpiredPositions(winningClob: string): void {
    const liveClobIdAmounts: Record<string, number> = {};
    for (const trade of this.trades) {
      if (trade.status === TradeStatus.EXPIRED) {
        liveClobIdAmounts[trade.clobTokenId] = (liveClobIdAmounts[trade.clobTokenId] || 0) + trade.amount;
      }
    }
    for (const [clobId, amount] of Object.entries(liveClobIdAmounts)) {
      if (amount <= 0) continue;
      const isWin = clobId === winningClob;
      const finalValue = isWin ? amount : 0;

      this.writeLog(`${clobId} expired (${isWin ? 'win' : 'loss'}) with ${amount} units for $${finalValue}`);

      const trade = new TradeOrder({
        amount,
        name: 'expiry',
        clobTokenId: clobId,
        createdAt: Date.now(),
        isProd: this.PROD_MODE,
        orderId: 'expiry',
        side: Side.BUY,
        totalCost: 0,
        status: TradeStatus.EXPIRED,
        finalValue,
      });

      this.writeCompletedTrade(trade);
    }
  }
}
