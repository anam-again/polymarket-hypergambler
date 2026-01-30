import { readFileSync, existsSync } from 'fs';
import { SimulationClock } from './SimulationClock.js';
import { CoinType } from './GeneticOptimizer.js';
import { IMarketData, HistoricalAverages, RecentPriceEntry, TargetedMarket } from '../types/interfaces.js';

// ============================================================================
// Types & Interfaces
// ============================================================================

interface HourlyDataEntry {
    timestamp: number;
    hourlyOpen: number;
    averagePrice: number;
    hourlyMin: number;
    hourlyMax: number;
    openFlops: number;
    averageFlops: number;
    totalChange: number;
}

interface MinuteDataEntry {
    timestamp: number;
    price: number;
}

// ============================================================================
// MockCDMarketData Class
// ============================================================================

/**
 * Mock implementation of CDMarketData that reads from historical log files
 * and returns data based on the simulation clock's current time.
 * Implements IMarketData interface for use with QuantBot.
 */
export class MockCDMarketData implements IMarketData {
    private static readonly LOG_PATHS: Record<CoinType, { hourly: string; minute: string }> = {
        [CoinType.BTC]: {
            hourly: './logs/market/btc-hourly.log',
            minute: './logs/market/btc-minute.log',
        },
        [CoinType.ETH]: {
            hourly: './logs/market/eth-hourly.log',
            minute: './logs/market/eth-minute.log',
        },
        [CoinType.SOL]: {
            hourly: './logs/market/sol-hourly.log',
            minute: './logs/market/sol-minute.log',
        },
        [CoinType.XRP]: {
            hourly: './logs/market/xrp-hourly.log',
            minute: './logs/market/xrp-minute.log',
        },
    };

    private clock: SimulationClock;
    private coinType: CoinType;
    private hourlyData: HourlyDataEntry[] = [];
    private minuteData: MinuteDataEntry[] = [];

    // Cache for avoiding repeated binary searches
    private lastHourlySearchTime: number = 0;
    private lastHourlySearchIndex: number = 0;
    private lastMinuteSearchTime: number = 0;
    private lastMinuteSearchIndex: number = 0;

    constructor(clock: SimulationClock, coinType: CoinType) {
        this.clock = clock;
        this.coinType = coinType;
        this.loadData();
    }

    // -------------------------------------------------------------------------
    // Data Loading
    // -------------------------------------------------------------------------

    private loadData(): void {
        this.hourlyData = this.loadHourlyData();
        this.minuteData = this.loadMinuteData();

        console.log(`[MockCDMarketData] Loaded ${this.hourlyData.length} hourly entries, ${this.minuteData.length} minute entries for ${this.coinType.toUpperCase()}`);
    }

    private loadHourlyData(): HourlyDataEntry[] {
        const logPath = MockCDMarketData.LOG_PATHS[this.coinType].hourly;
        if (!existsSync(logPath)) {
            console.warn(`[MockCDMarketData] Hourly log not found: ${logPath}`);
            return [];
        }

        const content = readFileSync(logPath, 'utf-8');
        const lines = content.trim().split('\n').filter(line => line.trim());

        return lines.map(line => {
            const parts = line.split(',').map(p => p.trim());
            return {
                timestamp: new Date(parts[0]).getTime(),
                hourlyOpen: parseFloat(parts[1]),
                averagePrice: parseFloat(parts[2]),
                hourlyMin: parseFloat(parts[3]),
                hourlyMax: parseFloat(parts[4]),
                openFlops: parseFloat(parts[5]),
                averageFlops: parseFloat(parts[6]),
                totalChange: parseFloat(parts[7]),
            };
        }).sort((a, b) => a.timestamp - b.timestamp);
    }

    private loadMinuteData(): MinuteDataEntry[] {
        const logPath = MockCDMarketData.LOG_PATHS[this.coinType].minute;
        if (!existsSync(logPath)) {
            console.warn(`[MockCDMarketData] Minute log not found: ${logPath}`);
            return [];
        }

        const content = readFileSync(logPath, 'utf-8');
        const lines = content.trim().split('\n').filter(line => line.trim());

        return lines.map(line => {
            const parts = line.split(',').map(p => p.trim());
            return {
                timestamp: new Date(parts[0]).getTime(),
                price: parseFloat(parts[1]),
            };
        }).sort((a, b) => a.timestamp - b.timestamp);
    }

