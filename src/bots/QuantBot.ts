import { ClobClient, OpenOrder, OrderResponse, OrderType, Side } from "@polymarket/clob-client";

// SignedOrder type from the client's createOrder method
type SignedOrder = Awaited<ReturnType<ClobClient['createOrder']>>;

import { appendFileSync, existsSync, mkdirSync } from "fs";

import { MarketInfo } from "../nonBots/MarketInfo.js";
import { CDMarketData } from "../nonBots/CDMarketData.js";
import { IClock, IMarketData, IMarketInfo, MarketSchedule, TargetedMarket, TradeStatus, TradeOrderProps } from "../types/interfaces.js";
import { RealClock } from "../utils/RealClock.js";
import { error } from "console";
import { TradingDatabase } from "../db/TradingDatabase.js";

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
  clock?: IClock;           // Optional - defaults to RealClock for production
  cdMarketData?: IMarketData;  // Optional - defaults to CDMarketData singleton for production
  logDirectory?: string;       // Optional - defaults to './logs/bots' for production
  shouldWriteLogs?: boolean;   // Optional - defaults to true. Set false to disable logging.
  simulationOrderDelayMs?: number;  // Optional - delay before orders can match in simulation (default: 10000ms)
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
 * If a bot fails, only that bot is stopped and scheduled for restart at
 * the top of the next hour. Other bots continue running.
 *
 * @param bots - Array of bots to run
 * @param label - Label for logging (e.g., 'PROD' or 'TEST')
 */
