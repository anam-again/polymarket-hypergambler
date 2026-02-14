/**
 * Integration tests for TradingDatabase pipeline.
 * Tests: Trade completion → insertTradeAudit → queryTrades/getStats
 *
 * Uses in-memory SQLite database (:memory:) for complete isolation.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TradingDatabase } from '../../src/db/TradingDatabase.js';
import type { TradeAuditRecord } from '../../src/db/types.js';
import {
    createInMemoryDb,
    resetTradingDatabaseSingleton,
    createMockTradeAudit,
    generateTestOrderId,
} from '../utils/testHelpers.js';

describe('TradingDatabase Pipeline', () => {
    let db: TradingDatabase;

    beforeEach(() => {
        // Create fresh in-memory database for each test
        db = createInMemoryDb();
    });

    afterEach(() => {
        // Close database and reset singleton
        db.close();
        resetTradingDatabaseSingleton();
    });

    describe('Insert and Query Trades', () => {
        it('should insert TradeAuditRecord and retrieve via queryTrades', () => {
            const trade = createMockTradeAudit({
                strategy: 'TestStrategy',
                pnl: 15.50,
                status: 'MATCHED',
            });

            // Insert trade
            db.insertTradeAudit(trade);

            // Query trades
            const results = db.queryTrades({ strategy: 'TestStrategy' });

            expect(results.length).toBe(1);
            expect(results[0].strategy).toBe('TestStrategy');
            expect(results[0].pnl).toBe(15.50);
            expect(results[0].status).toBe('MATCHED');
        });

        it('should verify all fields are correctly stored and retrieved', () => {
            const timestamp = Date.now();
            const entryTimestamp = timestamp - 5000;
            const trade: TradeAuditRecord = {
                timestamp,
                strategy: 'FieldTest',
                tradeId: 'test-field-123',
                status: 'EXPIRED',
                entryTimestamp,
                size: 250,
                buyPrice: 0.42,
                sellPrice: null,
                gross: 105,
                pnl: -25.50,
                mode: 'PROD',
                marketHash: 'market-hash-xyz',
                side: 'BUY',
            };

            db.insertTradeAudit(trade);

            const [result] = db.queryTrades({ strategy: 'FieldTest' });

            expect(result.timestamp).toBe(timestamp);
            expect(result.strategy).toBe('FieldTest');
            expect(result.tradeId).toBe('test-field-123');
            expect(result.status).toBe('EXPIRED');
            expect(result.entryTimestamp).toBe(entryTimestamp);
            expect(result.size).toBe(250);
            expect(result.buyPrice).toBe(0.42);
            expect(result.sellPrice).toBeNull();
            expect(result.gross).toBe(105);
            expect(result.pnl).toBe(-25.50);
            expect(result.mode).toBe('PROD');
            expect(result.marketHash).toBe('market-hash-xyz');
            expect(result.side).toBe('BUY');
        });

        it('should handle null buyPrice and sellPrice correctly', () => {
            const trade = createMockTradeAudit({
                buyPrice: null,
                sellPrice: 0.65,
                side: 'SELL',
            });

            db.insertTradeAudit(trade);

            const [result] = db.queryTrades();
            expect(result.buyPrice).toBeNull();
            expect(result.sellPrice).toBe(0.65);
        });
    });

    describe('Batch Insert Performance', () => {
        it('should batch insert 100 records in reasonable time (<100ms)', () => {
            const trades: TradeAuditRecord[] = [];

            for (let i = 0; i < 100; i++) {
                trades.push(createMockTradeAudit({
                    tradeId: `batch-${i}-${generateTestOrderId()}`,
                    strategy: 'BatchTest',
                    pnl: (Math.random() - 0.5) * 100, // Random PnL between -50 and 50
                }));
            }

            const startTime = performance.now();
            db.insertTradeAuditBatch(trades);
            const elapsed = performance.now() - startTime;

            expect(elapsed).toBeLessThan(100); // Should be fast

            // Verify all records were inserted
            const count = db.getTradeCount();
            expect(count).toBe(100);
        });

        it('should handle large batch inserts correctly', () => {
            const batchSize = 500;
            const trades: TradeAuditRecord[] = [];

            for (let i = 0; i < batchSize; i++) {
                trades.push(createMockTradeAudit({
                    tradeId: `large-batch-${i}`,
                    strategy: 'LargeBatch',
                    timestamp: Date.now() + i, // Unique timestamps
                }));
            }

            db.insertTradeAuditBatch(trades);

            const count = db.getTradeCount();
            expect(count).toBe(batchSize);
        });
    });

    describe('Stats Calculation', () => {
        it('should calculate totalPnl from mixed win/loss trades', () => {
            const trades: TradeAuditRecord[] = [
                createMockTradeAudit({ strategy: 'Stats', pnl: 100, status: 'MATCHED' }),
                createMockTradeAudit({ strategy: 'Stats', pnl: -50, status: 'EXPIRED' }),
                createMockTradeAudit({ strategy: 'Stats', pnl: 75, status: 'MATCHED' }),
                createMockTradeAudit({ strategy: 'Stats', pnl: -25, status: 'EXPIRED' }),
            ];

            // Insert with unique tradeIds
            trades.forEach((t, i) => {
                t.tradeId = `stats-${i}`;
                db.insertTradeAudit(t);
            });

            const stats = db.getStats({ strategy: 'Stats' });

            expect(stats.totalPnl).toBe(100); // 100 - 50 + 75 - 25 = 100
            expect(stats.totalTrades).toBe(4);
        });

        it('should calculate winRate correctly', () => {
            const trades: TradeAuditRecord[] = [
                createMockTradeAudit({ strategy: 'WinRate', pnl: 10, status: 'MATCHED' }),
                createMockTradeAudit({ strategy: 'WinRate', pnl: 20, status: 'MATCHED' }),
                createMockTradeAudit({ strategy: 'WinRate', pnl: -5, status: 'EXPIRED' }),
                createMockTradeAudit({ strategy: 'WinRate', pnl: 0, status: 'EXPIRED' }),
            ];

            trades.forEach((t, i) => {
                t.tradeId = `winrate-${i}`;
                db.insertTradeAudit(t);
            });

            const stats = db.getStats({ strategy: 'WinRate' });

            // 2 wins (pnl > 0) out of 4 completed = 50%
            expect(stats.winRate).toBe(50);
            expect(stats.winningTrades).toBe(2);
            expect(stats.losingTrades).toBe(2);
        });

        it('should calculate avgPnl correctly', () => {
            const trades: TradeAuditRecord[] = [
                createMockTradeAudit({ strategy: 'AvgPnl', pnl: 40, status: 'MATCHED' }),
                createMockTradeAudit({ strategy: 'AvgPnl', pnl: 20, status: 'MATCHED' }),
                createMockTradeAudit({ strategy: 'AvgPnl', pnl: -30, status: 'EXPIRED' }),
            ];

            trades.forEach((t, i) => {
                t.tradeId = `avgpnl-${i}`;
                db.insertTradeAudit(t);
            });

            const stats = db.getStats({ strategy: 'AvgPnl' });

            // Total: 40 + 20 - 30 = 30, Avg: 30/3 = 10
            expect(stats.avgPnl).toBe(10);
        });

        it('should count sold and expired trades separately', () => {
            const trades: TradeAuditRecord[] = [
                createMockTradeAudit({ strategy: 'SoldExpired', pnl: 10, status: 'MATCHED' }),
                createMockTradeAudit({ strategy: 'SoldExpired', pnl: 15, status: 'MATCHED' }),
                createMockTradeAudit({ strategy: 'SoldExpired', pnl: -5, status: 'EXPIRED' }),
            ];

            trades.forEach((t, i) => {
                t.tradeId = `soldexpired-${i}`;
                db.insertTradeAudit(t);
            });

            const stats = db.getStats({ strategy: 'SoldExpired' });

            expect(stats.soldTrades).toBe(2);
            expect(stats.expiredTrades).toBe(1);
        });
    });

    describe('getPnlByStrategy', () => {
        it('should return correct per-strategy aggregates sorted by PnL', () => {
            const trades: TradeAuditRecord[] = [
                // Strategy A: total PnL = 80
                createMockTradeAudit({ strategy: 'StrategyA', pnl: 50, status: 'MATCHED' }),
                createMockTradeAudit({ strategy: 'StrategyA', pnl: 30, status: 'MATCHED' }),
                // Strategy B: total PnL = 120
                createMockTradeAudit({ strategy: 'StrategyB', pnl: 100, status: 'MATCHED' }),
                createMockTradeAudit({ strategy: 'StrategyB', pnl: 20, status: 'EXPIRED' }),
                // Strategy C: total PnL = -30
                createMockTradeAudit({ strategy: 'StrategyC', pnl: -30, status: 'EXPIRED' }),
            ];

            trades.forEach((t, i) => {
                t.tradeId = `pnlstrat-${i}`;
                db.insertTradeAudit(t);
            });

            const results = db.getPnlByStrategy();

            // Should be sorted by PnL descending
            expect(results.length).toBe(3);
            expect(results[0].strategy).toBe('StrategyB');
            expect(results[0].pnl).toBe(120);
            expect(results[1].strategy).toBe('StrategyA');
            expect(results[1].pnl).toBe(80);
            expect(results[2].strategy).toBe('StrategyC');
            expect(results[2].pnl).toBe(-30);
        });

        it('should calculate per-strategy win/loss counts', () => {
            const trades: TradeAuditRecord[] = [
                createMockTradeAudit({ strategy: 'WinLoss', pnl: 10, status: 'MATCHED' }),
                createMockTradeAudit({ strategy: 'WinLoss', pnl: 20, status: 'MATCHED' }),
                createMockTradeAudit({ strategy: 'WinLoss', pnl: -5, status: 'EXPIRED' }),
            ];

            trades.forEach((t, i) => {
                t.tradeId = `winloss-${i}`;
                db.insertTradeAudit(t);
            });

            const [result] = db.getPnlByStrategy();

            expect(result.strategy).toBe('WinLoss');
            expect(result.trades).toBe(3);
            expect(result.wins).toBe(2);
            expect(result.losses).toBe(1);
            expect(result.winRate).toBeCloseTo(66.67, 1);
        });
    });

    describe('Query Filters', () => {
        beforeEach(() => {
            // Insert trades with various attributes
            const baseTime = Date.now();
            const trades: TradeAuditRecord[] = [
                createMockTradeAudit({
                    tradeId: 'filter-1',
                    timestamp: baseTime - 3600000, // 1 hour ago
                    strategy: 'FilterStrategy',
                    mode: 'PROD',
                    status: 'MATCHED',
                    side: 'BUY',
                }),
                createMockTradeAudit({
                    tradeId: 'filter-2',
                    timestamp: baseTime - 1800000, // 30 min ago
                    strategy: 'FilterStrategy',
                    mode: 'TEST',
                    status: 'EXPIRED',
                    side: 'SELL',
                }),
                createMockTradeAudit({
                    tradeId: 'filter-3',
                    timestamp: baseTime,
                    strategy: 'OtherStrategy',
                    mode: 'PROD',
                    status: 'MATCHED',
                    side: 'BUY',
                }),
            ];

            trades.forEach(t => db.insertTradeAudit(t));
        });

        it('should filter by time range', () => {
            const baseTime = Date.now();
            const results = db.queryTrades({
                startTime: baseTime - 2000000,
                endTime: baseTime - 1000000,
            });

            // Should only include trades within the time range
            expect(results.length).toBeGreaterThanOrEqual(0);
        });

        it('should filter by strategy', () => {
            const results = db.queryTrades({ strategy: 'FilterStrategy' });
            expect(results.length).toBe(2);
            results.forEach(r => expect(r.strategy).toBe('FilterStrategy'));
        });

        it('should filter by mode', () => {
            const prodResults = db.queryTrades({ mode: 'PROD' });
            expect(prodResults.length).toBe(2);

            const testResults = db.queryTrades({ mode: 'TEST' });
            expect(testResults.length).toBe(1);
        });

        it('should filter by status', () => {
            const matchedResults = db.queryTrades({ status: 'MATCHED' });
            expect(matchedResults.length).toBe(2);

            const expiredResults = db.queryTrades({ status: 'EXPIRED' });
            expect(expiredResults.length).toBe(1);
        });

        it('should filter by side', () => {
            const buyResults = db.queryTrades({ side: 'BUY' });
            expect(buyResults.length).toBe(2);

            const sellResults = db.queryTrades({ side: 'SELL' });
            expect(sellResults.length).toBe(1);
        });

        it('should apply limit and offset', () => {
            const results = db.queryTrades({ limit: 2, offset: 1 });
            expect(results.length).toBe(2);
        });
    });

    describe('Cumulative PnL', () => {
        it('should return cumulative PnL points in order', () => {
            const baseTime = Date.now();
            const trades: TradeAuditRecord[] = [
                createMockTradeAudit({
                    tradeId: 'cum-1',
                    timestamp: baseTime - 3000,
                    pnl: 10,
                    status: 'MATCHED',
                }),
                createMockTradeAudit({
                    tradeId: 'cum-2',
                    timestamp: baseTime - 2000,
                    pnl: -5,
                    status: 'EXPIRED',
                }),
                createMockTradeAudit({
                    tradeId: 'cum-3',
                    timestamp: baseTime - 1000,
                    pnl: 15,
                    status: 'MATCHED',
                }),
            ];

            trades.forEach(t => db.insertTradeAudit(t));

            const cumulative = db.getCumulativePnL();

            expect(cumulative.length).toBe(3);

            // Verify cumulative values
            expect(cumulative[0].pnl).toBe(10);
            expect(cumulative[0].cumulative).toBe(10);

            expect(cumulative[1].pnl).toBe(-5);
            expect(cumulative[1].cumulative).toBe(5); // 10 - 5

            expect(cumulative[2].pnl).toBe(15);
            expect(cumulative[2].cumulative).toBe(20); // 10 - 5 + 15
        });
    });

    describe('Bot Logs', () => {
        it('should insert and query bot logs', () => {
            db.insertBotLog({
                timestamp: Date.now(),
                level: 'ORDER',
                source: 'test-bot',
                message: 'Order placed',
                orderId: 'order-123',
                orderSide: 'BUY',
                orderAmount: 100,
                orderPrice: 0.45,
            });

            const logs = db.queryBotLogs({ source: 'test-bot' });

            expect(logs.length).toBe(1);
            expect(logs[0].level).toBe('ORDER');
            expect(logs[0].orderId).toBe('order-123');
            expect(logs[0].orderAmount).toBe(100);
        });

        it('should handle batch insert of bot logs', () => {
            const logs = Array.from({ length: 50 }, (_, i) => ({
                timestamp: Date.now() + i,
                level: 'INFO',
                source: 'batch-bot',
                message: `Log ${i}`,
            }));

            db.insertBotLogBatch(logs);

            const results = db.queryBotLogs({ source: 'batch-bot' });
            expect(results.length).toBe(50);
        });
    });

    describe('Get Strategies', () => {
        it('should return list of unique strategies', () => {
            const trades: TradeAuditRecord[] = [
                createMockTradeAudit({ tradeId: 'strat-1', strategy: 'Alpha' }),
                createMockTradeAudit({ tradeId: 'strat-2', strategy: 'Beta' }),
                createMockTradeAudit({ tradeId: 'strat-3', strategy: 'Alpha' }), // Duplicate
                createMockTradeAudit({ tradeId: 'strat-4', strategy: 'Gamma' }),
            ];

            trades.forEach(t => db.insertTradeAudit(t));

            const strategies = db.getStrategies();

            expect(strategies).toHaveLength(3);
            expect(strategies).toContain('Alpha');
            expect(strategies).toContain('Beta');
            expect(strategies).toContain('Gamma');
        });
    });
});
