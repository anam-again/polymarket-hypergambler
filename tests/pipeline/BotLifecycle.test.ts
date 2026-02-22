/**
 * Unit tests for PipelineDatabase CRUD operations,
 * state machine validation, and approval/rejection flows.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { TradingDatabase } from '../../src/db/TradingDatabase.js';
import { PipelineDatabase } from '../../src/pipeline/PipelineDatabase.js';
import { BotLifecycleState } from '../../src/pipeline/types.js';
import type { BotLifecycleRecord, PipelineEventRecord, PipelineStateRecord } from '../../src/pipeline/types.js';
import { createInMemoryDb } from '../utils/testHelpers.js';

function makeRecord(overrides: Partial<BotLifecycleRecord> = {}): BotLifecycleRecord {
    const now = Date.now();
    return {
        botId: `test-bot-${Math.random().toString(36).substring(2, 8)}`,
        strategy: 'FirstCandleMSPEQ',
        market: 'BitcoinHourly',
        state: BotLifecycleState.SIMULATED,
        simPnl: 15.5,
        simSharpe: 0.8,
        simWinRate: 55,
        simTotalTrades: 20,
        simTimestamp: now,
        createdAt: now,
        updatedAt: now,
        ...overrides,
    };
}

describe('PipelineDatabase', () => {
    let tradingDb: TradingDatabase;
    let pipelineDb: PipelineDatabase;

    beforeEach(() => {
        tradingDb = createInMemoryDb();
        pipelineDb = new PipelineDatabase(tradingDb);
    });

    // =========================================================================
    // Bot Lifecycle CRUD
    // =========================================================================

    describe('Bot Lifecycle CRUD', () => {
        it('should insert and retrieve a bot lifecycle record', () => {
            const record = makeRecord({ botId: 'crud-test-1' });
            pipelineDb.insertBotLifecycle(record);

            const retrieved = pipelineDb.getBotById('crud-test-1');
            expect(retrieved).not.toBeNull();
            expect(retrieved!.botId).toBe('crud-test-1');
            expect(retrieved!.strategy).toBe('FirstCandleMSPEQ');
            expect(retrieved!.market).toBe('BitcoinHourly');
            expect(retrieved!.state).toBe(BotLifecycleState.SIMULATED);
            expect(retrieved!.simPnl).toBe(15.5);
            expect(retrieved!.simSharpe).toBe(0.8);
        });

        it('should return null for non-existent bot', () => {
            const result = pipelineDb.getBotById('nonexistent');
            expect(result).toBeNull();
        });

        it('should get bots by state', () => {
            pipelineDb.insertBotLifecycle(makeRecord({ botId: 'state-1', state: BotLifecycleState.SIMULATED }));
            pipelineDb.insertBotLifecycle(makeRecord({ botId: 'state-2', state: BotLifecycleState.SIMULATED }));
            pipelineDb.insertBotLifecycle(makeRecord({ botId: 'state-3', state: BotLifecycleState.TEST_RUNNING }));

            const simulated = pipelineDb.getBotsByState(BotLifecycleState.SIMULATED);
            expect(simulated).toHaveLength(2);

            const testRunning = pipelineDb.getBotsByState(BotLifecycleState.TEST_RUNNING);
            expect(testRunning).toHaveLength(1);
            expect(testRunning[0].botId).toBe('state-3');
        });

        it('should count bots by state', () => {
            pipelineDb.insertBotLifecycle(makeRecord({ botId: 'count-1', state: BotLifecycleState.SIMULATED }));
            pipelineDb.insertBotLifecycle(makeRecord({ botId: 'count-2', state: BotLifecycleState.SIMULATED }));
            pipelineDb.insertBotLifecycle(makeRecord({ botId: 'count-3', state: BotLifecycleState.RETIRED }));

            expect(pipelineDb.countBotsByState(BotLifecycleState.SIMULATED)).toBe(2);
            expect(pipelineDb.countBotsByState(BotLifecycleState.RETIRED)).toBe(1);
            expect(pipelineDb.countBotsByState(BotLifecycleState.PROD_RUNNING)).toBe(0);
        });

        it('should get all bots', () => {
            pipelineDb.insertBotLifecycle(makeRecord({ botId: 'all-1' }));
            pipelineDb.insertBotLifecycle(makeRecord({ botId: 'all-2' }));
            pipelineDb.insertBotLifecycle(makeRecord({ botId: 'all-3' }));

            const all = pipelineDb.getAllBots();
            expect(all).toHaveLength(3);
        });

        it('should get bots for specific strategy and market', () => {
            pipelineDb.insertBotLifecycle(makeRecord({ botId: 'sm-1', strategy: 'EarlyBuyerMSPEQ', market: 'BitcoinHourly' }));
            pipelineDb.insertBotLifecycle(makeRecord({ botId: 'sm-2', strategy: 'EarlyBuyerMSPEQ', market: 'BitcoinQuarterly' }));
            pipelineDb.insertBotLifecycle(makeRecord({ botId: 'sm-3', strategy: 'FirstCandleMSPEQ', market: 'BitcoinHourly' }));

            const result = pipelineDb.getBotsForStrategyAndMarket('EarlyBuyerMSPEQ', 'BitcoinHourly');
            expect(result).toHaveLength(1);
            expect(result[0].botId).toBe('sm-1');
        });
    });

    // =========================================================================
    // State Updates
    // =========================================================================

    describe('State Updates', () => {
        it('should update bot state', () => {
            pipelineDb.insertBotLifecycle(makeRecord({ botId: 'update-1', state: BotLifecycleState.SIMULATED }));

            pipelineDb.updateBotState('update-1', BotLifecycleState.TEST_RUNNING, {
                testStartTimestamp: Date.now(),
            });

            const updated = pipelineDb.getBotById('update-1');
            expect(updated!.state).toBe(BotLifecycleState.TEST_RUNNING);
            expect(updated!.testStartTimestamp).not.toBeNull();
        });

        it('should update multiple fields at once', () => {
            pipelineDb.insertBotLifecycle(makeRecord({ botId: 'multi-update' }));

            pipelineDb.updateBotState('multi-update', BotLifecycleState.TEST_EVALUATED, {
                testPnl: 25.5,
                testWinRate: 60,
                testTradeCount: 15,
                testSharpe: 1.2,
                testEvaluatedAt: Date.now(),
            });

            const bot = pipelineDb.getBotById('multi-update');
            expect(bot!.state).toBe(BotLifecycleState.TEST_EVALUATED);
            expect(bot!.testPnl).toBe(25.5);
            expect(bot!.testWinRate).toBe(60);
            expect(bot!.testTradeCount).toBe(15);
            expect(bot!.testSharpe).toBe(1.2);
        });

        it('should transition through the full lifecycle', () => {
            const botId = 'lifecycle-full';
            pipelineDb.insertBotLifecycle(makeRecord({ botId, state: BotLifecycleState.SIMULATED }));

            // SIMULATED -> TEST_RUNNING
            pipelineDb.updateBotState(botId, BotLifecycleState.TEST_RUNNING, {
                testStartTimestamp: Date.now(),
            });
            expect(pipelineDb.getBotById(botId)!.state).toBe(BotLifecycleState.TEST_RUNNING);

            // TEST_RUNNING -> TEST_EVALUATED
            pipelineDb.updateBotState(botId, BotLifecycleState.TEST_EVALUATED, {
                testPnl: 10,
                testWinRate: 50,
                testTradeCount: 8,
            });
            expect(pipelineDb.getBotById(botId)!.state).toBe(BotLifecycleState.TEST_EVALUATED);

            // TEST_EVALUATED -> PROD_CANDIDATE
            pipelineDb.updateBotState(botId, BotLifecycleState.PROD_CANDIDATE);
            expect(pipelineDb.getBotById(botId)!.state).toBe(BotLifecycleState.PROD_CANDIDATE);

            // PROD_CANDIDATE -> PROD_RUNNING (via approval)
            pipelineDb.updateBotState(botId, BotLifecycleState.PROD_RUNNING, {
                prodStartTimestamp: Date.now(),
                promotedBy: 'USER_APPROVAL',
            });
            expect(pipelineDb.getBotById(botId)!.state).toBe(BotLifecycleState.PROD_RUNNING);

            // PROD_RUNNING -> RETIRED
            pipelineDb.updateBotState(botId, BotLifecycleState.RETIRED, {
                retiredAt: Date.now(),
                retireReason: 'Underperforming',
            });
            const retired = pipelineDb.getBotById(botId)!;
            expect(retired.state).toBe(BotLifecycleState.RETIRED);
            expect(retired.retireReason).toBe('Underperforming');
        });
    });

    // =========================================================================
    // Test Bots Ready for Evaluation
    // =========================================================================

    describe('Test Bots Ready for Evaluation', () => {
        it('should find bots older than the evaluation window', () => {
            const fortyNineHoursAgo = Date.now() - (49 * 60 * 60 * 1000);
            const twentyFourHoursAgo = Date.now() - (24 * 60 * 60 * 1000);

            pipelineDb.insertBotLifecycle(makeRecord({
                botId: 'ready-1',
                state: BotLifecycleState.TEST_RUNNING,
                testStartTimestamp: fortyNineHoursAgo,
            }));
            pipelineDb.insertBotLifecycle(makeRecord({
                botId: 'not-ready-1',
                state: BotLifecycleState.TEST_RUNNING,
                testStartTimestamp: twentyFourHoursAgo,
            }));

            const windowMs = 48 * 60 * 60 * 1000; // 48h
            const ready = pipelineDb.getTestBotsReadyForEvaluation(windowMs);
            expect(ready).toHaveLength(1);
            expect(ready[0].botId).toBe('ready-1');
        });

        it('should not include non-TEST_RUNNING bots', () => {
            const fortyNineHoursAgo = Date.now() - (49 * 60 * 60 * 1000);

            pipelineDb.insertBotLifecycle(makeRecord({
                botId: 'wrong-state',
                state: BotLifecycleState.SIMULATED,
                testStartTimestamp: fortyNineHoursAgo,
            }));

            const windowMs = 48 * 60 * 60 * 1000;
            const ready = pipelineDb.getTestBotsReadyForEvaluation(windowMs);
            expect(ready).toHaveLength(0);
        });
    });

    // =========================================================================
    // Approval / Rejection
    // =========================================================================

    describe('Approval and Rejection', () => {
        it('should approve a PROD_CANDIDATE bot', () => {
            pipelineDb.insertBotLifecycle(makeRecord({
                botId: 'approve-1',
                state: BotLifecycleState.PROD_CANDIDATE,
            }));

            const result = pipelineDb.approveProdCandidate('approve-1');
            expect(result).toBe(true);

            const bot = pipelineDb.getBotById('approve-1');
            expect(bot!.state).toBe(BotLifecycleState.PROD_RUNNING);
            expect(bot!.prodStartTimestamp).not.toBeNull();
            expect(bot!.promotedBy).toBe('USER_APPROVAL');
        });

        it('should not approve a bot that is not PROD_CANDIDATE', () => {
            pipelineDb.insertBotLifecycle(makeRecord({
                botId: 'not-candidate',
                state: BotLifecycleState.TEST_RUNNING,
            }));

            const result = pipelineDb.approveProdCandidate('not-candidate');
            expect(result).toBe(false);

            // State should not change
            expect(pipelineDb.getBotById('not-candidate')!.state).toBe(BotLifecycleState.TEST_RUNNING);
        });

        it('should not approve a non-existent bot', () => {
            const result = pipelineDb.approveProdCandidate('doesnt-exist');
            expect(result).toBe(false);
        });

        it('should reject a PROD_CANDIDATE bot', () => {
            pipelineDb.insertBotLifecycle(makeRecord({
                botId: 'reject-1',
                state: BotLifecycleState.PROD_CANDIDATE,
            }));

            const result = pipelineDb.rejectProdCandidate('reject-1', 'Low Sharpe ratio');
            expect(result).toBe(true);

            const bot = pipelineDb.getBotById('reject-1');
            expect(bot!.state).toBe(BotLifecycleState.RETIRED);
            expect(bot!.retireReason).toBe('Low Sharpe ratio');
            expect(bot!.retiredAt).not.toBeNull();
        });

        it('should reject with default reason when none provided', () => {
            pipelineDb.insertBotLifecycle(makeRecord({
                botId: 'reject-default',
                state: BotLifecycleState.PROD_CANDIDATE,
            }));

            pipelineDb.rejectProdCandidate('reject-default');

            const bot = pipelineDb.getBotById('reject-default');
            expect(bot!.retireReason).toBe('Rejected by user');
        });

        it('should create pipeline event on approval', () => {
            pipelineDb.insertBotLifecycle(makeRecord({
                botId: 'event-approve',
                state: BotLifecycleState.PROD_CANDIDATE,
            }));

            pipelineDb.approveProdCandidate('event-approve');

            const events = pipelineDb.getRecentEvents(10, undefined, 'event-approve');
            expect(events.length).toBeGreaterThanOrEqual(1);

            const approvalEvent = events.find(e => e.eventType === 'BOT_APPROVED_FOR_PROD');
            expect(approvalEvent).toBeDefined();
            expect(approvalEvent!.stageName).toBe('UserApproval');
            expect(approvalEvent!.botId).toBe('event-approve');
        });

        it('should create pipeline event on rejection', () => {
            pipelineDb.insertBotLifecycle(makeRecord({
                botId: 'event-reject',
                state: BotLifecycleState.PROD_CANDIDATE,
            }));

            pipelineDb.rejectProdCandidate('event-reject', 'Test reason');

            const events = pipelineDb.getRecentEvents(10, undefined, 'event-reject');
            const rejectEvent = events.find(e => e.eventType === 'BOT_REJECTED');
            expect(rejectEvent).toBeDefined();
            expect(rejectEvent!.botId).toBe('event-reject');
        });
    });

    // =========================================================================
    // Pipeline State (stage tracking)
    // =========================================================================

    describe('Pipeline State', () => {
        it('should upsert and retrieve pipeline state', () => {
            const state: PipelineStateRecord = {
                stageName: 'SimulationRunner',
                lastRunTimestamp: Date.now(),
                status: 'IDLE',
                runCount: 5,
                lastRunDurationMs: 30000,
            };

            pipelineDb.upsertPipelineState(state);

            const retrieved = pipelineDb.getPipelineState('SimulationRunner');
            expect(retrieved).not.toBeNull();
            expect(retrieved!.stageName).toBe('SimulationRunner');
            expect(retrieved!.status).toBe('IDLE');
            expect(retrieved!.runCount).toBe(5);
        });

        it('should update existing pipeline state on upsert', () => {
            pipelineDb.upsertPipelineState({
                stageName: 'TestEvaluator',
                status: 'IDLE',
                runCount: 1,
            });

            pipelineDb.upsertPipelineState({
                stageName: 'TestEvaluator',
                status: 'RUNNING',
                runCount: 2,
                lastRunTimestamp: Date.now(),
            });

            const state = pipelineDb.getPipelineState('TestEvaluator');
            expect(state!.status).toBe('RUNNING');
            expect(state!.runCount).toBe(2);
        });

        it('should get all pipeline states', () => {
            pipelineDb.upsertPipelineState({ stageName: 'Stage1', status: 'IDLE', runCount: 0 });
            pipelineDb.upsertPipelineState({ stageName: 'Stage2', status: 'IDLE', runCount: 0 });
            pipelineDb.upsertPipelineState({ stageName: 'Stage3', status: 'ERROR', runCount: 3, lastError: 'Test error' });

            const states = pipelineDb.getAllPipelineStates();
            expect(states).toHaveLength(3);
        });
    });

    // =========================================================================
    // Pipeline Events
    // =========================================================================

    describe('Pipeline Events', () => {
        it('should insert and retrieve events', () => {
            const event: PipelineEventRecord = {
                timestamp: Date.now(),
                stageName: 'SimulationRunner',
                eventType: 'SIMULATION_COMPLETE',
                botId: 'test-bot',
                detailsJson: JSON.stringify({ pnl: 15.5 }),
                severity: 'INFO',
            };

            pipelineDb.insertPipelineEvent(event);

            const events = pipelineDb.getRecentEvents(10);
            expect(events).toHaveLength(1);
            expect(events[0].eventType).toBe('SIMULATION_COMPLETE');
            expect(events[0].botId).toBe('test-bot');
        });

        it('should filter events by stage name', () => {
            pipelineDb.insertPipelineEvent({
                timestamp: Date.now(),
                stageName: 'SimulationRunner',
                eventType: 'SIMULATION_COMPLETE',
                severity: 'INFO',
            });
            pipelineDb.insertPipelineEvent({
                timestamp: Date.now(),
                stageName: 'BotPromoter',
                eventType: 'BOT_PROMOTED_TO_TEST',
                severity: 'INFO',
            });

            const simEvents = pipelineDb.getRecentEvents(10, 'SimulationRunner');
            expect(simEvents).toHaveLength(1);
            expect(simEvents[0].stageName).toBe('SimulationRunner');
        });

        it('should filter events by bot ID', () => {
            pipelineDb.insertPipelineEvent({
                timestamp: Date.now(),
                stageName: 'TestEvaluator',
                eventType: 'BOT_EVALUATED',
                botId: 'bot-A',
                severity: 'INFO',
            });
            pipelineDb.insertPipelineEvent({
                timestamp: Date.now(),
                stageName: 'TestEvaluator',
                eventType: 'BOT_EVALUATED',
                botId: 'bot-B',
                severity: 'INFO',
            });

            const eventsA = pipelineDb.getRecentEvents(10, undefined, 'bot-A');
            expect(eventsA).toHaveLength(1);
            expect(eventsA[0].botId).toBe('bot-A');
        });

        it('should respect the limit parameter', () => {
            for (let i = 0; i < 10; i++) {
                pipelineDb.insertPipelineEvent({
                    timestamp: Date.now() + i,
                    stageName: 'Test',
                    eventType: 'STAGE_RUN_COMPLETE',
                    severity: 'INFO',
                });
            }

            const limited = pipelineDb.getRecentEvents(3);
            expect(limited).toHaveLength(3);
        });

        it('should return events in descending timestamp order', () => {
            pipelineDb.insertPipelineEvent({
                timestamp: 1000,
                stageName: 'Test',
                eventType: 'STAGE_RUN_COMPLETE',
                severity: 'INFO',
            });
            pipelineDb.insertPipelineEvent({
                timestamp: 3000,
                stageName: 'Test',
                eventType: 'STAGE_RUN_COMPLETE',
                severity: 'INFO',
            });
            pipelineDb.insertPipelineEvent({
                timestamp: 2000,
                stageName: 'Test',
                eventType: 'STAGE_RUN_COMPLETE',
                severity: 'INFO',
            });

            const events = pipelineDb.getRecentEvents(10);
            expect(events[0].timestamp).toBe(3000);
            expect(events[1].timestamp).toBe(2000);
            expect(events[2].timestamp).toBe(1000);
        });
    });

    // =========================================================================
    // Metrics Queries
    // =========================================================================

    describe('Metrics Queries', () => {
        it('should return zero metrics when no trades exist', () => {
            const metrics = pipelineDb.getTestBotMetrics('nonexistent', 0);
            expect(metrics.pnl).toBe(0);
            expect(metrics.winRate).toBe(0);
            expect(metrics.tradeCount).toBe(0);
            expect(metrics.sharpe).toBe(0);
        });

        it('should compute metrics from trade_audits', () => {
            // Insert some trade audit records
            const db = tradingDb.getDb();
            const insert = db.prepare(`
                INSERT INTO trade_audits (timestamp, strategy, trade_id, status, entry_timestamp, size, buy_price, sell_price, gross, pnl, mode, market_hash, side)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);

            const now = Date.now();
            insert.run(now, 'test-strategy', 'trade-1', 'MATCHED', now - 1000, 100, 0.45, 0.55, 55, 10, 'TEST', 'hash1', 'BUY');
            insert.run(now, 'test-strategy', 'trade-2', 'MATCHED', now - 2000, 100, 0.50, 0.40, 40, -10, 'TEST', 'hash1', 'BUY');
            insert.run(now, 'test-strategy', 'trade-3', 'MATCHED', now - 3000, 100, 0.40, 0.60, 60, 20, 'TEST', 'hash1', 'BUY');

            const metrics = pipelineDb.getTestBotMetrics('test-strategy', now - 10000);
            expect(metrics.tradeCount).toBe(3);
            expect(metrics.pnl).toBe(20); // 10 - 10 + 20
            expect(metrics.winRate).toBeCloseTo(66.67, 0); // 2 of 3 trades positive
        });
    });
});
