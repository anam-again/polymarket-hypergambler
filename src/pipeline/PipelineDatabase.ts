/**
 * PipelineDatabase - Database operations for the Bot Pipeline.
 *
 * Wraps TradingDatabase with pipeline-specific queries for bot lifecycle
 * management, stage state tracking, and event logging.
 */
import Database from 'better-sqlite3';
import { TradingDatabase } from '../db/TradingDatabase.js';
import type {
    BotLifecycleRecord,
    BotLifecycleState,
    BotMetrics,
    PipelineEventRecord,
    PipelineEventType,
    PipelineStateRecord,
} from './types.js';

export class PipelineDatabase {
    private db: Database.Database;

    constructor(tradingDb: TradingDatabase) {
        this.db = tradingDb.getDb();
    }

    // =========================================================================
    // Bot Lifecycle CRUD
    // =========================================================================

    public insertBotLifecycle(record: BotLifecycleRecord): void {
        const stmt = this.db.prepare(`
            INSERT INTO bot_lifecycle (
                bot_id, strategy, market, state, yaml_path, params_json,
                sim_pnl, sim_sharpe, sim_sortino, sim_calmar, sim_win_rate,
                sim_max_drawdown, sim_total_trades, sim_timestamp,
                test_start_timestamp, test_pnl, test_win_rate, test_trade_count,
                test_sharpe, test_evaluated_at,
                prod_start_timestamp, prod_pnl, prod_win_rate, prod_trade_count,
                prod_last_checked,
                created_at, updated_at, retired_at, retire_reason,
                promoted_by, demoted_from
            ) VALUES (
                ?, ?, ?, ?, ?, ?,
                ?, ?, ?, ?, ?,
                ?, ?, ?,
                ?, ?, ?, ?,
                ?, ?,
                ?, ?, ?, ?,
                ?,
                ?, ?, ?, ?,
                ?, ?
            )
        `);

        stmt.run(
            record.botId, record.strategy, record.market, record.state,
            record.yamlPath ?? null, record.paramsJson ?? null,
            record.simPnl ?? null, record.simSharpe ?? null,
            record.simSortino ?? null, record.simCalmar ?? null,
            record.simWinRate ?? null, record.simMaxDrawdown ?? null,
            record.simTotalTrades ?? null, record.simTimestamp ?? null,
            record.testStartTimestamp ?? null, record.testPnl ?? null,
            record.testWinRate ?? null, record.testTradeCount ?? null,
            record.testSharpe ?? null, record.testEvaluatedAt ?? null,
            record.prodStartTimestamp ?? null, record.prodPnl ?? null,
            record.prodWinRate ?? null, record.prodTradeCount ?? null,
            record.prodLastChecked ?? null,
            record.createdAt, record.updatedAt,
            record.retiredAt ?? null, record.retireReason ?? null,
            record.promotedBy ?? null, record.demotedFrom ?? null,
        );
    }

    public updateBotState(
        botId: string,
        newState: BotLifecycleState,
        updates?: Partial<BotLifecycleRecord>,
    ): void {
        const setClauses = ['state = ?', 'updated_at = ?'];
        const params: (string | number | null)[] = [newState, Date.now()];

        if (updates) {
            const fieldMap: Record<string, string> = {
                yamlPath: 'yaml_path',
                paramsJson: 'params_json',
                simPnl: 'sim_pnl',
                simSharpe: 'sim_sharpe',
                simSortino: 'sim_sortino',
                simCalmar: 'sim_calmar',
                simWinRate: 'sim_win_rate',
                simMaxDrawdown: 'sim_max_drawdown',
                simTotalTrades: 'sim_total_trades',
                simTimestamp: 'sim_timestamp',
                testStartTimestamp: 'test_start_timestamp',
                testPnl: 'test_pnl',
                testWinRate: 'test_win_rate',
                testTradeCount: 'test_trade_count',
                testSharpe: 'test_sharpe',
                testEvaluatedAt: 'test_evaluated_at',
                prodStartTimestamp: 'prod_start_timestamp',
                prodPnl: 'prod_pnl',
                prodWinRate: 'prod_win_rate',
                prodTradeCount: 'prod_trade_count',
                prodLastChecked: 'prod_last_checked',
                retiredAt: 'retired_at',
                retireReason: 'retire_reason',
                promotedBy: 'promoted_by',
                demotedFrom: 'demoted_from',
            };

            for (const [key, column] of Object.entries(fieldMap)) {
                if (key in updates) {
                    setClauses.push(`${column} = ?`);
                    params.push((updates as Record<string, unknown>)[key] as string | number | null ?? null);
                }
            }
        }

        params.push(botId);
        const sql = `UPDATE bot_lifecycle SET ${setClauses.join(', ')} WHERE bot_id = ?`;
        this.db.prepare(sql).run(...params);
    }

