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

        let volatility: number;
        let momentum: number;
        let priceImbalance: number;

        if (this.useRandomValues) {
            volatility = Math.random();
            momentum = Math.random() * 2 - 1;
            priceImbalance = Math.random() - 0.5;
        } else {
            volatility = this.mockValues.volatility ?? 0.5;
            momentum = this.mockValues.momentum ?? 0;
            priceImbalance = this.mockValues.priceImbalance ?? 0;
        }

        return {
            candleSize,
            timeLeft,
            volatility,
            momentum,
            priceImbalance,
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
     */
    clearHistory(): void {
        this.priceHistory = [];
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

    async getSignals(): Promise<SignalSnapshot> {
        return {
            candleSize: this.getCandleSize(),
            timeLeft: this.getTimeLeft(),
            volatility: this.computeVolatility(),
            momentum: this.computeMomentum(),
            priceImbalance: this.computePriceImbalance(),
            timestamp: Date.now(),
        };
    }
}
