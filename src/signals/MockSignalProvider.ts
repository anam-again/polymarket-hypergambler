// ============================================================================
// MockSignalProvider - Mock Signal Provider for Simulation/Testing
// ============================================================================

import {
    BaseSignalProvider,
    SignalProviderConfig,
    SignalSnapshot,
    DEFAULT_SIGNAL_CONFIG,
} from './SignalProvider.js';

/**
 * Configuration for mock signal values.
 */
export interface MockSignalValues {
    volatility?: number;
    momentum?: number;
    priceImbalance?: number;
}

/**
 * MockSignalProvider for simulation and testing.
 *
 * Returns configurable or random signal values for testing multi-signal PEQ
 * without requiring live market data.
 */
export class MockSignalProvider extends BaseSignalProvider {
    private mockValues: MockSignalValues;
    private useRandomValues: boolean;

    constructor(
        config: Partial<SignalProviderConfig> = {},
        mockValues: MockSignalValues = {},
        useRandomValues: boolean = false
    ) {
        super(config);
        this.mockValues = mockValues;
        this.useRandomValues = useRandomValues;
    }

    /**
     * Sets mock values for specific signals.
     */
    setMockValues(values: MockSignalValues): void {
        this.mockValues = { ...this.mockValues, ...values };
    }

    /**
     * Enables or disables random value generation.
     */
    setUseRandomValues(useRandom: boolean): void {
        this.useRandomValues = useRandom;
    }

    /**
     * Gets signal snapshot with mock or random values.
     */
    async getSignals(): Promise<SignalSnapshot> {
        const candleSize = this.getCandleSize();
        const timeLeft = this.getTimeLeft();
        const hourOfDay = this.getHourOfDay();

        let volatility: number;
        let momentum: number;
        let priceImbalance: number;
        let rangePosition: number;
        let trendStrength: number;
        let volatilityTrend: number;

        if (this.useRandomValues) {
            volatility = Math.random();
            momentum = Math.random() * 2 - 1;
            priceImbalance = Math.random() - 0.5;
            rangePosition = Math.random();
            trendStrength = Math.random() * 2 - 1;
            volatilityTrend = Math.random() * 2 - 1;
        } else {
            volatility = this.mockValues.volatility ?? 0.5;
            momentum = this.mockValues.momentum ?? 0;
            priceImbalance = this.mockValues.priceImbalance ?? 0;
            rangePosition = 0.5;
            trendStrength = 0;
            volatilityTrend = 0;
        }

        return {
            candleSize,
            timeLeft,
            volatility,
            momentum,
            priceImbalance,
            rangePosition,
            trendStrength,
            volatilityTrend,
            hourOfDay,
            timestamp: Date.now(),
        };
    }
}

/**
 * HistoricalSignalProvider for simulation with historical data.
 *
 * Computes signals from historical price data during simulation.
 */
export class HistoricalSignalProvider extends BaseSignalProvider {
    private priceHistory: Array<{ timestamp: number; price: number }> = [];
    private upMidPrice: number = 0.5;
    private downMidPrice: number = 0.5;
    private volatilityWindowMinutes: number;
    private momentumWindowMinutes: number;

    constructor(config: Partial<SignalProviderConfig> = {}) {
        super(config);
        const fullConfig = { ...DEFAULT_SIGNAL_CONFIG, ...config };
        this.volatilityWindowMinutes = fullConfig.volatilityWindowMinutes;
        this.momentumWindowMinutes = fullConfig.momentumWindowMinutes;
    }

    /**
     * Updates the price history with a new price point.
     */
    addPricePoint(timestamp: number, price: number): void {
        this.priceHistory.push({ timestamp, price });

        const maxAge =
            Math.max(this.volatilityWindowMinutes, this.momentumWindowMinutes) * 60 * 1000 * 2;

        const cutoff = timestamp - maxAge;
        this.priceHistory = this.priceHistory.filter((p) => p.timestamp >= cutoff);
    }

    /**
     * Updates order book mid prices for imbalance calculation.
     */
    setOrderBookMids(upMid: number, downMid: number): void {
        this.upMidPrice = upMid;
        this.downMidPrice = downMid;
    }

    /**
     * Clears all historical data.
     * Should be called on period reset to avoid carrying stale data.
     */
    clearHistory(): void {
        this.priceHistory = [];
        this.upMidPrice = 0.5;
        this.downMidPrice = 0.5;
    }

    /**
     * Resets the signal provider for a new period.
     * Clears history and resets mid prices to neutral.
     */
    resetForNewPeriod(): void {
        this.clearHistory();
    }

    /**
     * Seeds the price history with historical data.
     * Call this after clearHistory() to provide pre-period context for
     * accurate volatility/momentum signals from the start of the period.
     */
    seedWithHistory(entries: Array<{ timestamp: number; price: number }>): void {
        for (const entry of entries) {
            this.priceHistory.push({ timestamp: entry.timestamp, price: entry.price });
        }
        // Sort by timestamp in case entries aren't ordered
        this.priceHistory.sort((a, b) => a.timestamp - b.timestamp);
    }

