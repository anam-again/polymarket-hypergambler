// ============================================================================
// MultiSignalPEQ - Multi-Signal Linear Equation Scaling
// ============================================================================

import { ScalingPEQ, ScalingPEQCoefficients } from './ScalingPEQ.js';

/**
 * Configuration for a single signal in the multi-signal PEQ.
 */
export interface SignalConfig {
    /** Signal name (e.g., 'candleSize', 'volatility', 'momentum') */
    name: string;
    /** Weight for this signal's contribution (genetically optimized) */
    weight: number;
    /** Linear coefficients for this signal (c0 + c1*x) */
    coefficients: ScalingPEQCoefficients;
    /** Optional normalization bounds for the input signal */
    normalize?: { min: number; max: number };
}

/**
 * Configuration for the multi-signal PEQ.
 */
export interface MultiSignalPEQConfig {
    /** Array of signal configurations */
    signals: SignalConfig[];
    /** Optional base value to scale (e.g., baseBuyPrice) */
    baseValue?: number;
    /** Optional output clamping bounds */
    outputClamp?: { min: number; max: number };
}

/**
 * Signal names used in the trading system.
 */
export const SIGNAL_NAMES = [
    'candleSize',
    'timeLeft',
    'volatility',
    'momentum',
    'priceImbalance',
    'rangePosition',
    'trendStrength',
    'volatilityTrend',
    'hourOfDay',
] as const;

export type SignalName = (typeof SIGNAL_NAMES)[number];

/**
 * MultiSignalPEQ - Multi-Signal Linear Equation Scaling
 *
 * Combines multiple input signals, each with their own linear equation and weight.
 * This allows the genetic optimizer to learn relationships between multiple market
 * signals and trading decisions.
 *
 * Output computation:
 * - If baseValue provided: output = baseValue * Σ(weight_i * PEQ_i(signal_i))
 * - If no baseValue: output = Σ(weight_i * PEQ_i(signal_i))
 *
 * Each signal can have its own normalization bounds, linear coefficients,
 * and contribution weight, giving the optimizer 3 parameters per signal:
 * weight, c0, c1
 */
export class MultiSignalPEQ {
    private readonly signals: Array<{
        name: string;
        weight: number;
        peq: ScalingPEQ;
        normalize?: { min: number; max: number };
    }>;
    private readonly baseValue?: number;
    private readonly outputClamp?: { min: number; max: number };

    constructor(config: MultiSignalPEQConfig) {
        this.signals = config.signals.map((s) => ({
            name: s.name,
            weight: s.weight,
            peq: new ScalingPEQ(s.coefficients),
            normalize: s.normalize,
        }));
        this.baseValue = config.baseValue;
        this.outputClamp = config.outputClamp;
    }

    /**
     * Normalizes a signal value to the range [0, 1] if bounds are specified.
     */
    private normalizeSignal(value: number, bounds?: { min: number; max: number }): number {
        if (!bounds) return value;
        const range = bounds.max - bounds.min;
        if (range === 0) return 0;
        return Math.max(0, Math.min(1, (value - bounds.min) / range));
    }

    /**
     * Computes output from multiple signals.
     *
     * For each signal:
     * 1. Normalize the input if bounds are specified
     * 2. Compute PEQ(normalizedSignal)
     * 3. Multiply by weight
     *
     * Sum all weighted contributions, then optionally multiply by baseValue.
     *
     * @param signals - Record of signal name to signal value
     * @returns The computed output value
     */
    compute(signals: Record<string, number>): number {
        let weightedSum = 0;

        for (const signal of this.signals) {
            const rawValue = signals[signal.name];
            if (rawValue === undefined) {
                // Skip signals not provided (weight effectively 0)
                continue;
            }

            const normalizedValue = this.normalizeSignal(rawValue, signal.normalize);
            const peqOutput = signal.peq.compute(normalizedValue);
            weightedSum += signal.weight * peqOutput;
        }

        // Apply base value if specified
        let output = this.baseValue !== undefined ? this.baseValue * weightedSum : weightedSum;

        // Apply output clamping if specified
        if (this.outputClamp) {
            output = Math.max(this.outputClamp.min, Math.min(this.outputClamp.max, output));
        }

        return output;
    }

    /**
     * Returns flat parameter representation for genetic optimizer.
     * Uses LINEAR model (w, c0, c1 only) to reduce parameter count.
     *
     * @param prefix - Parameter name prefix (e.g., 'buyPrice')
     * @returns Record of flat parameter names to values
     *
     * Example output:
     * {
     *   'buyPrice_candleSize_w': 0.5,
     *   'buyPrice_candleSize_c0': 0.4,
     *   'buyPrice_candleSize_c1': -0.2,
     *   'buyPrice_volatility_w': 0.3,
     *   ...
     * }
     */
    toFlatParams(prefix: string): Record<string, number> {
        const params: Record<string, number> = {};

        for (const signal of this.signals) {
            const signalPrefix = `${prefix}_${signal.name}`;
            params[`${signalPrefix}_w`] = signal.weight;

            const coeffs = signal.peq.getCoefficients();
            // Linear model: only c0 and c1
            params[`${signalPrefix}_c0`] = coeffs.c0;
            params[`${signalPrefix}_c1`] = coeffs.c1;
        }

        if (this.baseValue !== undefined) {
            params[`${prefix}_baseValue`] = this.baseValue;
        }

        return params;
    }