    // -------------------------------------------------------------------------
    // Public API - Price Data
    // -------------------------------------------------------------------------

    /**
     * Gets the price at the current simulated time.
     * Returns the most recent price entry before or at the current time.
     * Note: In simulation, all symbols return BTC data (mock limitation).
     */
    public async getCurrentPrice(): Promise<number> {
        const now = this.clock.now();
        const entry = this.findPreviousEntry(this.minuteData, now);

        if (!entry) {
            throw new Error(`No price data available for timestamp ${new Date(now).toISOString()}`);
        }

        return entry.price;
    }

    /**
     * Gets Binance price (same as getCurrentPrice for simulation).
     */
    public async getBinancePrice(): Promise<number> {
        return this.getCurrentPrice();
    }

    /**
     * Gets the current price by targeted market (IMarketData interface).
     * In simulation, all markets return the same price data for the loaded coin type.
     */
    public async getCurrentPriceByMarket(): Promise<number> {
        return this.getCurrentPrice();
    }

    // -------------------------------------------------------------------------
    // Public API - Historical Data
    // -------------------------------------------------------------------------

    /**
     * Gets averages of the last N hourly entries before the current simulated time.
     * Optimized to use binary search and cached index instead of filtering.
     */
    public getAverages(n: number): HistoricalAverages | null {
        const now = this.clock.now();

        // Find the index of the last entry before 'now' using cached search
        const lastValidIndex = this.findLastIndexBefore(this.hourlyData, now, true);

        if (lastValidIndex < 0 || lastValidIndex + 1 < n) {
            return null;
        }

        // Get the last N entries directly by index (no filtering/slicing needed)
        const startIndex = lastValidIndex - n + 1;
        const endIndex = lastValidIndex;

        // Calculate averages inline to avoid creating intermediate arrays
        let sumOpen = 0, sumAvg = 0, sumMin = 0, sumMax = 0;
        let sumOpenFlops = 0, sumAvgFlops = 0, sumTotalChange = 0;

        for (let i = startIndex; i <= endIndex; i++) {
            const e = this.hourlyData[i];
            sumOpen += e.hourlyOpen;
            sumAvg += e.averagePrice;
            sumMin += e.hourlyMin;
            sumMax += e.hourlyMax;
            sumOpenFlops += e.openFlops;
            sumAvgFlops += e.averageFlops;
            sumTotalChange += e.totalChange;
        }

        return {
            hourlyOpen: sumOpen / n,
            averagePrice: sumAvg / n,
            hourlyMin: sumMin / n,
            hourlyMax: sumMax / n,
            openFlops: sumOpenFlops / n,
            averageFlops: sumAvgFlops / n,
            totalChange: sumTotalChange / n,
        };
    }

    /**
     * Gets the average price over the last N hours.
     */
    public getAveragePrice(n: number): number | null {
        const averages = this.getAverages(n);
        return averages?.averagePrice ?? null;
    }

    /**
     * Gets recent price entries before the current simulated time.
     * Optimized to use binary search instead of filtering.
     */
    public getRecentPrices(n: number): RecentPriceEntry[] {
        const now = this.clock.now();

        // Find the index of the last entry at or before 'now'
        const lastValidIndex = this.findLastIndexBeforeOrAt(this.minuteData, now);

        if (lastValidIndex < 0) {
            return [];
        }

        // Get the last N entries directly by index
        const startIndex = Math.max(0, lastValidIndex - n + 1);
        const result: RecentPriceEntry[] = [];

        for (let i = startIndex; i <= lastValidIndex; i++) {
            const e = this.minuteData[i];
            result.push({
                timestamp: new Date(e.timestamp),
                price: e.price,
            });
        }

        return result;
    }

    // -------------------------------------------------------------------------
    // Utilities
    // -------------------------------------------------------------------------

