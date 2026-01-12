import { readFileSync, existsSync } from 'fs';
import { Side } from '@polymarket/clob-client';
import { SimulationClock } from './SimulationClock.js';

// ============================================================================
// Types & Interfaces
// ============================================================================

interface UpDownPriceEntry {
    timestamp: number;
    upPrice: number;
    downPrice: number;
}

interface BtcOrderBooks {
    BtcUpTokenId: string;
    BtcUp: MockOrderBook;
    BtcDownTokenId: string;
    BtcDown: MockOrderBook;
}

interface MockOrderBook {
    bids: { price: string; size: string }[];
    asks: { price: string; size: string }[];
}

interface MarketInfoSimple {
    clobTokenIds: string[];
    outcomePrices: string[];
}

// ============================================================================
// MockMarketInfo Class
// ============================================================================

/**
 * Mock implementation of MarketInfo that reads from historical log files
 * and returns data based on the simulation clock's current time.
 */
export class MockMarketInfo {
    private static readonly UPDOWN_LOG_PATH = './logs/pmarket-price/BTCHourlyUPDown.log';

    private clock: SimulationClock;
    private upDownData: UpDownPriceEntry[] = [];

    // Track hour winners for lookback queries
    private hourWinners: Map<string, 'UP' | 'DOWN'> = new Map();

    constructor(clock: SimulationClock) {
        this.clock = clock;
        this.loadData();
    }

    // -------------------------------------------------------------------------
    // Data Loading
    // -------------------------------------------------------------------------

    private loadData(): void {
        this.upDownData = this.loadUpDownData();
        this.computeHourWinners();

        console.log(`[MockMarketInfo] Loaded ${this.upDownData.length} UP/DOWN price entries`);
    }

    private loadUpDownData(): UpDownPriceEntry[] {
        if (!existsSync(MockMarketInfo.UPDOWN_LOG_PATH)) {
            console.warn(`[MockMarketInfo] UP/DOWN log not found: ${MockMarketInfo.UPDOWN_LOG_PATH}`);
            return [];
        }

        const content = readFileSync(MockMarketInfo.UPDOWN_LOG_PATH, 'utf-8');
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
     */
    private computeHourWinners(): void {
        // Group entries by hour
        const hourlyEntries = new Map<string, UpDownPriceEntry[]>();

        for (const entry of this.upDownData) {
            const hourKey = this.getHourKey(entry.timestamp);
            if (!hourlyEntries.has(hourKey)) {
                hourlyEntries.set(hourKey, []);
            }
            hourlyEntries.get(hourKey)!.push(entry);
        }

        // For each hour, determine winner based on final prices
        for (const [hourKey, entries] of hourlyEntries) {
            if (entries.length === 0) continue;

            const lastEntry = entries[entries.length - 1];
            const winner = lastEntry.upPrice >= lastEntry.downPrice ? 'UP' : 'DOWN';
            this.hourWinners.set(hourKey, winner);
        }
    }

    private getHourKey(timestamp: number): string {
        const date = new Date(timestamp);
        return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}-${date.getHours()}`;
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
     */
    public async getPrice(clobTokenId: string, side: Side): Promise<number> {
        const now = this.clock.now();
        const entry = this.findNearestEntry(now);

        if (!entry) {
            throw new Error(`No UP/DOWN data available for timestamp ${new Date(now).toISOString()}`);
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
     */
    public async getLiveData(): Promise<BtcOrderBooks> {
        const now = this.clock.now();
        const entry = this.findNearestEntry(now);

        if (!entry) {
            throw new Error(`No UP/DOWN data available for timestamp ${new Date(now).toISOString()}`);
        }

        const hourKey = this.getHourKey(now);

        return {
            BtcUpTokenId: `UP-${hourKey}`,
            BtcUp: this.createMockOrderBook(entry.upPrice),
            BtcDownTokenId: `DOWN-${hourKey}`,
            BtcDown: this.createMockOrderBook(entry.downPrice),
        };
    }

    /**
     * Gets mock CLOB token IDs for the current hour.
     */
    public async getCurrentClobTokenIds(): Promise<string[]> {
        const hourKey = this.getHourKey(this.clock.now());
        return [`UP-${hourKey}`, `DOWN-${hourKey}`];
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
     * Gets market info for a specific hour (for lookback queries).
     */
    public async getMarketInfo(url: string): Promise<MarketInfoSimple> {
        // Parse the URL to extract the timestamp
        // Format: mock://bitcoin-up-or-down-{month}-{day}-{hour}-et
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

        // Get end-of-hour prices
        const hourEntries = this.upDownData.filter(e => this.getHourKey(e.timestamp) === hourKey);

        if (hourEntries.length === 0) {
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
     * Gets the winner for a specific hour.
     */
    public getHourWinner(timestamp: number): 'UP' | 'DOWN' | null {
        const hourKey = this.getHourKey(timestamp);
        return this.hourWinners.get(hourKey) ?? null;
    }

    // -------------------------------------------------------------------------
    // Utilities
    // -------------------------------------------------------------------------

    private findNearestEntry(targetTime: number): UpDownPriceEntry | null {
        if (this.upDownData.length === 0) return null;

        // If target is before all data, return first entry
        if (targetTime < this.upDownData[0].timestamp) {
            return this.upDownData[0];
        }

        // If target is after all data, return last entry
        if (targetTime > this.upDownData[this.upDownData.length - 1].timestamp) {
            return this.upDownData[this.upDownData.length - 1];
        }

        let left = 0;
        let right = this.upDownData.length - 1;
        let result: UpDownPriceEntry | null = null;

        while (left <= right) {
            const mid = Math.floor((left + right) / 2);
            if (this.upDownData[mid].timestamp <= targetTime) {
                result = this.upDownData[mid];
                left = mid + 1;
            } else {
                right = mid - 1;
            }
        }

        return result;
    }

    private createMockOrderBook(price: number): MockOrderBook {
        const bidPrice = Math.max(0.01, price - 0.01);
        const askPrice = Math.min(0.99, price + 0.01);

        return {
            bids: [{ price: bidPrice.toFixed(2), size: '1000' }],
            asks: [{ price: askPrice.toFixed(2), size: '1000' }],
        };
    }

    /**
     * Gets the available data time range.
     */
    public getDataRange(): { start: Date; end: Date } | null {
        if (this.upDownData.length === 0) return null;

        return {
            start: new Date(this.upDownData[0].timestamp),
            end: new Date(this.upDownData[this.upDownData.length - 1].timestamp),
        };
    }
}
