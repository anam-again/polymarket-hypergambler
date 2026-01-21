import { ClobClient, OpenOrder, OrderResponse, OrderType, Side } from "@polymarket/clob-client";

// SignedOrder type from the client's createOrder method
type SignedOrder = Awaited<ReturnType<ClobClient['createOrder']>>;

import { appendFileSync } from "fs";

import { MarketInfo } from "../nonBots/MarketInfo.js";
import { IClock, IMarketInfo, MarketSchedule, TargetedMarket, TradeStatus, TradeOrderProps } from "../types/interfaces.js";
import { RealClock } from "../utils/RealClock.js";

// ============================================================================
// Order Batcher Types
// ============================================================================

interface GetOrderRequest {
  orderId: string;
  resolve: (result: OpenOrder | undefined) => void;
  reject: (error: Error) => void;
}

interface CancelOrderRequest {
  orderId: string;
  resolve: (success: boolean) => void;
  reject: (error: Error) => void;
}

interface CreateOrderRequest {
  tokenID: string;
  price: number;
  side: Side;
  size: number;
  feeRateBps: number;
  resolve: (result: OrderResponse) => void;
  reject: (error: Error) => void;
}

// ============================================================================
// Order Batcher Class (Static)
// ============================================================================

/**
 * OrderBatcher provides static methods for batching order operations across
 * multiple QuantBot instances. This reduces API calls by collecting requests
 * over a short window and executing them together.
 *
 * Individual failures don't affect other requests in the batch - each caller
 * receives their own result or error.
 */
export class OrderBatcher {
  private static client: ClobClient | null = null;
  private static batchWindowMs: number = 200;

  // Queues for batching requests
  private static getOrderQueue: GetOrderRequest[] = [];
  private static cancelOrderQueue: CancelOrderRequest[] = [];
  private static createOrderQueue: CreateOrderRequest[] = [];

  // Timers for batch execution
  private static getOrderTimer: ReturnType<typeof setTimeout> | null = null;
  private static cancelOrderTimer: ReturnType<typeof setTimeout> | null = null;
  private static createOrderTimer: ReturnType<typeof setTimeout> | null = null;

  // Processing flags to prevent concurrent batch execution
  private static isProcessingGetOrders: boolean = false;
  private static isProcessingCancelOrders: boolean = false;
  private static isProcessingCreateOrders: boolean = false;

  /**
   * Initialize the batcher with a ClobClient instance.
   * Must be called before using any batch methods.
   */
  public static initialize(client: ClobClient, batchWindowMs: number = 200): void {
    OrderBatcher.client = client;
    OrderBatcher.batchWindowMs = batchWindowMs;
  }

  /**
   * Batch-enabled getOrder. Collects multiple getOrder requests and executes
   * them together. Each request returns independently.
   */
  public static async getOrder(orderId: string): Promise<OpenOrder | undefined> {
    if (!OrderBatcher.client) {
      throw new Error('OrderBatcher not initialized. Call OrderBatcher.initialize(client) first.');
    }

    return new Promise((resolve, reject) => {
      OrderBatcher.getOrderQueue.push({ orderId, resolve, reject });
      OrderBatcher.scheduleGetOrderBatch();
    });
  }

  /**
   * Batch-enabled cancelOrder. Collects multiple cancel requests and executes
   * them together using cancelOrders API.
   */
  public static async cancelOrder(orderId: string): Promise<boolean> {
    if (!OrderBatcher.client) {
      throw new Error('OrderBatcher not initialized. Call OrderBatcher.initialize(client) first.');
    }

    return new Promise((resolve, reject) => {
      OrderBatcher.cancelOrderQueue.push({ orderId, resolve, reject });
      OrderBatcher.scheduleCancelOrderBatch();
    });
  }

