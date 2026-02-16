/**
 * Core interfaces for the Polymarket trading bot system.
 *
 * This module defines the key abstractions that allow swapping between
 * production and simulation environments:
 *
 * - IClock: Time abstraction (RealClock vs SimulationClock)
 * - IMarketData: External price data (CDMarketData vs MockCDMarketData)
 * - IMarketInfo: Polymarket data (MarketInfo vs MockMarketInfo)
 * - IOrderExecutor: Order execution interface
 *
 * @module types/interfaces
 */

import { Side } from "@polymarket/clob-client";
import { MarketInfoSimple } from "../nonBots/MarketInfo.js";

// ============================================================================
// Enums
// ============================================================================

/**
 * Direction of a binary UP/DOWN market prediction.
 */
export enum BtcDirection {
    UP = "UP",
    DOWN = "DOWN",
}

/**
 * Supported Polymarket prediction markets.
 * Each market tracks whether an asset will be higher or lower at period end.
 *
 * - HOURLY: Resolves every hour on the hour
 * - QUARTERLY: Resolves every 15 minutes (00, 15, 30, 45)
 */
export enum TargetedMarket {
    BITCOIN_HOURLY = 'BitcoinHourly',
    ETHEREUM_HOURLY = 'EthereumHourly',
    SOLANA_HOURLY = 'SolanaHourly',
    XRP_HOURLY = 'XRPHourly',
    BITCOIN_QUARTERLY = 'BitcoinQuarterly',
    ETHEREUM_QUARTERLY =  'EthereumQuarterly',
    SOLANA_QUARTERLY = 'SolanaQuarterly',
    XRP_QUARTERLY = 'XRPQuarterly',
}

/**
 * Market resolution schedule type.
 */
export enum MarketSchedule {
    /** Resolves every 15 minutes */
    QUARTERLY = 'Quarterly',
    /** Resolves every hour */
    HOURLY = 'Hourly',
}

/**
 * Order lifecycle states.
 *
 * Flow: LIVE → MATCHED (filled) | EXPIRED (timed out) | CANCELED (manual)
 * PARTIAL indicates partial fill (some amount matched).
 */
export enum TradeStatus {
    /** Order is active on the order book */
    LIVE = 'LIVE',
    /** Order has been fully filled */
    MATCHED = 'MATCHED',
    /** Order expired without filling */
    EXPIRED = 'EXPIRED',
    /** Order was manually canceled */
    CANCELED = 'CANCELED',
    /** Order was partially filled */
    PARTIAL = 'PARTIAL',
}

// ============================================================================
// Data Structures
// ============================================================================

export interface OrderBooks {
    UpTokenId: string;
    Up: OrderBookSummary;
    DownTokenId: string;
    Down: OrderBookSummary;
}

/** Alias for BTC-specific order books (backward compatibility) */
export interface BtcOrderBooks {
    BtcUpTokenId: string;
    BtcUp: OrderBookSummary;
    BtcDownTokenId: string;
    BtcDown: OrderBookSummary;
}

export interface OrderBookSummary {
    bids: { price: string; size: string }[];
    asks: { price: string; size: string }[];
}

export interface HistoricalAverages {
    hourlyOpen: number;
    averagePrice: number;
    hourlyMin: number;
    hourlyMax: number;
    openFlops: number;
    averageFlops: number;
    totalChange: number;
}

export interface RecentPriceEntry {
    timestamp: Date;
    price: number;
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
    isAudited?: boolean;
    periodId?: number;  // Period ID when order was created (for cross-period validation)
}

// ============================================================================
// Clock Interface
// ============================================================================

/** Event types emitted by the clock at period boundaries. */
export type ClockEventType = 'hourly' | 'quarterly';

