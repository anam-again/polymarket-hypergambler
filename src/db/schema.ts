/**
 * Database schema definitions and migrations for SQLite.
 */
import Database from 'better-sqlite3';

/**
 * Creates all tables and indexes if they don't exist.
 */
export function initializeSchema(db: Database.Database): void {
    // Enable WAL mode for better concurrent access
    db.pragma('journal_mode = WAL');

    // Core trade audit table
    db.exec(`
        CREATE TABLE IF NOT EXISTS trade_audits (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp INTEGER NOT NULL,
            strategy TEXT NOT NULL,
            trade_id TEXT NOT NULL UNIQUE,
            status TEXT NOT NULL,
            entry_timestamp INTEGER NOT NULL,
            size REAL NOT NULL,
            buy_price REAL,
            sell_price REAL,
            gross REAL NOT NULL,
            pnl REAL NOT NULL,
            mode TEXT NOT NULL,
            market_hash TEXT NOT NULL,
            side TEXT NOT NULL
        )
    `);

    db.exec(`CREATE INDEX IF NOT EXISTS idx_trades_timestamp ON trade_audits(timestamp)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_trades_strategy ON trade_audits(strategy)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_trades_mode_time ON trade_audits(mode, entry_timestamp)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_trades_status ON trade_audits(status)`);

    // Bot activity logs
    db.exec(`
        CREATE TABLE IF NOT EXISTS bot_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp INTEGER NOT NULL,
            level TEXT NOT NULL,
            source TEXT NOT NULL,
            message TEXT NOT NULL,
            order_id TEXT,
            order_side TEXT,
            order_amount REAL,
            order_price REAL
        )
    `);

    db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON bot_logs(timestamp)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_source ON bot_logs(source)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_level ON bot_logs(level)`);

    // Market prices (Polymarket)
    db.exec(`
        CREATE TABLE IF NOT EXISTS pmarket_prices (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp INTEGER NOT NULL,
            market TEXT NOT NULL,
            up_bid REAL NOT NULL,
            up_ask REAL NOT NULL,
            down_bid REAL,
            down_ask REAL
        )
    `);

    db.exec(`CREATE INDEX IF NOT EXISTS idx_pmarket_lookup ON pmarket_prices(market, timestamp)`);

    // Binance market data (hourly)
    db.exec(`
        CREATE TABLE IF NOT EXISTS binance_prices_hourly (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp INTEGER NOT NULL,
            symbol TEXT NOT NULL,
            hourly_open REAL NOT NULL,
            average_price REAL NOT NULL,
            hourly_min REAL NOT NULL,
            hourly_max REAL NOT NULL,
            open_flops INTEGER,
            average_flops INTEGER,
            total_change REAL
        )
    `);

    db.exec(`CREATE INDEX IF NOT EXISTS idx_binance_hourly_lookup ON binance_prices_hourly(symbol, timestamp)`);

    // Binance market data (minute)
    db.exec(`
        CREATE TABLE IF NOT EXISTS binance_prices_minute (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp INTEGER NOT NULL,
            symbol TEXT NOT NULL,
            price REAL NOT NULL
        )
    `);

    db.exec(`CREATE INDEX IF NOT EXISTS idx_binance_minute_lookup ON binance_prices_minute(symbol, timestamp)`);

    // Sync tracking for log migrator
    db.exec(`
        CREATE TABLE IF NOT EXISTS sync_state (
            file_path TEXT PRIMARY KEY,
            last_byte_position INTEGER NOT NULL,
            last_sync_timestamp INTEGER NOT NULL
        )
    `);

    // Confirmed winners tracking for RedemptionSolver
    db.exec(`
        CREATE TABLE IF NOT EXISTS confirmed_winners (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            period_id TEXT NOT NULL UNIQUE,
            market TEXT NOT NULL,
            clob_token_id_up TEXT NOT NULL,
            clob_token_id_down TEXT NOT NULL,
            winning_side TEXT NOT NULL,
            coin_open_price REAL,
            coin_close_price REAL,
            polymarket_confirmed INTEGER DEFAULT 0,
            coin_price_confirmed INTEGER DEFAULT 0,
            pmarket_convergence_confirmed INTEGER DEFAULT 0,
            mismatch_detected INTEGER DEFAULT 0,
            verified_at INTEGER NOT NULL,
            notes TEXT
        )
    `);

    db.exec(`CREATE INDEX IF NOT EXISTS idx_confirmed_winners_period ON confirmed_winners(period_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_confirmed_winners_market ON confirmed_winners(market)`);
}

/**
 * Runs any pending migrations.
 * Currently just initializes schema if needed.
 */
export function runMigrations(db: Database.Database): void {
    // Get current schema version
    const versionResult = db.pragma('user_version', { simple: true }) as number;

    if (versionResult < 1) {
        initializeSchema(db);
        db.pragma('user_version = 1');
    }

    // Migration v2: Add confirmed_winners table
    if (versionResult < 2) {
        db.exec(`
            CREATE TABLE IF NOT EXISTS confirmed_winners (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                period_id TEXT NOT NULL UNIQUE,
                market TEXT NOT NULL,
                clob_token_id_up TEXT NOT NULL,
                clob_token_id_down TEXT NOT NULL,
                winning_side TEXT NOT NULL,
                coin_open_price REAL,
                coin_close_price REAL,
                polymarket_confirmed INTEGER DEFAULT 0,
                coin_price_confirmed INTEGER DEFAULT 0,
                pmarket_convergence_confirmed INTEGER DEFAULT 0,
                mismatch_detected INTEGER DEFAULT 0,
                verified_at INTEGER NOT NULL,
                notes TEXT
            )
        `);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_confirmed_winners_period ON confirmed_winners(period_id)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_confirmed_winners_market ON confirmed_winners(market)`);
        db.pragma('user_version = 2');
    }
}
