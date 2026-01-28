import { readFileSync, existsSync } from 'fs';
import { Side } from '@polymarket/clob-client';
import { SimulationClock } from './SimulationClock.js';
import { CoinType } from './GeneticOptimizer.js';
import { IMarketInfo, BtcOrderBooks, OrderBookSummary, TargetedMarket, MarketSchedule } from '../types/interfaces.js';

// ============================================================================
// Types & Interfaces
// ============================================================================

interface UpDownPriceEntry {
    timestamp: number;
    upPrice: number;
    downPrice: number;
}

export interface MarketInfoSimple {
    clobTokenIds: string[];
    outcomePrices: string[];
    error?: boolean;
}

interface MarketLogPaths {
    hourly: string;
    quarterly: string;
}

// ============================================================================
// MockMarketInfo Class
// ============================================================================

/**
 * Mock implementation of MarketInfo that reads from historical log files
 * and returns data based on the simulation clock's current time.
 * Implements IMarketInfo interface for use with QuantBot.
 */
export class MockMarketInfo implements IMarketInfo {
    private static readonly LOG_PATHS: Record<CoinType, MarketLogPaths> = {
        [CoinType.BTC]: {
            hourly: './logs/pmarket-price/btc.log',
            quarterly: './logs/pmarket-price/btc-minutely.log',
        },
        [CoinType.ETH]: {
            hourly: './logs/pmarket-price/ethereum.log',
            quarterly: './logs/pmarket-price/ethereum-minutely.log',
        },
        [CoinType.SOL]: {
            hourly: './logs/pmarket-price/solana.log',
            quarterly: './logs/pmarket-price/solana-minutely.log',
        },
        [CoinType.XRP]: {
            hourly: './logs/pmarket-price/xrp.log',
            quarterly: './logs/pmarket-price/xrp-minutely.log',
        },
    };

    private clock: SimulationClock;
    private coinType: CoinType;
    private hourlyData: UpDownPriceEntry[] = [];
    private quarterlyData: UpDownPriceEntry[] = [];

    // Track winners for lookback queries (hourly and 15-minute intervals)
    private hourWinners: Map<string, 'UP' | 'DOWN'> = new Map();
    private quarterWinners: Map<string, 'UP' | 'DOWN'> = new Map();

    // Pre-indexed data for O(1) period lookups
    private hourlyByPeriod: Map<string, UpDownPriceEntry[]> = new Map();
    private quarterlyByPeriod: Map<string, UpDownPriceEntry[]> = new Map();

    // Key calculation cache to avoid repeated Date object creation
    private keyCache: Map<number, { hourKey: string; quarterKey: string }> = new Map();
    private static readonly KEY_CACHE_MAX_SIZE = 10000;

    constructor(clock: SimulationClock, coinType: CoinType = CoinType.BTC) {
        this.clock = clock;
        this.coinType = coinType;
        this.loadData();
    }

    // -------------------------------------------------------------------------
    // Data Loading
    // -------------------------------------------------------------------------

    private loadData(): void {
        const paths = MockMarketInfo.LOG_PATHS[this.coinType];
        this.hourlyData = this.loadLogFile(paths.hourly);
        this.quarterlyData = this.loadLogFile(paths.quarterly);

        // Build period-indexed maps for O(1) lookups
        this.buildPeriodIndex();

        this.computeHourWinners();
        this.computeQuarterWinners();

        console.log(`[MockMarketInfo] Loaded ${this.hourlyData.length} hourly, ${this.quarterlyData.length} quarterly entries for ${this.coinType.toUpperCase()}`);
    }

    /**
     * Builds period-indexed maps for fast lookups.
     */
    private buildPeriodIndex(): void {
        // Index hourly data
        for (const entry of this.hourlyData) {
            const hourKey = this.getHourKeyDirect(entry.timestamp);
            if (!this.hourlyByPeriod.has(hourKey)) {
                this.hourlyByPeriod.set(hourKey, []);
            }
            this.hourlyByPeriod.get(hourKey)!.push(entry);
        }

        // Index quarterly data
        for (const entry of this.quarterlyData) {
            const quarterKey = this.get15MinuteKeyDirect(entry.timestamp);
            if (!this.quarterlyByPeriod.has(quarterKey)) {
                this.quarterlyByPeriod.set(quarterKey, []);
            }
            this.quarterlyByPeriod.get(quarterKey)!.push(entry);
        }
    }

