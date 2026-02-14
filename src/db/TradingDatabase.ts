/**
 * Singleton database service for the trading bot system.
 * Uses better-sqlite3 for synchronous writes matching current appendFileSync() behavior.
 */
import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { runMigrations } from './schema.js';
import type {
    TradeAuditRecord,
    BotLogRecord,
    PmarketPriceRecord,
    BinancePriceHourlyRecord,
    BinancePriceMinuteRecord,
    SyncStateRecord,
    TradeQueryFilters,
    StatsResult,
    StrategyPnlResult,
    CumulativePnlPoint,
    ConfirmedWinnerRecord,
} from './types.js';

const DEFAULT_DB_PATH = './data/trading.db';

export class TradingDatabase {
    private db: Database.Database;
    private static instance: TradingDatabase | null = null;

    // Prepared statements for performance
    private insertTradeStmt: Database.Statement;
    private insertBotLogStmt: Database.Statement;
    private insertPmarketPriceStmt: Database.Statement;
    private insertBinanceHourlyStmt: Database.Statement;
    private insertBinanceMinuteStmt: Database.Statement;
    private upsertSyncStateStmt: Database.Statement;
    private insertConfirmedWinnerStmt: Database.Statement;
    private getConfirmedWinnerStmt: Database.Statement;

    private constructor(dbPath: string) {
        // Ensure directory exists
        const dir = dirname(dbPath);
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }

        // Open database
        this.db = new Database(dbPath);

        // Run migrations to ensure schema is up to date
        runMigrations(this.db);

