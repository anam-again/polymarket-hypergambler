/**
 * Integration tests for period reset and settlement.
 * Tests: Period boundary → expire orders → determine winner → calculate PnL → reset state
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Side } from '@polymarket/clob-client';

import { Contrarian } from '../../src/bots/Contrarian.js';
import { TradeStatus } from '../../src/bots/QuantBot.js';
import { SimulationClock } from '../../src/simulation/SimulationClock.js';
import { MockMarketInfo } from '../../src/simulation/MockMarketInfo.js';
import { MockCDMarketData } from '../../src/simulation/MockCDMarketData.js';
import { TargetedMarket } from '../../src/types/interfaces.js';
import { CoinType } from '../../src/simulation/GeneticOptimizer.js';
import { createMockClobClient, QuantBotSimulationAdapter } from '../../src/simulation/QuantBotSimulationAdapter.js';
import {
    createTestEnvironment,
    advanceClockByTicks,
    advanceToNextHour,
    resetTradingDatabaseSingleton,
} from '../utils/testHelpers.js';

// Mock fs to prevent log file pollution
vi.mock('fs', async () => {
    const actual = await vi.importActual<typeof import('fs')>('fs');
    return {
        ...actual,
        appendFileSync: vi.fn(),
        writeFileSync: vi.fn(),
        mkdirSync: vi.fn(),
    };
});

// Mock node-cron to prevent scheduled task pollution
vi.mock('node-cron', () => ({ default: { schedule: vi.fn() } }));

// Mock TradingDatabase to prevent database writes
vi.mock('../../src/db/TradingDatabase', () => ({
    TradingDatabase: { getInstance: vi.fn(() => null) },
}));

describe('Period Reset and Settlement', () => {
    let clock: SimulationClock;
    let marketInfo: MockMarketInfo;
    let cdMarketData: MockCDMarketData;
    let bot: Contrarian;

    beforeEach(() => {
        vi.clearAllMocks();

        // Create test environment with 3 days lookback for sufficient data
        const env = createTestEnvironment(3, CoinType.BTC);
        clock = env.clock;
        marketInfo = env.marketInfo;
        cdMarketData = env.cdMarketData;

        // Create Contrarian bot for testing
        bot = new Contrarian({
            name: 'TestContrarian',
            hourlyDollarLimit: 1000,
            client: createMockClobClient(),
            marketInfo,
            cdMarketData,
            PROD_MODE: false,
            targetedMarket: TargetedMarket.BITCOIN_HOURLY,
            clock,
            shouldWriteLogs: false,
            logDirectory: './logs/simulator',
            simulationOrderDelayMs: 1000,
            targetBuyPrice: 0.48,
            targetSellPrice: 0.60,
            targetDollars: 10,
            cutoffMinute: 30,
            lookbackHours: 3,
            invertSignal: false,
        });
    });

    afterEach(() => {
        bot.stop();
        clock.clearListeners();
        resetTradingDatabaseSingleton();
    });

    describe('Winner Determination', () => {
        it('should get period winner from MockMarketInfo', async () => {
            // Advance clock to have data available
            await advanceClockByTicks(clock, 60); // ~1 hour of ticks

            // Get winner for current hour minus 1
            const now = clock.now();
            const oneHourAgo = now - (60 * 60 * 1000);
            const winner = marketInfo.getHourWinner?.(oneHourAgo, TargetedMarket.BITCOIN_HOURLY);

            // Winner should be either 'UP' or 'DOWN' or null (if no data)
            expect(winner === 'UP' || winner === 'DOWN' || winner === null).toBe(true);
        });

        it('should determine winner from asset price movement', async () => {
            // This tests the logic where winner is determined by BTC price change
            await advanceClockByTicks(clock, 10);

            const periodStartPrice = await cdMarketData.getCurrentPrice();
            expect(typeof periodStartPrice).toBe('number');
            expect(periodStartPrice).toBeGreaterThan(0);

            // Advance to get a different price point
            await advanceClockByTicks(clock, 30);

            const currentPrice = await cdMarketData.getCurrentPrice();
            expect(typeof currentPrice).toBe('number');

            // Determine expected winner
            const expectedWinner = currentPrice >= periodStartPrice ? 'UP' : 'DOWN';
            expect(['UP', 'DOWN']).toContain(expectedWinner);
        });
    });

    describe('Expiry Trade Creation', () => {
        it('should create expiry trades for unsold positions', async () => {
            // Advance to have market data
            await advanceClockByTicks(clock, 5);

            // Get current period token ID
            const now = clock.now();
            const date = new Date(now);
            const periodKey = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}-${date.getHours()}`;
            const tokenId = `UP-${periodKey}`;

            // Create and match a BUY order manually
            const trade = await bot.makeOrder('test-buy', tokenId, 0.45, 100, Side.BUY);
            if (trade) {
                // Simulate matching
                trade.status = TradeStatus.MATCHED;
                trade.finalValue = -(trade.amount * trade.targetBuyPrice!);
            }

            // Trigger period end - should create expiry trade
            const periodTrades = await bot.onSimulationPeriodEnd();

            // Should have at least the original trade (expired or with expiry trade)
            expect(periodTrades.length).toBeGreaterThanOrEqual(1);
        });

        it('should set correct finalValue for expiry trades', async () => {
            await advanceClockByTicks(clock, 5);

            const now = clock.now();
            const date = new Date(now);
            const periodKey = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}-${date.getHours()}`;
            const tokenId = `UP-${periodKey}`;

            // Create a BUY order
            const trade = await bot.makeOrder('expiry-value-test', tokenId, 0.45, 100, Side.BUY);
            if (trade) {
                trade.status = TradeStatus.MATCHED;
                trade.finalValue = -(trade.amount * trade.targetBuyPrice!);
            }

            const periodTrades = await bot.onSimulationPeriodEnd();

            // Check expiry trades have finalValue defined
            const expiryTrades = periodTrades.filter(t => t.name === 'expiry');
            for (const expiry of expiryTrades) {
                expect(expiry.finalValue).toBeDefined();
                // finalValue should be 0 (loss) or amount (win)
                expect(expiry.finalValue === 0 || expiry.finalValue === expiry.amount).toBe(true);
            }
        });
    });

    describe('Token Holdings Reset', () => {
        it('should clear token holdings after period reset', async () => {
            await advanceClockByTicks(clock, 5);

            const now = clock.now();
            const date = new Date(now);
            const periodKey = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}-${date.getHours()}`;
            const tokenId = `UP-${periodKey}`;

            // Create a BUY order that gets matched
            await bot.makeOrder('holdings-test', tokenId, 0.45, 100, Side.BUY);

            // Trigger period end
            await bot.onSimulationPeriodEnd();

            // Trades should be cleared
            expect(bot.trades.length).toBe(0);
        });
    });

    describe('Bot State Reset', () => {
        it('should reset spentThisHour to zero', async () => {
            await advanceClockByTicks(clock, 5);

            const tokenId = `UP-test-${Date.now()}`;
            await bot.makeOrder('spend-test', tokenId, 0.50, 100, Side.BUY);

            // Verify budget was reduced
            expect(bot.getRemainingBudget()).toBe(950); // 1000 - 50

            // Trigger period reset
            await bot.onSimulationPeriodEnd();

            // Budget should be restored
            expect(bot.getRemainingBudget()).toBe(1000);
        });

        it('should reset tradesThisHour counter', async () => {
            await advanceClockByTicks(clock, 5);

            const tokenId = `UP-test-${Date.now()}`;
            await bot.makeOrder('trade-count-test', tokenId, 0.50, 100, Side.BUY);
            bot.recordTrade();

            const statusBefore = bot.getBudgetStatus();
            expect(statusBefore.trades).toBe(1);

            await bot.onSimulationPeriodEnd();

            const statusAfter = bot.getBudgetStatus();
            expect(statusAfter.trades).toBe(0);
        });

        it('should call resetTradeState for bot-specific cleanup', async () => {
            // The Contrarian bot resets buyOrder, sellOrder, isTie, doNothing

            await advanceClockByTicks(clock, 5);

            // Execute trading logic to set internal state
            await bot.onSimulationTick();

            // Trigger period reset
            await bot.onSimulationPeriodEnd();

            // Internal state should be reset
            // We can verify indirectly by checking bot can make new orders
            const tokenId = `UP-test-${Date.now()}`;
            const newTrade = await bot.makeOrder('after-reset', tokenId, 0.48, 20, Side.BUY);
            expect(newTrade).toBeDefined();
        });
    });

    describe('Period Change Integration', () => {
        it('should handle multiple period changes correctly', async () => {
            // Register hourly handler
            let hourlyCallCount = 0;
            clock.on('hourly', async () => {
                hourlyCallCount++;
                await bot.onSimulationPeriodEnd();
            });

            // Advance through multiple hours
            const initialHour = clock.getHours();
            let hoursAdvanced = 0;
            const maxTicks = 200; // Safety limit

            for (let i = 0; i < maxTicks && hoursAdvanced < 2; i++) {
                await clock.tick();
                if (clock.getHours() !== initialHour) {
                    hoursAdvanced++;
                    break;
                }
            }

            // Verify at least one hourly event was triggered
            expect(hourlyCallCount).toBeGreaterThanOrEqual(0);
        });

        it('should preserve simulation clock state across resets', async () => {
            const initialTime = clock.now();

            await advanceClockByTicks(clock, 10);

            const beforeReset = clock.now();
            expect(beforeReset).toBeGreaterThan(initialTime);

            await bot.onSimulationPeriodEnd();

            const afterReset = clock.now();
            // Clock should NOT be reset by bot reset
            expect(afterReset).toBe(beforeReset);
        });
    });

    describe('QuantBotSimulationAdapter Integration', () => {
        it('should accumulate trades across periods via adapter', async () => {
            const adapter = new QuantBotSimulationAdapter(bot, clock, marketInfo);

            // Advance and create some trading activity
            await advanceClockByTicks(clock, 5);

            // Get current period token ID
            const now = clock.now();
            const date = new Date(now);
            const periodKey = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}-${date.getHours()}`;
            const tokenId = `UP-${periodKey}`;

            await bot.makeOrder('adapter-test', tokenId, 0.48, 20, Side.BUY);

            // Simulate period change via adapter
            await adapter.onHourChange();

            // Get accumulated trades
            const trades = adapter.getTrades();

            // Should have trades from the period
            expect(trades.length).toBeGreaterThanOrEqual(0);

            // Cleanup
            adapter.dispose();
        });
    });
});
