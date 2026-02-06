import { readFileSync, existsSync } from 'fs';
import { CoinType } from '../simulation/GeneticOptimizer.js';
import { MarketSchedule } from '../types/interfaces.js';
import { PredictionStyle, PredictionStyleConfig, getPredictionStyleConfig } from './types.js';

// ============================================================================
// Types
// ============================================================================

export interface UpDownPriceEntry {
    timestamp: number;
    upBid: number;
    upAsk: number;
    downBid: number;
    downAsk: number;
}

export interface HourlyDataEntry {
    timestamp: number;
    hourlyOpen: number;
    averagePrice: number;
    hourlyMin: number;
    hourlyMax: number;
    openFlops: number;
    averageFlops: number;
    totalChange: number;
}

export interface MinuteDataEntry {
    timestamp: number;
    price: number;
}

export interface AlignedPeriodData {
    timestamp: number;
    periodKey: string;
    outcome: 'UP' | 'DOWN' | null;    // null if period incomplete

    // Polymarket order book data (array of snapshots during period)
    pmarketSnapshots: UpDownPriceEntry[];

    // Binance price data (minute-by-minute)
    minutePrices: MinuteDataEntry[];

    // Hourly aggregates (if available)
    hourlyData: HourlyDataEntry | null;
}

export interface PreparedDataset {
    coinType: CoinType;
    schedule: MarketSchedule;
    periods: AlignedPeriodData[];
    dateRange: { start: Date; end: Date };
    totalSamples: number;
    upWins: number;
    downWins: number;
}

// ============================================================================
// Log Path Configuration
// ============================================================================

const LOG_PATHS: Record<CoinType, {
    pmarketHourly: string;
    pmarketQuarterly: string;
    binanceHourly: string;
    binanceMinute: string;
}> = {
    [CoinType.BTC]: {
        pmarketHourly: './logs/pmarket-price/btc.log',
        pmarketQuarterly: './logs/pmarket-price/btc-minutely.log',
        binanceHourly: './logs/market/btc-hourly.log',
        binanceMinute: './logs/market/btc-minute.log',
    },
    [CoinType.ETH]: {
        pmarketHourly: './logs/pmarket-price/ethereum.log',
        pmarketQuarterly: './logs/pmarket-price/ethereum-minutely.log',
        binanceHourly: './logs/market/eth-hourly.log',
        binanceMinute: './logs/market/eth-minute.log',
    },
    [CoinType.SOL]: {
        pmarketHourly: './logs/pmarket-price/solana.log',
        pmarketQuarterly: './logs/pmarket-price/solana-minutely.log',
        binanceHourly: './logs/market/sol-hourly.log',
        binanceMinute: './logs/market/sol-minute.log',
    },
    [CoinType.XRP]: {
        pmarketHourly: './logs/pmarket-price/xrp.log',
        pmarketQuarterly: './logs/pmarket-price/xrp-minutely.log',
        binanceHourly: './logs/market/xrp-hourly.log',
        binanceMinute: './logs/market/xrp-minute.log',
    },
};

// ============================================================================
// DataPreparation Class
// ============================================================================

export class DataPreparation {
    private coinType: CoinType;
    private schedule: MarketSchedule;

    // Raw loaded data
    private pmarketData: UpDownPriceEntry[] = [];
    private binanceHourlyData: HourlyDataEntry[] = [];
    private binanceMinuteData: MinuteDataEntry[] = [];

    // Indexed by period for fast lookup
    private pmarketByPeriod: Map<string, UpDownPriceEntry[]> = new Map();
    private hourlyByPeriod: Map<string, HourlyDataEntry> = new Map();
    private minuteByTimestamp: Map<number, number> = new Map();

    constructor(coinType: CoinType, schedule: MarketSchedule = MarketSchedule.HOURLY) {
        this.coinType = coinType;
        this.schedule = schedule;
    }

    // -------------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------------

