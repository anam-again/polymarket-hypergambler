/**
 * Database module for the dashboard server.
 * Provides query functions to replace file-based log parsing.
 */
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB_PATH = path.join(__dirname, '../../data/trading.db');

let db = null;

/**
 * Get database connection (creates if needed).
 */
export function getDb() {
    if (!db) {
        const dbPath = process.env.DB_PATH || DEFAULT_DB_PATH;
        db = new Database(dbPath);
        db.pragma('journal_mode = WAL');
    }
    return db;
}

/**
 * Close database connection.
 */
export function closeDb() {
    if (db) {
        db.close();
        db = null;
    }
}

/**
 * Check if database exists and has data.
 */
export function isDatabaseReady() {
    try {
        const database = getDb();
        const row = database.prepare('SELECT COUNT(*) as count FROM trade_audits').get();
        return row && row.count > 0;
    } catch (e) {
        return false;
    }
}

// =============================================================================
// Trade Query Functions
// =============================================================================

/**
 * Build WHERE clause and params from filters.
 */
function buildTradeWhereClause(filters) {
    const conditions = [];
    const params = [];

    if (filters.startTime) {
        conditions.push('timestamp >= ?');
        params.push(filters.startTime);
    }
    if (filters.endTime) {
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

    return {
        where: conditions.length > 0 ? ' WHERE ' + conditions.join(' AND ') : '',
        params
    };
}

/**
 * Get all trades with optional filters.
 */
export function getTrades(filters = {}) {
    const database = getDb();
    const { where, params } = buildTradeWhereClause(filters);

    const sql = `
        SELECT
            id,
            timestamp,
            strategy,
            trade_id as tradeId,
            status,
            entry_timestamp as entryTimestamp,
            size,
            buy_price as buyPrice,
            sell_price as sellPrice,
            gross,
            pnl,
            mode,
            market_hash as marketHash,
            side
        FROM trade_audits
        ${where}
        ORDER BY timestamp DESC
    `;

    return database.prepare(sql).all(...params);
}

/**
 * Get summary statistics.
 */
export function getStats(filters = {}) {
    const database = getDb();
    const { where, params } = buildTradeWhereClause(filters);

    const sql = `
        SELECT
            COUNT(*) as totalTrades,
            SUM(CASE WHEN status = 'MATCHED' THEN 1 ELSE 0 END) as soldTrades,
            SUM(CASE WHEN status = 'EXPIRED' THEN 1 ELSE 0 END) as expiredTrades,
            SUM(CASE WHEN status IN ('MATCHED', 'EXPIRED') THEN pnl ELSE 0 END) as totalPnl,
            SUM(CASE WHEN status IN ('MATCHED', 'EXPIRED') AND pnl > 0 THEN 1 ELSE 0 END) as winningTrades,
            SUM(CASE WHEN status IN ('MATCHED', 'EXPIRED') AND pnl <= 0 THEN 1 ELSE 0 END) as losingTrades,
            SUM(CASE WHEN status IN ('MATCHED', 'EXPIRED') THEN 1 ELSE 0 END) as completedTrades
        FROM trade_audits
        ${where}
    `;

    const row = database.prepare(sql).get(...params);

    const completedTrades = row.completedTrades || 0;
    const winningTrades = row.winningTrades || 0;

    return {
        totalTrades: row.totalTrades || 0,
        soldTrades: row.soldTrades || 0,
        expiredTrades: row.expiredTrades || 0,
        totalPnl: (row.totalPnl || 0).toFixed(2),
        winRate: completedTrades > 0 ? ((winningTrades / completedTrades) * 100).toFixed(1) : 0,
        avgPnl: completedTrades > 0 ? ((row.totalPnl || 0) / completedTrades).toFixed(2) : 0,
        winningTrades: winningTrades,
        losingTrades: row.losingTrades || 0,
    };
}

/**
 * Get PnL grouped by strategy.
 */
export function getPnlByStrategy(filters = {}) {
    const database = getDb();
    const conditions = ["status IN ('MATCHED', 'EXPIRED')"];
    const params = [];

    if (filters.startTime) {
        conditions.push('timestamp >= ?');
        params.push(filters.startTime);
    }
    if (filters.endTime) {
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

    return database.prepare(sql).all(...params).map(row => ({
        strategy: row.strategy,
        pnl: parseFloat((row.pnl ?? 0).toFixed(2)),
        trades: row.trades,
        wins: row.wins,
        losses: row.losses,
        winRate: row.trades > 0 ? ((row.wins / row.trades) * 100).toFixed(1) : '0.0'
    }));
}

/**
 * Downsample an array to a maximum number of points.
 * Uses LTTB (Largest Triangle Three Buckets) inspired sampling to preserve shape.
 */
function downsample(data, maxPoints) {
    if (data.length <= maxPoints) return data;

    const result = [];
    const bucketSize = (data.length - 2) / (maxPoints - 2);

    result.push(data[0]); // Always include first point

    for (let i = 0; i < maxPoints - 2; i++) {
        const bucketStart = Math.floor((i) * bucketSize) + 1;
        const bucketEnd = Math.floor((i + 1) * bucketSize) + 1;

        // Pick the point in this bucket (use middle for simplicity)
        const mid = Math.floor((bucketStart + bucketEnd) / 2);
        if (mid < data.length) {
            result.push(data[mid]);
        }
    }

    result.push(data[data.length - 1]); // Always include last point

    return result;
}

/**
 * Get cumulative PnL over time.
 */
export function getCumulativePnl(filters = {}) {
    const database = getDb();
    const conditions = ["status IN ('MATCHED', 'EXPIRED')"];
    const params = [];

    if (filters.startTime) {
        conditions.push('timestamp >= ?');
        params.push(filters.startTime);
    }
    if (filters.endTime) {
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

    const rows = database.prepare(sql).all(...params).map(row => ({
        timestamp: row.timestamp,
        date: new Date(row.timestamp).toLocaleString(),
        pnl: row.pnl ?? 0,
        cumulative: parseFloat((row.cumulative ?? 0).toFixed(2)),
        strategy: row.strategy,
        status: row.status
    }));

    // Downsample to max 2000 points
    return downsample(rows, 2000);
}

/**
 * Get cumulative PnL with per-strategy breakdown.
 * Downsamples to max 1000 points to prevent massive responses.
 */
export function getCumulativePnlByStrategy(filters = {}) {
    const database = getDb();
    const conditions = ["status IN ('MATCHED', 'EXPIRED')"];
    const params = [];

    if (filters.startTime) {
        conditions.push('timestamp >= ?');
        params.push(filters.startTime);
    }
    if (filters.endTime) {
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

    // Get unique strategies
    const strategySql = `
        SELECT DISTINCT strategy FROM trade_audits
        WHERE ${conditions.join(' AND ')} AND strategy IS NOT NULL
        ORDER BY strategy
    `;
    const strategies = database.prepare(strategySql).all(...params).map(r => r.strategy);

    // Get trades ordered by timestamp
    const sql = `
        SELECT timestamp, pnl, strategy
        FROM trade_audits
        WHERE ${conditions.join(' AND ')} AND strategy IS NOT NULL
        ORDER BY timestamp ASC
    `;
    const trades = database.prepare(sql).all(...params);

    // Extract tags from strategies
    const tagSet = new Set();
    strategies.forEach(s => {
        if (s) {
            s.toLowerCase().split('-').filter(t => t.length > 0).forEach(tag => tagSet.add(tag));
        }
    });
    const tags = [...tagSet].sort();

    // Track cumulative PnL per strategy
    const cumulativeByStrategy = {};
    strategies.forEach(s => { cumulativeByStrategy[s] = 0; });

    // Build chart data points
    const allPoints = trades.filter(t => t.strategy).map(trade => {
        cumulativeByStrategy[trade.strategy] += trade.pnl;

        const total = Object.values(cumulativeByStrategy).reduce((a, b) => a + b, 0);

        return {
            timestamp: trade.timestamp,
            total: parseFloat(total.toFixed(2)),
            // Only store the strategy that changed (not all strategies)
            changedStrategy: trade.strategy,
            changedValue: parseFloat(cumulativeByStrategy[trade.strategy].toFixed(2))
        };
    });

    // Downsample to max 1000 points
    const maxPoints = 1000;
    let sampledPoints;
    if (allPoints.length <= maxPoints) {
        sampledPoints = allPoints;
    } else {
        // Sample evenly, always include first and last
        sampledPoints = [allPoints[0]];
        const step = (allPoints.length - 1) / (maxPoints - 1);
        for (let i = 1; i < maxPoints - 1; i++) {
            sampledPoints.push(allPoints[Math.floor(i * step)]);
        }
        sampledPoints.push(allPoints[allPoints.length - 1]);
    }

    // For sampled points, we need to recalculate full strategy breakdown
    // But only include strategies with non-zero values to reduce payload
    const finalCumulativeByStrategy = {};
    strategies.forEach(s => { finalCumulativeByStrategy[s] = 0; });

    // Recalculate cumulative values at each sampled point
    let tradeIndex = 0;
    const points = sampledPoints.map(sampledPoint => {
        // Process all trades up to this timestamp
        while (tradeIndex < trades.length && trades[tradeIndex].timestamp <= sampledPoint.timestamp) {
            const trade = trades[tradeIndex];
            if (trade.strategy) {
                finalCumulativeByStrategy[trade.strategy] += trade.pnl;
            }
            tradeIndex++;
        }

        // Only include strategies with non-zero values
        const strategyValues = {};
        strategies.forEach(s => {
            const val = finalCumulativeByStrategy[s];
            if (Math.abs(val) > 0.001) {
                strategyValues[s] = parseFloat(val.toFixed(2));
            }
        });

        return {
            timestamp: sampledPoint.timestamp,
            total: sampledPoint.total,
            strategies: strategyValues
        };
    });

    // Add starting point at 0 if we have a time range
    if (filters.startTime && points.length > 0) {
        const startPoint = { timestamp: filters.startTime, total: 0, strategies: {} };
        points.unshift(startPoint);
    }

    return { points, strategies, tags };
}

/**
 * Get trades by side.
 */
export function getTradesBySide(filters = {}) {
    const database = getDb();
    const conditions = ["status IN ('MATCHED', 'EXPIRED')"];
    const params = [];

    if (filters.startTime) {
        conditions.push('timestamp >= ?');
        params.push(filters.startTime);
    }
    if (filters.endTime) {
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
            side,
            COUNT(*) as count,
            SUM(pnl) as pnl
        FROM trade_audits
        WHERE ${conditions.join(' AND ')}
        GROUP BY side
    `;

    return database.prepare(sql).all(...params).map(row => ({
        side: row.side,
        count: row.count,
        pnl: parseFloat((row.pnl ?? 0).toFixed(2))
    }));
}

/**
 * Get list of strategies with tags.
 */
export function getStrategies(filters = {}) {
    const database = getDb();
    const { where, params } = buildTradeWhereClause(filters);

    const sql = `SELECT DISTINCT strategy FROM trade_audits ${where} ORDER BY strategy`;
    const strategies = database.prepare(sql).all(...params).map(r => r.strategy);

    const tagSet = new Set();
    strategies.forEach(s => {
        if (s) {
            s.toLowerCase().split('-').filter(t => t.length > 0).forEach(tag => tagSet.add(tag));
        }
    });

    return {
        strategies,
        tags: [...tagSet].sort()
    };
}

/**
 * Get trades for a specific strategy.
 */
export function getStrategyTrades(strategyName, filters = {}, limit = 500) {
    const database = getDb();
    filters.strategy = strategyName;
    const { where, params } = buildTradeWhereClause(filters);

    const sql = `
        SELECT
            timestamp,
            strategy,
            trade_id as tradeId,
            status,
            entry_timestamp as entryTimestamp,
            size,
            buy_price as buyPrice,
            sell_price as sellPrice,
            gross,
            pnl,
            mode,
            market_hash as marketHash,
            side
        FROM trade_audits
        ${where}
        ORDER BY timestamp DESC
        LIMIT ?
    `;

    return database.prepare(sql).all(...params, limit);
}

/**
 * Get stats for a specific strategy.
 */
export function getStrategyStats(strategyName, filters = {}) {
    const database = getDb();
    filters.strategy = strategyName;
    const { where, params } = buildTradeWhereClause(filters);

    const sql = `
        SELECT
            COUNT(*) as totalTrades,
            SUM(CASE WHEN status = 'MATCHED' THEN 1 ELSE 0 END) as soldTrades,
            SUM(CASE WHEN status = 'EXPIRED' THEN 1 ELSE 0 END) as expiredTrades,
            SUM(CASE WHEN status IN ('MATCHED', 'EXPIRED') THEN pnl ELSE 0 END) as totalPnl,
            SUM(CASE WHEN status IN ('MATCHED', 'EXPIRED') AND pnl > 0 THEN 1 ELSE 0 END) as winningTrades,
            SUM(CASE WHEN status IN ('MATCHED', 'EXPIRED') AND pnl <= 0 THEN 1 ELSE 0 END) as losingTrades,
            SUM(CASE WHEN status IN ('MATCHED', 'EXPIRED') THEN 1 ELSE 0 END) as completedTrades,
            SUM(CASE WHEN status IN ('MATCHED', 'EXPIRED') AND pnl > 0 THEN pnl ELSE 0 END) as totalWins,
            SUM(CASE WHEN status IN ('MATCHED', 'EXPIRED') AND pnl <= 0 THEN pnl ELSE 0 END) as totalLosses,
            MAX(CASE WHEN status IN ('MATCHED', 'EXPIRED') THEN pnl ELSE NULL END) as largestWin,
            MIN(CASE WHEN status IN ('MATCHED', 'EXPIRED') THEN pnl ELSE NULL END) as largestLoss
        FROM trade_audits
        ${where}
    `;

    const row = database.prepare(sql).get(...params);

    const completedTrades = row.completedTrades || 0;
    const winningTrades = row.winningTrades || 0;
    const losingTrades = row.losingTrades || 0;

    return {
        strategy: strategyName,
        totalTrades: row.totalTrades || 0,
        soldTrades: row.soldTrades || 0,
        expiredTrades: row.expiredTrades || 0,
        totalPnl: (row.totalPnl || 0).toFixed(2),
        winRate: completedTrades > 0 ? ((winningTrades / completedTrades) * 100).toFixed(1) : 0,
        avgPnl: completedTrades > 0 ? ((row.totalPnl || 0) / completedTrades).toFixed(2) : 0,
        avgWin: winningTrades > 0 ? ((row.totalWins || 0) / winningTrades).toFixed(2) : 0,
        avgLoss: losingTrades > 0 ? ((row.totalLosses || 0) / losingTrades).toFixed(2) : 0,
        winningTrades,
        losingTrades,
        largestWin: row.largestWin ? row.largestWin.toFixed(2) : 0,
        largestLoss: row.largestLoss ? row.largestLoss.toFixed(2) : 0
    };
}

/**
 * Get PnL distribution for a strategy.
 */
export function getStrategyPnlDistribution(strategyName, filters = {}) {
    const database = getDb();
    filters.strategy = strategyName;
    const conditions = ["status IN ('MATCHED', 'EXPIRED')"];
    const params = [];

    if (filters.startTime) {
        conditions.push('timestamp >= ?');
        params.push(filters.startTime);
    }
    if (filters.endTime) {
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
    conditions.push('strategy = ?');
    params.push(strategyName);

    const sql = `
        SELECT CAST(pnl AS INTEGER) as bucket, COUNT(*) as count
        FROM trade_audits
        WHERE ${conditions.join(' AND ')}
        GROUP BY bucket
        ORDER BY bucket ASC
    `;

    return database.prepare(sql).all(...params).map(row => ({
        pnl: row.bucket,
        count: row.count
    }));
}

// =============================================================================
// Bot Log Query Functions
// =============================================================================

/**
 * Get live logs from bot_logs table.
 */
export function getLiveLogs(options = {}) {
    const database = getDb();
    const conditions = [];
    const params = [];

    if (options.mode === 'PROD') {
        conditions.push("source LIKE 'prod-%'");
    } else if (options.mode === 'TEST') {
        conditions.push("source NOT LIKE 'prod-%'");
    }

    if (options.source) {
        conditions.push('source = ?');
        params.push(options.source);
    }

    const limit = options.limit || 50;

    let sql = `
        SELECT
            id,
            timestamp,
            level,
            source,
            message,
            order_id as orderId,
            order_side as orderSide,
            order_amount as orderAmount,
            order_price as orderPrice
        FROM bot_logs
    `;

    if (conditions.length > 0) {
        sql += ' WHERE ' + conditions.join(' AND ');
    }

    sql += ' ORDER BY timestamp DESC LIMIT ?';
    params.push(limit);

    return database.prepare(sql).all(...params).map(row => ({
        level: row.level,
        timestamp: row.timestamp,
        timestampStr: new Date(row.timestamp).toISOString(),
        message: row.message,
        source: row.source
    }));
}

/**
 * Get list of bot log sources.
 */
export function getLogSources(mode) {
    const database = getDb();
    let sql = 'SELECT DISTINCT source FROM bot_logs';

    if (mode === 'PROD') {
        sql += " WHERE source LIKE 'prod-%'";
    } else if (mode === 'TEST') {
        sql += " WHERE source NOT LIKE 'prod-%'";
    }

    sql += ' ORDER BY source';

    return database.prepare(sql).all().map(r => r.source.replace(/\.(log)?$/, ''));
}

/**
 * Get logs for a specific source.
 */
export function getLogsBySource(source, limit = 100) {
    const database = getDb();

    const sql = `
        SELECT
            timestamp,
            level,
            source,
            message
        FROM bot_logs
        WHERE source = ?
        ORDER BY timestamp DESC
        LIMIT ?
    `;

    return database.prepare(sql).all(source, limit).map(row => ({
        level: row.level,
        timestamp: row.timestamp,
        timestampStr: new Date(row.timestamp).toISOString(),
        message: row.message,
        source: row.source
    }));
}

// ============================================================================
// Pipeline Database Functions
// ============================================================================

/**
 * Check if pipeline tables exist.
 */
export function hasPipelineTables() {
    try {
        const database = getDb();
        const result = database.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='bot_lifecycle'"
        ).get();
        return !!result;
    } catch {
        return false;
    }
}

/**
 * Get all bots from bot_lifecycle table.
 */
export function getPipelineBots(state = null) {
    try {
        const database = getDb();
        if (!hasPipelineTables()) return [];

        let sql = `SELECT
            id, bot_id as botId, strategy, market, state,
            yaml_path as yamlPath, params_json as paramsJson,
            sim_pnl as simPnl, sim_sharpe as simSharpe, sim_sortino as simSortino,
            sim_calmar as simCalmar, sim_win_rate as simWinRate,
            sim_max_drawdown as simMaxDrawdown, sim_total_trades as simTotalTrades,
            sim_timestamp as simTimestamp,
            test_start_timestamp as testStartTimestamp, test_pnl as testPnl,
            test_win_rate as testWinRate, test_trade_count as testTradeCount,
            test_sharpe as testSharpe, test_evaluated_at as testEvaluatedAt,
            prod_start_timestamp as prodStartTimestamp, prod_pnl as prodPnl,
            prod_win_rate as prodWinRate, prod_trade_count as prodTradeCount,
            prod_last_checked as prodLastChecked,
            created_at as createdAt, updated_at as updatedAt,
            retired_at as retiredAt, retire_reason as retireReason,
            promoted_by as promotedBy, demoted_from as demotedFrom
        FROM bot_lifecycle`;
        const params = [];
        if (state) {
            sql += ' WHERE state = ?';
            params.push(state);
        }
        sql += ' ORDER BY updated_at DESC';

        return database.prepare(sql).all(...params);
    } catch (e) {
        console.error('Error in getPipelineBots:', e);
        return [];
    }
}

/**
 * Get a single bot by ID.
 */
export function getPipelineBot(botId) {
    try {
        const database = getDb();
        if (!hasPipelineTables()) return null;
        return database.prepare(`SELECT
            id, bot_id as botId, strategy, market, state,
            yaml_path as yamlPath, params_json as paramsJson,
            sim_pnl as simPnl, sim_sharpe as simSharpe, sim_sortino as simSortino,
            sim_calmar as simCalmar, sim_win_rate as simWinRate,
            sim_max_drawdown as simMaxDrawdown, sim_total_trades as simTotalTrades,
            sim_timestamp as simTimestamp,
            test_start_timestamp as testStartTimestamp, test_pnl as testPnl,
            test_win_rate as testWinRate, test_trade_count as testTradeCount,
            test_sharpe as testSharpe, test_evaluated_at as testEvaluatedAt,
            prod_start_timestamp as prodStartTimestamp, prod_pnl as prodPnl,
            prod_win_rate as prodWinRate, prod_trade_count as prodTradeCount,
            prod_last_checked as prodLastChecked,
            created_at as createdAt, updated_at as updatedAt,
            retired_at as retiredAt, retire_reason as retireReason,
            promoted_by as promotedBy, demoted_from as demotedFrom
        FROM bot_lifecycle WHERE bot_id = ?`).get(botId);
    } catch (e) {
        console.error('Error in getPipelineBot:', e);
        return null;
    }
}

/**
 * Get pipeline events (audit trail).
 */
export function getPipelineEvents(limit = 100) {
    try {
        const database = getDb();
        if (!hasPipelineTables()) return [];
        return database.prepare(`SELECT
            id, timestamp, stage_name as stageName,
            event_type as eventType, bot_id as botId,
            details_json as detailsJson, severity
        FROM pipeline_events ORDER BY timestamp DESC LIMIT ?`).all(limit);
    } catch (e) {
        console.error('Error in getPipelineEvents:', e);
        return [];
    }
}

/**
 * Get pipeline stage status.
 */
export function getPipelineStages() {
    try {
        const database = getDb();
        if (!hasPipelineTables()) return [];
        return database.prepare(`SELECT
            id, stage_name as stageName,
            last_run_timestamp as lastRunTimestamp,
            next_scheduled_run as nextScheduledRun,
            status, last_error as lastError,
            run_count as runCount,
            last_run_duration_ms as lastRunDurationMs,
            config_json as configJson
        FROM pipeline_state ORDER BY stage_name`).all();
    } catch (e) {
        console.error('Error in getPipelineStages:', e);
        return [];
    }
}

/**
 * Get live metrics for a bot from trade_audits.
 * This calculates real-time PnL, win rate, and trade count.
 */
export function getBotLiveMetrics(botId, sinceTimestamp = 0) {
    try {
        const database = getDb();
        const row = database.prepare(`
            SELECT
                COALESCE(SUM(pnl), 0) as totalPnl,
                COUNT(*) as tradeCount,
                SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins
            FROM trade_audits
            WHERE strategy = ? AND timestamp >= ? AND status IN ('MATCHED', 'EXPIRED')
        `).get(botId, sinceTimestamp);

        const tradeCount = row?.tradeCount || 0;
        const wins = row?.wins || 0;

        return {
            pnl: row?.totalPnl || 0,
            tradeCount,
            winRate: tradeCount > 0 ? (wins / tradeCount) * 100 : 0,
        };
    } catch (e) {
        console.error('Error in getBotLiveMetrics:', e);
        return { pnl: 0, tradeCount: 0, winRate: 0 };
    }
}

/**
 * Get live metrics for all running bots (TEST_RUNNING and PROD_RUNNING).
 */
export function getAllRunningBotsLiveMetrics() {
    try {
        const database = getDb();
        if (!hasPipelineTables()) return {};

        const runningBots = database.prepare(`
            SELECT bot_id as botId, state, test_start_timestamp as testStartTimestamp, prod_start_timestamp as prodStartTimestamp
            FROM bot_lifecycle
            WHERE state IN ('TEST_RUNNING', 'PROD_RUNNING')
        `).all();

        const metrics = {};
        for (const bot of runningBots) {
            const sinceTimestamp = bot.state === 'PROD_RUNNING'
                ? (bot.prodStartTimestamp || 0)
                : (bot.testStartTimestamp || 0);
            metrics[bot.botId] = getBotLiveMetrics(bot.botId, sinceTimestamp);
        }

        return metrics;
    } catch (e) {
        console.error('Error in getAllRunningBotsLiveMetrics:', e);
        return {};
    }
}

/**
 * Get pipeline summary statistics.
 */
export function getPipelineSummary() {
    try {
        const database = getDb();
        if (!hasPipelineTables()) return { total: 0, byState: {} };

        const rows = database.prepare(
            'SELECT state, COUNT(*) as count FROM bot_lifecycle GROUP BY state'
        ).all();

        const byState = {};
        let total = 0;
        for (const row of rows) {
            byState[row.state] = row.count;
            total += row.count;
        }

        return { total, byState };
    } catch {
        return { total: 0, byState: {} };
    }
}

/**
 * Delete a retired bot from the database.
 * Only allows deletion of RETIRED bots for safety.
 */
export function deleteRetiredBot(botId) {
    try {
        const database = getDb();
        if (!hasPipelineTables()) return { success: false, error: 'Pipeline tables not found' };

        // First check if the bot exists and is retired
        const bot = database.prepare('SELECT state FROM bot_lifecycle WHERE bot_id = ?').get(botId);
        if (!bot) {
            return { success: false, error: 'Bot not found' };
        }
        if (bot.state !== 'RETIRED') {
            return { success: false, error: 'Can only delete RETIRED bots' };
        }

        // Delete the bot
        const result = database.prepare('DELETE FROM bot_lifecycle WHERE bot_id = ?').run(botId);

        if (result.changes > 0) {
            return { success: true };
        } else {
            return { success: false, error: 'Failed to delete bot' };
        }
    } catch (e) {
        console.error('Error in deleteRetiredBot:', e);
        return { success: false, error: e.message };
    }
}