    public getBotById(botId: string): BotLifecycleRecord | null {
        const row = this.db.prepare('SELECT * FROM bot_lifecycle WHERE bot_id = ?').get(botId) as Record<string, unknown> | undefined;
        return row ? this.mapLifecycleRow(row) : null;
    }

    public getBotsByState(state: BotLifecycleState): BotLifecycleRecord[] {
        const rows = this.db.prepare('SELECT * FROM bot_lifecycle WHERE state = ? ORDER BY updated_at DESC').all(state) as Record<string, unknown>[];
        return rows.map(r => this.mapLifecycleRow(r));
    }

    public getAllBots(): BotLifecycleRecord[] {
        const rows = this.db.prepare('SELECT * FROM bot_lifecycle ORDER BY updated_at DESC').all() as Record<string, unknown>[];
        return rows.map(r => this.mapLifecycleRow(r));
    }

    public countBotsByState(state: BotLifecycleState): number {
        const row = this.db.prepare('SELECT COUNT(*) as count FROM bot_lifecycle WHERE state = ?').get(state) as { count: number };
        return row.count;
    }

    public getBotsForStrategyAndMarket(strategy: string, market: string): BotLifecycleRecord[] {
        const rows = this.db.prepare(
            'SELECT * FROM bot_lifecycle WHERE strategy = ? AND market = ? ORDER BY created_at DESC'
        ).all(strategy, market) as Record<string, unknown>[];
        return rows.map(r => this.mapLifecycleRow(r));
    }

    /**
     * Finds TEST_RUNNING bots that have been running for at least `windowMs` milliseconds.
     */
    public getTestBotsReadyForEvaluation(windowMs: number): BotLifecycleRecord[] {
        const cutoff = Date.now() - windowMs;
        const rows = this.db.prepare(
            `SELECT * FROM bot_lifecycle
             WHERE state = 'TEST_RUNNING' AND test_start_timestamp IS NOT NULL AND test_start_timestamp <= ?
             ORDER BY test_start_timestamp ASC`
        ).all(cutoff) as Record<string, unknown>[];
        return rows.map(r => this.mapLifecycleRow(r));
    }

    // =========================================================================
    // Metrics Queries (from existing trade_audits table)
    // =========================================================================

    /**
     * Gets test bot metrics by querying the trade_audits table.
     * Uses the bot's botId as the strategy name in trade_audits.
     */
    public getTestBotMetrics(botId: string, sinceTimestamp: number): BotMetrics {
        const row = this.db.prepare(`
            SELECT
                COALESCE(SUM(pnl), 0) as total_pnl,
                COUNT(*) as trade_count,
                SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
                AVG(pnl) as avg_pnl
            FROM trade_audits
            WHERE strategy = ? AND timestamp >= ? AND status IN ('MATCHED', 'EXPIRED')
        `).get(botId, sinceTimestamp) as {
            total_pnl: number;
            trade_count: number;
            wins: number;
            avg_pnl: number;
        };

        const tradeCount = row.trade_count || 0;
        const wins = row.wins || 0;
        const avgPnl = row.avg_pnl || 0;

        // Compute simple Sharpe approximation (avg PnL / stddev PnL)
        let sharpe = 0;
        if (tradeCount > 1) {
            const pnls = this.db.prepare(
                `SELECT pnl FROM trade_audits WHERE strategy = ? AND timestamp >= ? AND status IN ('MATCHED', 'EXPIRED')`
            ).all(botId, sinceTimestamp) as { pnl: number }[];

            const stddev = Math.sqrt(
                pnls.reduce((sum, p) => sum + (p.pnl - avgPnl) ** 2, 0) / (pnls.length - 1)
            );
            sharpe = stddev > 0 ? avgPnl / stddev : 0;
        }

        return {
            pnl: row.total_pnl,
            winRate: tradeCount > 0 ? (wins / tradeCount) * 100 : 0,
            tradeCount,
            sharpe,
        };
    }

