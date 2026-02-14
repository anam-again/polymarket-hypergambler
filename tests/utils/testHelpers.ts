/**
 * Common test utilities for integration tests.
 * Provides factory functions for creating test infrastructure components.
 */
import { SimulationClock } from '../../src/simulation/SimulationClock.js';
import { MockMarketInfo } from '../../src/simulation/MockMarketInfo.js';
import { MockCDMarketData } from '../../src/simulation/MockCDMarketData.js';
import { TradingDatabase } from '../../src/db/TradingDatabase.js';
import { CoinType } from '../../src/simulation/GeneticOptimizer.js';

/**
 * Creates a SimulationClock for testing with the specified lookback period.
 * @param lookbackDays - Number of days to look back from endTime
 * @param endTime - End time in milliseconds (defaults to Date.now())
 * @param tickIntervalMs - Time increment per tick (defaults to 60000ms = 1 minute)
 */
export function createTestClock(
    lookbackDays: number,
    endTime?: number,
    tickIntervalMs: number = 60 * 1000
): SimulationClock {
    const end = endTime ?? Date.now();
    const startTime = end - (lookbackDays * 24 * 60 * 60 * 1000);
    return new SimulationClock(startTime, end, tickIntervalMs);
}

/**
 * Creates a MockMarketInfo instance for testing.
 * @param clock - SimulationClock to use
 * @param coinType - Type of coin (defaults to BTC)
 */
export function createTestMarketInfo(
    clock: SimulationClock,
    coinType: CoinType = CoinType.BTC
): MockMarketInfo {
    return new MockMarketInfo(clock, coinType);
}

/**
 * Creates a MockCDMarketData instance for testing.
 * @param clock - SimulationClock to use
 * @param coinType - Type of coin (defaults to BTC)
 */
export function createTestCDMarketData(
    clock: SimulationClock,
    coinType: CoinType = CoinType.BTC
): MockCDMarketData {
    return new MockCDMarketData(clock, coinType);
}

/**
 * Creates an in-memory TradingDatabase for isolated testing.
 * Uses ':memory:' SQLite path to avoid file system pollution.
 */
export function createInMemoryDb(): TradingDatabase {
    // Reset the singleton instance to ensure we get a fresh in-memory DB
    resetTradingDatabaseSingleton();
    return TradingDatabase.getInstance(':memory:');
}

/**
 * Resets the TradingDatabase singleton instance.
 * Call this to ensure test isolation.
 */
export function resetTradingDatabaseSingleton(): void {
    // Access private static instance via bracket notation
    (TradingDatabase as unknown as { instance: TradingDatabase | null }).instance = null;
}

/**
 * Creates a complete test simulation environment.
 * Returns clock, marketInfo, and cdMarketData configured for testing.
 */
export function createTestEnvironment(
    lookbackDays: number = 3,
    coinType: CoinType = CoinType.BTC,
    endTime?: number,
    tickIntervalMs: number = 60 * 1000
): {
    clock: SimulationClock;
    marketInfo: MockMarketInfo;
    cdMarketData: MockCDMarketData;
} {
    const clock = createTestClock(lookbackDays, endTime, tickIntervalMs);
    const marketInfo = createTestMarketInfo(clock, coinType);
    const cdMarketData = createTestCDMarketData(clock, coinType);

    return { clock, marketInfo, cdMarketData };
}

/**
 * Advances the clock by N ticks, awaiting each tick.
 * Useful for advancing simulation time in tests.
 */
export async function advanceClockByTicks(
    clock: SimulationClock,
    tickCount: number
): Promise<void> {
    for (let i = 0; i < tickCount; i++) {
        const continued = await clock.tick();
        if (!continued) break;
    }
}

/**
 * Advances the clock until the given predicate returns true.
 * Returns the number of ticks advanced.
 */
export async function advanceClockUntil(
    clock: SimulationClock,
    predicate: () => boolean,
    maxTicks: number = 10000
): Promise<number> {
    let ticks = 0;
    while (!predicate() && ticks < maxTicks) {
        const continued = await clock.tick();
        if (!continued) break;
        ticks++;
    }
    return ticks;
}

/**
 * Advances the clock to the next hour boundary.
 */
export async function advanceToNextHour(clock: SimulationClock): Promise<void> {
    const currentHour = clock.getHours();
    await advanceClockUntil(
        clock,
        () => clock.getHours() !== currentHour
    );
}

/**
 * Advances the clock to the next 15-minute boundary.
 */
export async function advanceToNextQuarter(clock: SimulationClock): Promise<void> {
    const currentQuarter = Math.floor(clock.getMinutes() / 15);
    await advanceClockUntil(
        clock,
        () => Math.floor(clock.getMinutes() / 15) !== currentQuarter
    );
}

/**
 * Generates a unique test order ID.
 */
export function generateTestOrderId(): string {
    return `test-${Date.now()}-${Math.random().toString(36).substring(2, 10)}`;
}

/**
 * Creates a mock trade audit record for testing.
 */
export function createMockTradeAudit(overrides: Partial<{
    timestamp: number;
    strategy: string;
    tradeId: string;
    status: string;
    entryTimestamp: number;
    size: number;
    buyPrice: number | null;
    sellPrice: number | null;
    gross: number;
    pnl: number;
    mode: string;
    marketHash: string;
    side: string;
}> = {}): {
    timestamp: number;
    strategy: string;
    tradeId: string;
    status: string;
    entryTimestamp: number;
    size: number;
    buyPrice: number | null;
    sellPrice: number | null;
    gross: number;
    pnl: number;
    mode: string;
    marketHash: string;
    side: string;
} {
    return {
        timestamp: Date.now(),
        strategy: 'TestStrategy',
        tradeId: generateTestOrderId(),
        status: 'MATCHED',
        entryTimestamp: Date.now() - 1000,
        size: 100,
        buyPrice: 0.45,
        sellPrice: 0.55,
        gross: 45,
        pnl: 10,
        mode: 'TEST',
        marketHash: 'test-market-hash',
        side: 'BUY',
        ...overrides,
    };
}
