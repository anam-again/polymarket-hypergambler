import cron from 'node-cron';
import dotenv from 'dotenv';
import { appendFileSync, readFileSync, existsSync } from 'fs';

import { QuantBotRun } from "./../bots/QuantBot.js";

// ============================================================================
// Types & Interfaces
// ============================================================================

interface HourlyData {
    hourlyOpen: number;
    averagePrice: number;
    averageFlops: number;
    openFlops: number;
    totalChange: number;
    hourlyMax: number;
    hourlyMin: number;
    previousPrice: number;
    previousAverageOver: boolean;
    previousOpenOver: boolean;
}

interface BinancePriceResponse {
    symbol: string;
    price: string;
}

export interface HistoricalDataEntry {
    timestamp: Date;
    hourlyOpen: number;
    averagePrice: number;
    hourlyMin: number;
    hourlyMax: number;
    openFlops: number;
    averageFlops: number;
    totalChange: number;
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
// CDMarketData Class (Singleton)
// ============================================================================

export class CDMarketData implements QuantBotRun {

    // -------------------------------------------------------------------------
    // Constants
    // -------------------------------------------------------------------------

    private static readonly PRICE_CACHE_TIMEOUT_MS = 1 * 29 * 1000;
    private static readonly PRICE_UPDATE_INTERVAL_MS = 1 * 30 * 1000;
    private static readonly RETRY_ATTEMPTS = 5;

    private static readonly HOURLY_LOG_PATH = './logs/market/CDMarketWriterData.log';
    private static readonly MINUTE_LOG_PATH = './logs/market/CDMarketWriterData2m.log';
    private static readonly ERROR_LOG_PATH = './logs/market/CDMarketWriterError.log';

    // -------------------------------------------------------------------------
    // Singleton
    // -------------------------------------------------------------------------

    private static instance: CDMarketData | null = null;

    public static getInstance(): CDMarketData {
        if (!CDMarketData.instance) {
            CDMarketData.instance = new CDMarketData();
        }
        return CDMarketData.instance;
    }

    // -------------------------------------------------------------------------
    // Properties
    // -------------------------------------------------------------------------

    private cronJob: cron.ScheduledTask | null = null;
    private priceUpdateInterval: NodeJS.Timeout | null = null;

    private priceCache: number | null = null;
    private priceCacheTimestamp: number = 0;
    private thisHourData!: HourlyData;

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    private constructor() {
        dotenv.config();
    }

    // -------------------------------------------------------------------------
    // Lifecycle
    // -------------------------------------------------------------------------

    public async run(): Promise<void> {
        await this.initializeHourlyData();
        this.startScheduledTasks();
    }

    public stop(): void {
        if (this.cronJob) {
            this.cronJob.stop();
            this.cronJob = null;
        }
        if (this.priceUpdateInterval) {
            clearInterval(this.priceUpdateInterval);
            this.priceUpdateInterval = null;
        }
    }

    // -------------------------------------------------------------------------
    // Public API - Price Data
    // -------------------------------------------------------------------------

    public async getCurrentPrice(): Promise<number> {
        if (this.isCacheValid()) {
            return this.priceCache!;
        }

        const price = await this.fetchPriceFromApi();
        this.updatePriceCache(price);
        return price;
    }

    public getCurrentHourData(): HourlyData | null {
        return this.thisHourData ?? null;
    }

    public async getBinancePrice(symbol: string = 'BTCUSDT'): Promise<number> {
        return this.fetchBinancePriceFromApi(symbol);
    }

    // -------------------------------------------------------------------------
    // Public API - Historical Data
    // -------------------------------------------------------------------------