    /**
     * Gets prod bot metrics over a rolling window.
     * Uses the later of prodStartTimestamp or (now - windowMs) to ensure we
     * only evaluate true production performance (and not historical test data).
     */
    public getProdBotMetrics(botId: string, windowMs: number): BotMetrics {
        const bot = this.getBotById(botId);
        const windowStart = Date.now() - windowMs;
        const prodStart = bot?.prodStartTimestamp ?? null;
        const cutoff = prodStart ? Math.max(prodStart, windowStart) : windowStart;
        return this.getTestBotMetrics(botId, cutoff);
    }

    // =========================================================================
    // Pipeline State (stage tracking)
    // =========================================================================

    public upsertPipelineState(record: PipelineStateRecord): void {
        const stmt = this.db.prepare(`
            INSERT INTO pipeline_state (stage_name, last_run_timestamp, next_scheduled_run, status, last_error, run_count, last_run_duration_ms, config_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(stage_name) DO UPDATE SET
                last_run_timestamp = excluded.last_run_timestamp,
                next_scheduled_run = excluded.next_scheduled_run,
                status = excluded.status,
                last_error = excluded.last_error,
                run_count = excluded.run_count,
                last_run_duration_ms = excluded.last_run_duration_ms,
                config_json = excluded.config_json
        `);
        stmt.run(
            record.stageName,
            record.lastRunTimestamp ?? null,
            record.nextScheduledRun ?? null,
            record.status,
            record.lastError ?? null,
            record.runCount,
            record.lastRunDurationMs ?? null,
            record.configJson ?? null,
        );
    }

    public getPipelineState(stageName: string): PipelineStateRecord | null {
        const row = this.db.prepare('SELECT * FROM pipeline_state WHERE stage_name = ?').get(stageName) as Record<string, unknown> | undefined;
        if (!row) return null;
        return {
            id: row.id as number,
            stageName: row.stage_name as string,
            lastRunTimestamp: row.last_run_timestamp as number | null,
            nextScheduledRun: row.next_scheduled_run as number | null,
            status: row.status as 'IDLE' | 'RUNNING' | 'ERROR',
            lastError: row.last_error as string | null,
            runCount: row.run_count as number,
            lastRunDurationMs: row.last_run_duration_ms as number | null,
            configJson: row.config_json as string | null,
        };
    }

    public getAllPipelineStates(): PipelineStateRecord[] {
        const rows = this.db.prepare('SELECT * FROM pipeline_state ORDER BY stage_name').all() as Record<string, unknown>[];
        return rows.map(row => ({
            id: row.id as number,
            stageName: row.stage_name as string,
            lastRunTimestamp: row.last_run_timestamp as number | null,
            nextScheduledRun: row.next_scheduled_run as number | null,
            status: row.status as 'IDLE' | 'RUNNING' | 'ERROR',
            lastError: row.last_error as string | null,
            runCount: row.run_count as number,
            lastRunDurationMs: row.last_run_duration_ms as number | null,
            configJson: row.config_json as string | null,
        }));
    }

    // =========================================================================
    // Pipeline Events (audit trail)
    // =========================================================================

    public insertPipelineEvent(event: PipelineEventRecord): void {
        const stmt = this.db.prepare(`
            INSERT INTO pipeline_events (timestamp, stage_name, event_type, bot_id, details_json, severity)
            VALUES (?, ?, ?, ?, ?, ?)
        `);
        stmt.run(
            event.timestamp,
            event.stageName,
            event.eventType,
            event.botId ?? null,
            event.detailsJson ?? null,
            event.severity,
        );
    }

    public getRecentEvents(limit: number = 50, stageName?: string, botId?: string): PipelineEventRecord[] {
        const conditions: string[] = [];
        const params: (string | number)[] = [];

        if (stageName) {
            conditions.push('stage_name = ?');
            params.push(stageName);
        }
        if (botId) {
            conditions.push('bot_id = ?');
            params.push(botId);
        }

        let sql = 'SELECT * FROM pipeline_events';
        if (conditions.length > 0) {
            sql += ' WHERE ' + conditions.join(' AND ');
        }
        sql += ' ORDER BY timestamp DESC LIMIT ?';
        params.push(limit);

        const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
        return rows.map(row => ({
            id: row.id as number,
            timestamp: row.timestamp as number,
            stageName: row.stage_name as string,
            eventType: row.event_type as PipelineEventType,
            botId: row.bot_id as string | null,
            detailsJson: row.details_json as string | null,
            severity: row.severity as 'INFO' | 'WARN' | 'ERROR',
        }));
    }