/**
 * Abstract clock interface for time-dependent operations.
 *
 * Implementations:
 * - RealClock: Uses system time and cron jobs for production
 * - SimulationClock: Controllable time for backtesting
 *
 * Bots use the clock to:
 * - Get current time for order timestamps
 * - Subscribe to period boundary events (hourly/quarterly)
 * - Calculate time remaining in current period
 *
 * @example
 * ```typescript
 * clock.on('hourly', () => {
 *   // Called at the start of each hour
 *   this.resetTradeState();
 * });
 * ```
 */
export interface IClock {
    /** Returns current timestamp in milliseconds (UTC). */
    now(): number;

    /** Returns current minute (0-59) in local time. */
    getMinutes(): number;

    /** Returns current hour (0-23) in local time. */
    getHours(): number;

    /** Returns current timestamp in EST timezone (for Polymarket period alignment). */
    getCurrentEstTimestamp(): number;

    /**
     * Register a callback for period boundary events.
     * @param event - 'hourly' fires every hour, 'quarterly' fires every 15 minutes
     * @param callback - Function to call when event occurs
     */
    on(event: ClockEventType, callback: () => void): void;

    /**
     * Unregister a previously registered callback.
     * @param event - Event type to unsubscribe from
     * @param callback - The exact callback function to remove
     */
    off(event: ClockEventType, callback: () => void): void;

    /** Stop the clock and clean up resources (cron jobs, intervals, listeners). */
    stop(): void;
}

// ============================================================================
// Market Data Interface (Binance/External Price Data)
// ============================================================================

/**
 * Abstract interface for external market data (e.g., Binance prices).
 *
 * Implementations:
 * - CDMarketData: Real-time Binance WebSocket data for production
 * - MockCDMarketData: Historical/simulated data for backtesting
 *
 * This data is used to:
 * - Determine if markets should resolve UP or DOWN
 * - Compute features for ML models (candle sizes, momentum, volatility)
 * - Calculate fair value predictions
 *
 * @example
 * ```typescript
 * const binancePrice = await marketData.getCurrentPriceByMarket(TargetedMarket.BITCOIN_HOURLY);
 * const averages = marketData.getAverages(24, 'BTCUSDT');
 * ```
 */
export interface IMarketData {
    /**
     * Gets the current price for a symbol.
     * @param symbol - Trading pair (e.g., 'BTCUSDT'). Defaults to configured symbol.
     */
    getCurrentPrice(symbol?: string): Promise<number>;

    /**
     * Gets the current price for a targeted market.
     * Automatically resolves to the correct symbol (BTC, ETH, SOL, XRP).
     */
    getCurrentPriceByMarket(market: TargetedMarket): Promise<number>;

    /**
     * Gets statistical averages for the last N hours.
     * Used for computing historical features and baselines.
     */
    getAverages(n: number, symbol?: string): HistoricalAverages | null;

    /**
     * Gets the simple average price over the last N hours.
     */
    getAveragePrice(n: number, symbol?: string): number | null;

    /**
     * Gets recent price entries with timestamps.
     * Used for computing momentum and candle features.
     */
    getRecentPrices(n: number, market: TargetedMarket): RecentPriceEntry[];
}

// ============================================================================
// Market Info Interface (Polymarket Data)
// ============================================================================

/**
 * Abstract interface for Polymarket order book and market data.
 *
 * Implementations:
 * - MarketInfo: Real-time Polymarket API data with caching
 * - MockMarketInfo: Simulated order books for backtesting
 *
 * This data is used to:
 * - Get current UP/DOWN token prices and spreads
 * - Access order book depth for liquidity analysis
 * - Resolve market URLs for each time period
 *
 * @example
 * ```typescript
 * const orderBooks = await marketInfo.getLiveData(TargetedMarket.BITCOIN_HOURLY);
 * const upMid = await marketInfo.getMidPrice(orderBooks.BtcUpTokenId, market);
 * ```
 */
export interface IMarketInfo {
    /** Gets current EST timestamp (for Polymarket period alignment). */
    getCurrentEstTimestamp(): number;

