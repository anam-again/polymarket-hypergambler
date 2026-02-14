import { describe, it, expect, vi, beforeAll } from 'vitest';
import { HistoricalSimulator, CoinType } from '../src/simulation/HistoricalSimulator.js';
import { TargetedMarket } from '../src/types/interfaces.js';
import { Contrarian } from '../src/bots/Contrarian.js';
import { createMockClobClient, QuantBotSimulationAdapter } from '../src/simulation/QuantBotSimulationAdapter.js';
import type { BotParams, SimulatedBot } from '../src/simulation/HistoricalSimulator.js';

// Mock fs for log writing
vi.mock('fs', async () => {
    const actual = await vi.importActual<typeof import('fs')>('fs');
    return {
        ...actual,
        appendFileSync: vi.fn(),
        mkdirSync: vi.fn(),
    };
});

// ============================================================================
// Contrarian Bot Factory
// ============================================================================

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

// ============================================================================
// Tests
// ============================================================================

describe('Contrarian Bot Historical Simulation', () => {
    // Short lookback for faster tests
    const lookbackDays = 3;

    it('should produce positive PnL for either invertSignal=false or invertSignal=true', async () => {
        // Create simulator with a fixed end time for reproducibility
        const endTime = Date.now();

        const simulator = new HistoricalSimulator({
            lookbackDays,
            coinType: CoinType.BTC,
            targetedMarket: TargetedMarket.BITCOIN_HOURLY,
            tickIntervalMs: 60 * 1000, // 1 minute ticks
            endTime,
        });

        // Base params for the Contrarian bot
        const baseParams = {
            targetBuyPrice: 0.48,
            targetSellPrice: 0.60,
            targetDollars: 10,
            cutoffMinute: 30,
            lookbackHours: 3,
        };

        // Run simulation with invertSignal: false (contrarian - bet against trend)
        const { result: resultFalse } = await simulator.runSingleSimulation(
            'Contrarian-Normal',
            createContrarianBot,
            { ...baseParams, invertSignal: 0 }, // 0 = false (numeric for params)
        );

        // Run simulation with invertSignal: true (momentum - bet with trend)
        const { result: resultTrue } = await simulator.runSingleSimulation(
            'Contrarian-Inverted',
            createContrarianBot,
            { ...baseParams, invertSignal: 1 }, // 1 = true (numeric for params)
        );

        console.log(`\n--- Contrarian Simulation Results ---`);
        console.log(`invertSignal=false: PnL=$${resultFalse.totalPnl.toFixed(2)}, Trades=${resultFalse.totalTrades}, WinRate=${resultFalse.winRate.toFixed(1)}%`);
        console.log(`invertSignal=true:  PnL=$${resultTrue.totalPnl.toFixed(2)}, Trades=${resultTrue.totalTrades}, WinRate=${resultTrue.winRate.toFixed(1)}%`);

        // At least one of the two configurations should produce a positive PnL
        // The idea is that contrarian vs momentum strategies should have inverse results
        const hasPositivePnl = resultFalse.totalPnl > 0 || resultTrue.totalPnl > 0;

        expect(hasPositivePnl).toBe(true);
    }, 60000); // 60 second timeout for simulation

    it('should have opposite directionality between inverted and non-inverted signals', async () => {
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

        // Run both simulations
        const { result: resultFalse, trades: tradesFalse } = await simulator.runSingleSimulation(
            'Contrarian-Normal',
            createContrarianBot,
            { ...baseParams, invertSignal: 0 },
        );

        const { result: resultTrue, trades: tradesTrue } = await simulator.runSingleSimulation(
            'Contrarian-Inverted',
            createContrarianBot,
            { ...baseParams, invertSignal: 1 },
        );

        // Both should have made some trades
        expect(resultFalse.totalTrades).toBeGreaterThan(0);
        expect(resultTrue.totalTrades).toBeGreaterThan(0);

        // The strategies should have different PnLs (they're betting in opposite directions)
        // We allow for identical results only if both have zero trades
        if (resultFalse.totalTrades > 0 && resultTrue.totalTrades > 0) {
            // PnLs should not be identical (they should be somewhat inverse)
            // Allow small tolerance for edge cases
            const pnlDifference = Math.abs(resultFalse.totalPnl - resultTrue.totalPnl);
            console.log(`\nPnL difference between strategies: $${pnlDifference.toFixed(2)}`);

            // There should be a meaningful difference
            expect(pnlDifference).toBeGreaterThan(0);
        }
    }, 60000);
});
