import { Side } from "@polymarket/clob-client";
import { MarketInfoSimple } from "../nonBots/MarketInfo.js";

// ============================================================================
// Enums
// ============================================================================

export enum BtcDirection {
    UP = "UP",
    DOWN = "DOWN",
}

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

export enum MarketSchedule {
    QUARTERLY = 'Quarterly',
    HOURLY = 'Hourly',
}

export enum TradeStatus {
    LIVE = 'LIVE',
    MATCHED = 'MATCHED',
    EXPIRED = 'EXPIRED',
    CANCELED = 'CANCELED',
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
}

// ============================================================================
// Clock Interface
// ============================================================================

export type ClockEventType = 'hourly' | 'quarterly';

export interface IClock {
    /** Returns current timestamp in milliseconds */
    now(): number;

    /** Returns current minute (0-59) */
    getMinutes(): number;

    /** Returns current hour (0-23) */
    getHours(): number;

    /** Returns current EST timestamp */
    getCurrentEstTimestamp(): number;

    /** Register a callback for hourly or quarterly events */
    on(event: ClockEventType, callback: () => void): void;

    /** Unregister a callback */
    off(event: ClockEventType, callback: () => void): void;
}

// ============================================================================
// Market Data Interface (Binance/External Price Data)
// ============================================================================

export interface IMarketData {
    /** Gets the current price for a symbol */
    getCurrentPrice(symbol?: string): Promise<number>;

    /** Gets the current price by targeted market */
    getCurrentPriceByMarket(market: TargetedMarket): Promise<number>;

    /** Gets historical averages for the last N hours */
    getAverages(n: number, symbol?: string): HistoricalAverages | null;

    /** Gets the average price over the last N hours */
    getAveragePrice(n: number, symbol?: string): number | null;

    /** Gets recent price entries */
    getRecentPrices(n: number, market: TargetedMarket): RecentPriceEntry[];
}

// ============================================================================
// Market Info Interface (Polymarket Data)
// ============================================================================

export interface IMarketInfo {
    /** Gets current EST timestamp */
    getCurrentEstTimestamp(): number;

    /** Gets the order books for a targeted market */
    getLiveData(market: TargetedMarket): Promise<BtcOrderBooks>;

    /** Gets the current price for a token */
    getPrice(clobTokenId: string, side: Side, market: TargetedMarket): Promise<number>;

    /** Gets the CLOB token IDs for a targeted market */
    getCurrentClobTokenIds(market: TargetedMarket): Promise<string[]>;

    /** Gets the URL for a specific market at a timestamp */
    getUrl(timestamp: number, market: TargetedMarket): string;

    /** Gets market info for a specific URL (for lookback queries) */
    getMarketInfo(url: string): Promise<MarketInfoSimple>;

    /** Gets the winner for a specific hour (simulation only) */
    getHourWinner?(timestamp: number, market: TargetedMarket): 'UP' | 'DOWN' | null;
}

// ============================================================================
// Order Execution Interface
// ============================================================================

export enum OrderStatus {
    PENDING = 'PENDING',
    LIVE = 'LIVE',
    MATCHED = 'MATCHED',
    PARTIAL = 'PARTIAL',
    CANCELED = 'CANCELED',
    EXPIRED = 'EXPIRED',
}

export interface OrderResult {
    orderId: string;
    status: OrderStatus;
    tokenId: string;
    price: number;
    amount: number;
    side: Side;
    filledAmount?: number;
}

export interface IOrderExecutor {
    /** Creates and submits an order */
    createOrder(
        tokenId: string,
        price: number,
        amount: number,
        side: Side
    ): Promise<OrderResult>;

    /** Cancels an existing order */
    cancelOrder(orderId: string): Promise<boolean>;

    /** Gets the current status of an order */
    getOrderStatus(orderId: string): Promise<OrderResult | null>;

    /** Gets all open orders */
    getOpenOrders(): Promise<OrderResult[]>;
}