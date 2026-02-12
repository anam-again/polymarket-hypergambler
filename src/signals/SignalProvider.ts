// ============================================================================
// SignalProvider - Interface for Market Signal Computation
// ============================================================================

import { SignalName } from '../utils/MultiSignalPEQ.js';

/**
 * Snapshot of all signals at a point in time.
 */
export interface SignalSnapshot {
    /** Normalized candle size: (high - low) / reference */
    candleSize: number;
    /** Time remaining in period: (periodEnd - now) / periodLength, range 0-1 */
    timeLeft: number;
    /** Normalized volatility: std dev of recent prices, range 0-1 */
    volatility: number;
    /** Price momentum: recent price change percentage, range -1 to 1 */
    momentum: number;
    /** Order book imbalance: (upMid - downMid), range -0.5 to 0.5 */
    priceImbalance: number;
    /** Where price sits in recent range (0 = at low, 1 = at high), like Stochastic */
    rangePosition: number;
    /** Trend strength from linear regression slope, range -1 to 1 */
    trendStrength: number;
    /** Volatility trend: positive = increasing, negative = decreasing, range -1 to 1 */
    volatilityTrend: number;
    /** Hour of day normalized to 0-1 (0 = midnight, 0.5 = noon) */
    hourOfDay: number;
    /** Timestamp of when signals were computed */
    timestamp: number;
}

/**
 * Configuration for signal computation.
 */
export interface SignalProviderConfig {
    /** Reference value for normalizing candle size (e.g., 1000) */
    candleSizeReference: number;
    /** Number of minutes to look back for volatility calculation */
    volatilityWindowMinutes: number;
    /** Number of minutes to look back for momentum calculation */
    momentumWindowMinutes: number;
    /** Period length in milliseconds for timeLeft calculation */
    periodLengthMs: number;
    /** Optional clock for simulation compatibility (uses Date.now() if not provided) */
    clock?: { now(): number };
}

/**
 * Default signal provider configuration.
 */
export const DEFAULT_SIGNAL_CONFIG: SignalProviderConfig = {
    candleSizeReference: 1000,
    volatilityWindowMinutes: 5,
    momentumWindowMinutes: 3,
    periodLengthMs: 60 * 60 * 1000, // 1 hour
};

/**
 * Interface for signal providers.
 * Implementations can be live (fetching from APIs) or mock (for simulation).
 */
export interface ISignalProvider {
    /**
     * Gets the current snapshot of all signals.
     */
    getSignals(): Promise<SignalSnapshot>;

    /**
     * Gets a specific signal value.
     */
    getSignal(name: SignalName): Promise<number>;

    /**
     * Gets the current volatility (convenience method).
     */
    getVolatility(): Promise<number>;

    /**
     * Gets the current momentum (convenience method).
     */
    getMomentum(): Promise<number>;

    /**
     * Gets the current price imbalance (convenience method).
     */
    getPriceImbalance(): Promise<number>;

    /**
     * Updates the period timing for timeLeft calculation.
     */
    setPeriodTiming(periodStart: number, periodEnd: number): void;

    /**
     * Updates the candle data for candleSize calculation.
     */
    setCandleData(high: number, low: number): void;
}

/**
 * Base class with common signal provider functionality.
 */
export abstract class BaseSignalProvider implements ISignalProvider {
    protected config: SignalProviderConfig;
    protected periodStart: number = 0;
    protected periodEnd: number = 0;
    protected candleHigh: number = 0;
    protected candleLow: number = 0;
    protected clock?: { now(): number };

    constructor(config: Partial<SignalProviderConfig> = {}) {
        this.config = { ...DEFAULT_SIGNAL_CONFIG, ...config };
        this.clock = config.clock;
    }

    abstract getSignals(): Promise<SignalSnapshot>;

    async getSignal(name: SignalName): Promise<number> {
        const signals = await this.getSignals();
        return signals[name as keyof SignalSnapshot] as number;
    }

    async getVolatility(): Promise<number> {
        return this.getSignal('volatility');
    }

    async getMomentum(): Promise<number> {
        return this.getSignal('momentum');
    }

    async getPriceImbalance(): Promise<number> {
        return this.getSignal('priceImbalance');
    }

    setPeriodTiming(periodStart: number, periodEnd: number): void {
        this.periodStart = periodStart;
        this.periodEnd = periodEnd;
    }

    setCandleData(high: number, low: number): void {
        this.candleHigh = high;
        this.candleLow = low;
    }

    /**
     * Gets timeLeft signal from period timing.
     */
    getTimeLeft(): number {
        if (this.periodEnd === 0 || this.periodStart === 0) return 1;
        const now = this.clock?.now() ?? Date.now();
        const periodLength = this.periodEnd - this.periodStart;
        if (periodLength <= 0) return 1;
        const remaining = Math.max(0, this.periodEnd - now);
        return remaining / periodLength;
    }

    /**
     * Gets candleSize signal from high/low data.
     */
    getCandleSize(): number {
        const range = this.candleHigh - this.candleLow;
        return range / this.config.candleSizeReference;
    }

    /**
     * Gets hourOfDay signal normalized to 0-1.
     * 0 = midnight UTC, 0.5 = noon UTC, 1 = midnight UTC
     */
    getHourOfDay(): number {
        const now = this.clock?.now() ?? Date.now();
        const date = new Date(now);
        const hours = date.getUTCHours();
        const minutes = date.getUTCMinutes();
        return (hours + minutes / 60) / 24;
    }
}
