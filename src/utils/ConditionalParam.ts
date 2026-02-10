// ============================================================================
// ConditionalParam - Conditional Base Parameter Adjustment
// ============================================================================

import { ScalingPEQ, ScalingPEQCoefficients } from './ScalingPEQ.js';

/**
 * Configuration for a conditional parameter adjustment.
 */
export interface ConditionalParamConfig {
    /** Base value before adjustment */
    baseValue: number;
    /** PEQ coefficients for adjustment function */
    adjustmentPEQ: ScalingPEQCoefficients;
    /** Name of the signal used for adjustment (e.g., 'volatility') */
    signalName: string;
    /** Optional clamping bounds for the effective value */
    clamp?: { min: number; max: number };
}

/**
 * ConditionalParam - Adjusts base parameters at period start based on signals.
 *
 * This class allows static parameters (like breakoutBuffer, pullbackBuffer)
 * to adapt based on market conditions at the start of each trading period.
 *
 * Example usage:
 * - In high volatility, use a wider breakoutBuffer
 * - In low volatility, use a tighter pullbackBuffer
 *
 * The adjustment is computed as:
 *   effectiveValue = baseValue * PEQ(signalValue)
 *
 * This is meant to be computed once at period reset, not on every tick.
 */
export class ConditionalParam {
    private readonly baseValue: number;
    private readonly adjustmentPEQ: ScalingPEQ;
    private readonly signalName: string;
    private readonly clamp?: { min: number; max: number };

    constructor(config: ConditionalParamConfig) {
        this.baseValue = config.baseValue;
        this.adjustmentPEQ = new ScalingPEQ(config.adjustmentPEQ);
        this.signalName = config.signalName;
        this.clamp = config.clamp;
    }

    /**
     * Computes the effective value by adjusting the base value based on signal.
     *
     * @param signalValue - The current value of the signal (e.g., volatility 0-1)
     * @returns The adjusted effective value
     */
    compute(signalValue: number): number {
        // Compute adjustment multiplier from PEQ
        const multiplier = this.adjustmentPEQ.compute(signalValue);

        // Apply adjustment to base value
        let effectiveValue = this.baseValue * multiplier;

        // Apply clamping if specified
        if (this.clamp) {
            effectiveValue = Math.max(this.clamp.min, Math.min(this.clamp.max, effectiveValue));
        }

        return effectiveValue;
    }

    /**
     * Gets the base value (unadjusted).
     */
    getBaseValue(): number {
        return this.baseValue;
    }

    /**
     * Gets the signal name used for adjustment.
     */
    getSignalName(): string {
        return this.signalName;
    }

    /**
     * Gets the PEQ coefficients for serialization/logging.
     */
    getPEQCoefficients(): ScalingPEQCoefficients {
        return this.adjustmentPEQ.getCoefficients();
    }

    /**
     * Returns flat parameter representation for genetic optimizer.
     *
     * @param prefix - Parameter name prefix (e.g., 'breakoutBuffer')
     * @returns Record of flat parameter names to values
     */
    toFlatParams(prefix: string): Record<string, number> {
        const coeffs = this.adjustmentPEQ.getCoefficients();
        return {
            [`${prefix}_base`]: this.baseValue,
            [`${prefix}_adj_c0`]: coeffs.c0,
            [`${prefix}_adj_c1`]: coeffs.c1,
            [`${prefix}_adj_c2`]: coeffs.c2,
            [`${prefix}_adj_c3`]: coeffs.c3,
        };
    }

    /**
     * Creates ConditionalParam from flat parameters.
     *
     * @param prefix - Parameter name prefix (e.g., 'breakoutBuffer')
     * @param params - Flat parameter record from optimizer
     * @param signalName - Name of the signal for adjustment
     * @param clamp - Optional clamping bounds
     * @returns New ConditionalParam instance
     */
    static fromFlatParams(
        prefix: string,
        params: Record<string, number>,
        signalName: string,
        clamp?: { min: number; max: number }
    ): ConditionalParam {
        return new ConditionalParam({
            baseValue: params[`${prefix}_base`] ?? 0,
            adjustmentPEQ: {
                c0: params[`${prefix}_adj_c0`] ?? 1,
                c1: params[`${prefix}_adj_c1`] ?? 0,
                c2: params[`${prefix}_adj_c2`] ?? 0,
                c3: params[`${prefix}_adj_c3`] ?? 0,
            },
            signalName,
            clamp,
        });
    }

    /**
     * Creates a default ConditionalParam with no adjustment (multiplier = 1).
     *
     * @param baseValue - The base value
     * @param signalName - Name of the signal (for documentation purposes)
     * @returns New ConditionalParam with identity adjustment
     */
    static default(baseValue: number, signalName: string = 'volatility'): ConditionalParam {
        return new ConditionalParam({
            baseValue,
            adjustmentPEQ: { c0: 1, c1: 0, c2: 0, c3: 0 },
            signalName,
        });
    }
}

/**
 * Helper to generate parameter bounds for a ConditionalParam.
 *
 * @param prefix - Parameter name prefix (e.g., 'breakoutBuffer')
 * @param baseBounds - Bounds for the base value
 * @param coeffBounds - Bounds for PEQ coefficients
 * @returns Record of parameter bounds for genetic optimizer
 */
export function generateConditionalParamBounds(
    prefix: string,
    baseBounds: { min: number; max: number; step?: number },
    coeffBounds: { min: number; max: number; c0Min?: number; c0Max?: number } = {
        min: -1,
        max: 1,
    }
): Record<string, { min: number; max: number; step?: number }> {
    return {
        [`${prefix}_base`]: baseBounds,
        [`${prefix}_adj_c0`]: {
            min: coeffBounds.c0Min ?? 0.5,
            max: coeffBounds.c0Max ?? 1.5,
        },
        [`${prefix}_adj_c1`]: coeffBounds,
        [`${prefix}_adj_c2`]: coeffBounds,
        [`${prefix}_adj_c3`]: coeffBounds,
    };
}
