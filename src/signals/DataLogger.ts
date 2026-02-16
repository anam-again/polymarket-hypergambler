import { appendFileSync, existsSync, mkdirSync } from 'fs';
import { OrderBookDepthFeatures } from './OrderBookDepthAnalyzer.js';
import { BinanceSymbol } from './BinanceWebSocket.js';

/**
 * Logs Binance prices and order book depth for historical ML training.
 *
 * Log files created:
 *   - ./logs/ml-data/binance-{symbol}.log     - Binance price data
 *   - ./logs/ml-data/depth-{market}-up.log    - UP token order book depth
 *   - ./logs/ml-data/depth-{market}-down.log  - DOWN token order book depth
 *
 * Log format is CSV for easy parsing:
 *   - Binance: timestamp,price
 *   - Depth: timestamp,bidDepth1pct,askDepth1pct,bidDepth5pct,askDepth5pct,...
 */

const LOG_DIRECTORY = './logs/ml-data';

export class DataLogger {
    private static initialized = false;
    private static logInterval: number = 5000; // Log every 5 seconds (matches price logging)
    private static lastBinanceLog: Map<BinanceSymbol, number> = new Map();
    private static lastDepthLog: Map<string, number> = new Map();

    /**
     * Ensures the log directory exists.
     */
    private static ensureDirectory(): void {
        if (!this.initialized) {
            if (!existsSync(LOG_DIRECTORY)) {
                mkdirSync(LOG_DIRECTORY, { recursive: true });
            }
            this.initialized = true;
        }
    }

    /**
     * Gets the Binance log file path for a symbol.
     */
    private static getBinanceLogPath(symbol: BinanceSymbol): string {
        return `${LOG_DIRECTORY}/binance-${symbol.toLowerCase()}.log`;
    }

    /**
     * Gets the depth log file path for a market/token combination.
     */
    private static getDepthLogPath(market: string, token: 'up' | 'down'): string {
        return `${LOG_DIRECTORY}/depth-${market.toLowerCase()}-${token}.log`;
    }

    /**
     * Logs a Binance price update.
     * Throttled to logInterval to avoid excessive disk writes.
     *
     * @param symbol - The trading symbol (e.g., 'BTCUSDT')
     * @param price - The current price
     * @param timestamp - The timestamp of the price update
     */
    public static logBinancePrice(
        symbol: BinanceSymbol,
        price: number,
        timestamp: number = Date.now()
    ): void {
        // Throttle logging
        const lastLog = this.lastBinanceLog.get(symbol) ?? 0;
        if (timestamp - lastLog < this.logInterval) {
            return;
        }

        this.ensureDirectory();

        const logFile = this.getBinanceLogPath(symbol);
        const logLine = `${new Date(timestamp).toISOString()},${price}\n`;

        try {
            appendFileSync(logFile, logLine);
            this.lastBinanceLog.set(symbol, timestamp);
        } catch (error) {
            console.error(`[DataLogger] Failed to write Binance log: ${error}`);
        }
    }

    /**
     * Logs order book depth features.
     * Throttled to logInterval to avoid excessive disk writes.
     *
     * @param market - The market identifier (e.g., 'btc', 'eth')
     * @param token - Which token ('up' or 'down')
     * @param features - The order book depth features
     * @param timestamp - The timestamp of the snapshot
     */
    public static logOrderBookDepth(
        market: string,
        token: 'up' | 'down',
        features: OrderBookDepthFeatures,
        timestamp: number = Date.now()
    ): void {
        const key = `${market}-${token}`;

        // Throttle logging
        const lastLog = this.lastDepthLog.get(key) ?? 0;
        if (timestamp - lastLog < this.logInterval) {
            return;
        }

        this.ensureDirectory();

        const logFile = this.getDepthLogPath(market, token);

        // Write header if file doesn't exist
        if (!existsSync(logFile)) {
            const header = [
                'timestamp',
                'bidDepth1pct',
                'askDepth1pct',
                'bidDepth5pct',
                'askDepth5pct',
                'volumeImbalance',
                'bidVWAP',
                'askVWAP',
                'bookPressure',
                'spreadBps',
                'midPrice',
                'bidAskRatio',
                'topBidConcentration',
                'topAskConcentration',
                'bidWallDistance',
                'askWallDistance',
                'depthImbalance1pct',
                'depthImbalance5pct',
            ].join(',') + '\n';
            appendFileSync(logFile, header);
        }

        // Build CSV line with all features
        const values = [
            new Date(timestamp).toISOString(),
            features.bidDepth1pct.toFixed(6),
            features.askDepth1pct.toFixed(6),
            features.bidDepth5pct.toFixed(6),
            features.askDepth5pct.toFixed(6),
            features.volumeImbalance.toFixed(6),
            features.bidVWAP.toFixed(6),
            features.askVWAP.toFixed(6),
            features.bookPressure.toFixed(6),
            features.spreadBps.toFixed(2),
            features.midPrice.toFixed(6),
            features.bidAskRatio.toFixed(6),
            features.topBidConcentration.toFixed(6),
            features.topAskConcentration.toFixed(6),
            features.bidWallDistance.toFixed(6),
            features.askWallDistance.toFixed(6),
            features.depthImbalance1pct.toFixed(6),
            features.depthImbalance5pct.toFixed(6),
        ];

        const logLine = values.join(',') + '\n';

        try {
            appendFileSync(logFile, logLine);
            this.lastDepthLog.set(key, timestamp);
        } catch (error) {
            console.error(`[DataLogger] Failed to write depth log: ${error}`);
        }
    }

    /**
     * Configures the logging interval.
     * @param intervalMs - Minimum time between log entries in milliseconds
     */
    public static setLogInterval(intervalMs: number): void {
        this.logInterval = intervalMs;
    }

    /**
     * Gets the current log interval.
     */
    public static getLogInterval(): number {
        return this.logInterval;
    }

    /**
     * Forces an immediate log entry (bypasses throttling).
     * Use sparingly, e.g., at period boundaries.
     */
    public static forceLogBinancePrice(
        symbol: BinanceSymbol,
        price: number,
        timestamp: number = Date.now()
    ): void {
        this.ensureDirectory();

        const logFile = this.getBinanceLogPath(symbol);
        const logLine = `${new Date(timestamp).toISOString()},${price}\n`;

        try {
            appendFileSync(logFile, logLine);
            this.lastBinanceLog.set(symbol, timestamp);
        } catch (error) {
            console.error(`[DataLogger] Failed to write Binance log: ${error}`);
        }
    }

    /**
     * Forces an immediate depth log entry (bypasses throttling).
     */
    public static forceLogOrderBookDepth(
        market: string,
        token: 'up' | 'down',
        features: OrderBookDepthFeatures,
        timestamp: number = Date.now()
    ): void {
        const key = `${market}-${token}`;
        // Temporarily set lastLog to 0 to bypass throttle
        const savedLastLog = this.lastDepthLog.get(key);
        this.lastDepthLog.set(key, 0);

        this.logOrderBookDepth(market, token, features, timestamp);

        // Don't restore - we want the new timestamp to stick
    }

    /**
     * Resets all throttle timers. Useful for testing.
     */
    public static resetThrottles(): void {
        this.lastBinanceLog.clear();
        this.lastDepthLog.clear();
    }
}
