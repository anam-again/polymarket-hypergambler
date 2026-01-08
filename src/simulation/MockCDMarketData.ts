import { readFileSync, existsSync } from 'fs';
import { SimulationClock } from './SimulationClock.js';

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

export interface HistoricalAverages {
    hourlyOpen: number;
    averagePrice: number;
    hourlyMin: number;
    hourlyMax: number;
    openFlops: number;
    averageFlops: number;
    totalChange: number;
}

export interface RecentPriceEntry {
    timestamp: Date;
    price: number;
}

// ============================================================================
// MockCDMarketData Class
// ============================================================================

/**
 * Mock implementation of CDMarketData that reads from historical log files
 * and returns data based on the simulation clock's current time.
 */
export class MockCDMarketData {
    private static readonly HOURLY_LOG_PATH = './logs/market/CDMarketWriterData.log';
    private static readonly MINUTE_LOG_PATH = './logs/market/CDMarketWriterData2m.log';

    private clock: SimulationClock;
    private hourlyData: HourlyDataEntry[] = [];
    private minuteData: MinuteDataEntry[] = [];

    constructor(clock: SimulationClock) {
        this.clock = clock;
        this.loadData();
    }

    // -------------------------------------------------------------------------
    // Data Loading
    // -------------------------------------------------------------------------

    private loadData(): void {
        this.hourlyData = this.loadHourlyData();
        this.minuteData = this.loadMinuteData();

        console.log(`[MockCDMarketData] Loaded ${this.hourlyData.length} hourly entries, ${this.minuteData.length} minute entries`);
    }

    private loadHourlyData(): HourlyDataEntry[] {
        if (!existsSync(MockCDMarketData.HOURLY_LOG_PATH)) {
            console.warn(`[MockCDMarketData] Hourly log not found: ${MockCDMarketData.HOURLY_LOG_PATH}`);
            return [];
        }

        const content = readFileSync(MockCDMarketData.HOURLY_LOG_PATH, 'utf-8');
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
        if (!existsSync(MockCDMarketData.MINUTE_LOG_PATH)) {
            console.warn(`[MockCDMarketData] Minute log not found: ${MockCDMarketData.MINUTE_LOG_PATH}`);
            return [];
        }

        const content = readFileSync(MockCDMarketData.MINUTE_LOG_PATH, 'utf-8');
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
     * Gets the BTC price at the current simulated time.
     * Returns the most recent price entry before or at the current time.
     */
    public async getCurrentPrice(): Promise<number> {
        const now = this.clock.now();
        const entry = this.findNearestEntry(this.minuteData, now);

        if (!entry) {
            throw new Error(`No price data available for timestamp ${new Date(now).toISOString()}`);
        }

        return entry.price;
    }

    /**
     * Gets Binance price (same as getCurrentPrice for simulation).
     */
    public async getBinancePrice(symbol: string = 'BTCUSDT'): Promise<number> {
        return this.getCurrentPrice();
    }

    // -------------------------------------------------------------------------
    // Public API - Historical Data
    // -------------------------------------------------------------------------

    /**
     * Gets averages of the last N hourly entries before the current simulated time.
     */
    public getAverages(n: number): HistoricalAverages | null {
        const now = this.clock.now();
        const entries = this.hourlyData.filter(e => e.timestamp < now);

        if (entries.length < n) {
            return null;
        }

        const recentEntries = entries.slice(-n);

        return {
            hourlyOpen: this.calculateAverage(recentEntries.map(e => e.hourlyOpen)),
            averagePrice: this.calculateAverage(recentEntries.map(e => e.averagePrice)),
            hourlyMin: this.calculateAverage(recentEntries.map(e => e.hourlyMin)),
            hourlyMax: this.calculateAverage(recentEntries.map(e => e.hourlyMax)),
            openFlops: this.calculateAverage(recentEntries.map(e => e.openFlops)),
            averageFlops: this.calculateAverage(recentEntries.map(e => e.averageFlops)),
            totalChange: this.calculateAverage(recentEntries.map(e => e.totalChange)),
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
     */
    public getRecentPrices(n: number): RecentPriceEntry[] {
        const now = this.clock.now();
        const entries = this.minuteData
            .filter(e => e.timestamp <= now)
            .slice(-n);

        return entries.map(e => ({
            timestamp: new Date(e.timestamp),
            price: e.price,
        }));
    }

    // -------------------------------------------------------------------------
    // Utilities
    // -------------------------------------------------------------------------

    private findNearestEntry<T extends { timestamp: number }>(
        data: T[],
        targetTime: number
    ): T | null {
        if (data.length === 0) return null;

        // Binary search for the nearest entry at or before targetTime
        let left = 0;
        let right = data.length - 1;
        let result: T | null = null;

        while (left <= right) {
            const mid = Math.floor((left + right) / 2);
            if (data[mid].timestamp <= targetTime) {
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