    /**
     * Loads all data sources and prepares aligned dataset.
     */
    public prepare(): PreparedDataset {
        console.log(`[DataPreparation] Loading data for ${this.coinType.toUpperCase()} (${this.schedule})...`);

        this.loadAllData();
        this.indexData();

        const periods = this.alignPeriods();
        const completePeriods = periods.filter(p => p.outcome !== null);

        const upWins = completePeriods.filter(p => p.outcome === 'UP').length;
        const downWins = completePeriods.filter(p => p.outcome === 'DOWN').length;

        const timestamps = completePeriods.map(p => p.timestamp);
        const dateRange = {
            start: new Date(Math.min(...timestamps)),
            end: new Date(Math.max(...timestamps)),
        };

        console.log(`[DataPreparation] Prepared ${completePeriods.length} periods (UP: ${upWins}, DOWN: ${downWins})`);
        console.log(`[DataPreparation] Date range: ${dateRange.start.toISOString()} to ${dateRange.end.toISOString()}`);

        return {
            coinType: this.coinType,
            schedule: this.schedule,
            periods: completePeriods,
            dateRange,
            totalSamples: completePeriods.length,
            upWins,
            downWins,
        };
    }

    /**
     * Gets minute prices for a specific time range.
     * Useful for feature engineering lookback.
     */
    public getMinutePrices(startTime: number, endTime: number): MinuteDataEntry[] {
        return this.binanceMinuteData.filter(
            e => e.timestamp >= startTime && e.timestamp <= endTime
        );
    }

    /**
     * Gets the closest minute price to a timestamp.
     */
    public getClosestMinutePrice(timestamp: number): number | null {
        // Round to nearest minute
        const roundedTs = Math.floor(timestamp / 60000) * 60000;

        // Try exact match first
        const exact = this.minuteByTimestamp.get(roundedTs);
        if (exact !== undefined) return exact;

        // Search nearby (within 5 minutes)
        for (let offset = 60000; offset <= 300000; offset += 60000) {
            const before = this.minuteByTimestamp.get(roundedTs - offset);
            if (before !== undefined) return before;
            const after = this.minuteByTimestamp.get(roundedTs + offset);
            if (after !== undefined) return after;
        }

        return null;
    }

    // -------------------------------------------------------------------------
    // Data Loading
    // -------------------------------------------------------------------------

    private loadAllData(): void {
        const paths = LOG_PATHS[this.coinType];

        // Load Polymarket data based on schedule
        const pmarketPath = this.schedule === MarketSchedule.QUARTERLY
            ? paths.pmarketQuarterly
            : paths.pmarketHourly;
        this.pmarketData = this.loadPmarketLog(pmarketPath);

        // Load Binance data
        this.binanceHourlyData = this.loadHourlyLog(paths.binanceHourly);
        this.binanceMinuteData = this.loadMinuteLog(paths.binanceMinute);

        console.log(`[DataPreparation] Loaded: ${this.pmarketData.length} pmarket, ${this.binanceHourlyData.length} hourly, ${this.binanceMinuteData.length} minute entries`);
    }

    private loadPmarketLog(logPath: string): UpDownPriceEntry[] {
        if (!existsSync(logPath)) {
            console.warn(`[DataPreparation] Pmarket log not found: ${logPath}`);
            return [];
        }

        const content = readFileSync(logPath, 'utf-8');
        const lines = content.trim().split('\n').filter(line => line.trim());

        return lines.map(line => {
            const parts = line.split(',').map(p => p.trim());

            if (parts.length >= 5) {
                // New format: timestamp,upBid,upAsk,downBid,downAsk
                return {
                    timestamp: new Date(parts[0]).getTime(),
                    upBid: parseFloat(parts[1]),
                    upAsk: parseFloat(parts[2]),
                    downBid: parseFloat(parts[3]),
                    downAsk: parseFloat(parts[4]),
                };
            } else {
                // Old format: timestamp,upPrice,downPrice
                const upPrice = parseFloat(parts[1]);
                const downPrice = parseFloat(parts[2]);
                return {
                    timestamp: new Date(parts[0]).getTime(),
                    upBid: Math.max(0.01, upPrice - 0.01),
                    upAsk: Math.min(0.99, upPrice + 0.01),
                    downBid: Math.max(0.01, downPrice - 0.01),
                    downAsk: Math.min(0.99, downPrice + 0.01),
                };
            }
        }).filter(e => !isNaN(e.timestamp) && !isNaN(e.upBid))
            .sort((a, b) => a.timestamp - b.timestamp);
    }