    /**
     * Creates MultiSignalPEQ from flat parameters (for genetic optimizer loading).
     *
     * @param prefix - Parameter name prefix (e.g., 'buyPrice')
     * @param params - Flat parameter record from optimizer
     * @param signalNames - Array of signal names to extract
     * @param options - Optional configuration (normalization, output clamping)
     * @returns New MultiSignalPEQ instance
     */
    static fromFlatParams(
        prefix: string,
        params: Record<string, number>,
        signalNames: string[],
        options?: {
            normalizations?: Record<string, { min: number; max: number }>;
            outputClamp?: { min: number; max: number };
        }
    ): MultiSignalPEQ {
        const signals: SignalConfig[] = signalNames.map((name) => {
            const signalPrefix = `${prefix}_${name}`;

            return {
                name,
                weight: params[`${signalPrefix}_w`] ?? 0,
                coefficients: {
                    c0: params[`${signalPrefix}_c0`] ?? 1,
                    c1: params[`${signalPrefix}_c1`] ?? 0,
                },
                normalize: options?.normalizations?.[name],
            };
        });

        const baseValue = params[`${prefix}_baseValue`];

        return new MultiSignalPEQ({
            signals,
            baseValue: baseValue !== undefined ? baseValue : undefined,
            outputClamp: options?.outputClamp,
        });
    }

    /**
     * Creates a default MultiSignalPEQ with unit weights and identity PEQs.
     * Useful as a baseline for comparison.
     *
     * @param signalNames - Array of signal names
     * @returns New MultiSignalPEQ with default configuration
     */
    static default(signalNames: string[]): MultiSignalPEQ {
        return new MultiSignalPEQ({
            signals: signalNames.map((name) => ({
                name,
                weight: 1.0 / signalNames.length, // Equal weights summing to 1
                coefficients: { c0: 1, c1: 0 },
            })),
        });
    }

    /**
     * Gets the configuration for serialization/logging.
     */
    getConfig(): MultiSignalPEQConfig {
        return {
            signals: this.signals.map((s) => ({
                name: s.name,
                weight: s.weight,
                coefficients: s.peq.getCoefficients(),
                normalize: s.normalize,
            })),
            baseValue: this.baseValue,
            outputClamp: this.outputClamp,
        };
    }

    /**
     * Gets signal names configured in this MSPEQ.
     */
    getSignalNames(): string[] {
        return this.signals.map((s) => s.name);
    }

    /**
     * Gets the weight for a specific signal.
     */
    getSignalWeight(name: string): number | undefined {
        return this.signals.find((s) => s.name === name)?.weight;
    }
}

/**
 * Standard normalization bounds for common signals.
 */
export const STANDARD_NORMALIZATIONS: Record<SignalName, { min: number; max: number }> = {
    candleSize: { min: 0, max: 2 },
    timeLeft: { min: 0, max: 1 },
    volatility: { min: 0, max: 1 },
    momentum: { min: -1, max: 1 },
    priceImbalance: { min: -0.5, max: 0.5 },
    rangePosition: { min: 0, max: 1 },
    trendStrength: { min: -1, max: 1 },
    volatilityTrend: { min: -1, max: 1 },
    hourOfDay: { min: 0, max: 1 },
};

/**
 * Helper to generate parameter bounds for a MultiSignalPEQ.
 *
 * Uses LINEAR model (c0 + c1*x) for efficient optimization.
 *
 * @param prefix - Parameter name prefix (e.g., 'buyPrice')
 * @param signalNames - Array of signal names
 * @param weightBounds - Bounds for weights (default 0-2)
 * @param coeffBounds - Bounds for coefficients (default -2 to 2)
 * @returns Record of parameter bounds for genetic optimizer
 */
export function generateMSPEQBounds(
    prefix: string,
    signalNames: string[],
    weightBounds: { min: number; max: number } = { min: 0, max: 2 },
    coeffBounds: { min: number; max: number; c0Min?: number; c0Max?: number } = {
        min: -2,
        max: 2,
    }
): Record<string, { min: number; max: number }> {
    const bounds: Record<string, { min: number; max: number }> = {};

    for (const name of signalNames) {
        const signalPrefix = `${prefix}_${name}`;

        // Linear model: weight, c0 (intercept), c1 (slope)
        bounds[`${signalPrefix}_w`] = weightBounds;
        bounds[`${signalPrefix}_c0`] = {
            min: coeffBounds.c0Min ?? coeffBounds.min,
            max: coeffBounds.c0Max ?? coeffBounds.max,
        };
        bounds[`${signalPrefix}_c1`] = coeffBounds;
    }

    return bounds;
}
