import { PolymarketBook, PolymarketBookLevel } from './PolymarketWebSocket.js';

/**
 * Analyzes order book depth to extract features for ML models.
 * Computes volume-based metrics that reveal market sentiment.
 */
export interface OrderBookDepthFeatures {
    // Volume within price ranges
    bidDepth1pct: number;      // Total bid volume within 1% of best bid
    askDepth1pct: number;      // Total ask volume within 1% of best ask
    bidDepth5pct: number;      // Total bid volume within 5% of best bid
    askDepth5pct: number;      // Total ask volume within 5% of best ask

    // Volume metrics
    volumeImbalance: number;   // (bidVol - askVol) / (bidVol + askVol), range [-1, 1]
    bidVWAP: number;           // Volume-weighted average price of top N bids
    askVWAP: number;           // Volume-weighted average price of top N asks

    // Derived signals
    bookPressure: number;      // bidDepth1pct / askDepth1pct (>1 = bullish)
    spreadBps: number;         // Spread in basis points
    midPrice: number;          // (bestBid + bestAsk) / 2

    // Order flow features (new)
    bidAskRatio: number;       // total bid volume / total ask volume
    topBidConcentration: number;  // top bid size / total bid volume
    topAskConcentration: number;  // top ask size / total ask volume
    bidWallDistance: number;   // price distance to largest bid (normalized)
    askWallDistance: number;   // price distance to largest ask (normalized)
    depthImbalance1pct: number;  // (bidDepth1pct - askDepth1pct) / max depth
    depthImbalance5pct: number;  // (bidDepth5pct - askDepth5pct) / max depth
}

export class OrderBookDepthAnalyzer {
    private static readonly VWAP_LEVELS = 5;  // Number of levels for VWAP calculation

    /**
     * Computes depth features from a Polymarket order book snapshot.
     */
    public static analyze(book: PolymarketBook): OrderBookDepthFeatures {
        const bestBid = book.bids.length > 0 ? Math.max(...book.bids.map(b => b.price)) : 0;
        const bestAsk = book.asks.length > 0 ? Math.min(...book.asks.map(a => a.price)) : 1;
        const midPrice = (bestBid + bestAsk) / 2;

        // Calculate depth at various percentage levels
        const bidDepth1pct = this.calculateDepthWithinRange(book.bids, bestBid, 0.01, 'bid');
        const askDepth1pct = this.calculateDepthWithinRange(book.asks, bestAsk, 0.01, 'ask');
        const bidDepth5pct = this.calculateDepthWithinRange(book.bids, bestBid, 0.05, 'bid');
        const askDepth5pct = this.calculateDepthWithinRange(book.asks, bestAsk, 0.05, 'ask');

        // Total volume for imbalance calculation
        const totalBidVolume = book.bids.reduce((sum, b) => sum + b.size, 0);
        const totalAskVolume = book.asks.reduce((sum, a) => sum + a.size, 0);
        const totalVolume = totalBidVolume + totalAskVolume;
        const volumeImbalance = totalVolume > 0
            ? (totalBidVolume - totalAskVolume) / totalVolume
            : 0;

        // Volume-weighted average prices
        const bidVWAP = this.calculateVWAP(book.bids, this.VWAP_LEVELS, 'bid');
        const askVWAP = this.calculateVWAP(book.asks, this.VWAP_LEVELS, 'ask');

        // Book pressure (bid depth vs ask depth near best prices)
        // Clamp to reasonable range to avoid extreme values
        const rawBookPressure = askDepth1pct > 0 ? bidDepth1pct / askDepth1pct : 1;
        const bookPressure = Math.max(0.1, Math.min(10, rawBookPressure));

        // Spread in basis points
        const spreadBps = midPrice > 0 ? ((bestAsk - bestBid) / midPrice) * 10000 : 0;

        // NEW: Bid/Ask ratio (total volumes)
        const bidAskRatio = totalAskVolume > 0
            ? Math.max(0.1, Math.min(10, totalBidVolume / totalAskVolume))
            : 1;

        // NEW: Top concentration (how much of the volume is at the best level)
        const topBidSize = book.bids.length > 0
            ? Math.max(...book.bids.filter(b => b.price === bestBid).map(b => b.size))
            : 0;
        const topAskSize = book.asks.length > 0
            ? Math.max(...book.asks.filter(a => a.price === bestAsk).map(a => a.size))
            : 0;
        const topBidConcentration = totalBidVolume > 0 ? topBidSize / totalBidVolume : 0;
        const topAskConcentration = totalAskVolume > 0 ? topAskSize / totalAskVolume : 0;

        // NEW: Wall distances (distance to largest order in book)
        const { bidWallDistance, askWallDistance } = this.calculateWallDistances(
            book, bestBid, bestAsk, midPrice
        );

        // NEW: Depth imbalances (normalized)
        const maxDepth1pct = Math.max(bidDepth1pct, askDepth1pct, 1);
        const maxDepth5pct = Math.max(bidDepth5pct, askDepth5pct, 1);
        const depthImbalance1pct = (bidDepth1pct - askDepth1pct) / maxDepth1pct;
        const depthImbalance5pct = (bidDepth5pct - askDepth5pct) / maxDepth5pct;

        // Normalize depth values using log transform for ML compatibility
        // log(1 + x) maps large values to smaller range while preserving relative ordering
        return {
            bidDepth1pct: Math.log1p(bidDepth1pct),
            askDepth1pct: Math.log1p(askDepth1pct),
            bidDepth5pct: Math.log1p(bidDepth5pct),
            askDepth5pct: Math.log1p(askDepth5pct),
            volumeImbalance,
            bidVWAP,
            askVWAP,
            bookPressure,
            spreadBps,
            midPrice,
            // New order flow features
            bidAskRatio,
            topBidConcentration,
            topAskConcentration,
            bidWallDistance,
            askWallDistance,
            depthImbalance1pct,
            depthImbalance5pct,
        };
    }

