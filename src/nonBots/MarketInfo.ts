import { ClobClient, OrderBookSummary, Side } from "@polymarket/clob-client";

import { appendFileSync, existsSync, mkdirSync } from "fs";

import { retryWrapper } from "../utils/networking.js";
import { TargetedMarket } from "../types/interfaces.js";

interface ParsedDate {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    second: number;
}

interface MarketInfoProps {
    client: ClobClient;
}

interface BtcOrderBooks {
    BtcUpTokenId: string,
    BtcUp: OrderBookSummary,
    BtcDownTokenId: string,
    BtcDown: OrderBookSummary,
}

interface MarketInfoSimple {
    clobTokenIds: string[],
    outcomePrices: string[],
}

const LOG_DIRECTORY = './logs/pmarket-price';

enum LOG_DIR {
    BITCOIN_HOURLY = './logs/pmarket-price/btc.log',
    ETHEREUM_HOURLY = './logs/pmarket-price/ethereum.log',
    SOLANA_HOURLY = './logs/pmarket-price/solana.log',
    XRP_HOURLY = './logs/pmarket-price/xrp.log',
}

export class MarketInfo {

    private static readonly UPDATE_DATA_INTERVAL = 4 * 1000; // 4s
    private static readonly PRICE_LOG_INTERVAL = 30 * 1000; // 30s
    private static readonly MARKET_INFO_CACHE_TTL = 2 * 1000; // 2s
    private static readonly MARKET_INFO_CACHE_CLEANUP = 5 * 60 * 60 * 1000; // 5 hours

    private client!: ClobClient;
    private priceLogIntervals: Map<TargetedMarket, NodeJS.Timeout> = new Map();

    private cachedClobTokenIds: Map<TargetedMarket, string[]> = new Map();
    private clobTokenIdsFetchedAt: Map<TargetedMarket, number> = new Map();

    private cachedOrderBooks: Map<TargetedMarket, BtcOrderBooks> = new Map();
    private orderBooksFetchedAt: Map<TargetedMarket, number> = new Map();
    private liveDataPending: Map<TargetedMarket, Promise<BtcOrderBooks>> = new Map();

    private priceCache: Map<string, { price: number; fetchedAt: number }> = new Map();
    private pricePending: Map<string, Promise<number>> = new Map();

    private marketInfoCache: Map<string, { data: MarketInfoSimple; fetchedAt: number; lastAccessedAt: number }> = new Map();
    private marketInfoPending: Map<string, Promise<MarketInfoSimple>> = new Map();

    constructor(props: MarketInfoProps) {
        this.client = props.client;
        Object.values(TargetedMarket).forEach((market) => {
            this.getLiveData(market).catch((e) => {
                this.writeLog(`[ERROR] Failed to initialize live data: ${e}`);
            });
        });
    }

    public async run(): Promise<void> {
        this.startPriceLogging();
    }

    /**
     * Gets the current timestamp in Eastern Standard Time.
     * @returns The current EST timestamp in milliseconds since epoch.
     */
    public getCurrentEstTimestamp(): number {
        const estString = new Date().toLocaleString("en-US", { timeZone: "America/New_York" });
        return new Date(estString).getTime();
    }