    private loadHourlyLog(logPath: string): HourlyDataEntry[] {
        if (!existsSync(logPath)) {
            console.warn(`[DataPreparation] Hourly log not found: ${logPath}`);
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
        }).filter(e => !isNaN(e.timestamp) && !isNaN(e.hourlyOpen))
            .sort((a, b) => a.timestamp - b.timestamp);
    }

    private loadMinuteLog(logPath: string): MinuteDataEntry[] {
        if (!existsSync(logPath)) {
            console.warn(`[DataPreparation] Minute log not found: ${logPath}`);
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
        }).filter(e => !isNaN(e.timestamp) && !isNaN(e.price))
            .sort((a, b) => a.timestamp - b.timestamp);
    }

    // -------------------------------------------------------------------------
    // Data Indexing
    // -------------------------------------------------------------------------

    private indexData(): void {
        // Index Polymarket data by period
        for (const entry of this.pmarketData) {
            const periodKey = this.getPeriodKey(entry.timestamp);
            if (!this.pmarketByPeriod.has(periodKey)) {
                this.pmarketByPeriod.set(periodKey, []);
            }
            this.pmarketByPeriod.get(periodKey)!.push(entry);
        }

        // Index hourly data by hour key
        for (const entry of this.binanceHourlyData) {
            const hourKey = this.getHourKey(entry.timestamp);
            this.hourlyByPeriod.set(hourKey, entry);
        }

        // Index minute data by timestamp (rounded to minute)
        for (const entry of this.binanceMinuteData) {
            const roundedTs = Math.floor(entry.timestamp / 60000) * 60000;
            this.minuteByTimestamp.set(roundedTs, entry.price);
        }
    }

    private getPeriodKey(timestamp: number): string {
        const date = new Date(timestamp);
        if (this.schedule === MarketSchedule.QUARTERLY) {
            const quarter = Math.floor(date.getMinutes() / 15);
            return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}-${date.getHours()}-${quarter}`;
        }
        return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}-${date.getHours()}`;
    }

    private getHourKey(timestamp: number): string {
        const date = new Date(timestamp);
        return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}-${date.getHours()}`;
    }

    // -------------------------------------------------------------------------
    // Period Alignment
    // -------------------------------------------------------------------------

    private alignPeriods(): AlignedPeriodData[] {
        const periods: AlignedPeriodData[] = [];

        // Iterate through all Pmarket periods
        for (const [periodKey, pmarketSnapshots] of this.pmarketByPeriod) {
            if (pmarketSnapshots.length === 0) continue;

            // Get period start timestamp
            const periodStart = pmarketSnapshots[0].timestamp;

            // Determine outcome from end-of-period prices
            const outcome = this.determinePeriodOutcome(pmarketSnapshots);

            // Get minute prices for this period (and lookback)
            const periodEnd = this.getPeriodEndTime(periodStart);
            const lookbackStart = periodStart - 60 * 60 * 1000; // 1 hour lookback
            const minutePrices = this.getMinutePrices(lookbackStart, periodEnd);

            // Get hourly data if available
            const hourKey = this.getHourKey(periodStart);
            const hourlyData = this.hourlyByPeriod.get(hourKey) ?? null;

            periods.push({
                timestamp: periodStart,
                periodKey,
                outcome,
                pmarketSnapshots,
                minutePrices,
                hourlyData,
            });
        }

        return periods.sort((a, b) => a.timestamp - b.timestamp);
    }

    private determinePeriodOutcome(snapshots: UpDownPriceEntry[]): 'UP' | 'DOWN' | null {
        if (snapshots.length === 0) return null;

        // Find the most recent valid entry
        for (let i = snapshots.length - 1; i >= 0; i--) {
            const entry = snapshots[i];

            // Check for valid prices
            if (isNaN(entry.upBid) || isNaN(entry.upAsk) ||
                isNaN(entry.downBid) || isNaN(entry.downAsk)) {
                continue;
            }

            const upMid = (entry.upBid + entry.upAsk) / 2;
            const downMid = (entry.downBid + entry.downAsk) / 2;

            // Sanity check
            if (upMid + downMid <= 0.5) continue;

            return upMid >= downMid ? 'UP' : 'DOWN';
        }

        return null;
    }

    private getPeriodEndTime(periodStart: number): number {
        if (this.schedule === MarketSchedule.QUARTERLY) {
            return periodStart + 15 * 60 * 1000; // 15 minutes
        }
        return periodStart + 60 * 60 * 1000; // 1 hour
    }

    // -------------------------------------------------------------------------
    // Interval Label Determination
    // -------------------------------------------------------------------------

    /**
     * Determines the interval label (UP/DOWN) based on Binance price direction.
     *
     * For interval styles, we compare the Binance price at cutoffMinutes vs targetMinutes
     * to determine if the price went UP or DOWN.
     *
     * @param period The aligned period data
     * @param styleConfig The prediction style configuration
     * @returns 'UP' if price increased, 'DOWN' if decreased, null if insufficient data
     */
    public determineIntervalLabel(
        period: AlignedPeriodData,
        styleConfig: PredictionStyleConfig
    ): 'UP' | 'DOWN' | null {
        const periodStart = period.timestamp;
        const cutoffTime = periodStart + styleConfig.featureCutoffMinutes * 60 * 1000;
        const targetTime = periodStart + styleConfig.targetMinutes * 60 * 1000;

        // Get Binance price at cutoff time
        const priceAtCutoff = this.getClosestMinutePriceNear(period.minutePrices, cutoffTime);

        // Get Binance price at target time
        const priceAtTarget = this.getClosestMinutePriceNear(period.minutePrices, targetTime);

        if (priceAtCutoff === null || priceAtTarget === null) {
            return null;
        }

        // UP if price increased, DOWN if decreased
        return priceAtTarget >= priceAtCutoff ? 'UP' : 'DOWN';
    }

    /**
     * Gets the closest price to a target time from an array of minute prices.
     * Searches within a tolerance window.
     */
    private getClosestMinutePriceNear(
        prices: MinuteDataEntry[],
        targetTime: number,
        toleranceMs: number = 2 * 60 * 1000
    ): number | null {
        let closest: MinuteDataEntry | null = null;
        let closestDiff = Infinity;

        for (const p of prices) {
            const diff = Math.abs(p.timestamp - targetTime);
            if (diff < closestDiff && diff <= toleranceMs) {
                closest = p;
                closestDiff = diff;
            }
        }

        return closest?.price ?? null;
    }

    /**
     * Determines the label for a period based on the prediction style.
     *
     * For EOP styles: Uses the existing Polymarket-based outcome (upMid vs downMid at end of period)
     * For INTERVAL styles: Uses Binance price direction from cutoff to target time
     *
     * @param period The aligned period data
     * @param style The prediction style (defaults to EOP behavior if not provided)
     * @returns 'UP', 'DOWN', or null if unable to determine
     */
    public determineLabelForStyle(
        period: AlignedPeriodData,
        style?: PredictionStyle
    ): 'UP' | 'DOWN' | null {
        // If no style provided, use existing EOP behavior
        if (!style) {
            return period.outcome;
        }

        const styleConfig = getPredictionStyleConfig(style);

        if (styleConfig.targetType === 'EOP') {
            // EOP styles use the existing Polymarket-based outcome
            return period.outcome;
        } else {
            // INTERVAL styles use Binance price direction
            return this.determineIntervalLabel(period, styleConfig);
        }
    }
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Splits dataset into train/test based on time.
 * Uses the first `trainRatio` of data for training.
 */
export function splitByTime<T extends { timestamp: number }>(
    data: T[],
    trainRatio: number = 0.8
): { train: T[]; test: T[] } {
    const sorted = [...data].sort((a, b) => a.timestamp - b.timestamp);
    const splitIndex = Math.floor(sorted.length * trainRatio);

    return {
        train: sorted.slice(0, splitIndex),
        test: sorted.slice(splitIndex),
    };
}

/**
 * Filters dataset to a specific date range.
 */
export function filterByDateRange<T extends { timestamp: number }>(
    data: T[],
    startDate: Date,
    endDate: Date
): T[] {
    const startTs = startDate.getTime();
    const endTs = endDate.getTime();
    return data.filter(d => d.timestamp >= startTs && d.timestamp <= endTs);
}