    /**
     * Calculates total volume within a percentage range of the best price.
     * @param levels - Order book levels (bids or asks)
     * @param bestPrice - Best bid or ask price
     * @param pctRange - Percentage range (e.g., 0.01 for 1%)
     * @param side - 'bid' or 'ask' to determine range direction
     */
    private static calculateDepthWithinRange(
        levels: PolymarketBookLevel[],
        bestPrice: number,
        pctRange: number,
        side: 'bid' | 'ask'
    ): number {
        if (bestPrice === 0) return 0;

        const threshold = side === 'bid'
            ? bestPrice * (1 - pctRange)  // Bids: within X% below best bid
            : bestPrice * (1 + pctRange); // Asks: within X% above best ask

        let totalVolume = 0;
        for (const level of levels) {
            const inRange = side === 'bid'
                ? level.price >= threshold
                : level.price <= threshold;

            if (inRange) {
                totalVolume += level.size;
            }
        }

        return totalVolume;
    }

    /**
     * Calculates volume-weighted average price for top N levels.
     */
    private static calculateVWAP(
        levels: PolymarketBookLevel[],
        n: number,
        side: 'bid' | 'ask'
    ): number {
        if (levels.length === 0) return 0;

        // Sort bids descending (highest first), asks ascending (lowest first)
        const sortedLevels = [...levels]
            .sort((a, b) => side === 'bid' ? b.price - a.price : a.price - b.price)
            .slice(0, n);

        let volumeSum = 0;
        let priceVolumeSum = 0;

        for (const level of sortedLevels) {
            volumeSum += level.size;
            priceVolumeSum += level.price * level.size;
        }

        return volumeSum > 0 ? priceVolumeSum / volumeSum : 0;
    }

    /**
     * Calculates distance to largest orders (walls) in the book.
     * Returns normalized distances (0 = at best price, 1 = far away).
     */
    private static calculateWallDistances(
        book: PolymarketBook,
        bestBid: number,
        bestAsk: number,
        midPrice: number
    ): { bidWallDistance: number; askWallDistance: number } {
        // Find largest bid
        let largestBid: PolymarketBookLevel | null = null;
        let maxBidSize = 0;
        for (const bid of book.bids) {
            if (bid.size > maxBidSize) {
                maxBidSize = bid.size;
                largestBid = bid;
            }
        }

        // Find largest ask
        let largestAsk: PolymarketBookLevel | null = null;
        let maxAskSize = 0;
        for (const ask of book.asks) {
            if (ask.size > maxAskSize) {
                maxAskSize = ask.size;
                largestAsk = ask;
            }
        }

        // Calculate normalized distances
        // Distance is normalized by midPrice to get a percentage
        const bidWallDistance = largestBid && midPrice > 0
            ? Math.abs(bestBid - largestBid.price) / midPrice
            : 0;

        const askWallDistance = largestAsk && midPrice > 0
            ? Math.abs(largestAsk.price - bestAsk) / midPrice
            : 0;

        // Clamp to reasonable range
        return {
            bidWallDistance: Math.min(0.5, bidWallDistance),
            askWallDistance: Math.min(0.5, askWallDistance),
        };
    }

    /**
     * Converts depth features to a flat array for ML model input.
     * Returns features in consistent order for the feature vector.
     */
    public static toFeatureArray(features: OrderBookDepthFeatures): number[] {
        return [
            features.bidDepth1pct,
            features.askDepth1pct,
            features.bidDepth5pct,
            features.askDepth5pct,
            features.volumeImbalance,
            features.bidVWAP,
            features.askVWAP,
            features.bookPressure,
        ];
    }

    /**
     * Returns all features including new order flow features.
     */
    public static toFullFeatureArray(features: OrderBookDepthFeatures): number[] {
        return [
            features.bidDepth1pct,
            features.askDepth1pct,
            features.bidDepth5pct,
            features.askDepth5pct,
            features.volumeImbalance,
            features.bidVWAP,
            features.askVWAP,
            features.bookPressure,
            features.bidAskRatio,
            features.topBidConcentration,
            features.topAskConcentration,
            features.bidWallDistance,
            features.askWallDistance,
            features.depthImbalance1pct,
            features.depthImbalance5pct,
        ];
    }

    /**
     * Returns feature names in the same order as toFeatureArray().
     */
    public static getFeatureNames(prefix: string = ''): string[] {
        return [
            `${prefix}bidDepth1pct`,
            `${prefix}askDepth1pct`,
            `${prefix}bidDepth5pct`,
            `${prefix}askDepth5pct`,
            `${prefix}volumeImbalance`,
            `${prefix}bidVWAP`,
            `${prefix}askVWAP`,
            `${prefix}bookPressure`,
        ];
    }

    /**
     * Returns all feature names including new order flow features.
     */
    public static getFullFeatureNames(prefix: string = ''): string[] {
        return [
            `${prefix}bidDepth1pct`,
            `${prefix}askDepth1pct`,
            `${prefix}bidDepth5pct`,
            `${prefix}askDepth5pct`,
            `${prefix}volumeImbalance`,
            `${prefix}bidVWAP`,
            `${prefix}askVWAP`,
            `${prefix}bookPressure`,
            `${prefix}bidAskRatio`,
            `${prefix}topBidConcentration`,
            `${prefix}topAskConcentration`,
            `${prefix}bidWallDistance`,
            `${prefix}askWallDistance`,
            `${prefix}depthImbalance1pct`,
            `${prefix}depthImbalance5pct`,
        ];
    }
}