  /**
   * Batch-enabled createAndPostOrder. Collects multiple create requests and
   * executes them together.
   */
  public static async createAndPostOrder(
    tokenID: string,
    price: number,
    side: Side,
    size: number,
    feeRateBps: number = 0
  ): Promise<OrderResponse> {
    if (!OrderBatcher.client) {
      throw new Error('OrderBatcher not initialized. Call OrderBatcher.initialize(client) first.');
    }

    return new Promise((resolve, reject) => {
      OrderBatcher.createOrderQueue.push({ tokenID, price, side, size, feeRateBps, resolve, reject });
      OrderBatcher.scheduleCreateOrderBatch();
    });
  }

  /**
   * Process all pending batches immediately (useful for testing or shutdown).
   */
  public static async flush(): Promise<void> {
    if (OrderBatcher.getOrderTimer) {
      clearTimeout(OrderBatcher.getOrderTimer);
      OrderBatcher.getOrderTimer = null;
    }
    if (OrderBatcher.cancelOrderTimer) {
      clearTimeout(OrderBatcher.cancelOrderTimer);
      OrderBatcher.cancelOrderTimer = null;
    }
    if (OrderBatcher.createOrderTimer) {
      clearTimeout(OrderBatcher.createOrderTimer);
      OrderBatcher.createOrderTimer = null;
    }

    await Promise.all([
      OrderBatcher.processGetOrderBatch(),
      OrderBatcher.processCancelOrderBatch(),
      OrderBatcher.processCreateOrderBatch(),
    ]);
  }

  /**
   * Clear all pending requests (rejects them with cancellation error).
   */
  public static clear(): void {
    const error = new Error('OrderBatcher cleared');

    OrderBatcher.getOrderQueue.forEach(req => req.reject(error));
    OrderBatcher.cancelOrderQueue.forEach(req => req.reject(error));
    OrderBatcher.createOrderQueue.forEach(req => req.reject(error));

    OrderBatcher.getOrderQueue = [];
    OrderBatcher.cancelOrderQueue = [];
    OrderBatcher.createOrderQueue = [];

    if (OrderBatcher.getOrderTimer) clearTimeout(OrderBatcher.getOrderTimer);
    if (OrderBatcher.cancelOrderTimer) clearTimeout(OrderBatcher.cancelOrderTimer);
    if (OrderBatcher.createOrderTimer) clearTimeout(OrderBatcher.createOrderTimer);

    OrderBatcher.getOrderTimer = null;
    OrderBatcher.cancelOrderTimer = null;
    OrderBatcher.createOrderTimer = null;
  }

  // -------------------------------------------------------------------------
  // Private: Scheduling
  // -------------------------------------------------------------------------

  private static scheduleGetOrderBatch(): void {
    if (OrderBatcher.getOrderTimer) return;

    OrderBatcher.getOrderTimer = setTimeout(() => {
      OrderBatcher.getOrderTimer = null;
      OrderBatcher.processGetOrderBatch();
    }, OrderBatcher.batchWindowMs);
  }

  private static scheduleCancelOrderBatch(): void {
    if (OrderBatcher.cancelOrderTimer) return;

    OrderBatcher.cancelOrderTimer = setTimeout(() => {
      OrderBatcher.cancelOrderTimer = null;
      OrderBatcher.processCancelOrderBatch();
    }, OrderBatcher.batchWindowMs);
  }

  private static scheduleCreateOrderBatch(): void {
    if (OrderBatcher.createOrderTimer) return;

    OrderBatcher.createOrderTimer = setTimeout(() => {
      OrderBatcher.createOrderTimer = null;
      OrderBatcher.processCreateOrderBatch();
    }, OrderBatcher.batchWindowMs);
  }

  // -------------------------------------------------------------------------
  // Private: Batch Processing
  // -------------------------------------------------------------------------

