// ============================================================================
// ScalingPEQ - Polynomial Equation Scaling Functions
// ============================================================================

/**
 * Coefficients for the polynomial scaling equation:
 * f(x) = c0 + c1*x + c2*x^2 + c3*x^3
 *
 * Default values (c0=1, c1=0, c2=0, c3=0) give a constant multiplier of 1.
 */
export interface ScalingPEQCoefficients {
    c0: number;  // constant term
    c1: number;  // linear term
    c2: number;  // quadratic term
    c3: number;  // cubic term
}

/**
 * ScalingPEQ - Polynomial Equation Scaling
 *
 * Provides polynomial-based scaling functions for trading parameters.
 * Instead of simple linear scalars like `f(x) = scalar * x`, this allows
 * more expressive non-linear relationships: `f(x) = c0 + c1*x + c2*x^2 + c3*x^3`
 *
 * This gives the genetic optimizer 4 coefficients per scaling function,
 * enabling more flexible optimization of time-based parameter adjustments.
 */
export class ScalingPEQ {
    private readonly c0: number;
    private readonly c1: number;
    private readonly c2: number;
    private readonly c3: number;

    constructor(coefficients: ScalingPEQCoefficients) {
        this.c0 = coefficients.c0;
        this.c1 = coefficients.c1;
        this.c2 = coefficients.c2;
        this.c3 = coefficients.c3;
    }

    /**
     * Computes the polynomial value for input x.
     * f(x) = c0 + c1*x + c2*x^2 + c3*x^3
     *
     * @param x - Input value (typically 0-1 for timeLeftRatio)
     * @returns The computed polynomial value
     */
    compute(x: number): number {
        return this.c0 + this.c1 * x + this.c2 * x * x + this.c3 * x * x * x;
    }

    /**
     * Scales a base value by the polynomial function.
     *
     * @param baseValue - The base value to scale
     * @param x - Input value for the polynomial (typically timeLeftRatio)
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
            c2: this.c2,
            c3: this.c3,
        };
    }

    /**
     * Creates a ScalingPEQ with default coefficients (constant 1.0).
     * This is equivalent to the old behavior with no scaling.
     */
    static default(): ScalingPEQ {
        return new ScalingPEQ({ c0: 1.0, c1: 0, c2: 0, c3: 0 });
    }

    /**
     * Creates a ScalingPEQ that approximates (1 - x).
     * Useful for migrating from old scalars that used (1 - timeLeftRatio).
     */
    static linear(slope: number = -1): ScalingPEQ {
        return new ScalingPEQ({ c0: 1.0, c1: slope, c2: 0, c3: 0 });
    }
}