    /**
     * Gets the order books for both UP and DOWN tokens.
     * Returns token IDs and full bid/ask arrays.
     */
    getLiveData(market: TargetedMarket): Promise<BtcOrderBooks>;

    /**
     * Gets the best price for a token on a given side.
     * @param clobTokenId - The Polymarket CLOB token ID
     * @param side - BUY (best ask) or SELL (best bid)
     */
    getPrice(clobTokenId: string, side: Side, market: TargetedMarket): Promise<number>;

    /**
     * Gets the midpoint price for a token (average of best bid and ask).
     * @returns Midpoint price, or null if token not found in current period
     */
    getMidPrice(clobTokenId: string, market: TargetedMarket): Promise<number | null>;

    /**
     * Gets the CLOB token IDs for the current period.
     * Returns [upTokenId, downTokenId].
     */
    getCurrentClobTokenIds(market: TargetedMarket): Promise<string[]>;

    /**
     * Constructs the Polymarket URL for a market at a specific timestamp.
     * Used for resolving historical periods.
     */
    getUrl(timestamp: number, market: TargetedMarket): string;

    /**
     * Gets market info for a specific URL.
     * Used for lookback queries to past periods.
     */
    getMarketInfo(url: string): Promise<MarketInfoSimple>;

    /**
     * Gets the winner for a specific period (simulation only).
     * @returns 'UP' if UP token won, 'DOWN' if DOWN token won, null if unknown
     */
    getHourWinner?(timestamp: number, market: TargetedMarket): 'UP' | 'DOWN' | null;
}

// ============================================================================
// Order Execution Interface
// ============================================================================

/**
 * Status of an order in the execution system.
 */
export enum OrderStatus {
    /** Order created but not yet submitted */
    PENDING = 'PENDING',
    /** Order is active on the order book */
    LIVE = 'LIVE',
    /** Order has been fully filled */
    MATCHED = 'MATCHED',
    /** Order has been partially filled */
    PARTIAL = 'PARTIAL',
    /** Order was manually canceled */
    CANCELED = 'CANCELED',
    /** Order expired without filling */
    EXPIRED = 'EXPIRED',
}

/**
 * Result of an order operation (create, status check).
 */
export interface OrderResult {
    /** Unique order identifier */
    orderId: string;
    /** Current order status */
    status: OrderStatus;
    /** CLOB token ID being traded */
    tokenId: string;
    /** Order price */
    price: number;
    /** Order amount (shares) */
    amount: number;
    /** BUY or SELL */
    side: Side;
    /** Amount filled so far (for partial fills) */
    filledAmount?: number;
}

/**
 * Abstract interface for order execution.
 *
 * This interface abstracts away the order execution mechanism,
 * allowing the same bot code to work with:
 * - Real Polymarket CLOB API (production)
 * - Simulated order matching (backtesting)
 *
 * Note: QuantBot handles most order execution internally via OrderBatcher.
 * This interface is primarily used for advanced simulation scenarios.
 */
export interface IOrderExecutor {
    /**
     * Creates and submits an order.
     * @param tokenId - CLOB token ID to trade
     * @param price - Limit price (0.01-0.99)
     * @param amount - Number of shares
     * @param side - BUY or SELL
     * @returns Order result with ID and initial status
     */
    createOrder(
        tokenId: string,
        price: number,
        amount: number,
        side: Side
    ): Promise<OrderResult>;

    /**
     * Cancels an existing order.
     * @returns true if successfully canceled, false otherwise
     */
    cancelOrder(orderId: string): Promise<boolean>;

    /**
     * Gets the current status of an order.
     * @returns Order result or null if not found
     */
    getOrderStatus(orderId: string): Promise<OrderResult | null>;

    /**
     * Gets all open (LIVE or PARTIAL) orders.
     */
    getOpenOrders(): Promise<OrderResult[]>;
}