        // Prepare statements for fast inserts
        this.insertTradeStmt = this.db.prepare(`
            INSERT OR IGNORE INTO trade_audits (
                timestamp, strategy, trade_id, status, entry_timestamp,
                size, buy_price, sell_price, gross, pnl,
                mode, market_hash, side
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        this.insertBotLogStmt = this.db.prepare(`
            INSERT INTO bot_logs (
                timestamp, level, source, message,
                order_id, order_side, order_amount, order_price
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);

        this.insertPmarketPriceStmt = this.db.prepare(`
            INSERT INTO pmarket_prices (
                timestamp, market, up_bid, up_ask, down_bid, down_ask
            ) VALUES (?, ?, ?, ?, ?, ?)
        `);

        this.insertBinanceHourlyStmt = this.db.prepare(`
            INSERT INTO binance_prices_hourly (
                timestamp, symbol, hourly_open, average_price,
                hourly_min, hourly_max, open_flops, average_flops, total_change
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        this.insertBinanceMinuteStmt = this.db.prepare(`
            INSERT INTO binance_prices_minute (
                timestamp, symbol, price
            ) VALUES (?, ?, ?)
        `);

        this.upsertSyncStateStmt = this.db.prepare(`
            INSERT OR REPLACE INTO sync_state (
                file_path, last_byte_position, last_sync_timestamp
            ) VALUES (?, ?, ?)
        `);

        this.insertConfirmedWinnerStmt = this.db.prepare(`
            INSERT OR REPLACE INTO confirmed_winners (
                period_id, market, clob_token_id_up, clob_token_id_down,
                winning_side, coin_open_price, coin_close_price,
                polymarket_confirmed, coin_price_confirmed, pmarket_convergence_confirmed,
                mismatch_detected, verified_at, notes
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        this.getConfirmedWinnerStmt = this.db.prepare(`
            SELECT * FROM confirmed_winners WHERE period_id = ?
        `);
    }

    /**
     * Get the singleton instance.
     */
    public static getInstance(dbPath?: string): TradingDatabase {
        if (!TradingDatabase.instance) {
            TradingDatabase.instance = new TradingDatabase(dbPath ?? process.env.DB_PATH ?? DEFAULT_DB_PATH);
        }
        return TradingDatabase.instance;
    }

    /**
     * Close the database connection.
     */
    public close(): void {
        if (this.db) {
            this.db.close();
        }
        TradingDatabase.instance = null;
    }

    /**
     * Get raw database for advanced operations.
     */
    public getDb(): Database.Database {
        return this.db;
    }

    // =========================================================================
    // Insert Methods (sync writes)
    // =========================================================================

    /**
     * Insert a trade audit record.
     */
    public insertTradeAudit(trade: TradeAuditRecord): void {
        this.insertTradeStmt.run(
            trade.timestamp,
            trade.strategy,
            trade.tradeId,
            trade.status,
            trade.entryTimestamp,
            trade.size,
            trade.buyPrice,
            trade.sellPrice,
            trade.gross,
            trade.pnl,
            trade.mode,
            trade.marketHash,
            trade.side
        );
    }

    /**
     * Insert a bot log record.
     */
    public insertBotLog(log: BotLogRecord): void {
        this.insertBotLogStmt.run(
            log.timestamp,
            log.level,
            log.source,
            log.message,
            log.orderId ?? null,
            log.orderSide ?? null,
            log.orderAmount ?? null,
            log.orderPrice ?? null
        );
    }

    /**
     * Insert a Polymarket price record.
     */
    public insertPmarketPrice(price: PmarketPriceRecord): void {
        this.insertPmarketPriceStmt.run(
            price.timestamp,
            price.market,
            price.upBid,
            price.upAsk,
            price.downBid ?? null,
            price.downAsk ?? null
        );
    }

    /**
     * Insert a Binance hourly price record.
     */
    public insertBinanceHourly(record: BinancePriceHourlyRecord): void {
        this.insertBinanceHourlyStmt.run(
            record.timestamp,
            record.symbol,
            record.hourlyOpen,
            record.averagePrice,
            record.hourlyMin,
            record.hourlyMax,
            record.openFlops ?? null,
            record.averageFlops ?? null,
            record.totalChange ?? null
        );
    }

    /**
     * Insert a Binance minute price record.
     */
    public insertBinanceMinute(record: BinancePriceMinuteRecord): void {
        this.insertBinanceMinuteStmt.run(
            record.timestamp,
            record.symbol,
            record.price
        );
    }

    /**
     * Batch insert trade audits within a transaction for performance.
     */
    public insertTradeAuditBatch(trades: TradeAuditRecord[]): void {
        const insertMany = this.db.transaction((items: TradeAuditRecord[]) => {
            for (const trade of items) {
                this.insertTradeStmt.run(
                    trade.timestamp,
                    trade.strategy,
                    trade.tradeId,
                    trade.status,
                    trade.entryTimestamp,
                    trade.size,
                    trade.buyPrice,
                    trade.sellPrice,
                    trade.gross,
                    trade.pnl,
                    trade.mode,
                    trade.marketHash,
                    trade.side
                );
            }
        });
        insertMany(trades);
    }

    /**
     * Batch insert bot logs within a transaction.
     */
    public insertBotLogBatch(logs: BotLogRecord[]): void {
        const insertMany = this.db.transaction((items: BotLogRecord[]) => {
            for (const log of items) {
                this.insertBotLogStmt.run(
                    log.timestamp,
                    log.level,
                    log.source,
                    log.message,
                    log.orderId ?? null,
                    log.orderSide ?? null,
                    log.orderAmount ?? null,
                    log.orderPrice ?? null
                );
            }
        });
        insertMany(logs);
    }

    /**
     * Batch insert Polymarket prices within a transaction.
     */
    public insertPmarketPriceBatch(prices: PmarketPriceRecord[]): void {
        const insertMany = this.db.transaction((items: PmarketPriceRecord[]) => {
            for (const price of items) {
                this.insertPmarketPriceStmt.run(
                    price.timestamp,
                    price.market,
                    price.upBid,
                    price.upAsk,
                    price.downBid ?? null,
                    price.downAsk ?? null
                );
            }
        });
        insertMany(prices);
    }

    /**
     * Batch insert Binance hourly records within a transaction.
     */
    public insertBinanceHourlyBatch(records: BinancePriceHourlyRecord[]): void {
        const insertMany = this.db.transaction((items: BinancePriceHourlyRecord[]) => {
            for (const record of items) {
                this.insertBinanceHourlyStmt.run(
                    record.timestamp,
                    record.symbol,
                    record.hourlyOpen,
                    record.averagePrice,
                    record.hourlyMin,
                    record.hourlyMax,
                    record.openFlops ?? null,
                    record.averageFlops ?? null,
                    record.totalChange ?? null
                );
            }
        });
        insertMany(records);
    }

    /**
     * Batch insert Binance minute records within a transaction.
     */
    public insertBinanceMinuteBatch(records: BinancePriceMinuteRecord[]): void {
        const insertMany = this.db.transaction((items: BinancePriceMinuteRecord[]) => {
            for (const record of items) {
                this.insertBinanceMinuteStmt.run(
                    record.timestamp,
                    record.symbol,
                    record.price
                );
            }
        });
        insertMany(records);
    }

    // =========================================================================
    // Query Methods
    // =========================================================================

    /**
     * Query trades with optional filters.
     */
    public queryTrades(filters: TradeQueryFilters = {}): TradeAuditRecord[] {
        const conditions: string[] = [];
        const params: (string | number)[] = [];

        if (filters.startTime != null) {
            conditions.push('timestamp >= ?');
            params.push(filters.startTime);
        }
        if (filters.endTime != null) {
            conditions.push('timestamp <= ?');
            params.push(filters.endTime);
        }
        if (filters.mode && filters.mode !== 'all') {
            if (filters.mode === 'PROD') {
                conditions.push("(mode = 'PROD' OR mode = 'ORDER')");
            } else {
                conditions.push('mode = ?');
                params.push(filters.mode);
            }
        }
        if (filters.strategy) {
            conditions.push('strategy = ?');
            params.push(filters.strategy);
        }
        if (filters.status) {
            conditions.push('status = ?');
            params.push(filters.status);
        }
        if (filters.side) {
            conditions.push('side = ?');
            params.push(filters.side);
        }

        let sql = 'SELECT * FROM trade_audits';
        if (conditions.length > 0) {
            sql += ' WHERE ' + conditions.join(' AND ');
        }
        sql += ' ORDER BY timestamp DESC';

        if (filters.limit) {
            sql += ' LIMIT ?';
            params.push(filters.limit);
        }
        if (filters.offset) {
            sql += ' OFFSET ?';
            params.push(filters.offset);
        }

        const rows = this.db.prepare(sql).all(...params) as {
            id: number;
            timestamp: number;
            strategy: string;
            trade_id: string;
            status: string;
            entry_timestamp: number;
            size: number;
            buy_price: number | null;
            sell_price: number | null;
            gross: number;
            pnl: number;
            mode: string;
            market_hash: string;
            side: string;
        }[];

        return rows.map(row => ({
            id: row.id,
            timestamp: row.timestamp,
            strategy: row.strategy,
            tradeId: row.trade_id,
            status: row.status,
            entryTimestamp: row.entry_timestamp,
            size: row.size,
            buyPrice: row.buy_price,
            sellPrice: row.sell_price,
            gross: row.gross,
            pnl: row.pnl,
            mode: row.mode,
            marketHash: row.market_hash,
            side: row.side,
        }));
    }

    /**
     * Get aggregated stats for trades.
     */
    public getStats(filters: TradeQueryFilters = {}): StatsResult {
        const conditions: string[] = [];
        const params: (string | number)[] = [];

        if (filters.startTime != null) {
            conditions.push('timestamp >= ?');
            params.push(filters.startTime);
        }
        if (filters.endTime != null) {
            conditions.push('timestamp <= ?');
            params.push(filters.endTime);
        }
        if (filters.mode && filters.mode !== 'all') {
            if (filters.mode === 'PROD') {
                conditions.push("(mode = 'PROD' OR mode = 'ORDER')");
            } else {
                conditions.push('mode = ?');
                params.push(filters.mode);
            }
        }
        if (filters.strategy) {
            conditions.push('strategy = ?');
            params.push(filters.strategy);
        }

        let whereClause = '';
        if (conditions.length > 0) {
            whereClause = ' WHERE ' + conditions.join(' AND ');
        }

        const sql = `
            SELECT
                COUNT(*) as total_trades,
                SUM(CASE WHEN status = 'MATCHED' THEN 1 ELSE 0 END) as sold_trades,
                SUM(CASE WHEN status = 'EXPIRED' THEN 1 ELSE 0 END) as expired_trades,
                SUM(CASE WHEN status IN ('MATCHED', 'EXPIRED') THEN pnl ELSE 0 END) as total_pnl,
                SUM(CASE WHEN status IN ('MATCHED', 'EXPIRED') AND pnl > 0 THEN 1 ELSE 0 END) as winning_trades,
                SUM(CASE WHEN status IN ('MATCHED', 'EXPIRED') AND pnl <= 0 THEN 1 ELSE 0 END) as losing_trades,
                SUM(CASE WHEN status IN ('MATCHED', 'EXPIRED') THEN 1 ELSE 0 END) as completed_trades
            FROM trade_audits${whereClause}
        `;

        const row = this.db.prepare(sql).get(...params) as {
            total_trades: number;
            sold_trades: number;
            expired_trades: number;
            total_pnl: number;
            winning_trades: number;
            losing_trades: number;
            completed_trades: number;
        };

        const completedTrades = row.completed_trades || 0;
        const winningTrades = row.winning_trades || 0;

        return {
            totalTrades: row.total_trades || 0,
            soldTrades: row.sold_trades || 0,
            expiredTrades: row.expired_trades || 0,
            totalPnl: row.total_pnl || 0,
            winRate: completedTrades > 0 ? (winningTrades / completedTrades) * 100 : 0,
            avgPnl: completedTrades > 0 ? (row.total_pnl || 0) / completedTrades : 0,
            winningTrades: winningTrades,
            losingTrades: row.losing_trades || 0,
        };
    }

    /**
     * Get PnL grouped by strategy.
     */
    public getPnlByStrategy(filters: TradeQueryFilters = {}): StrategyPnlResult[] {
        const conditions: string[] = ["status IN ('MATCHED', 'EXPIRED')"];
        const params: (string | number)[] = [];

        if (filters.startTime != null) {
            conditions.push('timestamp >= ?');
            params.push(filters.startTime);
        }
        if (filters.endTime != null) {
            conditions.push('timestamp <= ?');
            params.push(filters.endTime);
        }
        if (filters.mode && filters.mode !== 'all') {
            if (filters.mode === 'PROD') {
                conditions.push("(mode = 'PROD' OR mode = 'ORDER')");
            } else {
                conditions.push('mode = ?');
                params.push(filters.mode);
            }
        }

        const sql = `
            SELECT
                strategy,
                SUM(pnl) as pnl,
                COUNT(*) as trades,
                SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
                SUM(CASE WHEN pnl <= 0 THEN 1 ELSE 0 END) as losses
            FROM trade_audits
            WHERE ${conditions.join(' AND ')}
            GROUP BY strategy
            ORDER BY pnl DESC
        `;

        const rows = this.db.prepare(sql).all(...params) as {
            strategy: string;
            pnl: number;
            trades: number;
            wins: number;
            losses: number;
        }[];

        return rows.map(row => ({
            strategy: row.strategy,
            pnl: row.pnl,
            trades: row.trades,
            wins: row.wins,
            losses: row.losses,
            winRate: row.trades > 0 ? (row.wins / row.trades) * 100 : 0,
        }));
    }

    /**
     * Get cumulative PnL over time.
     */
    public getCumulativePnL(filters: TradeQueryFilters = {}): CumulativePnlPoint[] {
        const conditions: string[] = ["status IN ('MATCHED', 'EXPIRED')"];
        const params: (string | number)[] = [];

        if (filters.startTime != null) {
            conditions.push('timestamp >= ?');
            params.push(filters.startTime);
        }
        if (filters.endTime != null) {
            conditions.push('timestamp <= ?');
            params.push(filters.endTime);
        }
        if (filters.mode && filters.mode !== 'all') {
            if (filters.mode === 'PROD') {
                conditions.push("(mode = 'PROD' OR mode = 'ORDER')");
            } else {
                conditions.push('mode = ?');
                params.push(filters.mode);
            }
        }
        if (filters.strategy) {
            conditions.push('strategy = ?');
            params.push(filters.strategy);
        }

        const sql = `
            SELECT
                timestamp,
                pnl,
                SUM(pnl) OVER (ORDER BY timestamp ROWS UNBOUNDED PRECEDING) as cumulative,
                strategy,
                status
            FROM trade_audits
            WHERE ${conditions.join(' AND ')}
            ORDER BY timestamp ASC
        `;

        const rows = this.db.prepare(sql).all(...params) as {
            timestamp: number;
            pnl: number;
            cumulative: number;
            strategy: string;
            status: string;
        }[];

        return rows.map(row => ({
            timestamp: row.timestamp,
            pnl: row.pnl,
            cumulative: row.cumulative,
            strategy: row.strategy,
            status: row.status,
        }));
    }

    /**
     * Get bot logs with optional filters.
     */
    public queryBotLogs(options: {
        source?: string;
        level?: string;
        startTime?: number;
        limit?: number;
    } = {}): BotLogRecord[] {
        const conditions: string[] = [];
        const params: (string | number)[] = [];

        if (options.source) {
            conditions.push('source = ?');
            params.push(options.source);
        }
        if (options.level) {
            conditions.push('level = ?');
            params.push(options.level);
        }
        if (options.startTime) {
            conditions.push('timestamp >= ?');
            params.push(options.startTime);
        }

        let sql = 'SELECT * FROM bot_logs';
        if (conditions.length > 0) {
            sql += ' WHERE ' + conditions.join(' AND ');
        }
        sql += ' ORDER BY timestamp DESC';
        if (options.limit) {
            sql += ' LIMIT ?';
            params.push(options.limit);
        }

        const rows = this.db.prepare(sql).all(...params) as {
            id: number;
            timestamp: number;
            level: string;
            source: string;
            message: string;
            order_id: string | null;
            order_side: string | null;
            order_amount: number | null;
            order_price: number | null;
        }[];

        return rows.map(row => ({
            id: row.id,
            timestamp: row.timestamp,
            level: row.level,
            source: row.source,
            message: row.message,
            orderId: row.order_id,
            orderSide: row.order_side,
            orderAmount: row.order_amount,
            orderPrice: row.order_price,
        }));
    }

    /**
     * Get list of unique strategies.
     */
    public getStrategies(filters: TradeQueryFilters = {}): string[] {
        const conditions: string[] = [];
        const params: (string | number)[] = [];

        if (filters.startTime != null) {
            conditions.push('timestamp >= ?');
            params.push(filters.startTime);
        }
        if (filters.endTime != null) {
            conditions.push('timestamp <= ?');
            params.push(filters.endTime);
        }
        if (filters.mode && filters.mode !== 'all') {
            if (filters.mode === 'PROD') {
                conditions.push("(mode = 'PROD' OR mode = 'ORDER')");
            } else {
                conditions.push('mode = ?');
                params.push(filters.mode);
            }
        }

        let sql = 'SELECT DISTINCT strategy FROM trade_audits';
        if (conditions.length > 0) {
            sql += ' WHERE ' + conditions.join(' AND ');
        }
        sql += ' ORDER BY strategy';

        const rows = this.db.prepare(sql).all(...params) as { strategy: string }[];
        return rows.map(row => row.strategy);
    }

    /**
     * Get list of unique bot sources.
     */
    public getBotSources(): string[] {
        const sql = 'SELECT DISTINCT source FROM bot_logs ORDER BY source';
        const rows = this.db.prepare(sql).all() as { source: string }[];
        return rows.map(row => row.source);
    }

    // =========================================================================
    // Sync State Methods
    // =========================================================================

    /**
     * Get sync state for a file.
     */
    public getSyncState(filePath: string): SyncStateRecord | null {
        const sql = 'SELECT * FROM sync_state WHERE file_path = ?';
        const row = this.db.prepare(sql).get(filePath) as {
            file_path: string;
            last_byte_position: number;
            last_sync_timestamp: number;
        } | undefined;

        if (!row) return null;

        return {
            filePath: row.file_path,
            lastBytePosition: row.last_byte_position,
            lastSyncTimestamp: row.last_sync_timestamp,
        };
    }

    /**
     * Update sync state for a file.
     */
    public updateSyncState(state: SyncStateRecord): void {
        this.upsertSyncStateStmt.run(
            state.filePath,
            state.lastBytePosition,
            state.lastSyncTimestamp
        );
    }

    /**
     * Get trade count for verification.
     */
    public getTradeCount(): number {
        const row = this.db.prepare('SELECT COUNT(*) as count FROM trade_audits').get() as { count: number };
        return row.count;
    }

    // =========================================================================
    // P-Market Price Query Methods
    // =========================================================================

    /**
     * Query p-market prices for a time range.
     */
    public queryPmarketPrices(market: string, startTime: number, endTime: number): PmarketPriceRecord[] {
        const sql = `
            SELECT * FROM pmarket_prices
            WHERE market = ? AND timestamp >= ? AND timestamp <= ?
            ORDER BY timestamp ASC
        `;
        const rows = this.db.prepare(sql).all(market, startTime, endTime) as {
            id: number;
            timestamp: number;
            market: string;
            up_bid: number;
            up_ask: number;
            down_bid: number | null;
            down_ask: number | null;
        }[];

        return rows.map(row => ({
            id: row.id,
            timestamp: row.timestamp,
            market: row.market,
            upBid: row.up_bid,
            upAsk: row.up_ask,
            downBid: row.down_bid,
            downAsk: row.down_ask,
        }));
    }

    // =========================================================================
    // Binance Hourly Query Methods
    // =========================================================================

    /**
     * Query Binance hourly prices for a symbol and time range.
     */
    public queryBinanceHourly(symbol: string, startTime: number, endTime: number): BinancePriceHourlyRecord[] {
        const sql = `
            SELECT * FROM binance_prices_hourly
            WHERE symbol = ? AND timestamp >= ? AND timestamp <= ?
            ORDER BY timestamp ASC
        `;
        const rows = this.db.prepare(sql).all(symbol, startTime, endTime) as {
            id: number;
            timestamp: number;
            symbol: string;
            hourly_open: number;
            average_price: number;
            hourly_min: number;
            hourly_max: number;
            open_flops: number | null;
            average_flops: number | null;
            total_change: number | null;
        }[];

        return rows.map(row => ({
            id: row.id,
            timestamp: row.timestamp,
            symbol: row.symbol,
            hourlyOpen: row.hourly_open,
            averagePrice: row.average_price,
            hourlyMin: row.hourly_min,
            hourlyMax: row.hourly_max,
            openFlops: row.open_flops,
            averageFlops: row.average_flops,
            totalChange: row.total_change,
        }));
    }

    // =========================================================================
    // Confirmed Winners Methods
    // =========================================================================

    /**
     * Insert or update a confirmed winner record.
     */
    public insertConfirmedWinner(winner: ConfirmedWinnerRecord): void {
        this.insertConfirmedWinnerStmt.run(
            winner.periodId,
            winner.market,
            winner.clobTokenIdUp,
            winner.clobTokenIdDown,
            winner.winningSide,
            winner.coinOpenPrice,
            winner.coinClosePrice,
            winner.polymarketConfirmed ? 1 : 0,
            winner.coinPriceConfirmed ? 1 : 0,
            winner.pmarketConvergenceConfirmed ? 1 : 0,
            winner.mismatchDetected ? 1 : 0,
            winner.verifiedAt,
            winner.notes
        );
    }

    /**
     * Get a confirmed winner by period ID.
     */
    public getConfirmedWinner(periodId: string): ConfirmedWinnerRecord | null {
        const row = this.getConfirmedWinnerStmt.get(periodId) as {
            id: number;
            period_id: string;
            market: string;
            clob_token_id_up: string;
            clob_token_id_down: string;
            winning_side: string;
            coin_open_price: number | null;
            coin_close_price: number | null;
            polymarket_confirmed: number;
            coin_price_confirmed: number;
            pmarket_convergence_confirmed: number;
            mismatch_detected: number;
            verified_at: number;
            notes: string | null;
        } | undefined;

        if (!row) return null;

        return {
            id: row.id,
            periodId: row.period_id,
            market: row.market,
            clobTokenIdUp: row.clob_token_id_up,
            clobTokenIdDown: row.clob_token_id_down,
            winningSide: row.winning_side as 'UP' | 'DOWN',
            coinOpenPrice: row.coin_open_price,
            coinClosePrice: row.coin_close_price,
            polymarketConfirmed: row.polymarket_confirmed === 1,
            coinPriceConfirmed: row.coin_price_confirmed === 1,
            pmarketConvergenceConfirmed: row.pmarket_convergence_confirmed === 1,
            mismatchDetected: row.mismatch_detected === 1,
            verifiedAt: row.verified_at,
            notes: row.notes,
        };
    }

    /**
     * Get all confirmed winners.
     */
    public getAllConfirmedWinners(): ConfirmedWinnerRecord[] {
        const sql = 'SELECT * FROM confirmed_winners ORDER BY verified_at DESC';
        const rows = this.db.prepare(sql).all() as {
            id: number;
            period_id: string;
            market: string;
            clob_token_id_up: string;
            clob_token_id_down: string;
            winning_side: string;
            coin_open_price: number | null;
            coin_close_price: number | null;
            polymarket_confirmed: number;
            coin_price_confirmed: number;
            pmarket_convergence_confirmed: number;
            mismatch_detected: number;
            verified_at: number;
            notes: string | null;
        }[];

        return rows.map(row => ({
            id: row.id,
            periodId: row.period_id,
            market: row.market,
            clobTokenIdUp: row.clob_token_id_up,
            clobTokenIdDown: row.clob_token_id_down,
            winningSide: row.winning_side as 'UP' | 'DOWN',
            coinOpenPrice: row.coin_open_price,
            coinClosePrice: row.coin_close_price,
            polymarketConfirmed: row.polymarket_confirmed === 1,
            coinPriceConfirmed: row.coin_price_confirmed === 1,
            pmarketConvergenceConfirmed: row.pmarket_convergence_confirmed === 1,
            mismatchDetected: row.mismatch_detected === 1,
            verifiedAt: row.verified_at,
            notes: row.notes,
        }));
    }

    /**
     * Update trade audit PnL and gross by market hash for expiry trades.
     */
    public updateTradeAuditByMarketHash(
        marketHash: string,
        newPnl: number,
        newGross: number
    ): number {
        const sql = `
            UPDATE trade_audits
            SET pnl = ?, gross = ?, status = 'EXPIRED'
            WHERE market_hash = ? AND trade_id LIKE '%expiry%'
        `;
        const result = this.db.prepare(sql).run(newPnl, newGross, marketHash);
        return result.changes;
    }
}