    public getAverages(n: number): HistoricalAverages | null {
        const entries = this.readHourlyLogFile();

        if (entries.length < n) {
            this.logError(`Insufficient data: have ${entries.length} entries, need ${n}`);
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

    public getAveragePrice(n: number): number | null {
        const averages = this.getAverages(n);
        return averages?.averagePrice ?? null;
    }

    public getRecentPrices(n: number): RecentPriceEntry[] {
        return this.readMinuteLogFile(n);
    }

    public getHistoricalEntries(n?: number): HistoricalDataEntry[] {
        const entries = this.readHourlyLogFile();
        return n ? entries.slice(-n) : entries;
    }

    // -------------------------------------------------------------------------
    // Scheduling
    // -------------------------------------------------------------------------

    private startScheduledTasks(): void {
        // Write hourly data at minute 55
        this.cronJob = cron.schedule('55 * * * *', async () => {
            this.writeHourlyLogEntry();
            await this.initializeHourlyData();
        });

        // Update price data every 2 minutes
        this.priceUpdateInterval = setInterval(async () => {
            await this.updateCurrentHourData();
        }, CDMarketData.PRICE_UPDATE_INTERVAL_MS);
    }

    // -------------------------------------------------------------------------
    // Hourly Data Management
    // -------------------------------------------------------------------------

    private async initializeHourlyData(): Promise<void> {
        const price = await this.getCurrentPrice();

        this.thisHourData = {
            hourlyOpen: price,
            averagePrice: price,
            hourlyMax: price,
            hourlyMin: price,
            previousPrice: price,
            previousOpenOver: false,
            previousAverageOver: false,
            openFlops: 0,
            averageFlops: 0,
            totalChange: 0,
        };
    }

    private async updateCurrentHourData(): Promise<void> {
        if (!this.thisHourData) return;

        const price = await this.getCurrentPrice();
        const data = this.thisHourData;

        const isOverOpen = price > data.hourlyOpen;
        const isOverAverage = price > data.averagePrice;

        this.thisHourData = {
            hourlyOpen: data.hourlyOpen,
            previousPrice: price,
            averagePrice: this.calculateRunningAverage(data.averagePrice, price),
            hourlyMax: Math.max(price, data.hourlyMax),
            hourlyMin: Math.min(price, data.hourlyMin),
            previousOpenOver: isOverOpen,
            previousAverageOver: isOverAverage,
            openFlops: data.openFlops + this.detectFlop(isOverOpen, data.previousOpenOver),
            averageFlops: data.averageFlops + this.detectFlop(isOverAverage, data.previousAverageOver),
            totalChange: data.totalChange + Math.abs(data.previousPrice - price),
        };

        this.writeMinuteLogEntry();
    }

    private calculateRunningAverage(currentAvg: number, newPrice: number): number {
        return currentAvg + (currentAvg - (newPrice / 60));
    }

    private detectFlop(currentOver: boolean, previousOver: boolean): number {
        const crossed = currentOver !== previousOver;
        return crossed ? 1 : 0;
    }

    // -------------------------------------------------------------------------
    // Price Fetching & Caching
    // -------------------------------------------------------------------------

    private isCacheValid(): boolean {
        if (this.priceCache === null) return false;
        const elapsed = Date.now() - this.priceCacheTimestamp;
        return elapsed < CDMarketData.PRICE_CACHE_TIMEOUT_MS;
    }

    private updatePriceCache(price: number): void {
        this.priceCache = price;
        this.priceCacheTimestamp = Date.now();
    }

    private async fetchPriceFromApi(): Promise<number> {
        return this.fetchBinancePriceFromApi('BTCUSDT');
    }

    private async fetchBinancePriceFromApi(symbol: string): Promise<number> {
        const url = `https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`;

        for (let attempt = 0; attempt < CDMarketData.RETRY_ATTEMPTS; attempt++) {
            try {
                const response = await fetch(url);

                if (!response.ok) {
                    this.logError(`Binance API request failed (attempt ${attempt + 1}): ${response.status}`);
                    continue;
                }

                const data = await response.json() as BinancePriceResponse;
                return this.parseBinancePrice(data);
            } catch (error) {
                this.logError(`Binance API fetch error (attempt ${attempt + 1}): ${error}`);
            }
        }

        throw new Error(`Failed to fetch Binance price after ${CDMarketData.RETRY_ATTEMPTS} attempts`);
    }

    private parseBinancePrice(data: BinancePriceResponse): number {
        if (!data?.price) {
            throw new Error(`Invalid Binance API response: ${JSON.stringify(data)}`);
        }

        const price = parseFloat(data.price);

        if (isNaN(price)) {
            throw new Error(`Invalid Binance price value: ${data.price}`);
        }

        return price;
    }

    // -------------------------------------------------------------------------
    // File Reading
    // -------------------------------------------------------------------------

    private readHourlyLogFile(): HistoricalDataEntry[] {
        if (!existsSync(CDMarketData.HOURLY_LOG_PATH)) {
            return [];
        }

        try {
            const content = readFileSync(CDMarketData.HOURLY_LOG_PATH, 'utf-8');
            const lines = content.trim().split('\n').filter(line => line.trim());

            return lines.map(line => this.parseHourlyLogLine(line));
        } catch (error) {
            this.logError(`Error reading hourly log: ${error}`);
            return [];
        }
    }

    private parseHourlyLogLine(line: string): HistoricalDataEntry {
        const parts = line.split(',').map(p => p.trim());

        return {
            timestamp: new Date(parts[0]),
            hourlyOpen: parseFloat(parts[1]),
            averagePrice: parseFloat(parts[2]),
            hourlyMin: parseFloat(parts[3]),
            hourlyMax: parseFloat(parts[4]),
            openFlops: parseFloat(parts[5]),
            averageFlops: parseFloat(parts[6]),
            totalChange: parseFloat(parts[7]),
        };
    }

    private readMinuteLogFile(n: number): RecentPriceEntry[] {
        if (!existsSync(CDMarketData.MINUTE_LOG_PATH)) {
            return [];
        }

        try {
            const content = readFileSync(CDMarketData.MINUTE_LOG_PATH, 'utf-8');
            const lines = content.trim().split('\n').filter(line => line.trim());

            const entries = lines.map(line => this.parseMinuteLogLine(line));
            return entries.slice(-n);
        } catch (error) {
            this.logError(`Error reading minute log: ${error}`);
            return [];
        }
    }

    private parseMinuteLogLine(line: string): RecentPriceEntry {
        const parts = line.split(',').map(p => p.trim());

        return {
            timestamp: new Date(parts[0]),
            price: parseFloat(parts[1]),
        };
    }

    // -------------------------------------------------------------------------
    // File Writing
    // -------------------------------------------------------------------------

    private writeHourlyLogEntry(): void {
        const timestamp = this.getHourStartTimestamp();
        const data = this.thisHourData;

        const line = [
            timestamp,
            data.hourlyOpen,
            data.averagePrice,
            data.hourlyMin,
            data.hourlyMax,
            data.openFlops,
            data.averageFlops,
            data.totalChange,
        ].join(',');

        appendFileSync(CDMarketData.HOURLY_LOG_PATH, `${line}\n`);
    }

    private writeMinuteLogEntry(): void {
        const timestamp = new Date().toISOString();

        const line = [
            timestamp,
            this.thisHourData.previousPrice,
        ].join(',');

        appendFileSync(CDMarketData.MINUTE_LOG_PATH, `${line}\n`);
    }

    private logError(message: string): void {
        const timestamp = new Date().toISOString();
        const logLine = `${timestamp}\t${message}\n`;
        appendFileSync(CDMarketData.ERROR_LOG_PATH, logLine);
    }

    // -------------------------------------------------------------------------
    // Utilities
    // -------------------------------------------------------------------------

    private calculateAverage(values: number[]): number {
        if (values.length === 0) return 0;
        return values.reduce((sum, val) => sum + val, 0) / values.length;
    }

    private getHourStartTimestamp(): string {
        const now = new Date();
        now.setMinutes(0, 0, 0);
        return now.toISOString();
    }
}
