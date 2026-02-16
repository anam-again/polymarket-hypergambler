import { ClobClient, OrderBookSummary, Side } from "@polymarket/clob-client";

import { appendFileSync, existsSync, mkdirSync } from "fs";

import { retryWrapper } from "../utils/networking.js";
import { MarketSchedule, TargetedMarket } from "../types/interfaces.js";
import { QuantBot } from "../bots/QuantBot.js";
import { TradingDatabase } from "../db/TradingDatabase.js";

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

export interface MarketInfoSimple {
    clobTokenIds: string[],
    outcomePrices: string[],
    closed: boolean,
    error?: boolean,
}

const LOG_DIRECTORY = './logs/pmarket-price';

enum LOG_DIR {
    BITCOIN_HOURLY = './logs/pmarket-price/btc.log',
    ETHEREUM_HOURLY = './logs/pmarket-price/ethereum.log',
    SOLANA_HOURLY = './logs/pmarket-price/solana.log',
    XRP_HOURLY = './logs/pmarket-price/xrp.log',
    BITCION_MINUTELY = './logs/pmarket-price/btc-minutely.log',
    ETHEREUM_MINUTELY = './logs/pmarket-price/ethereum-minutely.log',
    SOLANA_MINUTELY = './logs/pmarket-price/solana-minutely.log',
    XRP_MINUTELY = './logs/pmarket-price/xrp-minutely.log',
}

export class MarketInfo {

    private static readonly UPDATE_DATA_INTERVAL = 4 * 1000; // 4s
    private static readonly PRICE_LOG_INTERVAL = 5 * 1000; // 5s (reduced from 15s to ensure data at period boundaries)
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

    // Period boundary tracking for sanity checks
    private lastPeriodKey: Map<TargetedMarket, string> = new Map();

    // Sanity check thresholds
    private static readonly EXTREME_PRICE_LOW = 0.20;
    private static readonly EXTREME_PRICE_HIGH = 0.80;
    private static readonly PERIOD_START_GRACE_SECONDS = 60;

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
        // Get current time adjusted for EST/EDT offset
        const now = new Date();

        // Get the offset for America/New_York at the current time
        const estFormatter = new Intl.DateTimeFormat('en-US', {
            timeZone: 'America/New_York',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false
        });

        const parts = estFormatter.formatToParts(now);
        const estDate = new Date(
            parseInt(parts.find(p => p.type === 'year')!.value),
            parseInt(parts.find(p => p.type === 'month')!.value) - 1,
            parseInt(parts.find(p => p.type === 'day')!.value),
            parseInt(parts.find(p => p.type === 'hour')!.value),
            parseInt(parts.find(p => p.type === 'minute')!.value),
            parseInt(parts.find(p => p.type === 'second')!.value)
        );

