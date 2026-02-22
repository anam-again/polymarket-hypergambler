/**
 * Integration tests for the BotPipeline and PipelineBotManager.
 *
 * Tests the full lifecycle from SIMULATED through PROD_CANDIDATE,
 * verifying that PROD_CANDIDATE does NOT auto-promote.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { QuantBotRun } from '../../src/bots/QuantBot.js';
import { TradingDatabase } from '../../src/db/TradingDatabase.js';
import { PipelineDatabase } from '../../src/pipeline/PipelineDatabase.js';
import { PipelineBotManager } from '../../src/pipeline/PipelineBotManager.js';
import { BotLifecycleState } from '../../src/pipeline/types.js';
import type { BotLifecycleRecord } from '../../src/pipeline/types.js';
import { createInMemoryDb } from '../utils/testHelpers.js';

// Mock QuantBotRun
function createMockBot(name: string): QuantBotRun {
    return {
        name,
        PROD_MODE: false,
        run: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn(),
    };
}

// Mock runBotsWithRestartOnFailure to prevent actual bot startup
vi.mock('../../src/bots/QuantBot.js', async (importOriginal) => {
    const actual = await importOriginal() as Record<string, unknown>;
    return {
        ...actual,
        runBotsWithRestartOnFailure: vi.fn(),
    };
});

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

describe('PipelineBotManager', () => {
    let testBots: QuantBotRun[];
    let prodBots: QuantBotRun[];
    let manager: PipelineBotManager;

    beforeEach(() => {
        testBots = [];
        prodBots = [];
        manager = new PipelineBotManager(testBots, prodBots);
    });

    describe('addTestBot', () => {
        it('should add a bot to the test array', () => {
            const bot = createMockBot('test-bot-1');
            manager.addTestBot(bot, 'bot-1');

            expect(testBots).toHaveLength(1);
            expect(testBots[0]).toBe(bot);
            expect(manager.isManagedBot('bot-1')).toBe(true);
        });

        it('should not add duplicate bot IDs', () => {
            const bot1 = createMockBot('bot-1');
            const bot2 = createMockBot('bot-1-dup');

            manager.addTestBot(bot1, 'dup-id');
            manager.addTestBot(bot2, 'dup-id');

            expect(testBots).toHaveLength(1);
        });

        it('should track managed bot counts', () => {
            manager.addTestBot(createMockBot('test-1'), 'id-1');
            manager.addTestBot(createMockBot('test-2'), 'id-2');

            const counts = manager.getActiveBotCount();
            expect(counts.test).toBe(2);
            expect(counts.prod).toBe(0);
        });
    });

    describe('addProdBot', () => {
        it('should add a bot to the prod array', () => {
            const bot = createMockBot('prod-bot-1');
            manager.addProdBot(bot, 'prod-1');

            expect(prodBots).toHaveLength(1);
            expect(prodBots[0]).toBe(bot);
            expect(manager.isManagedBot('prod-1')).toBe(true);
        });
    });

    describe('removeBot', () => {
        it('should remove a test bot and call stop()', () => {
            const bot = createMockBot('removable');
            manager.addTestBot(bot, 'rm-1');

            const removed = manager.removeBot('rm-1');

            expect(removed).toBe(true);
            expect(testBots).toHaveLength(0);
            expect(bot.stop).toHaveBeenCalled();
            expect(manager.isManagedBot('rm-1')).toBe(false);
        });

        it('should remove a prod bot and call stop()', () => {
            const bot = createMockBot('prod-removable');
            manager.addProdBot(bot, 'rm-prod');

            const removed = manager.removeBot('rm-prod');

            expect(removed).toBe(true);
            expect(prodBots).toHaveLength(0);
            expect(bot.stop).toHaveBeenCalled();
        });

        it('should return false for non-existent bot', () => {
            const removed = manager.removeBot('nonexistent');
            expect(removed).toBe(false);
        });
    });

    describe('getManagedBotIds', () => {
        it('should return IDs of all managed bots', () => {
            manager.addTestBot(createMockBot('t1'), 'test-id-1');
            manager.addTestBot(createMockBot('t2'), 'test-id-2');
            manager.addProdBot(createMockBot('p1'), 'prod-id-1');

            const ids = manager.getManagedBotIds();
            expect(ids.test).toEqual(['test-id-1', 'test-id-2']);
            expect(ids.prod).toEqual(['prod-id-1']);
        });
    });

    describe('stopAll', () => {
        it('should stop all managed bots and clear arrays', () => {
            const testBot = createMockBot('t1');
            const prodBot = createMockBot('p1');

            manager.addTestBot(testBot, 'stop-test');
            manager.addProdBot(prodBot, 'stop-prod');

            manager.stopAll();

            expect(testBot.stop).toHaveBeenCalled();
            expect(prodBot.stop).toHaveBeenCalled();
            expect(testBots).toHaveLength(0);
            expect(prodBots).toHaveLength(0);
            expect(manager.getActiveBotCount()).toEqual({ test: 0, prod: 0 });
        });
    });
});

describe('Pipeline Lifecycle Integration', () => {
    let tradingDb: TradingDatabase;
    let pipelineDb: PipelineDatabase;

    beforeEach(() => {
        tradingDb = createInMemoryDb();
        pipelineDb = new PipelineDatabase(tradingDb);
    });

    it('should transition bot through SIMULATED -> TEST_RUNNING -> TEST_EVALUATED -> PROD_CANDIDATE', () => {
        const botId = 'lifecycle-test';
        const now = Date.now();

        // Step 1: Insert as SIMULATED (SimulationRunner would do this)
        pipelineDb.insertBotLifecycle(makeRecord({
            botId,
            state: BotLifecycleState.SIMULATED,
            simPnl: 25.0,
            simSharpe: 1.2,
            simWinRate: 60,
            simTotalTrades: 30,
        }));

        let bot = pipelineDb.getBotById(botId)!;
        expect(bot.state).toBe(BotLifecycleState.SIMULATED);

        // Step 2: Promote to TEST_RUNNING (BotPromoter would do this)
        pipelineDb.updateBotState(botId, BotLifecycleState.TEST_RUNNING, {
            testStartTimestamp: now - (49 * 60 * 60 * 1000), // 49h ago
        });
        pipelineDb.insertPipelineEvent({
            timestamp: now,
            stageName: 'BotPromoter',
            eventType: 'BOT_PROMOTED_TO_TEST',
            botId,
            severity: 'INFO',
        });

        bot = pipelineDb.getBotById(botId)!;
        expect(bot.state).toBe(BotLifecycleState.TEST_RUNNING);

        // Step 3: Evaluate and promote to TEST_EVALUATED (TestEvaluator would do this)
        pipelineDb.updateBotState(botId, BotLifecycleState.TEST_EVALUATED, {
            testPnl: 15.0,
            testWinRate: 55,
            testTradeCount: 12,
            testSharpe: 0.9,
            testEvaluatedAt: now,
        });

        bot = pipelineDb.getBotById(botId)!;
        expect(bot.state).toBe(BotLifecycleState.TEST_EVALUATED);
        expect(bot.testPnl).toBe(15.0);

        // Step 4: Promote to PROD_CANDIDATE (TestEvaluator would do this)
        pipelineDb.updateBotState(botId, BotLifecycleState.PROD_CANDIDATE);
        pipelineDb.insertPipelineEvent({
            timestamp: now,
            stageName: 'TestEvaluator',
            eventType: 'BOT_PROMOTED_TO_PROD_CANDIDATE',
            botId,
            severity: 'INFO',
        });

        bot = pipelineDb.getBotById(botId)!;
        expect(bot.state).toBe(BotLifecycleState.PROD_CANDIDATE);

        // Verify: PROD_CANDIDATE does NOT automatically become PROD_RUNNING
        // The only way to transition is via explicit approveProdCandidate()
        expect(bot.state).not.toBe(BotLifecycleState.PROD_RUNNING);
    });

    it('should verify PROD_CANDIDATE requires explicit user approval', () => {
        const botId = 'no-auto-promote';

        pipelineDb.insertBotLifecycle(makeRecord({
            botId,
            state: BotLifecycleState.PROD_CANDIDATE,
        }));

        // Verify it stays as PROD_CANDIDATE
        const bot = pipelineDb.getBotById(botId)!;
        expect(bot.state).toBe(BotLifecycleState.PROD_CANDIDATE);

        // Only explicit approval changes state
        const approved = pipelineDb.approveProdCandidate(botId);
        expect(approved).toBe(true);

        const updatedBot = pipelineDb.getBotById(botId)!;
        expect(updatedBot.state).toBe(BotLifecycleState.PROD_RUNNING);
    });

    it('should retire bots that fail test evaluation', () => {
        const botId = 'fail-test';

        pipelineDb.insertBotLifecycle(makeRecord({
            botId,
            state: BotLifecycleState.TEST_RUNNING,
            testStartTimestamp: Date.now() - (50 * 60 * 60 * 1000),
        }));

        // Evaluate and find poor performance -> RETIRED
        pipelineDb.updateBotState(botId, BotLifecycleState.RETIRED, {
            testPnl: -5.0,
            testWinRate: 20,
            testTradeCount: 3,
            retiredAt: Date.now(),
            retireReason: 'Failed test evaluation: PnL below threshold',
        });

        const bot = pipelineDb.getBotById(botId)!;
        expect(bot.state).toBe(BotLifecycleState.RETIRED);
        expect(bot.retireReason).toContain('Failed test evaluation');
    });

    it('should track events through the full lifecycle', () => {
        const botId = 'event-tracking';
        const now = Date.now();

        pipelineDb.insertBotLifecycle(makeRecord({ botId, state: BotLifecycleState.SIMULATED }));

        // Sim complete event
        pipelineDb.insertPipelineEvent({
            timestamp: now,
            stageName: 'SimulationRunner',
            eventType: 'SIMULATION_COMPLETE',
            botId,
            detailsJson: JSON.stringify({ pnl: 25 }),
            severity: 'INFO',
        });

        // Promotion event
        pipelineDb.insertPipelineEvent({
            timestamp: now + 1000,
            stageName: 'BotPromoter',
            eventType: 'BOT_PROMOTED_TO_TEST',
            botId,
            severity: 'INFO',
        });

        // Evaluation event
        pipelineDb.insertPipelineEvent({
            timestamp: now + 2000,
            stageName: 'TestEvaluator',
            eventType: 'BOT_EVALUATED',
            botId,
            detailsJson: JSON.stringify({ pnl: 15, winRate: 55 }),
            severity: 'INFO',
        });

        const events = pipelineDb.getRecentEvents(20, undefined, botId);
        expect(events.length).toBe(3);
        // Most recent first
        expect(events[0].eventType).toBe('BOT_EVALUATED');
        expect(events[1].eventType).toBe('BOT_PROMOTED_TO_TEST');
        expect(events[2].eventType).toBe('SIMULATION_COMPLETE');
    });

    it('should handle concurrent bots in different states', () => {
        pipelineDb.insertBotLifecycle(makeRecord({ botId: 'sim-1', state: BotLifecycleState.SIMULATED }));
        pipelineDb.insertBotLifecycle(makeRecord({ botId: 'sim-2', state: BotLifecycleState.SIMULATED }));
        pipelineDb.insertBotLifecycle(makeRecord({ botId: 'test-1', state: BotLifecycleState.TEST_RUNNING }));
        pipelineDb.insertBotLifecycle(makeRecord({ botId: 'test-2', state: BotLifecycleState.TEST_RUNNING }));
        pipelineDb.insertBotLifecycle(makeRecord({ botId: 'candidate-1', state: BotLifecycleState.PROD_CANDIDATE }));
        pipelineDb.insertBotLifecycle(makeRecord({ botId: 'prod-1', state: BotLifecycleState.PROD_RUNNING }));
        pipelineDb.insertBotLifecycle(makeRecord({ botId: 'retired-1', state: BotLifecycleState.RETIRED }));

        expect(pipelineDb.countBotsByState(BotLifecycleState.SIMULATED)).toBe(2);
        expect(pipelineDb.countBotsByState(BotLifecycleState.TEST_RUNNING)).toBe(2);
        expect(pipelineDb.countBotsByState(BotLifecycleState.PROD_CANDIDATE)).toBe(1);
        expect(pipelineDb.countBotsByState(BotLifecycleState.PROD_RUNNING)).toBe(1);
        expect(pipelineDb.countBotsByState(BotLifecycleState.RETIRED)).toBe(1);

        const all = pipelineDb.getAllBots();
        expect(all).toHaveLength(7);
    });
});
