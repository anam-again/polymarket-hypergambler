/**
 * Database types for the trading bot system.
 */

// =============================================================================
// Trade Audit Types
// =============================================================================

export interface TradeAuditRecord {
    id?: number;
    timestamp: number;
    strategy: string;
    tradeId: string;
    status: string;           // MATCHED, EXPIRED, CANCELED
    entryTimestamp: number;
    size: number;
    buyPrice: number | null;
    sellPrice: number | null;
    gross: number;
    pnl: number;
    mode: string;             // PROD, TEST, SIM
    marketHash: string;
    side: string;             // BUY, SELL
}

// =============================================================================
// Bot Log Types
// =============================================================================

export interface BotLogRecord {
    id?: number;
    timestamp: number;
    level: string;            // INFO, ERROR, ORDER, UPDATE, COMPLETED
    source: string;           // Bot name
    message: string;
    orderId?: string | null;
    orderSide?: string | null;
    orderAmount?: number | null;
    orderPrice?: number | null;
}

// =============================================================================
// Market Price Types
// =============================================================================

export interface PmarketPriceRecord {
    id?: number;
    timestamp: number;
    market: string;           // btc, eth, sol, xrp
    upBid: number;
    upAsk: number;
    downBid: number | null;
    downAsk: number | null;
}

export interface BinancePriceHourlyRecord {
    id?: number;
    timestamp: number;
    symbol: string;           // BTCUSDT, ETHUSDT, etc.
    hourlyOpen: number;
    averagePrice: number;
    hourlyMin: number;
    hourlyMax: number;
    openFlops: number | null;
    averageFlops: number | null;
    totalChange: number | null;
}

export interface BinancePriceMinuteRecord {
    id?: number;
    timestamp: number;
    symbol: string;
    price: number;
}

// =============================================================================
// Sync State Types
// =============================================================================

export interface SyncStateRecord {
    filePath: string;
    lastBytePosition: number;
    lastSyncTimestamp: number;
}

// =============================================================================
// Query Types
// =============================================================================

export interface TradeQueryFilters {
    startTime?: number | null;
    endTime?: number | null;
    mode?: string | null;      // 'all', 'PROD', 'TEST', 'SIM'
    strategy?: string | null;
    status?: string | null;    // 'MATCHED', 'EXPIRED', 'CANCELED'
    side?: string | null;      // 'BUY', 'SELL'
    limit?: number;
    offset?: number;
}

export interface StatsResult {
    totalTrades: number;
    soldTrades: number;
    expiredTrades: number;
    totalPnl: number;
    winRate: number;
    avgPnl: number;
    winningTrades: number;
    losingTrades: number;
}

export interface StrategyPnlResult {
    strategy: string;
    pnl: number;
    trades: number;
    wins: number;
    losses: number;
    winRate: number;
}

export interface CumulativePnlPoint {
    timestamp: number;
    pnl: number;
    cumulative: number;
    strategy: string;
    status: string;
}

// =============================================================================
// Confirmed Winners Types (RedemptionSolver)
// =============================================================================

export interface ConfirmedWinnerRecord {
    id?: number;
    periodId: string;
    market: string;
    clobTokenIdUp: string;
    clobTokenIdDown: string;
    winningSide: 'UP' | 'DOWN';
    coinOpenPrice: number | null;
    coinClosePrice: number | null;
    polymarketConfirmed: boolean;
    coinPriceConfirmed: boolean;
    pmarketConvergenceConfirmed: boolean;
    mismatchDetected: boolean;
    verifiedAt: number;
    notes: string | null;
}

export interface HistoricalRevision {
    timestamp: string;
    periodId: string;
    clobTokenId: string;
    field: string;
    oldValue: string;
    newValue: string;
    source: 'polymarket_api' | 'coin_price' | 'pmarket_convergence';
}