  private static async processGetOrderBatch(): Promise<void> {
    if (OrderBatcher.isProcessingGetOrders || OrderBatcher.getOrderQueue.length === 0) return;

    OrderBatcher.isProcessingGetOrders = true;
    const batch = [...OrderBatcher.getOrderQueue];
    OrderBatcher.getOrderQueue = [];

    try {
      // Process each getOrder individually but in parallel
      // The CLOB client doesn't have a batch getOrders method
      const results = await Promise.allSettled(
        batch.map(async (req) => {
          try {
            const result = await OrderBatcher.client!.getOrder(req.orderId);
            return { req, result, error: null };
          } catch (error) {
            return { req, result: null, error };
          }
        })
      );

      // Distribute results to callers
      for (const settled of results) {
        if (settled.status === 'fulfilled') {
          const { req, result, error } = settled.value;
          if (error) {
            req.reject(error instanceof Error ? error : new Error(String(error)));
          } else {
            req.resolve(result as OpenOrder | undefined);
          }
        } else {
          // This shouldn't happen since we catch errors above, but handle it
          const correspondingReq = batch.find(r => !results.some(
            s => s.status === 'fulfilled' && s.value.req === r
          ));
          correspondingReq?.reject(new Error(settled.reason));
        }
      }
    } finally {
      OrderBatcher.isProcessingGetOrders = false;

      // Process any requests that came in during processing
      if (OrderBatcher.getOrderQueue.length > 0) {
        OrderBatcher.scheduleGetOrderBatch();
      }
    }
  }

  private static async processCancelOrderBatch(): Promise<void> {
    if (OrderBatcher.isProcessingCancelOrders || OrderBatcher.cancelOrderQueue.length === 0) return;

    OrderBatcher.isProcessingCancelOrders = true;
    const batch = [...OrderBatcher.cancelOrderQueue];
    OrderBatcher.cancelOrderQueue = [];

    try {
      // Use batch cancel API
      const orderIds = batch.map(req => req.orderId);

      try {
        await OrderBatcher.client!.cancelOrders(orderIds);

        // All succeeded
        batch.forEach(req => req.resolve(true));
      } catch (batchError) {
        // Batch failed - fall back to individual cancellations
        console.warn('[OrderBatcher] Batch cancel failed, falling back to individual cancels:', batchError);

        const results = await Promise.allSettled(
          batch.map(async (req) => {
            try {
              await OrderBatcher.client!.cancelOrder({ orderID: req.orderId });
              return { req, success: true, error: null };
            } catch (error) {
              return { req, success: false, error };
            }
          })
        );

        for (const settled of results) {
          if (settled.status === 'fulfilled') {
            const { req, success, error } = settled.value;
            if (error) {
              req.reject(error instanceof Error ? error : new Error(String(error)));
            } else {
              req.resolve(success);
            }
          }
        }
      }
    } finally {
      OrderBatcher.isProcessingCancelOrders = false;

      if (OrderBatcher.cancelOrderQueue.length > 0) {
        OrderBatcher.scheduleCancelOrderBatch();
      }
    }
  }

