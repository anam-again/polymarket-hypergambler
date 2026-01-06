import { ClobClient, OrderBookSummary, Side } from "@polymarket/clob-client";

import { appendFileSync } from "fs";

import { retryWrapper } from "../utils/networking.js";

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

export class MarketInfo {

    private static readonly UPDATE_DATA_INTERVAL = 4 * 1000; // 5s

    private client!: ClobClient;

    private cachedClobTokenIds: string[] = [];
    private clobTokenIdsFetchedAt = 0;

    private cachedOrderBooks!: BtcOrderBooks;
    private orderBooksFetchedAt = 0;
    private liveDataPending: Promise<BtcOrderBooks> | null = null;

    private priceCache: Map<string, { price: number; fetchedAt: number }> = new Map();
    private pricePending: Map<string, Promise<number>> = new Map();

    constructor(props: MarketInfoProps) {
        this.client = props.client;
        this.getLiveData().catch((e) => {
            this.writeLog(`[ERROR] Failed to initialize live data: ${e}`);
        });
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
        appendFileSync(`./logs/MarketInfoErrors.log`, logLine);
    }

    /**
     * Constructs the Polymarket API URL for the Bitcoin hourly market at a given timestamp.
     * @param timestamp - The timestamp in milliseconds since epoch.
     * @returns The Polymarket gamma API URL for the Bitcoin up/down market.
     */
    public getBitcoinHourlyUrl(timestamp: number) {
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

        return `https://gamma-api.polymarket.com/events/slug/bitcoin-up-or-down-${stringMonth}-${time.day}-${stringHour}-et`
    }

    public async getMarketInfo(url: string): Promise<MarketInfoSimple> {
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

        return {
            clobTokenIds: marketJson.clobTokenIds,
            outcomePrices: marketJson.outcomePrices,
        };
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
    public async getBitcoinHourClobs(timestamp: number): Promise<string[]> {
        const url = this.getBitcoinHourlyUrl(timestamp);
        const markets = await this.getMarketInfo(url);
        return markets.clobTokenIds;
    }

    /**
     * Gets the CLOB token IDs for the current Bitcoin hourly market.
     * Results are cached and expire on the hour (e.g., at 13:00, 14:00).
     * @returns A promise resolving to an array of CLOB token IDs [btcUp, btcDown].
     */
    public async getCurrentClobTokenIds(): Promise<string[]> {
        const now = Date.now();
        const currentHour = new Date(now).getHours();
        const cachedHour = new Date(this.clobTokenIdsFetchedAt).getHours();
        const isExpired = this.clobTokenIdsFetchedAt === 0 || currentHour !== cachedHour;

        if (this.cachedClobTokenIds.length === 0 || isExpired) {
            this.cachedClobTokenIds = await this.getBitcoinHourClobs(this.getCurrentEstTimestamp());
            this.clobTokenIdsFetchedAt = now;
        }
        return this.cachedClobTokenIds;
    }

    /**
     * Gets the current order books for Bitcoin up/down markets.
     * Results are cached and expire every UPDATE_DATA_INTERVAL seconds.
     * Uses a mutex lock to prevent concurrent fetches.
     * @returns A promise resolving to the BtcOrderBooks containing buy/sell order books.
     */
    public async getLiveData(): Promise<BtcOrderBooks> {
        if (this.liveDataPending) {
            return this.liveDataPending;
        }

        const now = Date.now();
        const isExpired = this.orderBooksFetchedAt === 0 || now - this.orderBooksFetchedAt >= MarketInfo.UPDATE_DATA_INTERVAL;

        if (!this.cachedOrderBooks || isExpired) {
            this.liveDataPending = (async () => {
                try {
                    const clobTokenIds = await this.getCurrentClobTokenIds();
                    const orderBooks = await this.client.getOrderBooks([
                        { token_id: clobTokenIds[0], side: Side.BUY },
                        { token_id: clobTokenIds[0], side: Side.SELL },
                        { token_id: clobTokenIds[1], side: Side.BUY },
                        { token_id: clobTokenIds[1], side: Side.SELL },
                    ]);
                    this.cachedOrderBooks = {
                        BtcUpTokenId: clobTokenIds[0],
                        BtcUp: orderBooks[0],
                        BtcDownTokenId: clobTokenIds[1],
                        BtcDown: orderBooks[1],
                    };
                    this.orderBooksFetchedAt = Date.now();
                    return this.cachedOrderBooks;
                } finally {
                    this.liveDataPending = null;
                }
            })();
            return this.liveDataPending;
        }
        return this.cachedOrderBooks;
    }
}