    /**
     * Parses a timestamp into its date components.
     * @param timestamp - The timestamp in milliseconds since epoch.
     * @returns An object containing year, month (1-12), day, and hour.
     */
    public parseTimestamp(timestamp: number): ParsedDate {
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

    /**
     * Converts a month number to its lowercase English name.
     * @param month - The month number (1-12).
     * @returns The lowercase month name, or empty string if invalid.
     */
    public getMonthName(month: number): string {
        const months = [
            "january", "february", "march", "april",
            "may", "june", "july", "august",
            "september", "october", "november", "december"
        ];
        return months[month - 1] ?? "";
    }

    /**
     * Writes a timestamped message to the error log file.
     * @param message - The message to log.
     */
    private writeLog(message: string): void {
        const timestamp = new Date().toISOString();
        const logLine = `${timestamp}\t ${message}\n`;
        appendFileSync(`./logs/pmarket-price/MarketInfoErrors.log`, logLine);
    }

    /**
     * Constructs the Polymarket API URL for the Bitcoin hourly market at a given timestamp.
     * @param timestamp - The timestamp in milliseconds since epoch.
     * @returns The Polymarket gamma API URL for the Bitcoin up/down market.
     */
    public getUrl(timestamp: number, targetMarket: TargetedMarket) {
        const time = this.parseTimestamp(timestamp);
        let stringHour = "";
        if (time.hour === 0) {
            stringHour = "12am"
        } else if (time.hour === 12) {
            stringHour = "12pm"
        } else if (time.hour > 12) {
            stringHour = `${time.hour - 12}pm`;
        } else {
            stringHour = `${time.hour}am`;
        }

        let marketString = '';
        switch (targetMarket) {
            case TargetedMarket.BITCOIN_HOURLY:
                marketString = 'bitcoin'
                break;
            case TargetedMarket.ETHEREUM_HOURLY:
                marketString = 'ethereum'
                break;
            case TargetedMarket.SOLANA_HOURLY:
                marketString = 'solana';
                break;
            case TargetedMarket.XRP_HOURLY:
                marketString = 'xrp';
                break;
            default:
                throw Error(`illegal market supplied to getPolymarketUrl: ${targetMarket}`)
        }

        const stringMonth = this.getMonthName(time.month);

        return `https://gamma-api.polymarket.com/events/slug/${marketString}-up-or-down-${stringMonth}-${time.day}-${stringHour}-et`
    }

    ///https://polymarket.com/event/ethereum-up-or-down-january-9-7pm-et
    public getEthereumHourlyUrl(timestamp: number) {
        const time = this.parseTimestamp(timestamp);
        let stringHour = "";
        if (time.hour === 0) {
            stringHour = "12am"
        } else if (time.hour === 12) {
            stringHour = "12pm"
        } else if (time.hour > 12) {
            stringHour = `${time.hour - 12}pm`;
        } else {
            stringHour = `${time.hour}am`;
        }

        const stringMonth = this.getMonthName(time.month);

        return `https://gamma-api.polymarket.com/events/slug/ethereum-up-or-down-${stringMonth}-${time.day}-${stringHour}-et`
    }


    public async getMarketInfo(url: string): Promise<MarketInfoSimple> {
        // Clean up old cache entries periodically
        this.cleanupMarketInfoCache();

        // Return pending request if one exists (mutex)
        const pending = this.marketInfoPending.get(url);
        if (pending) {
            return pending;
        }

        // Check cache
        const now = Date.now();
        const cached = this.marketInfoCache.get(url);
        if (cached && now - cached.fetchedAt < MarketInfo.MARKET_INFO_CACHE_TTL) {
            // Update last accessed time
            cached.lastAccessedAt = now;
            return cached.data;
        }

        // Fetch with mutex
        const fetchPromise = (async () => {
            try {
                const responseJson = await retryWrapper(async () => {
                    const response = await fetch(url, {
                        method: "GET",
                        headers: {
                            "Accept": "application/json",
                        },
                    });

                    if (!response.ok) {
                        throw new Error(`HTTP error: ${response.status}`);
                    }
                    return await response.json();
                }, () => {
                    this.writeLog(`Curl URL Error: ${url}`);
                });

                const markets = (responseJson as { markets?: { clobTokenIds?: string, outcomePrices: string }[] })?.markets ?? [];
                if (!markets) throw Error("Failed to getBitcoinHourlyClobs");
                const marketJson = {
                    clobTokenIds: JSON.parse(markets[0].clobTokenIds || "") as string[],
                    outcomePrices: JSON.parse(markets[0].outcomePrices || "") as string[],
                };
                if (!marketJson.clobTokenIds) throw Error("Failed to parse clobTokenIds");
                if (!marketJson.outcomePrices) throw Error("Failed to JSON parse outcomePrices");

                const result: MarketInfoSimple = {
                    clobTokenIds: marketJson.clobTokenIds,
                    outcomePrices: marketJson.outcomePrices,
                };

                // Store in cache
                const fetchTime = Date.now();
                this.marketInfoCache.set(url, {
                    data: result,
                    fetchedAt: fetchTime,
                    lastAccessedAt: fetchTime,
                });

                return result;
            } catch (e) {
                console.log('getMarketInfo failed: ', url, e);
                throw e;
            } finally {
                this.marketInfoPending.delete(url);
            }
        })();

        this.marketInfoPending.set(url, fetchPromise);
        return fetchPromise;
    }

    /**
     * Removes market info cache entries that haven't been accessed in 5 hours.
     */
    private cleanupMarketInfoCache(): void {
        const now = Date.now();
        for (const [url, entry] of this.marketInfoCache) {
            if (now - entry.lastAccessedAt > MarketInfo.MARKET_INFO_CACHE_CLEANUP) {
                this.marketInfoCache.delete(url);
            }
        }
    }

    public async getPrice(clobTokenId: string, side: Side): Promise<number> {
        const cacheKey = `${clobTokenId}-${side}`;

        // Return pending request if one exists (mutex)
        const pending = this.pricePending.get(cacheKey);
        if (pending) {
            return pending;
        }

        // Check cache
        const now = Date.now();
        const cached = this.priceCache.get(cacheKey);
        if (cached && now - cached.fetchedAt < MarketInfo.UPDATE_DATA_INTERVAL) {
            return cached.price;
        }

        // Fetch with mutex
        const fetchPromise = (async () => {
            try {
                const res = (await this.client.getPrice(clobTokenId, side)) as { price: string };
                const price = parseFloat(res.price);
                this.priceCache.set(cacheKey, { price, fetchedAt: Date.now() });
                return price;
            } finally {
                this.pricePending.delete(cacheKey);
            }
        })();

        this.pricePending.set(cacheKey, fetchPromise);
        return fetchPromise;
    }

    /**
     * Fetches the CLOB token IDs for the Bitcoin hourly market at a given timestamp.
     * This function does not cache the result.
     * @param timestamp - The timestamp in milliseconds since epoch.
     * @returns A promise resolving to an array of CLOB token IDs [btcUp, btcDown].
     * @throws Error if the API request fails or token IDs cannot be parsed.
     */
    public async getBitcoinHourClobs(timestamp: number, targetedMarket: TargetedMarket): Promise<string[]> {
        const url = this.getUrl(timestamp, targetedMarket);
        const markets = await this.getMarketInfo(url);
        return markets.clobTokenIds;
    }

    /**
     * Gets the CLOB token IDs for the current Bitcoin hourly market.
     * Results are cached and expire on the hour (e.g., at 13:00, 14:00).
     * @returns A promise resolving to an array of CLOB token IDs [btcUp, btcDown].
     */
    public async getCurrentClobTokenIds(targetedMarket: TargetedMarket): Promise<string[]> {
        const now = Date.now();
        const currentHour = new Date(now).getHours();
        const fetchedAt = this.clobTokenIdsFetchedAt.get(targetedMarket) ?? 0;
        const cachedHour = new Date(fetchedAt).getHours();
        const isExpired = fetchedAt === 0 || currentHour !== cachedHour;

        const cached = this.cachedClobTokenIds.get(targetedMarket);
        if (!cached || cached.length === 0 || isExpired) {
            const clobTokenIds = await this.getBitcoinHourClobs(this.getCurrentEstTimestamp(), targetedMarket);
            this.cachedClobTokenIds.set(targetedMarket, clobTokenIds);
            this.clobTokenIdsFetchedAt.set(targetedMarket, now);
            return clobTokenIds;
        }
        return cached;
    }

    /**
     * Gets the current order books for Bitcoin up/down markets.
     * Results are cached and expire every UPDATE_DATA_INTERVAL seconds.
     * Uses a mutex lock to prevent concurrent fetches.
     * @returns A promise resolving to the BtcOrderBooks containing buy/sell order books.
     */
    public async getLiveData(targetedMarket: TargetedMarket): Promise<BtcOrderBooks> {
        const pending = this.liveDataPending.get(targetedMarket);
        if (pending) {
            return pending;
        }

        const now = Date.now();
        const fetchedAt = this.orderBooksFetchedAt.get(targetedMarket) ?? 0;
        const isExpired = fetchedAt === 0 || now - fetchedAt >= MarketInfo.UPDATE_DATA_INTERVAL;

        const cached = this.cachedOrderBooks.get(targetedMarket);
        if (!cached || isExpired) {
            const fetchPromise = (async () => {
                try {
                    const clobTokenIds = await this.getCurrentClobTokenIds(targetedMarket);
                    const orderBooks = await this.client.getOrderBooks([
                        { token_id: clobTokenIds[0], side: Side.BUY },
                        { token_id: clobTokenIds[0], side: Side.SELL },
                        { token_id: clobTokenIds[1], side: Side.BUY },
                        { token_id: clobTokenIds[1], side: Side.SELL },
                    ]);
                    const result: BtcOrderBooks = {
                        BtcUpTokenId: clobTokenIds[0],
                        BtcUp: orderBooks[0],
                        BtcDownTokenId: clobTokenIds[1],
                        BtcDown: orderBooks[1],
                    };
                    this.cachedOrderBooks.set(targetedMarket, result);
                    this.orderBooksFetchedAt.set(targetedMarket, Date.now());
                    return result;
                } finally {
                    this.liveDataPending.delete(targetedMarket);
                }
            })();
            this.liveDataPending.set(targetedMarket, fetchPromise);
            return fetchPromise;
        }
        return cached;
    }

    private getLogFromMarket(targetedMarket: TargetedMarket): LOG_DIR {
        switch (targetedMarket) {
            case TargetedMarket.BITCOIN_HOURLY:
                return LOG_DIR.BITCOIN_HOURLY;
            case TargetedMarket.ETHEREUM_HOURLY:
                return LOG_DIR.ETHEREUM_HOURLY;
            case TargetedMarket.SOLANA_HOURLY:
                return LOG_DIR.SOLANA_HOURLY;
            case TargetedMarket.XRP_HOURLY:
                return LOG_DIR.XRP_HOURLY;
            default:
                throw Error(`Unknown market supplied to getLogFromMarket: ${targetedMarket}`)
        }
    }

    /**
     * Starts logging UP/DOWN market prices every 30 seconds.
     * Prices are written to pmarket-price/BTCHourlyUPDown.log
     */
    public startPriceLogging(): void {
        if (this.priceLogIntervals.size > 0) {
            return;
        }
        if (!existsSync(LOG_DIRECTORY)) {
            mkdirSync(LOG_DIRECTORY, { recursive: true });
        }
        Object.values(TargetedMarket).forEach((market) => {
            // Log immediately on start
            this.logCurrentPrices(market);

            // Then log every 30 seconds
            const interval = setInterval(() => {
                try {
                    this.logCurrentPrices(market);
                } catch (e) {
                    this.writeLog(e as string);
                }
            }, MarketInfo.PRICE_LOG_INTERVAL);
            this.priceLogIntervals.set(market, interval);
        })
    }

    /**
     * Stops the price logging intervals.
     */
    public stopPriceLogging(): void {
        for (const interval of this.priceLogIntervals.values()) {
            clearInterval(interval);
        }
        this.priceLogIntervals.clear();
    }

    /**
     * Fetches current UP/DOWN prices and writes them to the log file.
     */
    private async logCurrentPrices(targetedMarket: TargetedMarket): Promise<void> {
        try {
            const clobTokenIds = await this.getCurrentClobTokenIds(targetedMarket);
            const [upTokenId, downTokenId] = clobTokenIds;

            const [upPrice, downPrice] = await Promise.all([
                this.getPrice(upTokenId, Side.BUY),
                this.getPrice(downTokenId, Side.BUY),
            ]);

            const timestamp = new Date().toISOString();
            const logLine = `${timestamp},${upPrice},${downPrice}\n`;
            const logFile = this.getLogFromMarket(targetedMarket);
            appendFileSync(logFile, logLine);
        } catch (error) {
            this.writeLog(`[ERROR] Failed to log prices: ${error}`);
        }
    }
}