    /**
     * Gets prices within a time window (in minutes).
     */
    private getPricesInWindow(windowMinutes: number): number[] {
        if (this.priceHistory.length === 0) return [];

        const now = this.priceHistory[this.priceHistory.length - 1].timestamp;
        const windowMs = windowMinutes * 60 * 1000;
        const cutoff = now - windowMs;

        return this.priceHistory.filter((p) => p.timestamp >= cutoff).map((p) => p.price);
    }

    /**
     * Computes normalized volatility from price history.
     */
    private computeVolatility(): number {
        const prices = this.getPricesInWindow(this.volatilityWindowMinutes);
        if (prices.length < 2) return 0.5;

        const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
        const variance = prices.reduce((sum, p) => sum + Math.pow(p - mean, 2), 0) / prices.length;
        const stdDev = Math.sqrt(variance);

        const normalizedVol = stdDev / (mean * 0.04);
        return Math.max(0, Math.min(1, normalizedVol));
    }

    /**
     * Computes momentum from price history.
     */
    private computeMomentum(): number {
        const prices = this.getPricesInWindow(this.momentumWindowMinutes);
        if (prices.length < 2) return 0;

        const oldPrice = prices[0];
        const newPrice = prices[prices.length - 1];

        if (oldPrice === 0) return 0;

        const change = (newPrice - oldPrice) / oldPrice;
        const normalizedMomentum = change / 0.1;

        return Math.max(-1, Math.min(1, normalizedMomentum));
    }

    /**
     * Computes price imbalance from order book mid prices.
     */
    private computePriceImbalance(): number {
        const imbalance = this.upMidPrice - this.downMidPrice;
        return Math.max(-0.5, Math.min(0.5, imbalance));
    }

    /**
     * Computes range position: where current price sits in recent high/low range.
     * Like Stochastic oscillator: 0 = at low, 1 = at high.
     */
    private computeRangePosition(): number {
        const prices = this.getPricesInWindow(this.volatilityWindowMinutes);
        if (prices.length < 2) return 0.5;

        const high = Math.max(...prices);
        const low = Math.min(...prices);
        const current = prices[prices.length - 1];

        const range = high - low;
        if (range === 0) return 0.5;

        return Math.max(0, Math.min(1, (current - low) / range));
    }

    /**
     * Computes trend strength using linear regression slope.
     * Positive = uptrend, negative = downtrend, normalized to -1 to 1.
     */
    private computeTrendStrength(): number {
        const prices = this.getPricesInWindow(this.momentumWindowMinutes);
        if (prices.length < 3) return 0;

        // Simple linear regression
        const n = prices.length;
        let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;

        for (let i = 0; i < n; i++) {
            sumX += i;
            sumY += prices[i];
            sumXY += i * prices[i];
            sumX2 += i * i;
        }

        const denominator = n * sumX2 - sumX * sumX;
        if (denominator === 0) return 0;

        const slope = (n * sumXY - sumX * sumY) / denominator;
        const meanPrice = sumY / n;

        // Normalize slope relative to mean price (slope per data point as % of price)
        // Multiply by n to get total change over window, then normalize
        if (meanPrice === 0) return 0;
        const normalizedSlope = (slope * n) / meanPrice;

        // Scale to -1 to 1 (assume 5% total change is max expected)
        return Math.max(-1, Math.min(1, normalizedSlope / 0.05));
    }

    /**
     * Computes volatility trend: is volatility increasing or decreasing?
     * Compares recent volatility to older volatility.
     * Positive = increasing, negative = decreasing, range -1 to 1.
     */
    private computeVolatilityTrend(): number {
        // Need enough data for two volatility windows
        const halfWindow = Math.floor(this.volatilityWindowMinutes / 2);
        if (halfWindow < 1) return 0;

        const allPrices = this.getPricesInWindow(this.volatilityWindowMinutes);
        if (allPrices.length < 4) return 0;

        const midPoint = Math.floor(allPrices.length / 2);
        const olderPrices = allPrices.slice(0, midPoint);
        const newerPrices = allPrices.slice(midPoint);

        const computeStdDev = (prices: number[]): number => {
            if (prices.length < 2) return 0;
            const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
            const variance = prices.reduce((sum, p) => sum + Math.pow(p - mean, 2), 0) / prices.length;
            return Math.sqrt(variance);
        };

        const olderVol = computeStdDev(olderPrices);
        const newerVol = computeStdDev(newerPrices);

        if (olderVol === 0) return newerVol > 0 ? 1 : 0;

        // Compute % change in volatility
        const volChange = (newerVol - olderVol) / olderVol;

        // Normalize to -1 to 1 (assume 50% change is significant)
        return Math.max(-1, Math.min(1, volChange / 0.5));
    }

    async getSignals(): Promise<SignalSnapshot> {
        return {
            candleSize: this.getCandleSize(),
            timeLeft: this.getTimeLeft(),
            volatility: this.computeVolatility(),
            momentum: this.computeMomentum(),
            priceImbalance: this.computePriceImbalance(),
            rangePosition: this.computeRangePosition(),
            trendStrength: this.computeTrendStrength(),
            volatilityTrend: this.computeVolatilityTrend(),
            hourOfDay: this.getHourOfDay(),
            timestamp: Date.now(),
        };
    }
}