  private static async processCreateOrderBatch(): Promise<void> {
    if (OrderBatcher.isProcessingCreateOrders || OrderBatcher.createOrderQueue.length === 0) return;

    OrderBatcher.isProcessingCreateOrders = true;
    const batch = [...OrderBatcher.createOrderQueue];
    OrderBatcher.createOrderQueue = [];

    try {
      // Create signed orders for batch submission
      const signedOrders: { req: CreateOrderRequest; order: SignedOrder }[] = [];

      // First, create all orders (this doesn't submit them yet)
      for (const req of batch) {
        try {
          const order = await OrderBatcher.client!.createOrder(
            {
              tokenID: req.tokenID,
              price: req.price,
              side: req.side,
              size: req.size,
              feeRateBps: req.feeRateBps,
            },
            { tickSize: "0.01", negRisk: false }
          );
          signedOrders.push({ req, order });
        } catch (error) {
          // Individual order creation failed
          req.reject(error instanceof Error ? error : new Error(String(error)));
        }
      }

      if (signedOrders.length === 0) {
        return;
      }

      // Try to submit all orders in a batch
      try {
        const batchArgs = signedOrders.map(({ order }) => ({
          order,
          orderType: OrderType.GTC,
        }));

        const batchResult = await OrderBatcher.client!.postOrders(batchArgs);

        // Parse batch result and distribute to callers
        // The batch result format varies - handle both array and object responses
        if (Array.isArray(batchResult)) {
          for (let i = 0; i < signedOrders.length; i++) {
            const { req } = signedOrders[i];
            const result = batchResult[i];

            // Determine success: need orderID AND (success !== false) AND no error message
            const hasOrderId = result && result.orderID;
            const explicitFailure = result?.success === false;
            const hasErrorMsg = result?.errorMsg && result.errorMsg.length > 0;
            const hasErrorField = result?.error && result.error.length > 0;

            // Order is successful only if: has orderID, not explicitly failed, no error messages
            if (hasOrderId && !explicitFailure && !hasErrorMsg && !hasErrorField) {
              req.resolve({
                orderID: result.orderID,
                status: result.status || 'LIVE',
                success: true,
                errorMsg: '',
                makingAmount: '',
                takingAmount: '',
                transactionsHashes: result.transactionsHashes || [],
              });
            } else {
              // Order failed - extract the error message
              const errorMessage = result?.errorMsg || result?.error ||
                (explicitFailure ? 'Order explicitly failed' : 'Missing orderID');
              console.log('[OrderBatcher] Order failed:', errorMessage, JSON.stringify(result));
              req.reject(new Error(String(errorMessage)));
            }
          }
        } else {
          // Single response for batch - check if it indicates success
          const anyResult = batchResult as { success?: boolean; error?: string };
          if (anyResult.success === false || anyResult.error) {
            throw new Error(anyResult.error || 'Batch order submission failed');
          }

          // Fall back to individual submissions if batch response format is unclear
          throw new Error('Unclear batch response format, falling back to individual');
        }
      } catch (batchError) {
        // Batch submission failed - fall back to individual submissions
        console.warn('[OrderBatcher] Batch create failed, falling back to individual posts:', batchError);

        const results = await Promise.allSettled(
          signedOrders.map(async ({ req, order }) => {
            try {
              const result = await OrderBatcher.client!.postOrder(order, OrderType.GTC);
              return { req, result, error: null };
            } catch (error) {
              return { req, result: null, error };
            }
          })
        );

        for (const settled of results) {
          if (settled.status === 'fulfilled') {
            const { req, result, error } = settled.value;
            if (error) {
              req.reject(error instanceof Error ? error : new Error(String(error)));
            } else {
              req.resolve(result as OrderResponse);
            }
          }
        }
      }
    } finally {
      OrderBatcher.isProcessingCreateOrders = false;

      if (OrderBatcher.createOrderQueue.length > 0) {
        OrderBatcher.scheduleCreateOrderBatch();
      }
    }
  }
}

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

// Re-export TradeStatus for backward compatibility
export { TradeStatus } from "../types/interfaces.js";

// ============================================================================
// Interfaces
// ============================================================================

export interface QuantBotProps {
  name: string;
  hourlyDollarLimit: number;
  client: ClobClient;
  marketInfo: MarketInfo | IMarketInfo;
  PROD_MODE: boolean;
  targetedMarket: TargetedMarket;
  clock?: IClock;  // Optional - defaults to RealClock for production
}

export interface QuantBotRun {
  run(): void;
  stop(): void;
  name: string;
  PROD_MODE: boolean;
}

// ============================================================================
// Bot Runner with Restart on Failure
// ============================================================================

/**
 * Calculates milliseconds until the next hour boundary.
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

/**
 * Starts bots and sets up error handling for automatic restart on failure.
 * If any bot fails, all bots are stopped and a restart is scheduled
 * at the top of the next hour.
 *
 * @param bots - Array of bots to run
 * @param label - Label for logging (e.g., 'PROD' or 'TEST')
 */