export function runBotsWithRestartOnFailure(bots: QuantBotRun[], label: string): void {
  // Track which bots are currently scheduled for restart to prevent duplicate restarts
  const botsScheduledForRestart = new Set<string>();

  const restartBot = (bot: QuantBotRun, reason: string) => {
    const botName = bot.name || 'unknown';

    // Prevent duplicate restart scheduling for the same bot
    if (botsScheduledForRestart.has(botName)) {
      console.log(`[${label}] Bot ${botName} already scheduled for restart, ignoring`);
      return;
    }
    botsScheduledForRestart.add(botName);

    console.error(`[${label}] Bot ${botName} failed: ${reason}. Scheduling individual restart.`);

    // Stop only this bot
    try {
      bot.stop();
    } catch (e) {
      // Ignore stop errors
    }

    const msUntilRestart = getMsUntilNextHour() + 5 * 1000;
    console.log(`[${label}] Bot ${botName} will restart in ${formatDuration(msUntilRestart)}`);

    setTimeout(() => {
      botsScheduledForRestart.delete(botName);
      console.log(`[${label}] Restarting bot ${botName}...`);
      startSingleBot(bot);
    }, msUntilRestart);
  };

  const startSingleBot = (bot: QuantBotRun) => {
    const botName = bot.name || 'unknown';
    try {
      // Wrap in Promise.resolve to handle both sync and async run() methods
      Promise.resolve(bot.run()).catch((error: unknown) => {
        console.error(`[${label}] Bot ${botName} failed:`, error);
        restartBot(bot, String(error));
      });
    } catch (error) {
      console.error(`[${label}] Failed to start bot ${botName}:`, error);
      restartBot(bot, String(error));
    }
  };

  // Start all bots
  console.log(`[${label}] Starting ${bots.length} bots...`);
  bots.forEach(startSingleBot);
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

  // Track available tokens per clobTokenId to prevent double-selling
  private tokenHoldings: Map<string, number> = new Map();

  // Stop function for the tick wrapper
  private tickStopFn: (() => void) | null = null;
  private isStopped: boolean = false;

  // Track if reset handler has been registered to prevent duplicates
  private resetListenerRegistered: boolean = false;

  public targetedMarket: TargetedMarket;
  public marketSchedule: MarketSchedule;

  // Injectable dependencies for simulation support
  protected cdMarketData?: IMarketData;
  protected logDirectory: string;
  protected shouldWriteLogs: boolean;

  // Simulation order delay - orders cannot match until this delay has passed
  private static readonly DEFAULT_SIMULATION_ORDER_DELAY_MS = 10 * 1000;  // 10 seconds
  protected simulationOrderDelayMs: number;

  // Track asset price at period start for settlement validation
  private periodStartPrice: number | null = null;

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

    // Use provided cdMarketData or fallback to singleton (set in getter)
    this.cdMarketData = props.cdMarketData;

    // Use provided logDirectory or default to production logs
    this.logDirectory = props.logDirectory ?? './logs/bots';

    // Whether to write logs (default: true)
    this.shouldWriteLogs = props.shouldWriteLogs ?? true;

    // Simulation order delay (default: 10 seconds)
    this.simulationOrderDelayMs = props.simulationOrderDelayMs ?? QuantBot.DEFAULT_SIMULATION_ORDER_DELAY_MS;

    console.log(`[${this.PROD_MODE ? "PROD" : "TEST"}] ${this.name} initialized...`);
    this.writeLog('Initialized...', LogLevel.INFO);

    // Register for clock events
    this.clock.on('hourly', () => {
      if (this.isStopped) return;
      this.emit('hourly');
      if (this.marketSchedule === MarketSchedule.HOURLY) {
        this.emit('reset');
      }
    });

    this.clock.on('quarterly', () => {
      if (this.isStopped) return;
      this.emit('quarterly');
      if (this.marketSchedule === MarketSchedule.QUARTERLY) {
        this.emit('reset');
      }
    });

    // Capture initial period start price for first period validation
    this.initializePeriodStartPrice();
  }

  /**
   * Captures the initial period start price asynchronously.
   * This ensures validation works from the first period, not just after the first reset.
   */
  private initializePeriodStartPrice(): void {
    // Use setTimeout to avoid blocking constructor
    setTimeout(async () => {
      if (this.isStopped) return;
      try {
        const marketData = this.getCdMarketData();
        this.periodStartPrice = await marketData.getCurrentPriceByMarket(this.targetedMarket);
        this.writeLog(`Initial period start price captured: $${this.periodStartPrice.toFixed(2)}`);
      } catch (e) {
        this.writeLog(`Failed to capture initial period start price: ${e}`, LogLevel.ERROR);
      }
    }, 1000); // Small delay to ensure dependencies are ready
  }

  // -------------------------------------------------------------------------
  // Market Data Access
  // -------------------------------------------------------------------------

  /**
   * Returns the injected cdMarketData instance or falls back to the singleton.
   * This allows simulation to provide a mock implementation while production
   * uses the real CDMarketData singleton.
   */
  protected getCdMarketData(): IMarketData {
    return this.cdMarketData ?? CDMarketData.getInstance();
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
   * Cancels all active (LIVE) trades before stopping.
   */
  public stop(): void {
    this.isStopped = true;
    if (this.tickStopFn) {
      this.tickStopFn();
      this.tickStopFn = null;
    }

    // Cancel all live trades
    const liveTrades = this.trades.filter(t => t.status === TradeStatus.LIVE);
    if (liveTrades.length > 0) {
      this.writeLog(`Canceling ${liveTrades.length} live trades on stop...`, LogLevel.INFO);

      // Fire and forget - we don't await since stop() is synchronous
      // but we still want to attempt cancellation
      Promise.all(
        liveTrades.map(trade =>
          this.cancelTrade(trade).catch(e => {
            this.writeLog(`Failed to cancel trade ${trade.orderId}: ${e}`, LogLevel.ERROR);
          })
        )
      ).then(() => {
        this.writeLog('All live trades canceled', LogLevel.INFO);
      }).catch(e => {
        this.writeLog(`Error during trade cancellation: ${e}`, LogLevel.ERROR);
      });
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

  /**
   * Registers a handler for the 'reset' event, ensuring it's only registered once.
   * This prevents duplicate listeners when a bot's run() method is called multiple times
   * (e.g., after restart).
   */
  protected registerResetHandler(handler: () => Promise<void>): void {
    if (this.resetListenerRegistered) return;
    this.resetListenerRegistered = true;
    this.on('reset', handler);
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

      // For SELL orders, check and reserve tokens
      if (side === Side.SELL) {
        if (!this.reserveTokensForSell(clobTokenId, amount)) {
          return undefined;  // Not enough tokens available
        }
      }

      if (this.orderOperationPending) {
        // Escape if our subclass entered into makeOrder, but there was a racecondition with clobIds, can often happen if we
        // try to place an order during an audit reset (the tickwrapper was running, and slowly progressing past the 'do nothing' due to awaits)
        // Return reserved tokens on SELL order escape
        if (side === Side.SELL) {
          this.returnTokens(clobTokenId, amount);
        }
        return;
      }

      // Final check before creating order
      if (this.currentPeriodId !== orderPeriodId || this.isResetting) {
        this.writeLog(`Order aborted: period changed before order creation for ${name}`);
        // Return reserved tokens on SELL order abort
        if (side === Side.SELL) {
          this.returnTokens(clobTokenId, amount);
        }
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
          // Return reserved tokens on SELL order failure
          if (side === Side.SELL) {
            this.returnTokens(clobTokenId, amount);
          }
          return undefined;
        }

        this.writeLog(JSON.stringify(result));

        const  trade = new TradeOrder({
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
        this.writeError(e instanceof Error ? e.message : JSON.stringify(e));
        this.writeError(`Errored amount: ${amount}`)
        // Return reserved tokens on SELL order failure
        if (side === Side.SELL) {
          this.returnTokens(clobTokenId, amount);
        }
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

        // Verify the order's actual status after cancel attempt
        const liveResult = await OrderBatcher.getOrder(trade.orderId);

        if (liveResult && liveResult.status === 'MATCHED') {
          // Order matched before cancel arrived - backfill it
          this.writeLog(`Order ${trade.orderId} matched before cancel completed - backfilling`);
          await this.handleUnexpectedMatch(trade, liveResult);
          return false;  // Cancel failed - order matched
        }

        if (liveResult && liveResult.status === 'PARTIAL') {
          // Order partially matched before cancel
          this.writeLog(`Order ${trade.orderId} partially matched before cancel - backfilling`);
          await this.handleUnexpectedMatch(trade, liveResult);
          return false;  // Cancel failed - order partially matched
        }
      }

      this.updateTradeStatus(trade, TradeStatus.CANCELED);
      this.recordSpend(-trade.totalCost, trade.side);

      // Return tokens on SELL cancel
      if (trade.side === Side.SELL) {
        this.returnTokens(trade.clobTokenId, trade.amount);
      }

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

  /**
   * Handles an order that matched unexpectedly (e.g., while we were trying to cancel it)
   */
  private async handleUnexpectedMatch(trade: TradeOrder, liveResult: OpenOrder): Promise<void> {
    this.writeLog(`Handling unexpected match for order ${trade.orderId}`);

    // Use size_matched from API response, rounded down to .01
    const matchedAmount = Math.floor(parseFloat(liveResult.size_matched) * 100) / 100;
    const livePrice = parseFloat(liveResult.price);

    if (!isNaN(matchedAmount) && matchedAmount > 0) {
      if (matchedAmount !== trade.amount) {
        this.writeLog(`Trade ${trade.orderId} matched amount differs: requested ${trade.amount}, matched ${matchedAmount}`);
      }
      trade.amount = matchedAmount;
      trade.totalCost = matchedAmount * livePrice;
    } else {
      this.writeLog(`Warning: Trade ${trade.orderId} has invalid size_matched: ${liveResult.size_matched}`);
    }

    // Update status to MATCHED
    this.updateTradeStatus(trade, TradeStatus.MATCHED);

    // Calculate finalValue based on side
    if (trade.side === Side.BUY) {
      trade.finalValue = -(trade.amount * livePrice);
    } else {
      trade.finalValue = trade.amount * livePrice;
    }

    // Write to audit log
    if (!trade.isAudited) {
      this.writeCompletedTrade(trade);
      trade.isAudited = true;
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

  /**
   * Called on each simulation tick. Bots should override this method to implement
   * their per-tick trading logic for simulation mode. This method is called by the
   * QuantBotSimulationAdapter instead of relying on tickWrapper (which uses real setTimeout).
   *
   * The default implementation just calls updateOrders(). Override this in subclasses
   * to add your bot's state machine, signal detection, order placement logic, etc.
   */
  public async onSimulationTick(): Promise<void> {
    throw Error("onSimulationTick should be overriden in child bot");
  }

  /**
   * Called at the end of each simulation period (hourly or quarterly).
   * Performs full reset logic similar to auditAndReset() but preserves trades for end-of-simulation results.
   */
  public async onSimulationPeriodEnd(): Promise<void> {
    await this.updateOrders();

    // Increment period ID and set resetting flag to block new orders
    this.currentPeriodId++;
    this.isResetting = true;

    if (this.orderOperationPending) {
      await this.orderOperationPending;
    }

    if (this.makeOrderPending) {
      await this.makeOrderPending;
    }

    // Reset period counters
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

    // Determine winning clob from previous period (use 5 min offset to ensure we're in previous period)
    const previousHourUrl = this.marketInfo.getUrl(
      this.marketInfo.getCurrentEstTimestamp() - (5 * 60 * 1000),
      this.targetedMarket,
    );
    this.writeLog(`Checking winner from URL: ${previousHourUrl}`);

    const previousMarket = await this.marketInfo.getMarketInfo(previousHourUrl);
    if (previousMarket.error) {
      this.writeLog(`Warning: Unable to find winning previous market: ${previousMarket.error}`);
    } else {
      this.writeLog(`Previous market prices: ${JSON.stringify(previousMarket.outcomePrices)}, closed: ${previousMarket.closed}`);

      // Warn if market doesn't appear to be resolved (prices not at 0/1)
      const prices = previousMarket.outcomePrices.map(p => parseFloat(p));
      const hasResolvedPrice = prices.some(p => p >= 0.99 || p <= 0.01);
      if (!hasResolvedPrice) {
        this.writeLog(`WARNING: Previous market may not be resolved yet! Prices: ${JSON.stringify(prices)}`);
      }
      if (!previousMarket.closed) {
        this.writeLog(`WARNING: Previous market 'closed' flag is false - market may not be resolved!`);
      }

      const winningIndex = previousMarket.outcomePrices.reduce(
        (maxIdx, curr, idx, arr) => (parseFloat(curr) > parseFloat(arr[maxIdx]) ? idx : maxIdx),
        0
      );
      const winningClob = previousMarket.clobTokenIds[winningIndex];
      this.writeLog(`Winner determination: index=${winningIndex}, clobId=${winningClob}`);

      // Determine asset price winner (if we have period start price)
      let assetPriceWinner: 'UP' | 'DOWN' | null = null;
      if (this.periodStartPrice !== null && this.cdMarketData) {
        const currentPrice = await this.cdMarketData.getCurrentPriceByMarket(this.targetedMarket);
        if (currentPrice >= this.periodStartPrice) {
          // UP wins if price went up OR stayed the same (favor UP on tie)
          assetPriceWinner = 'UP';
        } else {
          assetPriceWinner = 'DOWN';
        }
        this.writeLog(`Asset price: start=$${this.periodStartPrice.toFixed(2)}, end=$${currentPrice.toFixed(2)}, winner=${assetPriceWinner}`);
      }

      // Settle expired positions (handles remaining unmatched buy positions)
      this.settleExpiredPositions(winningClob, previousMarket.clobTokenIds, assetPriceWinner);
    }

    // Mark matched trades as audited (but don't write to file in simulation)
    for (const trade of this.trades) {
      if (trade.status === TradeStatus.MATCHED && !trade.isAudited) {
        trade.isAudited = true;
      }
    }

    // Clear trades since adapter has accumulated them before calling this method
    this.trades = [];
    this.tokenHoldings.clear();

    this.isResetting = false;

    // Call bot-specific reset logic (child classes override this)
    this.resetTradeState();

    // Capture period start price for next period's settlement validation
    if (this.cdMarketData) {
      this.periodStartPrice = await this.cdMarketData.getCurrentPriceByMarket(this.targetedMarket);
      this.writeLog(`Period start price captured: $${this.periodStartPrice.toFixed(2)}`);
    }
  }

  /**
   * Called at the end of each simulation period after base reset logic.
   * Child classes should override this to reset their bot-specific state.
   */
  protected resetTradeState(): void {
    throw Error('Child class must override resetTradeState')
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

  /**
   * Converts a dollar amount to token quantity at the given price.
   * Rounds down to nearest whole number. Returns null if the resulting
   * token amount would be invalid (less than minimum order size).
   */
  protected dollarToTokens(dollarAmount: number, price: number): number | null {
    if (price <= 0 || price >= 1) {
      return null;
    }
    const tokens = Math.floor(dollarAmount / price);
    if (tokens < 5) {
      return null;
    }
    return tokens;
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

      // Wait for settlement - API may not have updated winner immediately at period boundary
      const SETTLEMENT_DELAY_MS = 5 * 1000;
      await new Promise(resolve => setTimeout(resolve, SETTLEMENT_DELAY_MS));

      // Determine winning clob from previous period (use 5 min offset to ensure we're in previous period)
      const previousHourUrl = this.marketInfo.getUrl(
        this.marketInfo.getCurrentEstTimestamp() - (5 * 60 * 1000),
        this.targetedMarket,
      );
      this.writeLog(`Checking winner from URL: ${previousHourUrl}`);

      const previousMarket = await this.marketInfo.getMarketInfo(previousHourUrl);
      if(previousMarket.error) {
        // todo
        throw Error(`Unable to find winning previous market: ${previousMarket.error}`)
      }

      this.writeLog(`Previous market prices: ${JSON.stringify(previousMarket.outcomePrices)}, closed: ${previousMarket.closed}`);

      // Warn if market doesn't appear to be resolved (prices not at 0/1)
      const prices = previousMarket.outcomePrices.map(p => parseFloat(p));
      const hasResolvedPrice = prices.some(p => p >= 0.99 || p <= 0.01);
      if (!hasResolvedPrice) {
        this.writeLog(`WARNING: Previous market may not be resolved yet! Prices: ${JSON.stringify(prices)}`);
      }
      if (!previousMarket.closed) {
        this.writeLog(`WARNING: Previous market 'closed' flag is false - market may not be resolved!`);
      }

      const winningIndex = previousMarket.outcomePrices.reduce(
        (maxIdx, curr, idx, arr) => (parseFloat(curr) > parseFloat(arr[maxIdx]) ? idx : maxIdx),
        0
      );
      const winningClob = previousMarket.clobTokenIds[winningIndex];
      this.writeLog(`Winner determination: index=${winningIndex}, clobId=${winningClob}`);

      // Determine asset price winner (if we have period start price)
      let assetPriceWinner: 'UP' | 'DOWN' | null = null;
      if (this.periodStartPrice !== null && this.cdMarketData) {
        const currentPrice = await this.cdMarketData.getCurrentPriceByMarket(this.targetedMarket);
        if (currentPrice >= this.periodStartPrice) {
          // UP wins if price went up OR stayed the same (favor UP on tie)
          assetPriceWinner = 'UP';
        } else {
          assetPriceWinner = 'DOWN';
        }
        this.writeLog(`Asset price: start=$${this.periodStartPrice.toFixed(2)}, end=$${currentPrice.toFixed(2)}, winner=${assetPriceWinner}`);
      }

      // Settle expired positions (handles remaining unmatched buy positions)
      this.settleExpiredPositions(winningClob, previousMarket.clobTokenIds, assetPriceWinner);

      // Write any completed trades that haven't been audited yet
      for (const trade of this.trades) {
        if (trade.status === TradeStatus.MATCHED && !trade.isAudited) {
          this.writeCompletedTrade(trade);
          trade.isAudited = true;
        }
      }

      this.trades = [];
      this.tokenHoldings.clear();
      this.isResetting = false;

      // Capture period start price for next period's settlement validation
      if (this.cdMarketData) {
        this.periodStartPrice = await this.cdMarketData.getCurrentPriceByMarket(this.targetedMarket);
        this.writeLog(`Period start price captured: $${this.periodStartPrice.toFixed(2)}`);
      }
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
  // Token Holdings Management
  // -------------------------------------------------------------------------

  /**
   * Gets the current available token count for a given clobTokenId.
   */
  protected getAvailableTokens(clobTokenId: string): number {
    return this.tokenHoldings.get(clobTokenId) ?? 0;
  }

  /**
   * Reserves tokens for a sell order. Returns true if successful, false if insufficient tokens.
   */
  private reserveTokensForSell(clobTokenId: string, amount: number): boolean {
    const available = this.getAvailableTokens(clobTokenId);
    if (available < amount) {
      this.writeLog(`Cannot sell ${amount} tokens: only ${available} available for ...${clobTokenId.slice(-20)}`);
      return false;
    }
    this.tokenHoldings.set(clobTokenId, available - amount);
    this.writeLog(`Reserved ${amount} tokens for sell, ${available - amount} remaining for ...${clobTokenId.slice(-20)}`);
    return true;
  }

  /**
   * Returns tokens to available pool (on SELL cancel/expire).
   */
  private returnTokens(clobTokenId: string, amount: number): void {
    const current = this.getAvailableTokens(clobTokenId);
    this.tokenHoldings.set(clobTokenId, current + amount);
    this.writeLog(`Returned ${amount} tokens, now ${current + amount} available for ...${clobTokenId.slice(-20)}`);
  }

  /**
   * Credits tokens on BUY match.
   */
  private creditTokensOnBuy(clobTokenId: string, amount: number): void {
    const current = this.getAvailableTokens(clobTokenId);
    this.tokenHoldings.set(clobTokenId, current + amount);
    this.writeLog(`Credited ${amount} tokens on BUY match, now ${current + amount} available for ...${clobTokenId.slice(-20)}`);
  }

  // -------------------------------------------------------------------------
  // Logging
  // -------------------------------------------------------------------------

  public writeLog(message: string, logLevel = LogLevel.INFO): void {
    if (!this.shouldWriteLogs) return;

    const timestampMs = this.clock.now();
    const timestamp = new Date(timestampMs).toISOString();
    const logLine = `[${logLevel}] ${timestamp}\t ${message}\n`;
    const prodTest = this.PROD_MODE ? 'prod' : 'test';

    // Write to log file (if WRITE_LOGS env is not explicitly false)
    if (process.env.WRITE_LOGS !== 'false') {
      // Ensure log directory exists
      if (!existsSync(this.logDirectory)) {
        mkdirSync(this.logDirectory, { recursive: true });
      }
      appendFileSync(`${this.logDirectory}/${prodTest}-${this.name}.log`, logLine);
    }

    // Write ORDER/UPDATE/COMPLETED logs to database for live trades tracking
    // Skip simulation mode logs
    const isSimulationMode = this.logDirectory.includes('logs/simulator');
    if (!isSimulationMode && (logLevel === LogLevel.ORDER || logLevel === LogLevel.UPDATE)) {
      try {
        const db = TradingDatabase.getInstance();
        // Parse ORDER log: orderId, name, side, clobTokenId, orderID, amount, price, marketUrl
        let orderId: string | null = null;
        let orderSide: string | null = null;
        let orderAmount: number | null = null;
        let orderPrice: number | null = null;

        if (logLevel === LogLevel.ORDER) {
          const parts = message.split(', ').map(p => p.trim());
          if (parts.length >= 7) {
            orderId = parts[0];
            orderSide = parts[2];
            orderAmount = parseFloat(parts[5]) || null;
            orderPrice = parseFloat(parts[6]) || null;
          }
        }

        db.insertBotLog({
          timestamp: timestampMs,
          level: logLevel,
          source: `${prodTest}-${this.name}`,
          message: message.trim(),
          orderId,
          orderSide,
          orderAmount,
          orderPrice,
        });
      } catch (e) {
        // Don't let DB errors stop the bot
        console.error(`[DB ERROR] Failed to write bot log: ${e}`);
      }
    }
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
    const timestamp = this.clock.now();
    const mode = trade.isProd ? 'PROD' : 'TEST';

    const message = [
      timestamp,
      this.name,
      trade.orderId,
      trade.status,
      trade.createdAt,
      trade.amount,
      trade.targetBuyPrice || -1,
      trade.targetSellPrice || -1,
      trade.totalCost,
      trade.finalValue ?? 0,
      mode,
      trade.clobTokenId,
      trade.side,
    ].join(', ') + "\n";

    // Skip writing to main audit log if running in simulation mode
    // (detected by logDirectory being in logs/simulator folder)
    const isSimulationMode = this.logDirectory.includes('logs/simulator');
    if (!isSimulationMode) {
      // Write to log file (if WRITE_LOGS env is not explicitly false)
      if (process.env.WRITE_LOGS !== 'false') {
        appendFileSync(`./logs/audits/tradeAudit.log`, message);
      }

      // Write to database
      try {
        const db = TradingDatabase.getInstance();
        db.insertTradeAudit({
          timestamp,
          strategy: this.name,
          tradeId: trade.orderId,
          status: trade.status,
          entryTimestamp: trade.createdAt,
          size: trade.amount,
          buyPrice: trade.targetBuyPrice ?? null,
          sellPrice: trade.targetSellPrice ?? null,
          gross: trade.totalCost,
          pnl: trade.finalValue ?? 0,
          mode,
          marketHash: trade.clobTokenId,
          side: trade.side,
        });
      } catch (e) {
        // Don't let DB errors stop the bot - log and continue
        console.error(`[DB ERROR] Failed to write trade audit: ${e}`);
      }
    }
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
    // Reset the stopped flag when starting a new tick loop (allows restart after stop())
    this.isStopped = false;

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
    // Skip already completed statuses
    if (trade.status === TradeStatus.MATCHED || trade.status === TradeStatus.EXPIRED) return;

    // For CANCELED trades, still check if they actually matched
    const shouldVerifyCanceled = trade.status === TradeStatus.CANCELED && this.PROD_MODE;
    if (trade.status !== TradeStatus.LIVE && !shouldVerifyCanceled) return;

    const liveResult: OpenOrder | undefined = await OrderBatcher.getOrder(trade.orderId);
    if (!liveResult) return;

    // Handle case where we marked it CANCELED but it actually matched
    if (trade.status === TradeStatus.CANCELED && liveResult.status === 'MATCHED') {
      this.writeLog(`Order ${trade.orderId} was marked CANCELED but actually MATCHED - recovering`);
      await this.handleUnexpectedMatch(trade, liveResult);
      return;
    }

    // Only LIVE orders proceed from here
    if (trade.status !== TradeStatus.LIVE) return;

    // Handle PARTIAL status - keep trade in partial state
    if (liveResult.status === 'PARTIAL') {
      this.writeLog(`LiveResult (PARTIAL): ${JSON.stringify(liveResult)}`);
      this.updateTradeStatus(trade, TradeStatus.PARTIAL);
      return;
    }

    // Only process MATCHED orders beyond this point
    if (liveResult.status !== 'MATCHED') return;

    this.writeLog(`LiveResult: ${JSON.stringify(liveResult)}`);

    this.updateTradeStatus(trade, TradeStatus.MATCHED);

    // Use size_matched from API response (actual filled amount), rounded down to .01
    const matchedAmount = Math.floor(parseFloat(liveResult.size_matched) * 100) / 100;
    const livePrice = parseFloat(liveResult.price);

    // Always use size_matched when available and valid
    if (!isNaN(matchedAmount) && matchedAmount > 0) {
      if (matchedAmount !== trade.amount) {
        this.writeLog(`Trade ${trade.orderId} matched amount differs: requested ${trade.amount}, matched ${matchedAmount}`);
      }
      trade.amount = matchedAmount;
      trade.totalCost = matchedAmount * livePrice;
    } else {
      this.writeLog(`Warning: Trade ${trade.orderId} has invalid size_matched: ${liveResult.size_matched}, using original amount: ${trade.amount}`);
    }

    if (trade.side === Side.BUY) {
      if (trade.targetBuyPrice && livePrice) {
        trade.finalValue = -(matchedAmount * livePrice);
      } else {
        this.writeError(`trade: ${trade.orderId} does not have targetBuyPrice/livePrice but is BUY order, livePrice: ${livePrice}`);
      }
    } else {
      if (trade.targetSellPrice && livePrice) {
        trade.finalValue = matchedAmount * livePrice;
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

    // Check if order has passed the simulation delay period
    const orderAge = this.clock.now() - trade.createdAt;
    if (orderAge < this.simulationOrderDelayMs) {
      // Order is still in delay period, cannot match yet
      return;
    }

    if (trade.side === Side.BUY) {
      if (!trade.targetBuyPrice) {
        this.writeError(`trade: ${trade.orderId} does not have targetBuyPrice but is BUY order`);
        return;
      }
      const liveSellPrice = await this.marketInfo.getPrice(trade.clobTokenId, trade.side, this.targetedMarket);
      if (liveSellPrice < trade.targetBuyPrice) { // < (over <=) causes the price to have to be .01c over the price, this could cause issues in edge price cases.
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
      const liveBuyPrice = await this.marketInfo.getPrice(trade.clobTokenId, trade.side, this.targetedMarket);
      if (liveBuyPrice > trade.targetSellPrice) { // > (over >=) causes the price to have to be .01c over the price, this could cause issues in edge price cases.
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
        // Return tokens on SELL expire
        if (trade.side === Side.SELL) {
          this.returnTokens(trade.clobTokenId, trade.amount);
        }
        break;
      case TradeStatus.CANCELED:
        trade.emit('tradeCanceled');
        break;
      case TradeStatus.MATCHED:
        trade.emit('tradeMatched');
        // Credit tokens on BUY match
        if (trade.side === Side.BUY) {
          this.creditTokensOnBuy(trade.clobTokenId, trade.amount);
        }
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

  private settleExpiredPositions(
    winningClob: string,
    allClobTokenIds: string[],
    assetPriceWinner: 'UP' | 'DOWN' | null
  ): void {
    const positionsByClob: Record<string, number> = {};

    for (const trade of this.trades) {
      if (trade.status === TradeStatus.MATCHED && trade.side === Side.BUY) {
        positionsByClob[trade.clobTokenId] = (positionsByClob[trade.clobTokenId] || 0) + trade.amount;
      } else if (trade.status === TradeStatus.MATCHED && trade.side === Side.SELL) {
        positionsByClob[trade.clobTokenId] = (positionsByClob[trade.clobTokenId] || 0) - trade.amount;
      }
    }

    // Determine p-market winner direction (clobTokenIds[0] = UP, clobTokenIds[1] = DOWN)
    const pMarketWinner: 'UP' | 'DOWN' = winningClob === allClobTokenIds[0] ? 'UP' : 'DOWN';

    // Check for winner mismatch
    const hasMismatch = assetPriceWinner !== null && pMarketWinner !== assetPriceWinner;
    if (hasMismatch) {
      this.writeLog(`ERROR: Winner mismatch! P-market says ${pMarketWinner}, asset price says ${assetPriceWinner}. Expiring all positions for $0.`);
    }

    // Settle remaining positions (bought but not sold)
    for (const [clobId, amount] of Object.entries(positionsByClob)) {
      if (amount <= 0) continue;

      // If mismatch, all positions expire for zero
      const isWin = hasMismatch ? false : (clobId === winningClob);
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
