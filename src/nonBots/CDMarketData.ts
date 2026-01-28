import cron from 'node-cron';
import dotenv from 'dotenv';
import { appendFileSync, readFileSync, existsSync } from 'fs';

import { QuantBotRun } from "./../bots/QuantBot.js";
import { TargetedMarket } from '../types/interfaces.js';

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

enum BinanceSymbol {
    BTCUSDT = 'BTCUSDT',
    XRPUSDT = 'XRPUSDT',
    SOLUSDT = 'SOLUSDT',
    ETHUSDT = 'ETHUSDT',
}

enum LogPath {
    BTCHourly = './logs/market/btc-hourly.log',
    BTCMinute = './logs/market/btc-minute.log',
    XRPHourly = './logs/market/xrp-hourly.log',
    XRPMinute = './logs/market/xrp-minute.log',
    SOLHourly = './logs/market/sol-hourly.log',
    SOLMinute = './logs/market/sol-minute.log',
    ETHHourly = './logs/market/eth-hourly.log',
    ETHMinute = './logs/market/eth-minute.log',
}

// ============================================================================
// CDMarketData Class (Singleton)
// ============================================================================

export class CDMarketData implements QuantBotRun {

    // Todo typeremove these
    public PROD_MODE = false;
    public name = 'CDMarketData';

    // -------------------------------------------------------------------------
    // Constants
    // -------------------------------------------------------------------------

    private static readonly PRICE_CACHE_TIMEOUT_MS = 1 * 15 * 1000;
    private static readonly PRICE_UPDATE_INTERVAL_MS = 1 * 15 * 1000;
    private static readonly RETRY_ATTEMPTS = 5;

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

    private priceCache: Map<BinanceSymbol, number> = new Map();
    private priceCacheTimestamp: Map<BinanceSymbol, number> = new Map();
    private thisHourData: Map<BinanceSymbol, HourlyData> = new Map();

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

    public async getCurrentPrice(symbol: BinanceSymbol): Promise<number> {
        if (this.isCacheValid(symbol)) {
            return this.priceCache.get(symbol)!;
        }
        const price = await this.fetchBinancePriceFromApi(symbol);
        this.updatePriceCache(price, symbol);
        return price;
    }

    public getCurrentHourData(symbol: BinanceSymbol): HourlyData | null {
        return this.thisHourData.get(symbol) ?? null;
    }

    public async getBinancePrice(symbol: BinanceSymbol): Promise<number> {
        return this.fetchBinancePriceFromApi(symbol);
    }

    // -------------------------------------------------------------------------
    // Public API - Historical Data
    // -------------------------------------------------------------------------

    symbolToHourlyLogFile(symbol: BinanceSymbol): LogPath {
        switch (symbol) {
            case BinanceSymbol.BTCUSDT:
                return LogPath.BTCHourly;
            case BinanceSymbol.ETHUSDT:
                return LogPath.ETHHourly;
            case BinanceSymbol.SOLUSDT:
                return LogPath.SOLHourly;
            case BinanceSymbol.XRPUSDT:
                return LogPath.XRPHourly;
            default:
                throw Error(`Illegal symbol supplied to symbolToHourlyLogFile: ${symbol}`);
        }
    }

    symbolToMinutelyLogFile(symbol: BinanceSymbol): LogPath {
        switch (symbol) {
            case BinanceSymbol.BTCUSDT:
                return LogPath.BTCMinute;
            case BinanceSymbol.ETHUSDT:
                return LogPath.ETHMinute;
            case BinanceSymbol.SOLUSDT:
                return LogPath.SOLMinute;
            case BinanceSymbol.XRPUSDT:
                return LogPath.XRPMinute;
            default:
                throw Error(`Illegal symbol supplied to symbolToHourlyLogFile: ${symbol}`);
        }
    }

    marketToSymbol(market: TargetedMarket): BinanceSymbol {
        switch (market) {
            case TargetedMarket.BITCOIN_HOURLY:
            case TargetedMarket.BITCOIN_QUARTERLY:
                return BinanceSymbol.BTCUSDT;
            case TargetedMarket.ETHEREUM_HOURLY:
            case TargetedMarket.ETHEREUM_QUARTERLY:
                return BinanceSymbol.ETHUSDT;
            case TargetedMarket.SOLANA_HOURLY:
            case TargetedMarket.SOLANA_QUARTERLY:
                return BinanceSymbol.SOLUSDT;
            case TargetedMarket.XRP_HOURLY:
            case TargetedMarket.XRP_QUARTERLY:
                return BinanceSymbol.XRPUSDT;
            default:
                throw Error(`Unknown market supplied to marketToSymbol: ${market}`);
        }
    }

    getCurrentPriceByMarket(market: TargetedMarket): Promise<number> {
        return this.getCurrentPrice(this.marketToSymbol(market));
    }