    /**
     * Direct key calculation without caching (used for indexing at load time).
     */
    private getHourKeyDirect(timestamp: number): string {
        const date = new Date(timestamp);
        return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}-${date.getHours()}`;
    }

    /**
     * Direct 15-minute key calculation without caching.
     */
    private get15MinuteKeyDirect(timestamp: number): string {
        const date = new Date(timestamp);
        const quarter = Math.floor(date.getMinutes() / 15);
        return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}-${date.getHours()}-${quarter}`;
    }

    private loadLogFile(logPath: string): UpDownPriceEntry[] {
        if (!existsSync(logPath)) {
            console.warn(`[MockMarketInfo] Log not found: ${logPath}`);
            return [];
        }

        const content = readFileSync(logPath, 'utf-8');
        const lines = content.trim().split('\n').filter(line => line.trim());

        return lines.map(line => {
            const parts = line.split(',').map(p => p.trim());
            return {
                timestamp: new Date(parts[0]).getTime(),
                upPrice: parseFloat(parts[1]),
                downPrice: parseFloat(parts[2]),
            };
        }).sort((a, b) => a.timestamp - b.timestamp);
    }

    /**
     * Pre-compute hour winners based on end-of-hour prices.
     * Uses pre-indexed data for efficiency.
     */
    private computeHourWinners(): void {
        for (const [hourKey, entries] of this.hourlyByPeriod) {
            if (entries.length === 0) continue;
            const lastEntry = entries[entries.length - 1];
            const winner = lastEntry.upPrice >= lastEntry.downPrice ? 'UP' : 'DOWN';
            this.hourWinners.set(hourKey, winner);
        }
    }

    /**
     * Pre-compute 15-minute winners based on end-of-quarter prices.
     * Uses pre-indexed data for efficiency.
     */
    private computeQuarterWinners(): void {
        for (const [quarterKey, entries] of this.quarterlyByPeriod) {
            if (entries.length === 0) continue;
            const lastEntry = entries[entries.length - 1];
            const winner = lastEntry.upPrice >= lastEntry.downPrice ? 'UP' : 'DOWN';
            this.quarterWinners.set(quarterKey, winner);
        }
    }

    /**
     * Gets cached keys for a timestamp, computing and caching if needed.
     */
    private getCachedKeys(timestamp: number): { hourKey: string; quarterKey: string } {
        // Round to nearest minute to improve cache hit rate
        const roundedTs = Math.floor(timestamp / 60000) * 60000;

        let cached = this.keyCache.get(roundedTs);
        if (!cached) {
            // Evict old entries if cache is too large
            if (this.keyCache.size >= MockMarketInfo.KEY_CACHE_MAX_SIZE) {
                // Clear half the cache (simple eviction strategy)
                const entries = Array.from(this.keyCache.keys());
                for (let i = 0; i < entries.length / 2; i++) {
                    this.keyCache.delete(entries[i]);
                }
            }

            cached = {
                hourKey: this.getHourKeyDirect(roundedTs),
                quarterKey: this.get15MinuteKeyDirect(roundedTs),
            };
            this.keyCache.set(roundedTs, cached);
        }
        return cached;
    }

    private getHourKey(timestamp: number): string {
        return this.getCachedKeys(timestamp).hourKey;
    }

    private get15MinuteKey(timestamp: number): string {
        return this.getCachedKeys(timestamp).quarterKey;
    }

    /**
     * Gets the market schedule for a given TargetedMarket.
     */
    public static getMarketSchedule(market: TargetedMarket): MarketSchedule {
        switch (market) {
            case TargetedMarket.BITCOIN_HOURLY:
            case TargetedMarket.ETHEREUM_HOURLY:
            case TargetedMarket.SOLANA_HOURLY:
            case TargetedMarket.XRP_HOURLY:
                return MarketSchedule.HOURLY;
            case TargetedMarket.BITCOIN_QUARTERLY:
            case TargetedMarket.ETHEREUM_QUARTERLY:
            case TargetedMarket.SOLANA_QUARTERLY:
            case TargetedMarket.XRP_QUARTERLY:
                return MarketSchedule.QUARTERLY;
            default:
                return MarketSchedule.HOURLY;
        }
    }

    /**
     * Gets the appropriate data set based on market schedule.
     */
    private getDataForMarket(market?: TargetedMarket): UpDownPriceEntry[] {
        if (!market) return this.hourlyData;
        const schedule = MockMarketInfo.getMarketSchedule(market);
        return schedule === MarketSchedule.QUARTERLY ? this.quarterlyData : this.hourlyData;
    }

    /**
     * Gets the appropriate period key based on market schedule.
     */
    private getPeriodKey(timestamp: number, market?: TargetedMarket): string {
        if (!market) return this.getHourKey(timestamp);
        const schedule = MockMarketInfo.getMarketSchedule(market);
        return schedule === MarketSchedule.QUARTERLY
            ? this.get15MinuteKey(timestamp)
            : this.getHourKey(timestamp);
    }

    // -------------------------------------------------------------------------
    // Public API - Time
    // -------------------------------------------------------------------------

    public getCurrentEstTimestamp(): number {
        return this.clock.getCurrentEstTimestamp();
    }

    public parseTimestamp(timestamp: number): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
        const date = new Date(timestamp);
        return {
            year: date.getFullYear(),
            month: date.getMonth() + 1,
            day: date.getDate(),
            hour: date.getHours(),
            minute: date.getMinutes(),
            second: date.getSeconds(),
        };
    }

    public getMonthName(month: number): string {
        const months = [
            "january", "february", "march", "april",
            "may", "june", "july", "august",
            "september", "october", "november", "december"
        ];
        return months[month - 1] ?? "";
    }

    // -------------------------------------------------------------------------
    // Public API - Market Data
    // -------------------------------------------------------------------------

    /**
     * Gets the UP/DOWN prices at the current simulated time.
     * Uses hourly data by default; pass market parameter for quarterly support.
     * For quarterly markets, uses retry logic to find data within the current 15-minute period.
     */
    public async getPrice(clobTokenId: string, side: Side, market?: TargetedMarket): Promise<number> {
        const now = this.clock.now();
        const data = this.getDataForMarket(market);

        let entry: UpDownPriceEntry | null;

        // For quarterly markets, use retry logic to wait for current period data
        if (market && MockMarketInfo.getMarketSchedule(market) === MarketSchedule.QUARTERLY) {
            entry = this.findEntryForCurrentPeriodSync(data, now);
            if (!entry) {
                throw new Error(`No data available for current 15-minute period after retries. Current time: ${new Date(now).toISOString()}`);
            }
        } else {
            entry = this.findPreviousEntry(data, now);
            if (!entry) {
                throw new Error(`No UP/DOWN data available for timestamp ${new Date(now).toISOString()}`);
            }
        }

        // Determine if this is UP or DOWN token based on ID
        const isUpToken = clobTokenId.startsWith('UP-');

        // Return bid price for BUY, ask price for SELL (with small spread simulation)
        const basePrice = isUpToken ? entry.upPrice : entry.downPrice;
        const spreadAdjustment = side === Side.BUY ? -0.01 : 0.01;

        return Math.max(0.01, Math.min(0.99, basePrice + spreadAdjustment));
    }

    /**
     * Gets mock order books for the current simulated time.
     * Supports both hourly and quarterly markets based on market parameter.
     * For quarterly markets, uses retry logic to find data within the current 15-minute period.
     */
    public async getLiveData(market?: TargetedMarket): Promise<BtcOrderBooks> {
        const now = this.clock.now();
        const data = this.getDataForMarket(market);

        let entry: UpDownPriceEntry | null;

        // For quarterly markets, use retry logic to wait for current period data
        if (market && MockMarketInfo.getMarketSchedule(market) === MarketSchedule.QUARTERLY) {
            entry = this.findEntryForCurrentPeriodSync(data, now);
            if (!entry) {
                throw new Error(`No data available for current 15-minute period after retries. Current time: ${new Date(now).toISOString()}`);
            }
        } else {
            entry = this.findPreviousEntry(data, now);
            if (!entry) {
                throw new Error(`No UP/DOWN data available for timestamp ${new Date(now).toISOString()}`);
            }
        }

        const periodKey = this.getPeriodKey(now, market);

        return {
            BtcUpTokenId: `UP-${periodKey}`,
            BtcUp: this.createMockOrderBook(entry.upPrice),
            BtcDownTokenId: `DOWN-${periodKey}`,
            BtcDown: this.createMockOrderBook(entry.downPrice),
        };
    }

    /**
     * Gets mock CLOB token IDs for the current period.
     * Uses hourly intervals for hourly markets, 15-minute intervals for quarterly markets.
     */
    public async getCurrentClobTokenIds(market?: TargetedMarket): Promise<string[]> {
        const periodKey = this.getPeriodKey(this.clock.now(), market);
        return [`UP-${periodKey}`, `DOWN-${periodKey}`];
    }

    /**
     * Constructs a Polymarket-style URL (for compatibility).
     */
    public getBitcoinHourlyUrl(timestamp: number): string {
        const time = this.parseTimestamp(timestamp);
        let stringHour = "";
        if (time.hour === 0) {
            stringHour = "12am";
        } else if (time.hour === 12) {
            stringHour = "12pm";
        } else if (time.hour > 12) {
            stringHour = `${time.hour - 12}pm`;
        } else {
            stringHour = `${time.hour}am`;
        }

        const stringMonth = this.getMonthName(time.month);
        return `mock://bitcoin-up-or-down-${stringMonth}-${time.day}-${stringHour}-et`;
    }

    /**
     * Gets market info for a specific period (for lookback queries).
     * Supports both hourly and quarterly URL formats.
     */
    public async getMarketInfo(url: string): Promise<MarketInfoSimple> {
        // Check if quarterly URL format
        const quarterlyMatch = url.match(/bitcoin-quarterly-(\w+)-(\d+)-(\d+)(am|pm)-q(\d)-et/);
        if (quarterlyMatch) {
            return this.getQuarterlyMarketInfo(quarterlyMatch);
        }

        // Parse hourly URL format: mock://bitcoin-up-or-down-{month}-{day}-{hour}-et
        const match = url.match(/bitcoin-up-or-down-(\w+)-(\d+)-(\d+)(am|pm)-et/);

        if (!match) {
            throw new Error(`Unable to parse URL: ${url}`);
        }

        const monthName = match[1];
        const day = parseInt(match[2]);
        const rawHour = parseInt(match[3]);
        const ampm = match[4];

        // Convert to 24-hour format
        let hour = rawHour;
        if (ampm === 'pm' && rawHour !== 12) hour += 12;
        if (ampm === 'am' && rawHour === 12) hour = 0;

        // Find month number
        const months = ["january", "february", "march", "april", "may", "june",
            "july", "august", "september", "october", "november", "december"];
        const month = months.indexOf(monthName);

        // Get year from current simulated time
        const year = new Date(this.clock.now()).getFullYear();

        // Find the entry for this hour
        const targetDate = new Date(year, month, day, hour);
        const hourKey = this.getHourKey(targetDate.getTime());

        // Get end-of-hour prices using indexed data (O(1) lookup)
        const hourEntries = this.hourlyByPeriod.get(hourKey);

        if (!hourEntries || hourEntries.length === 0) {
            // Return neutral prices if no data
            return {
                clobTokenIds: [`UP-${hourKey}`, `DOWN-${hourKey}`],
                outcomePrices: ['0.50', '0.50'],
            };
        }

        const lastEntry = hourEntries[hourEntries.length - 1];

        return {
            clobTokenIds: [`UP-${hourKey}`, `DOWN-${hourKey}`],
            outcomePrices: [lastEntry.upPrice.toString(), lastEntry.downPrice.toString()],
        };
    }

    /**
     * Parses quarterly URL and returns market info.
     */
    private getQuarterlyMarketInfo(match: RegExpMatchArray): MarketInfoSimple {
        const monthName = match[1];
        const day = parseInt(match[2]);
        const rawHour = parseInt(match[3]);
        const ampm = match[4];
        const quarter = parseInt(match[5]);

        // Convert to 24-hour format
        let hour = rawHour;
        if (ampm === 'pm' && rawHour !== 12) hour += 12;
        if (ampm === 'am' && rawHour === 12) hour = 0;

        // Find month number
        const months = ["january", "february", "march", "april", "may", "june",
            "july", "august", "september", "october", "november", "december"];
        const month = months.indexOf(monthName);

        // Get year from current simulated time
        const year = new Date(this.clock.now()).getFullYear();

        // Find the entry for this 15-minute period
        const minute = quarter * 15;
        const targetDate = new Date(year, month, day, hour, minute);
        const quarterKey = this.get15MinuteKey(targetDate.getTime());

        // Get end-of-quarter prices using indexed data (O(1) lookup)
        const quarterEntries = this.quarterlyByPeriod.get(quarterKey);

        if (!quarterEntries || quarterEntries.length === 0) {
            // Return neutral prices if no data
            return {
                clobTokenIds: [`UP-${quarterKey}`, `DOWN-${quarterKey}`],
                outcomePrices: ['0.50', '0.50'],
            };
        }

        const lastEntry = quarterEntries[quarterEntries.length - 1];

        return {
            clobTokenIds: [`UP-${quarterKey}`, `DOWN-${quarterKey}`],
            outcomePrices: [lastEntry.upPrice.toString(), lastEntry.downPrice.toString()],
        };
    }

    /**
     * Gets the winner for a specific period.
     * For hourly markets, returns hourly winner; for quarterly, returns 15-minute winner.
     */
    public getHourWinner(timestamp: number, market?: TargetedMarket): 'UP' | 'DOWN' | null {
        if (market && MockMarketInfo.getMarketSchedule(market) === MarketSchedule.QUARTERLY) {
            const quarterKey = this.get15MinuteKey(timestamp);
            return this.quarterWinners.get(quarterKey) ?? null;
        }
        const hourKey = this.getHourKey(timestamp);
        return this.hourWinners.get(hourKey) ?? null;
    }

    /**
     * Gets the winner for a specific 15-minute period (quarterly markets).
     */
    public getQuarterWinner(timestamp: number): 'UP' | 'DOWN' | null {
        const quarterKey = this.get15MinuteKey(timestamp);
        return this.quarterWinners.get(quarterKey) ?? null;
    }

    // -------------------------------------------------------------------------
    // Utilities
    // -------------------------------------------------------------------------

    /**
     * Finds the most recent entry BEFORE the target time (strictly previous).
     * This avoids look-ahead bias by only returning data that would have been
     * available before the target time.
     */
    private findPreviousEntry(data: UpDownPriceEntry[], targetTime: number): UpDownPriceEntry | null {
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
        let result: UpDownPriceEntry | null = null;

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

    /**
     * Finds entry for current 15-minute period using indexed data.
     * Falls back to previous period's last entry if current period has no data yet.
     */
    private findEntryForCurrentPeriodSync(
        data: UpDownPriceEntry[],
        startTime: number,
        _maxWaitMs: number = 30000,
        _incrementMs: number = 5000
    ): UpDownPriceEntry | null {
        const currentPeriodKey = this.get15MinuteKey(startTime);

        // First, try to get data from the indexed map (O(1) lookup)
        const periodEntries = this.quarterlyByPeriod.get(currentPeriodKey);
        if (periodEntries && periodEntries.length > 0) {
            // Find the most recent entry before startTime within this period
            for (let i = periodEntries.length - 1; i >= 0; i--) {
                if (periodEntries[i].timestamp < startTime) {
                    return periodEntries[i];
                }
            }
            // If we're at the very start of the period, return the first entry
            // (this simulates "waiting" for data to appear)
            return periodEntries[0];
        }

        // Fallback to binary search if indexed lookup fails
        return this.findPreviousEntry(data, startTime);
    }

    private createMockOrderBook(price: number): OrderBookSummary {
        const bidPrice = Math.max(0.01, price - 0.01);
        const askPrice = Math.min(0.99, price + 0.01);

        return {
            bids: [{ price: bidPrice.toFixed(2), size: '1000' }],
            asks: [{ price: askPrice.toFixed(2), size: '1000' }],
        };
    }

    /**
     * Gets the URL for a specific market at a timestamp (for IMarketInfo compatibility).
     */
    public getUrl(timestamp: number, market?: TargetedMarket): string {
        if (market && MockMarketInfo.getMarketSchedule(market) === MarketSchedule.QUARTERLY) {
            return this.getQuarterlyUrl(timestamp);
        }
        return this.getBitcoinHourlyUrl(timestamp);
    }

    /**
     * Constructs a mock URL for quarterly markets.
     */
    private getQuarterlyUrl(timestamp: number): string {
        const time = this.parseTimestamp(timestamp);
        const quarter = Math.floor(time.minute / 15);
        const stringMonth = this.getMonthName(time.month);

        let stringHour = "";
        if (time.hour === 0) {
            stringHour = "12am";
        } else if (time.hour === 12) {
            stringHour = "12pm";
        } else if (time.hour > 12) {
            stringHour = `${time.hour - 12}pm`;
        } else {
            stringHour = `${time.hour}am`;
        }

        return `mock://bitcoin-quarterly-${stringMonth}-${time.day}-${stringHour}-q${quarter}-et`;
    }

    /**
     * Gets the available data time range.
     * Returns the combined range of both hourly and quarterly data.
     */
    public getDataRange(market?: TargetedMarket): { start: Date; end: Date } | null {
        const data = this.getDataForMarket(market);
        if (data.length === 0) return null;

        return {
            start: new Date(data[0].timestamp),
            end: new Date(data[data.length - 1].timestamp),
        };
    }

    /**
     * Gets combined data range across all loaded data.
     */
    public getAllDataRange(): { start: Date; end: Date } | null {
        const allData = [...this.hourlyData, ...this.quarterlyData];
        if (allData.length === 0) return null;

        const timestamps = allData.map(d => d.timestamp);
        return {
            start: new Date(Math.min(...timestamps)),
            end: new Date(Math.max(...timestamps)),
        };
    }
}
