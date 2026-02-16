import { BinanceWebSocket, BinanceSymbol, BinancePriceEvent } from './BinanceWebSocket.js';
import { DataLogger } from './DataLogger.js';

/**
 * A single price point in the buffer.
 */
export interface PricePoint {
    timestamp: number;
    price: number;
}

/**
 * Circular buffer for real-time price data.
 * Integrates with BinanceWebSocket for sub-100ms updates.
 */
export class RealTimePriceBuffer {
    private buffer: PricePoint[] = [];
    private maxAgeMs: number;
    private websocket: BinanceWebSocket | null = null;
    private symbol: BinanceSymbol;

    constructor(symbol: BinanceSymbol, maxAgeMs: number = 5 * 60 * 1000) {
        this.symbol = symbol;
        this.maxAgeMs = maxAgeMs;
    }

    /**
     * Starts WebSocket connection and begins buffering prices.
     */
    public start(): void {
        this.websocket = new BinanceWebSocket(this.symbol);

        this.websocket.on('price', (event: BinancePriceEvent) => {
            this.add(event.price, event.timestamp);
        });

        this.websocket.connect();
    }

    /**
     * Stops WebSocket connection.
     */
    public stop(): void {
        if (this.websocket) {
            this.websocket.disconnect();
            this.websocket = null;
        }
    }

    /**
     * Adds a price point to the buffer (called automatically by WebSocket).
     */
    public add(price: number, timestamp?: number): void {
        const ts = timestamp ?? Date.now();
        this.buffer.push({ timestamp: ts, price });

        // Log for historical ML training (throttled internally to every 5s)
        DataLogger.logBinancePrice(this.symbol, price, ts);

        // Prune old entries
        const cutoff = Date.now() - this.maxAgeMs;
        while (this.buffer.length > 0 && this.buffer[0].timestamp < cutoff) {
            this.buffer.shift();
        }
    }

    /**
     * Gets percentage price change over the last N seconds.
     */
    public getCandle(secondsAgo: number): number {
        const now = Date.now();
        const targetTime = now - (secondsAgo * 1000);
        const current = this.buffer[this.buffer.length - 1]?.price ?? 0;
        const past = this.getPriceAt(targetTime);

        if (!past || past === 0) return 0;
        return (current - past) / past;
    }

    /**
     * Gets simple moving average over the last N seconds.
     */
    public getMA(seconds: number): number {
        const now = Date.now();
        const cutoff = now - (seconds * 1000);
        const relevant = this.buffer.filter(p => p.timestamp >= cutoff);

        if (relevant.length === 0) return 0;
        return relevant.reduce((sum, p) => sum + p.price, 0) / relevant.length;
    }

    /**
     * Gets price volatility (standard deviation) over the last N seconds.
     */
    public getVolatility(seconds: number): number {
        const now = Date.now();
        const cutoff = now - (seconds * 1000);
        const prices = this.buffer.filter(p => p.timestamp >= cutoff).map(p => p.price);

        if (prices.length < 2) return 0;

        const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
        const variance = prices.reduce((sum, p) => sum + Math.pow(p - mean, 2), 0) / prices.length;
        return Math.sqrt(variance);
    }

    /**
     * Gets the most recent price.
     */
    public getCurrentPrice(): number | null {
        return this.buffer[this.buffer.length - 1]?.price ?? null;
    }

    /**
     * Gets the timestamp of the most recent price.
     */
    public getLastUpdateTime(): number | null {
        return this.buffer[this.buffer.length - 1]?.timestamp ?? null;
    }

    /**
     * Gets the number of price points in the buffer.
     */
    public getBufferSize(): number {
        return this.buffer.length;
    }

    /**
     * Checks if the buffer is receiving live data.
     */
    public isLive(): boolean {
        const lastUpdate = this.getLastUpdateTime();
        if (!lastUpdate) return false;
        return Date.now() - lastUpdate < 5000; // Consider stale after 5 seconds
    }

    /**
     * Gets price at a specific timestamp using binary search.
     */
    private getPriceAt(timestamp: number): number | null {
        if (this.buffer.length === 0) return null;

        // Binary search for efficiency with large buffers
        let left = 0;
        let right = this.buffer.length - 1;
        let closest: PricePoint | null = null;
        let minDiff = Infinity;

        while (left <= right) {
            const mid = Math.floor((left + right) / 2);
            const diff = Math.abs(this.buffer[mid].timestamp - timestamp);

            if (diff < minDiff) {
                minDiff = diff;
                closest = this.buffer[mid];
            }

            if (this.buffer[mid].timestamp < timestamp) {
                left = mid + 1;
            } else {
                right = mid - 1;
            }
        }

        return closest?.price ?? null;
    }

    /**
     * Gets all price points within a time range.
     */
    public getPricesInRange(startMs: number, endMs: number): PricePoint[] {
        return this.buffer.filter(p => p.timestamp >= startMs && p.timestamp <= endMs);
    }

    /**
     * Gets the minimum price over the last N seconds.
     */
    public getMin(seconds: number): number | null {
        const now = Date.now();
        const cutoff = now - (seconds * 1000);
        const prices = this.buffer.filter(p => p.timestamp >= cutoff).map(p => p.price);

        if (prices.length === 0) return null;
        return Math.min(...prices);
    }

    /**
     * Gets the maximum price over the last N seconds.
     */
    public getMax(seconds: number): number | null {
        const now = Date.now();
        const cutoff = now - (seconds * 1000);
        const prices = this.buffer.filter(p => p.timestamp >= cutoff).map(p => p.price);

        if (prices.length === 0) return null;
        return Math.max(...prices);
    }

    /**
     * Clears the buffer.
     */
    public clear(): void {
        this.buffer = [];
    }
}

// Re-export BinanceSymbol for convenience
export { BinanceSymbol } from './BinanceWebSocket.js';