    /**
     * Gets simulation events (SIMULATION_COMPLETE and SIMULATION_FAILED) for a strategy/market combo.
     * Used by SimulationRunnerStage to track run history including failed simulations.
     */
    public getSimulationEventsForCombo(strategy: string, market: string, limit: number = 20): PipelineEventRecord[] {
        const sql = `
            SELECT * FROM pipeline_events
            WHERE event_type IN ('SIMULATION_COMPLETE', 'SIMULATION_FAILED')
              AND stage_name = 'SimulationRunner'
              AND details_json LIKE ?
              AND details_json LIKE ?
            ORDER BY timestamp DESC
            LIMIT ?
        `;
        // Use LIKE to match strategy and market in the JSON
        const strategyPattern = `%"strategy":"${strategy}"%`;
        const marketPattern = `%"market":"${market}"%`;

        const rows = this.db.prepare(sql).all(strategyPattern, marketPattern, limit) as Record<string, unknown>[];
        return rows.map(row => ({
            id: row.id as number,
            timestamp: row.timestamp as number,
            stageName: row.stage_name as string,
            eventType: row.event_type as PipelineEventType,
            botId: row.bot_id as string | null,
            detailsJson: row.details_json as string | null,
            severity: row.severity as 'INFO' | 'WARN' | 'ERROR',
        }));
    }

    // =========================================================================
    // Approval / Rejection (called from dashboard)
    // =========================================================================

    public approveProdCandidate(botId: string): boolean {
        const bot = this.getBotById(botId);
        if (!bot || bot.state !== 'PROD_CANDIDATE') {
            return false;
        }
        this.updateBotState(botId, 'PROD_RUNNING' as BotLifecycleState, {
            prodStartTimestamp: Date.now(),
            promotedBy: 'USER_APPROVAL',
        });
        this.insertPipelineEvent({
            timestamp: Date.now(),
            stageName: 'UserApproval',
            eventType: 'BOT_APPROVED_FOR_PROD',
            botId,
            detailsJson: JSON.stringify({ approvedAt: Date.now() }),
            severity: 'INFO',
        });
        return true;
    }

    public rejectProdCandidate(botId: string, reason?: string): boolean {
        const bot = this.getBotById(botId);
        if (!bot || bot.state !== 'PROD_CANDIDATE') {
            return false;
        }
        this.updateBotState(botId, 'RETIRED' as BotLifecycleState, {
            retiredAt: Date.now(),
            retireReason: reason ?? 'Rejected by user',
        });
        this.insertPipelineEvent({
            timestamp: Date.now(),
            stageName: 'UserApproval',
            eventType: 'BOT_REJECTED',
            botId,
            detailsJson: JSON.stringify({ reason: reason ?? 'Rejected by user' }),
            severity: 'INFO',
        });
        return true;
    }

    // =========================================================================
    // Internal: Row Mapping
    // =========================================================================

    private mapLifecycleRow(row: Record<string, unknown>): BotLifecycleRecord {
        return {
            id: row.id as number,
            botId: row.bot_id as string,
            strategy: row.strategy as string,
            market: row.market as string,
            state: row.state as BotLifecycleState,
            yamlPath: row.yaml_path as string | null,
            paramsJson: row.params_json as string | null,
            simPnl: row.sim_pnl as number | null,
            simSharpe: row.sim_sharpe as number | null,
            simSortino: row.sim_sortino as number | null,
            simCalmar: row.sim_calmar as number | null,
            simWinRate: row.sim_win_rate as number | null,
            simMaxDrawdown: row.sim_max_drawdown as number | null,
            simTotalTrades: row.sim_total_trades as number | null,
            simTimestamp: row.sim_timestamp as number | null,
            testStartTimestamp: row.test_start_timestamp as number | null,
            testPnl: row.test_pnl as number | null,
            testWinRate: row.test_win_rate as number | null,
            testTradeCount: row.test_trade_count as number | null,
            testSharpe: row.test_sharpe as number | null,
            testEvaluatedAt: row.test_evaluated_at as number | null,
            prodStartTimestamp: row.prod_start_timestamp as number | null,
            prodPnl: row.prod_pnl as number | null,
            prodWinRate: row.prod_win_rate as number | null,
            prodTradeCount: row.prod_trade_count as number | null,
            prodLastChecked: row.prod_last_checked as number | null,
            createdAt: row.created_at as number,
            updatedAt: row.updated_at as number,
            retiredAt: row.retired_at as number | null,
            retireReason: row.retire_reason as string | null,
            promotedBy: row.promoted_by as string | null,
            demotedFrom: row.demoted_from as string | null,
        };
    }
}
