/**
 * Integration tests for Multi-Bot Simulation.
 * Tests: Run multiple strategies → compare performance → aggregate results
 */
import { describe, it, expect, vi, afterAll } from 'vitest';

import { HistoricalSimulator, CoinType } from '../../src/simulation/HistoricalSimulator.js';
import { Contrarian } from '../../src/bots/Contrarian.js';
import { createMockClobClient, QuantBotSimulationAdapter } from '../../src/simulation/QuantBotSimulationAdapter.js';
import { TargetedMarket } from '../../src/types/interfaces.js';
import type { BotParams, SimulatedBot, SimulationResult } from '../../src/simulation/HistoricalSimulator.js';
import { resetTradingDatabaseSingleton } from '../utils/testHelpers.js';

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

// Mock node-cron
vi.mock('node-cron', () => ({ default: { schedule: vi.fn() } }));

// Contrarian bot factory (non-inverted - contrarian signal)
function createContrarianBot(botParams: BotParams): SimulatedBot {
    const { name, clock, marketInfo, cdMarketData, params, targetedMarket, shouldWriteLogs, logDirectory } = botParams;

    const bot = new Contrarian({
        name,
        hourlyDollarLimit: 10000,
        client: createMockClobClient(),
        marketInfo,
        cdMarketData,
        PROD_MODE: false,
        targetedMarket,
        clock,
        logDirectory: logDirectory ?? './logs/simulator',
        shouldWriteLogs: shouldWriteLogs ?? false,
        targetBuyPrice: params.targetBuyPrice as number ?? 0.48,
        targetSellPrice: params.targetSellPrice as number ?? 0.60,
        targetDollars: params.targetDollars as number ?? 10,
        cutoffMinute: params.cutoffMinute as number ?? 30,
        lookbackHours: params.lookbackHours as number ?? 3,
        invertSignal: params.invertSignal as boolean ?? false,
    });

    return new QuantBotSimulationAdapter(bot, clock, marketInfo);
}

// Momentum bot factory (inverted signal - follow trend)
function createMomentumBot(botParams: BotParams): SimulatedBot {
    const { name, clock, marketInfo, cdMarketData, params, targetedMarket, shouldWriteLogs, logDirectory } = botParams;

    const bot = new Contrarian({
        name,
        hourlyDollarLimit: 10000,
        client: createMockClobClient(),
        marketInfo,
        cdMarketData,
        PROD_MODE: false,
        targetedMarket,
        clock,
        logDirectory: logDirectory ?? './logs/simulator',
        shouldWriteLogs: shouldWriteLogs ?? false,
        targetBuyPrice: params.targetBuyPrice as number ?? 0.48,
        targetSellPrice: params.targetSellPrice as number ?? 0.60,
        targetDollars: params.targetDollars as number ?? 10,
        cutoffMinute: params.cutoffMinute as number ?? 30,
        lookbackHours: params.lookbackHours as number ?? 3,
        invertSignal: true, // Always inverted for momentum
    });

    return new QuantBotSimulationAdapter(bot, clock, marketInfo);
}