export function runBotsWithRestartOnFailure(bots: QuantBotRun[], label: string): void {
  let isRestarting = false;

  const scheduleRestart = (reason: string) => {
    if (isRestarting) return;
    isRestarting = true;

    console.error(`[${label}] ${reason}. Scheduling restart at next hour boundary.`);

    // Stop all bots
    bots.forEach((bot) => {
      try {
        bot.stop();
      } catch (e) {
        // Ignore stop errors
      }
    });

    const msUntilRestart = getMsUntilNextHour() + 5 * 1000;
    console.log(`[${label}] Will restart in ${formatDuration(msUntilRestart)}`);

    setTimeout(() => {
      isRestarting = false;
      console.log(`[${label}] Restarting bots after failure...`);
      startBots();
    }, msUntilRestart);
  };

  const startBots = () => {
    console.log(`[${label}] Starting ${bots.length} bots...`);

    bots.forEach((bot) => {
      try {
        // Wrap in Promise.resolve to handle both sync and async run() methods
        Promise.resolve(bot.run()).catch((error: unknown) => {
          console.error(`[${label}] Bot ${bot.name || 'unknown'} failed:`, error);
          scheduleRestart(`Bot ${bot.name || 'unknown'} threw an error`);
        });
      } catch (error) {
        console.error(`[${label}] Failed to start bot ${bot.name || 'unknown'}:`, error);
        scheduleRestart(`Bot ${bot.name || 'unknown'} failed to start`);
      }
    });
  };

  startBots();
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
  isAudited: boolean;

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
    this.isAudited = props.isAudited ?? false;
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
  quarterly: () => void;
  reset: () => void;
}

export class QuantBot {

  // --- Properties ---

  public name!: string;
  public PROD_MODE!: boolean;
  protected hourlyDollarLimit!: number;

  public clock!: IClock;
  public marketInfo!: MarketInfo | IMarketInfo;
  public client!: ClobClient;
  public trades: TradeOrder[] = [];

  protected spentThisHour: number = 0;
  protected tradesThisHour: number = 0;
  private orderOperationPending: Promise<void> | null = null;
  private makeOrderPending: Promise<TradeOrder | undefined> | null = null;
  private listeners: { [K in keyof QuantBotEvents]?: QuantBotEvents[K][] } = {};

  // Period tracking to prevent race conditions at period boundaries
  private currentPeriodId: number = 0;
  private isResetting: boolean = false;

  // Stop function for the tick wrapper
  private tickStopFn: (() => void) | null = null;
  private isStopped: boolean = false;

  public targetedMarket: TargetedMarket;
  public marketSchedule: MarketSchedule;

  // --- Constructor ---