    public getAverages(n: number, market: TargetedMarket): HistoricalAverages | null {
        const symbol = this.marketToSymbol(market)
        const entries = this.readHourlyLogFile(symbol);

        if (entries.length < n) {
            this.logError(`Insufficient data: have ${entries.length} entries, need ${n}`, symbol);
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

    public getAveragePrice(n: number, market: TargetedMarket): number | null {
        const averages = this.getAverages(n, market);
        return averages?.averagePrice ?? null;
    }

    public getRecentPrices(n: number, market?: TargetedMarket): RecentPriceEntry[] {
        const symbol = market ? this.marketToSymbol(market) : BinanceSymbol.BTCUSDT;
        return this.readMinuteLogFile(n, symbol);
    }

    public getHistoricalEntries(symbol: BinanceSymbol, n?: number): HistoricalDataEntry[] {
        const entries = this.readHourlyLogFile(symbol);
        return n ? entries.slice(-n) : entries;
    }

    // -------------------------------------------------------------------------
    // Scheduling
    // -------------------------------------------------------------------------

    private startScheduledTasks(): void {
        // Write hourly data at minute 55
        this.cronJob = cron.schedule('55 * * * *', async () => {
            for (const symbol of Object.values(BinanceSymbol)) {
                this.writeHourlyLogEntry(symbol);
            }
            await this.initializeHourlyData();
        });

        // Update price data every 2 minutes
        this.priceUpdateInterval = setInterval(async () => {
            await Promise.all(Object.values(BinanceSymbol).map(symbol =>
                this.updateCurrentHourData(symbol)
            ));
        }, CDMarketData.PRICE_UPDATE_INTERVAL_MS);
    }

    // -------------------------------------------------------------------------
    // Hourly Data Management
    // -------------------------------------------------------------------------

    private async initializeHourlyData(): Promise<void> {
        await Promise.all(Object.values(BinanceSymbol).map(async (symbol) => {
            const price = await this.getCurrentPrice(symbol);

            this.thisHourData.set(symbol, {
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
            });
        }));
    }

    private async updateCurrentHourData(symbol: BinanceSymbol): Promise<void> {
        const data = this.thisHourData.get(symbol);
        if (!data) return;

        const price = await this.getCurrentPrice(symbol);

        const isOverOpen = price > data.hourlyOpen;
        const isOverAverage = price > data.averagePrice;

        this.thisHourData.set(symbol, {
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
        });

        this.writeMinuteLogEntry(symbol);
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

    private isCacheValid(symbol: BinanceSymbol): boolean {
        const cachedPrice = this.priceCache.get(symbol);
        if (cachedPrice === undefined) return false;
        const timestamp = this.priceCacheTimestamp.get(symbol) ?? 0;
        const elapsed = Date.now() - timestamp;
        return elapsed < CDMarketData.PRICE_CACHE_TIMEOUT_MS;
    }

    private updatePriceCache(price: number, symbol: BinanceSymbol): void {
        this.priceCache.set(symbol, price);
        this.priceCacheTimestamp.set(symbol, Date.now());
    }

    private async fetchBinancePriceFromApi(symbol: BinanceSymbol): Promise<number> {
        const url = `https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`;

        for (let attempt = 0; attempt < CDMarketData.RETRY_ATTEMPTS; attempt++) {
            try {
                const response = await fetch(url);

                if (!response.ok) {
                    this.logError(`Binance API request failed (attempt ${attempt + 1}): ${response.status}`, symbol);
                    continue;
                }

                const data = await response.json() as BinancePriceResponse;
                return this.parseBinancePrice(data);
            } catch (error) {
                this.logError(`Binance API fetch error (attempt ${attempt + 1}): ${error}`, symbol);
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

    private readHourlyLogFile(symbol: BinanceSymbol): HistoricalDataEntry[] {
        const logFile = this.symbolToHourlyLogFile(symbol);
        if (!existsSync(logFile)) {
            return [];
        }

        try {
            const content = readFileSync(logFile, 'utf-8');
            const lines = content.trim().split('\n').filter(line => line.trim());

            return lines.map(line => this.parseHourlyLogLine(line));
        } catch (error) {
            this.logError(`Error reading hourly log: ${error}`, symbol);
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

    private readMinuteLogFile(n: number, symbol: BinanceSymbol): RecentPriceEntry[] {
        const logFile = this.symbolToMinutelyLogFile(symbol);
        if (!existsSync(logFile)) {
            return [];
        }

        try {
            const content = readFileSync(logFile, 'utf-8');
            const lines = content.trim().split('\n').filter(line => line.trim());

            const entries = lines.map(line => this.parseMinuteLogLine(line));
            return entries.slice(-n);
        } catch (error) {
            this.logError(`Error reading minute log: ${error}`, symbol);
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

    private writeHourlyLogEntry(symbol: BinanceSymbol): void {
        const data = this.thisHourData.get(symbol);
        if (!data) return;

        const timestamp = this.getHourStartTimestamp();

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
        const logFile = this.symbolToHourlyLogFile(symbol);
        appendFileSync(logFile, `${line}\n`);
    }

    private writeMinuteLogEntry(symbol: BinanceSymbol): void {
        const data = this.thisHourData.get(symbol);
        if (!data) return;

        const timestamp = new Date().toISOString();

        const line = [
            timestamp,
            data.previousPrice,
        ].join(',');
        const logFile = this.symbolToMinutelyLogFile(symbol);
        appendFileSync(logFile, `${line}\n`);
    }

    private logError(message: string, symbol: BinanceSymbol): void {
        const timestamp = new Date().toISOString();
        const logLine = `${timestamp}\t${symbol},${message}\n`;
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