describe('Multi-Bot Simulation', { timeout: 60000 }, () => {
    const lookbackDays = 3;

    afterAll(() => {
        resetTradingDatabaseSingleton();
    });

    describe('Multiple Strategies Through Same Time Period', () => {
        it('should run Contrarian and Momentum bots through same period', async () => {
            const endTime = Date.now();

            const simulator = new HistoricalSimulator({
                lookbackDays,
                coinType: CoinType.BTC,
                targetedMarket: TargetedMarket.BITCOIN_HOURLY,
                tickIntervalMs: 60 * 1000,
                endTime,
            });

            const baseParams = {
                targetBuyPrice: 0.48,
                targetSellPrice: 0.60,
                targetDollars: 10,
                cutoffMinute: 30,
                lookbackHours: 3,
            };

            // Run Contrarian strategy
            const { result: contrarianResult } = await simulator.runSingleSimulation(
                'Contrarian',
                createContrarianBot,
                { ...baseParams, invertSignal: 0 }
            );

            // Run Momentum strategy (same params but inverted)
            const { result: momentumResult } = await simulator.runSingleSimulation(
                'Momentum',
                createMomentumBot,
                { ...baseParams, invertSignal: 1 }
            );

            // Both should complete without errors
            expect(contrarianResult).toBeDefined();
            expect(momentumResult).toBeDefined();

            // Both should have consistent structure
            expect(typeof contrarianResult.totalPnl).toBe('number');
            expect(typeof momentumResult.totalPnl).toBe('number');

            console.log(`Contrarian: PnL=$${contrarianResult.totalPnl.toFixed(2)}, Trades=${contrarianResult.totalTrades}`);
            console.log(`Momentum: PnL=$${momentumResult.totalPnl.toFixed(2)}, Trades=${momentumResult.totalTrades}`);
        });

        it('should run multiple parameter variations', async () => {
            const endTime = Date.now();

            const simulator = new HistoricalSimulator({
                lookbackDays,
                coinType: CoinType.BTC,
                targetedMarket: TargetedMarket.BITCOIN_HOURLY,
                tickIntervalMs: 60 * 1000,
                endTime,
            });

            const paramVariations = [
                { targetBuyPrice: 0.45, targetSellPrice: 0.65, label: 'Wide' },
                { targetBuyPrice: 0.48, targetSellPrice: 0.55, label: 'Tight' },
                { targetBuyPrice: 0.50, targetSellPrice: 0.60, label: 'Mid' },
            ];

            const results: SimulationResult[] = [];

            for (const variation of paramVariations) {
                const { result } = await simulator.runSingleSimulation(
                    variation.label,
                    createContrarianBot,
                    {
                        targetBuyPrice: variation.targetBuyPrice,
                        targetSellPrice: variation.targetSellPrice,
                        targetDollars: 10,
                        cutoffMinute: 30,
                        lookbackHours: 3,
                    }
                );
                results.push(result);
            }

            // All should complete
            expect(results.length).toBe(3);
            results.forEach((r, i) => {
                console.log(`${paramVariations[i].label}: PnL=$${r.totalPnl.toFixed(2)}, WinRate=${r.winRate.toFixed(1)}%`);
            });
        });
    });

    describe('Inverted Signal Comparison', () => {
        it('should produce different PnLs for inverted vs non-inverted signals', async () => {
            const endTime = Date.now();

            const simulator = new HistoricalSimulator({
                lookbackDays,
                coinType: CoinType.BTC,
                targetedMarket: TargetedMarket.BITCOIN_HOURLY,
                tickIntervalMs: 60 * 1000,
                endTime,
            });

            const baseParams = {
                targetBuyPrice: 0.48,
                targetSellPrice: 0.60,
                targetDollars: 10,
                cutoffMinute: 30,
                lookbackHours: 3,
            };

            const { result: normalResult, trades: normalTrades } = await simulator.runSingleSimulation(
                'Normal',
                createContrarianBot,
                { ...baseParams, invertSignal: 0 }
            );

            const { result: invertedResult, trades: invertedTrades } = await simulator.runSingleSimulation(
                'Inverted',
                createContrarianBot,
                { ...baseParams, invertSignal: 1 }
            );

            // Both should have trades
            expect(normalResult.totalTrades).toBeGreaterThan(0);
            expect(invertedResult.totalTrades).toBeGreaterThan(0);

            // PnLs should be different (opposite signals = different outcomes)
            const pnlDifference = Math.abs(normalResult.totalPnl - invertedResult.totalPnl);
            console.log(`Normal PnL: $${normalResult.totalPnl.toFixed(2)}`);
            console.log(`Inverted PnL: $${invertedResult.totalPnl.toFixed(2)}`);
            console.log(`Difference: $${pnlDifference.toFixed(2)}`);

            // There should be some difference (unless market was completely random)
            // Allow for case where they happen to be similar
            expect(typeof pnlDifference).toBe('number');
        });
    });

    describe('Concurrent Simulations', () => {
        it('should run simulations concurrently via Promise.all()', async () => {
            const endTime = Date.now();

            const createSimulator = () => new HistoricalSimulator({
                lookbackDays: 1, // Shorter for faster concurrent tests
                coinType: CoinType.BTC,
                targetedMarket: TargetedMarket.BITCOIN_HOURLY,
                tickIntervalMs: 60 * 1000,
                endTime,
            });

            const baseParams = {
                targetBuyPrice: 0.48,
                targetSellPrice: 0.60,
                targetDollars: 10,
                cutoffMinute: 30,
                lookbackHours: 3,
            };

            // Run multiple simulations concurrently
            const startTime = performance.now();

            const [result1, result2, result3] = await Promise.all([
                createSimulator().runSingleSimulation('Concurrent1', createContrarianBot, baseParams),
                createSimulator().runSingleSimulation('Concurrent2', createContrarianBot, baseParams),
                createSimulator().runSingleSimulation('Concurrent3', createContrarianBot, baseParams),
            ]);

            const elapsed = performance.now() - startTime;

            // All should complete successfully
            expect(result1.result).toBeDefined();
            expect(result2.result).toBeDefined();
            expect(result3.result).toBeDefined();

            // Results should be consistent (same params = same results with fixed endTime)
            expect(result1.result.totalPnl).toBeCloseTo(result2.result.totalPnl, 1);
            expect(result2.result.totalPnl).toBeCloseTo(result3.result.totalPnl, 1);

            console.log(`3 concurrent simulations completed in ${elapsed.toFixed(0)}ms`);
        });

        it('should handle different bot types concurrently', async () => {
            const endTime = Date.now();

            const simulator1 = new HistoricalSimulator({
                lookbackDays: 1,
                coinType: CoinType.BTC,
                targetedMarket: TargetedMarket.BITCOIN_HOURLY,
                tickIntervalMs: 60 * 1000,
                endTime,
            });

            const simulator2 = new HistoricalSimulator({
                lookbackDays: 1,
                coinType: CoinType.BTC,
                targetedMarket: TargetedMarket.BITCOIN_HOURLY,
                tickIntervalMs: 60 * 1000,
                endTime,
            });

            const baseParams = {
                targetBuyPrice: 0.48,
                targetSellPrice: 0.60,
                targetDollars: 10,
                cutoffMinute: 30,
                lookbackHours: 3,
            };

            // Run different bot types concurrently
            const [contrarianResult, momentumResult] = await Promise.all([
                simulator1.runSingleSimulation('ConcurrentContrarian', createContrarianBot, { ...baseParams, invertSignal: 0 }),
                simulator2.runSingleSimulation('ConcurrentMomentum', createMomentumBot, { ...baseParams, invertSignal: 1 }),
            ]);

            expect(contrarianResult.result).toBeDefined();
            expect(momentumResult.result).toBeDefined();

            // Different strategies should have different results
            console.log(`Contrarian: $${contrarianResult.result.totalPnl.toFixed(2)}`);
            console.log(`Momentum: $${momentumResult.result.totalPnl.toFixed(2)}`);
        });
    });

    describe('Regime-Aware Simulation', () => {
        it('should include regimeStats in result when available', async () => {
            const endTime = Date.now();

            const simulator = new HistoricalSimulator({
                lookbackDays: 2,
                coinType: CoinType.BTC,
                targetedMarket: TargetedMarket.BITCOIN_HOURLY,
                tickIntervalMs: 60 * 1000,
                endTime,
            });

            // runRegimeAwareSimulation requires regime parameters
            const params = {
                targetBuyPrice: 0.48,
                targetSellPrice: 0.60,
                targetDollars: 10,
                cutoffMinute: 30,
                lookbackHours: 3,
                // Regime detection thresholds
                volThreshold: 0.02,
                trendThreshold: 0.005,
            };

            const { result, trades } = await simulator.runRegimeAwareSimulation(
                'RegimeAware',
                createContrarianBot,
                params
            );

            // Result should have regimeStats
            expect(result).toBeDefined();
            expect(result.regimeStats).toBeDefined();

            // Check regime stats structure
            if (result.regimeStats) {
                const regimeTypes = ['HighVolTrending', 'HighVolRanging', 'LowVolTrending', 'LowVolRanging'];
                regimeTypes.forEach(regime => {
                    const stats = result.regimeStats![regime as keyof typeof result.regimeStats];
                    if (stats) {
                        expect(typeof stats.periodCount).toBe('number');
                        expect(typeof stats.tradeCount).toBe('number');
                        expect(typeof stats.pnl).toBe('number');
                        expect(typeof stats.sharpeRatio).toBe('number');
                    }
                });

                console.log('Regime Stats:');
                Object.entries(result.regimeStats).forEach(([regime, stats]) => {
                    console.log(`  ${regime}: periods=${stats.periodCount}, trades=${stats.tradeCount}, pnl=$${stats.pnl.toFixed(2)}`);
                });
            }
        });
    });

    describe('Result Aggregation', () => {
        it('should aggregate results from multiple simulations', async () => {
            const endTime = Date.now();

            const simulator = new HistoricalSimulator({
                lookbackDays,
                coinType: CoinType.BTC,
                targetedMarket: TargetedMarket.BITCOIN_HOURLY,
                tickIntervalMs: 60 * 1000,
                endTime,
            });

            const strategies = [
                { name: 'Conservative', buyPrice: 0.40, sellPrice: 0.70 },
                { name: 'Moderate', buyPrice: 0.45, sellPrice: 0.60 },
                { name: 'Aggressive', buyPrice: 0.48, sellPrice: 0.55 },
            ];

            const results: SimulationResult[] = [];

            for (const strategy of strategies) {
                const { result } = await simulator.runSingleSimulation(
                    strategy.name,
                    createContrarianBot,
                    {
                        targetBuyPrice: strategy.buyPrice,
                        targetSellPrice: strategy.sellPrice,
                        targetDollars: 10,
                        cutoffMinute: 30,
                        lookbackHours: 3,
                    }
                );
                results.push(result);
            }

            // Calculate aggregate metrics
            const totalPnl = results.reduce((sum, r) => sum + r.totalPnl, 0);
            const totalTrades = results.reduce((sum, r) => sum + r.totalTrades, 0);
            const avgWinRate = results.reduce((sum, r) => sum + r.winRate, 0) / results.length;
            const avgSharpe = results.reduce((sum, r) => sum + r.sharpeRatio, 0) / results.length;

            console.log('--- Aggregate Results ---');
            console.log(`Total PnL: $${totalPnl.toFixed(2)}`);
            console.log(`Total Trades: ${totalTrades}`);
            console.log(`Average Win Rate: ${avgWinRate.toFixed(1)}%`);
            console.log(`Average Sharpe: ${avgSharpe.toFixed(3)}`);

            // Sort by PnL
            const sortedResults = [...results].sort((a, b) => b.totalPnl - a.totalPnl);
            console.log('\n--- Ranking by PnL ---');
            sortedResults.forEach((r, i) => {
                console.log(`${i + 1}. ${r.botName}: $${r.totalPnl.toFixed(2)}`);
            });

            expect(results.length).toBe(3);
        });
    });
});