        return estDate.getTime();
    }

    /**
     * This function expects the input timestamp to be in EST.
     * Returns a Unix timestamp in seconds, offset by 2 hours for the API slug format.
     */
    public static getFifteenMinuteTimestamp(timestamp: number): number {
        const fifteenMinMs = 15 * 60 * 1000;
        const twoHoursInSeconds = 2 * 60 * 60;  // 7200 seconds (not milliseconds!)
        return (Math.floor(timestamp / fifteenMinMs) * fifteenMinMs / 1000) - twoHoursInSeconds;
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
        const stringMonth = this.getMonthName(time.month);
        const minutelyTimestamp = MarketInfo.getFifteenMinuteTimestamp(timestamp)
        switch (targetMarket) {
            case TargetedMarket.BITCOIN_HOURLY:
                return `https://gamma-api.polymarket.com/events/slug/bitcoin-up-or-down-${stringMonth}-${time.day}-${stringHour}-et`
            case TargetedMarket.ETHEREUM_HOURLY:
                return `https://gamma-api.polymarket.com/events/slug/ethereum-up-or-down-${stringMonth}-${time.day}-${stringHour}-et`
            case TargetedMarket.SOLANA_HOURLY:
                return `https://gamma-api.polymarket.com/events/slug/solana-up-or-down-${stringMonth}-${time.day}-${stringHour}-et`
            case TargetedMarket.XRP_HOURLY:
                return `https://gamma-api.polymarket.com/events/slug/xrp-up-or-down-${stringMonth}-${time.day}-${stringHour}-et`
            case TargetedMarket.BITCOIN_QUARTERLY:
                return `https://gamma-api.polymarket.com/events/slug/btc-updown-15m-${minutelyTimestamp}`
            case TargetedMarket.ETHEREUM_QUARTERLY:
                return `https://gamma-api.polymarket.com/events/slug/eth-updown-15m-${minutelyTimestamp}`
            case TargetedMarket.SOLANA_QUARTERLY:
                return `https://gamma-api.polymarket.com/events/slug/sol-updown-15m-${minutelyTimestamp}`
            case TargetedMarket.XRP_QUARTERLY:
                return `https://gamma-api.polymarket.com/events/slug/xrp-updown-15m-${minutelyTimestamp}`
            default:
                throw Error(`illegal market supplied to getPolymarketUrl: ${targetMarket}`)
        }
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
                const closed =  ((responseJson as {closed?: string})?.closed ?? 'false') === 'true' ? true : false;
                if (!markets) throw Error("Failed to getBitcoinHourlyClobs");
                const marketJson = {
                    clobTokenIds: JSON.parse(markets[0].clobTokenIds || "") as string[],
                    outcomePrices: JSON.parse(markets[0].outcomePrices || "") as string[],
                    closed: closed,
                };
                if (!marketJson.clobTokenIds) throw Error("Failed to parse clobTokenIds");
                if (!marketJson.outcomePrices) throw Error("Failed to JSON parse outcomePrices");

                const result: MarketInfoSimple = {
                    clobTokenIds: marketJson.clobTokenIds,
                    outcomePrices: marketJson.outcomePrices,
                    closed: closed,
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
                // console.log('getMarketInfo failed: ', url, e);
                const fetchTime = Date.now();
                const result: MarketInfoSimple = {
                    clobTokenIds: [],
                    outcomePrices: [],
                    error: true,
                    closed: false,
                }
                this.marketInfoCache.set(url, {
                    data: result,
                    fetchedAt: fetchTime,
                    lastAccessedAt: fetchTime,
                })
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
     * Gets the midpoint price for a token (average of best bid and best ask).
     * @param clobTokenId - The CLOB token ID to get the midpoint for.
     * @param market - The targeted market.
     * @returns The midpoint price, or 0.5 if no bids/asks available.
     */
    public async getMidPrice(clobTokenId: string, market: TargetedMarket): Promise<number | null> {
        const liveData = await this.getLiveData(market);

        // Determine which token we're looking at
        let orderBook: { bids: { price: string; size: string }[]; asks: { price: string; size: string }[] };
        if (clobTokenId === liveData.BtcUpTokenId) {
            orderBook = liveData.BtcUp;
        } else if (clobTokenId === liveData.BtcDownTokenId) {
            orderBook = liveData.BtcDown;
        } else {
            // Token not found in current period's order books - return null to prevent matching
            return null;
        }

        // Get best bid (highest) and best ask (lowest)
        const bestBid = orderBook.bids.length > 0
            ? parseFloat(orderBook.bids[orderBook.bids.length - 1].price)
            : 0;
        const bestAsk = orderBook.asks.length > 0
            ? parseFloat(orderBook.asks[orderBook.asks.length - 1].price)
            : 1;

        return (bestBid + bestAsk) / 2;
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
     * Gets the CLOB token IDs for the current market.
     * Results are cached and expire based on market schedule:
     * - Hourly markets: expire on the hour (e.g., 13:00, 14:00)
     * - Quarterly (15-min) markets: expire on 15-minute intervals (e.g., 13:00, 13:15, 13:30, 13:45)
     * @returns A promise resolving to an array of CLOB token IDs [up, down].
     */
    public async getCurrentClobTokenIds(targetedMarket: TargetedMarket): Promise<string[]> {
        const now = Date.now();
        const fetchedAt = this.clobTokenIdsFetchedAt.get(targetedMarket) ?? 0;
        const schedule = QuantBot.getMarketSchedule(targetedMarket);

        let isExpired: boolean;
        if (schedule === MarketSchedule.QUARTERLY) {
            // 15-minute markets expire when we cross into a new 15-minute interval
            const currentInterval = MarketInfo.getFifteenMinuteTimestamp(now);
            const cachedInterval = MarketInfo.getFifteenMinuteTimestamp(fetchedAt);
            isExpired = fetchedAt === 0 || currentInterval !== cachedInterval;
        } else {
            // Hourly markets expire when we cross into a new hour
            const currentHour = new Date(now).getHours();
            const cachedHour = new Date(fetchedAt).getHours();
            isExpired = fetchedAt === 0 || currentHour !== cachedHour;
        }

        const cached = this.cachedClobTokenIds.get(targetedMarket);
        if (!cached || cached.length === 0 || isExpired) {
            const timestamp = this.getCurrentEstTimestamp();
            const clobTokenIds = await this.getBitcoinHourClobs(timestamp, targetedMarket);
            this.cachedClobTokenIds.set(targetedMarket, clobTokenIds);
            this.clobTokenIdsFetchedAt.set(targetedMarket, now);
            return clobTokenIds;
        }
        return cached;
    }

    /**
     * Gets the current order books for Bitcoin up/down markets.
     * Results are cached and expire on period boundaries (15-min for quarterly, hourly for hourly)
     * or after UPDATE_DATA_INTERVAL seconds, whichever comes first.
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
        const schedule = QuantBot.getMarketSchedule(targetedMarket);

        let isExpired: boolean;
        if (schedule === MarketSchedule.QUARTERLY) {
            // Expire on 15-minute boundaries OR time-based expiry
            const currentInterval = MarketInfo.getFifteenMinuteTimestamp(now);
            const cachedInterval = MarketInfo.getFifteenMinuteTimestamp(fetchedAt);
            isExpired = fetchedAt === 0 ||
                currentInterval !== cachedInterval ||
                now - fetchedAt >= MarketInfo.UPDATE_DATA_INTERVAL;
        } else {
            // Hourly markets: expire on hour boundaries OR time-based expiry
            const currentHour = new Date(now).getHours();
            const cachedHour = new Date(fetchedAt).getHours();
            isExpired = fetchedAt === 0 ||
                currentHour !== cachedHour ||
                now - fetchedAt >= MarketInfo.UPDATE_DATA_INTERVAL;
        }

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
                    const tokenUpOrderBook = orderBooks.find((book) => {
                        return book.asset_id === clobTokenIds[0];
                    });
                    const tokenDownOrderBook = orderBooks.find((book) => {
                        return book.asset_id === clobTokenIds[1];
                    });
                    if (!tokenUpOrderBook || !tokenDownOrderBook) {
                        throw Error("Failed to parse order book");
                    }
                    const result: BtcOrderBooks = {
                        BtcUpTokenId: clobTokenIds[0],
                        BtcUp: tokenUpOrderBook,
                        BtcDownTokenId: clobTokenIds[1],
                        BtcDown: tokenDownOrderBook,
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
            case TargetedMarket.BITCOIN_QUARTERLY:
                return LOG_DIR.BITCION_MINUTELY
            case TargetedMarket.ETHEREUM_QUARTERLY:
                return LOG_DIR.ETHEREUM_MINUTELY;
            case TargetedMarket.SOLANA_QUARTERLY:
                return LOG_DIR.SOLANA_MINUTELY;
            case TargetedMarket.XRP_QUARTERLY:
                return LOG_DIR.XRP_MINUTELY;
            default:
                throw Error(`Unknown market supplied to getLogFromMarket: ${targetedMarket}`)
        }
    }

    /**
     * Starts logging UP/DOWN market prices.
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
            const liveData = await this.getLiveData(targetedMarket);

            // Highest bid (BUY) and lowest ask (SELL) for UP token
            const upBid = liveData.BtcUp.bids.length > 0
                ? parseFloat(liveData.BtcUp.bids[liveData.BtcUp.bids.length - 1].price)
                : 0;
            const upAsk = liveData.BtcUp.asks.length > 0
                ? parseFloat(liveData.BtcUp.asks[liveData.BtcUp.asks.length - 1].price)
                : 1;

            // Highest bid (BUY) and lowest ask (SELL) for DOWN token
            const downBid = liveData.BtcDown.bids.length > 0
                ? parseFloat(liveData.BtcDown.bids[liveData.BtcDown.bids.length - 1].price)
                : 0;
            const downAsk = liveData.BtcDown.asks.length > 0
                ? parseFloat(liveData.BtcDown.asks[liveData.BtcDown.asks.length - 1].price)
                : 1;

            const now = new Date();
            const timestamp = now.toISOString();
            const timestampMs = Date.now();

            // Sanity check: reject extreme prices at period start
            const sanityCheck = this.sanityCheckPrices(upBid, upAsk, downBid, downAsk, targetedMarket, now);
            if (!sanityCheck.pass) {
                this.writeLog(`[SANITY] Skipping price write: ${sanityCheck.reason}`);
                return;
            }

            const logLine = `${timestamp},${upBid},${downBid}\n`;
            // Note: Original format was ${timestamp},${upBid},${upAsk},${downBid},${downAsk}
            // Changed to match existing log file format: ${timestamp},${upBid},${downBid}

            // Write to log file (if WRITE_LOGS env is not explicitly false)
            if (process.env.WRITE_LOGS !== 'false') {
                const logFile = this.getLogFromMarket(targetedMarket);
                appendFileSync(logFile, logLine);
            }

            // Write to database
            try {
                const db = TradingDatabase.getInstance();
                const market = this.targetedMarketToDbMarket(targetedMarket);
                db.insertPmarketPrice({
                    timestamp: timestampMs,
                    market,
                    upBid,
                    upAsk,
                    downBid,
                    downAsk,
                });
            } catch (e) {
                // Don't let DB errors stop price logging
                console.error(`[DB ERROR] Failed to write pmarket price: ${e}`);
            }
        } catch (error) {
            this.writeLog(`[ERROR] Failed to log prices: ${error}`);
        }
    }

    /**
     * Convert targeted market to database market name.
     */
    private targetedMarketToDbMarket(targetedMarket: TargetedMarket): string {
        switch (targetedMarket) {
            case TargetedMarket.BITCOIN_HOURLY:
            case TargetedMarket.BITCOIN_QUARTERLY:
                return 'btc';
            case TargetedMarket.ETHEREUM_HOURLY:
            case TargetedMarket.ETHEREUM_QUARTERLY:
                return 'eth';
            case TargetedMarket.SOLANA_HOURLY:
            case TargetedMarket.SOLANA_QUARTERLY:
                return 'sol';
            case TargetedMarket.XRP_HOURLY:
            case TargetedMarket.XRP_QUARTERLY:
                return 'xrp';
            default:
                return 'unknown';
        }
    }

    /**
     * Gets the period key for a given timestamp and market schedule.
     * Hourly markets: "YYYY-MM-DDTHH"
     * Quarterly markets: "YYYY-MM-DDTHH:QN" where N is 0-3
     */
    private getPeriodKey(timestamp: Date, targetedMarket: TargetedMarket): string {
        const schedule = QuantBot.getMarketSchedule(targetedMarket);
        const year = timestamp.getUTCFullYear();
        const month = String(timestamp.getUTCMonth() + 1).padStart(2, '0');
        const day = String(timestamp.getUTCDate()).padStart(2, '0');
        const hour = String(timestamp.getUTCHours()).padStart(2, '0');

        if (schedule === MarketSchedule.QUARTERLY) {
            const quarter = Math.floor(timestamp.getUTCMinutes() / 15);
            return `${year}-${month}-${day}T${hour}:Q${quarter}`;
        }
        return `${year}-${month}-${day}T${hour}`;
    }

    /**
     * Gets how many seconds into the current period we are.
     */
    private getSecondsIntoPeriod(timestamp: Date, targetedMarket: TargetedMarket): number {
        const schedule = QuantBot.getMarketSchedule(targetedMarket);
        const minutes = timestamp.getUTCMinutes();
        const seconds = timestamp.getUTCSeconds();

        if (schedule === MarketSchedule.QUARTERLY) {
            const minuteInQuarter = minutes % 15;
            return minuteInQuarter * 60 + seconds;
        }
        return minutes * 60 + seconds;
    }

    /**
     * Checks if a price is extreme (near 0 or 1).
     */
    private isExtremePrice(price: number): boolean {
        return price <= MarketInfo.EXTREME_PRICE_LOW || price >= MarketInfo.EXTREME_PRICE_HIGH;
    }

    /**
     * Performs sanity checks on price data before writing.
     * Returns true if the data should be written, false if it should be skipped.
     *
     * Checks:
     * 1. At period start (first 60 seconds), extreme prices (< 0.05 or > 0.95) are rejected
     *    because they likely indicate stale data from the previous period.
     */
    private sanityCheckPrices(
        upBid: number,
        upAsk: number,
        downBid: number,
        downAsk: number,
        targetedMarket: TargetedMarket,
        timestamp: Date
    ): { pass: boolean; reason?: string } {
        const currentPeriodKey = this.getPeriodKey(timestamp, targetedMarket);
        const lastPeriodKey = this.lastPeriodKey.get(targetedMarket);
        const secondsIntoPeriod = this.getSecondsIntoPeriod(timestamp, targetedMarket);

        // Update period key
        this.lastPeriodKey.set(targetedMarket, currentPeriodKey);

        // Check if we're at the start of a new period
        const isNewPeriod = lastPeriodKey !== undefined && lastPeriodKey !== currentPeriodKey;
        const isAtPeriodStart = secondsIntoPeriod <= MarketInfo.PERIOD_START_GRACE_SECONDS;

        // At period start (or just after period boundary), reject extreme prices
        if (isAtPeriodStart || isNewPeriod) {
            // Use mid prices for the check
            const upMid = (upBid + upAsk) / 2;
            const downMid = (downBid + downAsk) / 2;

            if (this.isExtremePrice(upMid) || this.isExtremePrice(downMid)) {
                return {
                    pass: false,
                    reason: `Extreme prices at period start rejected: ` +
                        `upMid=${upMid.toFixed(3)}, downMid=${downMid.toFixed(3)}, ` +
                        `period=${currentPeriodKey}, secondsIn=${secondsIntoPeriod}`,
                };
            }
        }

        return { pass: true };
    }
}