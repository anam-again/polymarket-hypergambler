// ============================================================================
// ScalingPEQ - Linear Equation Scaling Functions
// ============================================================================

/**
 * Coefficients for the linear scaling equation:
 * f(x) = c0 + c1*x
 *
 * Default values (c0=1, c1=0) give a constant multiplier of 1.
 */
export interface ScalingPEQCoefficients {
    c0: number;  // constant term (intercept)
    c1: number;  // linear term (slope)
}

/**
 * ScalingPEQ - Linear Equation Scaling
 *
 * Provides linear scaling functions for trading parameters.
 * Uses the equation: `f(x) = c0 + c1*x`
 *
 * This gives the genetic optimizer 2 coefficients per scaling function,
 * enabling flexible optimization of signal-based parameter adjustments
 * while keeping the search space manageable.
 */
export class ScalingPEQ {
    private readonly c0: number;
    private readonly c1: number;

    constructor(coefficients: ScalingPEQCoefficients) {
        this.c0 = coefficients.c0;
        this.c1 = coefficients.c1;
    }

    /**
     * Computes the linear value for input x.
     * f(x) = c0 + c1*x
     *
     * @param x - Input value (typically 0-1 normalized signal)
     * @returns The computed linear value
     */
    compute(x: number): number {
        return this.c0 + this.c1 * x;
    }

    /**
     * Scales a base value by the linear function.
     *
     * @param baseValue - The base value to scale
     * @param x - Input value for the equation (typically normalized signal)
     * @returns baseValue * compute(x)
     */
    scale(baseValue: number, x: number): number {
        return baseValue * this.compute(x);
    }

    /**
     * Gets the coefficients for serialization/logging.
     */
    getCoefficients(): ScalingPEQCoefficients {
        return {
            c0: this.c0,
            c1: this.c1,
        };
    }

    /**
     * Creates a ScalingPEQ with default coefficients (constant 1.0).
     * This is equivalent to no scaling.
     */
    static default(): ScalingPEQ {
        return new ScalingPEQ({ c0: 1.0, c1: 0 });
    }

    /**
     * Creates a ScalingPEQ with a specific slope.
     * Useful for simple linear relationships.
     */
    static linear(slope: number = -1): ScalingPEQ {
        return new ScalingPEQ({ c0: 1.0, c1: slope });
    }
}