    /**
     * Finds the most recent entry BEFORE the target time (strictly previous).
     * This avoids look-ahead bias by only returning data that would have been
     * available before the target time.
     */
    private findPreviousEntry<T extends { timestamp: number }>(
        data: T[],
        targetTime: number
    ): T | null {
        if (data.length === 0) return null;

        // If target is before or at first data point, no previous data exists
        if (targetTime <= data[0].timestamp) {
            return null;
        }

        // If target is after all data, return last entry
        if (targetTime > data[data.length - 1].timestamp) {
            return data[data.length - 1];
        }

        // Binary search for the last entry strictly before targetTime
        let left = 0;
        let right = data.length - 1;
        let result: T | null = null;

        while (left <= right) {
            const mid = Math.floor((left + right) / 2);
            if (data[mid].timestamp < targetTime) {
                result = data[mid];
                left = mid + 1;
            } else {
                right = mid - 1;
            }
        }

        return result;
    }

    private calculateAverage(values: number[]): number {
        if (values.length === 0) return 0;
        return values.reduce((sum, val) => sum + val, 0) / values.length;
    }

    /**
     * Finds the index of the last entry strictly before the target time.
     * Uses cached index for optimization when time advances monotonically.
     */
    private findLastIndexBefore<T extends { timestamp: number }>(
        data: T[],
        targetTime: number,
        isHourly: boolean
    ): number {
        if (data.length === 0) return -1;

        // Check cache - if time hasn't changed much, start from cached position
        const lastTime = isHourly ? this.lastHourlySearchTime : this.lastMinuteSearchTime;
        const lastIndex = isHourly ? this.lastHourlySearchIndex : this.lastMinuteSearchIndex;

        // If target time is same or very close, return cached result
        if (targetTime === lastTime && lastIndex >= 0) {
            return lastIndex;
        }

        // If time advanced, we can start search from cached index
        let startIndex = 0;
        if (targetTime > lastTime && lastIndex >= 0 && lastIndex < data.length) {
            startIndex = lastIndex;
        }

        // Linear scan from start position for small advances (common case)
        if (targetTime > lastTime && startIndex < data.length - 1) {
            let i = startIndex;
            while (i < data.length && data[i].timestamp < targetTime) {
                i++;
            }
            const result = i > 0 ? i - 1 : -1;

            // Update cache
            if (isHourly) {
                this.lastHourlySearchTime = targetTime;
                this.lastHourlySearchIndex = result;
            } else {
                this.lastMinuteSearchTime = targetTime;
                this.lastMinuteSearchIndex = result;
            }
            return result;
        }

        // Fallback to binary search for non-monotonic access
        let left = 0;
        let right = data.length - 1;
        let result = -1;

        while (left <= right) {
            const mid = Math.floor((left + right) / 2);
            if (data[mid].timestamp < targetTime) {
                result = mid;
                left = mid + 1;
            } else {
                right = mid - 1;
            }
        }

        // Update cache
        if (isHourly) {
            this.lastHourlySearchTime = targetTime;
            this.lastHourlySearchIndex = result;
        } else {
            this.lastMinuteSearchTime = targetTime;
            this.lastMinuteSearchIndex = result;
        }

        return result;
    }

    /**
     * Finds the index of the last entry at or before the target time.
     */
    private findLastIndexBeforeOrAt<T extends { timestamp: number }>(
        data: T[],
        targetTime: number
    ): number {
        if (data.length === 0) return -1;

        // Binary search for the last entry at or before targetTime
        let left = 0;
        let right = data.length - 1;
        let result = -1;

        while (left <= right) {
            const mid = Math.floor((left + right) / 2);
            if (data[mid].timestamp <= targetTime) {
                result = mid;
                left = mid + 1;
            } else {
                right = mid - 1;
            }
        }

        return result;
    }

    /**
     * Gets the available data time range.
     */
    public getDataRange(): { start: Date; end: Date } | null {
        if (this.minuteData.length === 0) return null;

        return {
            start: new Date(this.minuteData[0].timestamp),
            end: new Date(this.minuteData[this.minuteData.length - 1].timestamp),
        };
    }
}