  constructor(props: QuantBotProps) {
    this.PROD_MODE = props.PROD_MODE;
    this.name = props.name;
    this.hourlyDollarLimit = props.hourlyDollarLimit;
    this.marketInfo = props.marketInfo;
    this.client = props.client;
    this.targetedMarket = props.targetedMarket;
    this.marketSchedule = QuantBot.getMarketSchedule(this.targetedMarket);

    // Use provided clock or create RealClock for production
    this.clock = props.clock ?? new RealClock();

    console.log(`[${this.PROD_MODE ? "PROD" : "TEST"}] ${this.name} initialized...`);
    this.writeLog('Initialized...', LogLevel.INFO);

    // Register for clock events
    this.clock.on('hourly', () => {
      this.emit('hourly');
      if (this.marketSchedule === MarketSchedule.HOURLY) {
        this.emit('reset');
      }
    });

    this.clock.on('quarterly', () => {
      this.emit('quarterly');
      if (this.marketSchedule === MarketSchedule.QUARTERLY) {
        this.emit('reset');
      }
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

  /**
   * Stops the bot's tick wrapper and marks it as stopped.
   */
  public stop(): void {
    this.isStopped = true;
    if (this.tickStopFn) {
      this.tickStopFn();
      this.tickStopFn = null;
    }
    this.writeLog('Bot stopped', LogLevel.INFO);
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
    // Capture period ID at the start to detect if period changes during order creation
    const orderPeriodId = this.currentPeriodId;

    // Block orders if we're in the middle of a reset
    if (this.isResetting) {
      this.writeLog(`Order blocked: reset in progress for ${name}`);
      return undefined;
    }

    // Wait for any pending makeOrder to complete
    if (this.makeOrderPending) {
      await this.makeOrderPending;
    }

    const orderPromise = (async (): Promise<TradeOrder | undefined> => {
      // Re-check after awaiting - period may have changed
      if (this.currentPeriodId !== orderPeriodId) {
        this.writeLog(`Order aborted: period changed during queue wait for ${name} (was period ${orderPeriodId}, now ${this.currentPeriodId})`);
        return undefined;
      }

      if (this.isResetting) {
        this.writeLog(`Order blocked: reset started during queue wait for ${name}`);
        return undefined;
      }

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

      if (this.orderOperationPending) {
        // Escape if our subclass entered into makeOrder, but there was a racecondition with clobIds, can often happen if we
        // try to place an order during an audit reset (the tickwrapper was running, and slowly progressing past the 'do nothing' due to awaits)
        return;
      }

      // Final check before creating order
      if (this.currentPeriodId !== orderPeriodId || this.isResetting) {
        this.writeLog(`Order aborted: period changed before order creation for ${name}`);
        return undefined;
      }
      try {
        const result = await this.createOrder(clobTokenId, price, amount, side);
        // Check again after the async order creation - this is the critical check
        if (this.currentPeriodId !== orderPeriodId) {
          this.writeLog(`Order created but NOT recorded: period changed during creation for ${name} (was period ${orderPeriodId}, now ${this.currentPeriodId}). Order ${result.orderID} may be orphaned.`);
          // The order was placed but we won't track it - it will need manual cleanup
          // This is safer than recording it in the wrong period
          return undefined;
        }

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
          createdAt: this.clock.now(),
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

        // Get market URL and convert to Polymarket URL
        const gammaUrl = (this.marketInfo as MarketInfo).getUrl?.(this.clock.getCurrentEstTimestamp(), this.targetedMarket) ?? '';
        const marketUrl = gammaUrl.replace('gamma-api.polymarket.com/events/slug/', 'polymarket.com/event/');

        this.writeLog(`${trade.orderId}, ${name}, ${side}, ${clobTokenId}, ${result.orderID}, ${amount}, ${price}, ${marketUrl}`, LogLevel.ORDER);

        return trade;
      } catch (e) {
        this.writeError(JSON.stringify(e));
        return undefined;
      }
    })();

    this.makeOrderPending = orderPromise.finally(() => {
      this.makeOrderPending = null;
    }) as Promise<TradeOrder | undefined>;

    return this.makeOrderPending;
  }

  public async cancelTrade(trade: TradeOrder): Promise<boolean> {
    try {
      if (this.PROD_MODE) {
        await OrderBatcher.cancelOrder(trade.orderId);
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
      // Run updates in parallel - the OrderBatcher will batch the getOrder calls
      const updatePromises = this.trades.map(trade => {
        if (this.PROD_MODE) {
          return this.updateProdOrder(trade);
        } else {
          return this.updateTestOrder(trade);
        }
      });
      await Promise.all(updatePromises);
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
    // Immediately increment period ID and set resetting flag to block new orders
    this.currentPeriodId++;
    this.isResetting = true;

    if (this.orderOperationPending) {
      await this.orderOperationPending;
    }

    // Also wait for any pending makeOrder to complete before auditing
    if (this.makeOrderPending) {
      await this.makeOrderPending;
    }

    const auditPromise = (async () => {
      this.spentThisHour = 0;
      this.tradesThisHour = 0;
      this.writeLog(`Doing reset at time ${this.clock.getHours()}:${this.clock.getMinutes()}, periodId=${this.currentPeriodId}, usingUrl=${this.marketInfo.getUrl(this.marketInfo.getCurrentEstTimestamp(), this.targetedMarket)}`);

      // Expire still living trades
      this.trades.sort((a, b) => a.createdAt - b.createdAt);
      for (const trade of this.trades) {
        if (trade.status === TradeStatus.LIVE) {
          this.updateTradeStatus(trade, TradeStatus.EXPIRED);
        }
      }

      // Determine winning clob from two mins ago
      const previousHourUrl = this.marketInfo.getUrl(
        this.marketInfo.getCurrentEstTimestamp() - (60 * 2 * 1000),
        this.targetedMarket,
      );
      const previousMarket = await this.marketInfo.getMarketInfo(previousHourUrl);
      const winningIndex = previousMarket.outcomePrices.reduce(
        (maxIdx, curr, idx, arr) => (parseFloat(curr) > parseFloat(arr[maxIdx]) ? idx : maxIdx),
        0
      );
      const winningClob = previousMarket.clobTokenIds[winningIndex];

      // Settle expired positions (handles remaining unmatched buy positions)
      this.settleExpiredPositions(winningClob);

      // Write any completed trades that haven't been audited yet
      for (const trade of this.trades) {
        if (trade.status === TradeStatus.MATCHED && !trade.isAudited) {
          this.writeCompletedTrade(trade);
          trade.isAudited = true;
        }
      }

      this.trades = [];
      this.isResetting = false;
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
    // this.writeLog(`Spent $${amount}, total this hour: $${this.spentThisHour}/${this.hourlyDollarLimit}`);
    return true;
  }

  /**
   * Returns the remaining budget available for this hour.
   */
  public getRemainingBudget(): number {
    return Math.max(0, this.hourlyDollarLimit - this.spentThisHour);
  }

  /**
   * Checks if the specified amount can be spent within the remaining hourly budget.
   */
  public canSpendFromBudget(amount: number): boolean {
    return amount <= this.getRemainingBudget();
  }

  /**
   * Checks if trading is still allowed this hour based on trade count and budget.
   * @param maxTradesPerHour - Maximum number of trades allowed per hour
   * @param minTradeValue - Minimum value of a single trade (default: $0.05)
   */
  public canTradeThisHour(maxTradesPerHour: number, minTradeValue: number = 0.05): boolean {
    if (this.tradesThisHour >= maxTradesPerHour) {
      return false;
    }
    if (this.spentThisHour + minTradeValue > this.hourlyDollarLimit) {
      return false;
    }
    return true;
  }

  /**
   * Increments the trade counter for this hour.
   */
  public recordTrade(): void {
    this.tradesThisHour++;
  }

  /**
   * Gets the current budget status for logging/debugging.
   */
  public getBudgetStatus(): { spent: number; limit: number; trades: number } {
    return {
      spent: this.spentThisHour,
      limit: this.hourlyDollarLimit,
      trades: this.tradesThisHour,
    };
  }

  // -------------------------------------------------------------------------
  // Logging
  // -------------------------------------------------------------------------

  public writeLog(message: string, logLevel = LogLevel.INFO): void {
    const timestamp = new Date(this.clock.now()).toISOString();
    const logLine = `[${logLevel}] ${timestamp}\t ${message}\n`;
    const prodTest = this.PROD_MODE ? 'prod' : 'test';
    appendFileSync(`./logs/bots/${prodTest}-${this.name}.log`, logLine);
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
      this.clock.now(),
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

    appendFileSync(`./logs/audits/tradeAudit.log`, message);
    this.writeLog(message, LogLevel.COMPLETED);
  }

  // -------------------------------------------------------------------------
  // Utilities
  // -------------------------------------------------------------------------

  public static getMarketSchedule(market: TargetedMarket): MarketSchedule {
    switch (market) {
      case TargetedMarket.BITCOIN_HOURLY:
      case TargetedMarket.ETHEREUM_HOURLY:
      case TargetedMarket.SOLANA_HOURLY:
      case TargetedMarket.XRP_HOURLY:
        return MarketSchedule.HOURLY;
      case TargetedMarket.BITCOIN_QUARTERLY:
      case TargetedMarket.ETHEREUM_QUARTERLY:
      case TargetedMarket.SOLANA_QUARTERLY:
      case TargetedMarket.XRP_QUARTERLY:
        return MarketSchedule.QUARTERLY;
      default:
        throw Error(`Unknown market supplied to getMarketScheudle: ${market}`)
    }
  }

  /**
   * Executes a function repeatedly with a delay and optional jitter.
   * Includes retry logic for transient failures.
   * Stores the stop function in this.tickStopFn for use by stop().
   */
  public tickWrapper(
    sleepMs: number,
    jitterMs: number,
    f: () => void | Promise<void>,
    retryOptions?: { maxRetries?: number; retryDelayMs?: number }
  ): () => void {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    const maxRetries = retryOptions?.maxRetries ?? 3;
    const retryDelayMs = retryOptions?.retryDelayMs ?? 3000;

    const executeWithRetry = async (): Promise<void> => {
      let lastError: unknown;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (stopped || this.isStopped) return;
        try {
          await f();
          return;
        } catch (e) {
          lastError = e;
          if (attempt < maxRetries) {
            this.writeError(`tickWrapper error (attempt ${attempt + 1}/${maxRetries + 1}): ${e}, retrying in ${retryDelayMs}ms...`);
            await new Promise(resolve => setTimeout(resolve, retryDelayMs));
          }
        }
      }
      this.writeError(`tickWrapper failed after ${maxRetries + 1} attempts: ${lastError}`);
    };

    const tick = async () => {
      if (stopped || this.isStopped) return;
      await executeWithRetry();
      if (stopped || this.isStopped) return;
      const jitteredDelay = sleepMs + Math.random() * jitterMs;
      timeoutId = setTimeout(tick, jitteredDelay);
    };

    tick();

    const stopFn = () => {
      stopped = true;
      if (timeoutId) clearTimeout(timeoutId);
    };

    // Store the stop function so stop() can call it
    this.tickStopFn = stopFn;

    return stopFn;
  }

  // -------------------------------------------------------------------------
  // Private Helpers
  // -------------------------------------------------------------------------

  private async createOrder(clobTokenId: string, price: number, amount: number, side: Side): Promise<OrderResponse> {
    if (this.PROD_MODE) {
      const feeRateBps = this.marketSchedule === MarketSchedule.QUARTERLY ? 1000 : 0;
      return await OrderBatcher.createAndPostOrder(clobTokenId, price, side, amount, feeRateBps);
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

    const liveResult: OpenOrder | undefined = await OrderBatcher.getOrder(trade.orderId);
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

    // Write the trade immediately when matched
    if (!trade.isAudited) {
      this.writeCompletedTrade(trade);
      trade.isAudited = true;
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
        // Write the trade immediately when matched
        if (!trade.isAudited) {
          this.writeCompletedTrade(trade);
          trade.isAudited = true;
        }
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
        // Write the trade immediately when matched
        if (!trade.isAudited) {
          this.writeCompletedTrade(trade);
          trade.isAudited = true;
        }
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
    const positionsByClob: Record<string, number> = {};

    for (const trade of this.trades) {
      if (trade.status === TradeStatus.MATCHED && trade.side === Side.BUY) {
        positionsByClob[trade.clobTokenId] = (positionsByClob[trade.clobTokenId] || 0) + trade.amount;
      } else if (trade.status === TradeStatus.MATCHED && trade.side === Side.SELL) {
        positionsByClob[trade.clobTokenId] = (positionsByClob[trade.clobTokenId] || 0) - trade.amount;
      }
    }

    // Settle remaining positions (bought but not sold)
    for (const [clobId, amount] of Object.entries(positionsByClob)) {
      if (amount <= 0) continue;

      const isWin = clobId === winningClob;
      const finalValue = isWin ? amount : 0;

      this.writeLog(`${clobId} expired (${isWin ? 'win' : 'loss'}) with ${amount} units for $${finalValue}`);

      const trade = new TradeOrder({
        amount,
        name: 'expiry',
        clobTokenId: clobId,
        createdAt: this.clock.now(),
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
