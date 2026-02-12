/**
 * Gaussian Process Implementation
 *
 * Provides GP regression for Bayesian Optimization using an RBF (squared exponential) kernel.
 * Includes automatic length scale estimation and efficient prediction.
 */

import type { Vector, Matrix } from './MatrixUtils.js';
import {
    dot,
    vectorSub,
    norm,
    zeroMatrix,
} from './MatrixUtils.js';

// ============================================================================
// Types
// ============================================================================

export interface GPConfig {
    /** Noise level (observation variance) */
    noiseLevel: number;

    /** Length scale for RBF kernel (auto-estimated if <= 0) */
    lengthScale: number;

    /** Output scale (signal variance) */
    outputScale: number;

    /** Regularization for numerical stability */
    jitter: number;
}

export const DEFAULT_GP_CONFIG: GPConfig = {
    noiseLevel: 1e-6,
    lengthScale: 0, // Auto
    outputScale: 1.0,
    jitter: 1e-8,
};

export interface GPPrediction {
    mean: number;
    variance: number;
    std: number;
}

// ============================================================================
// Gaussian Process Class
// ============================================================================

export class GaussianProcess {
    private config: GPConfig;
    private X: Vector[] = [];       // Training inputs (normalized)
    private y: Vector = [];         // Training targets
    private K: Matrix = [];         // Kernel matrix
    private L: Matrix = [];         // Cholesky decomposition of K
    private alpha: Vector = [];     // K^-1 * y (precomputed for prediction)
    private fitted = false;
    private estimatedLengthScale: number = 1.0;

    constructor(config: Partial<GPConfig> = {}) {
        this.config = { ...DEFAULT_GP_CONFIG, ...config };
    }

    // -------------------------------------------------------------------------
    // Training
    // -------------------------------------------------------------------------

    /**
     * Fit the Gaussian Process to training data.
     * @param X Array of input vectors (each in [0,1]^d)
     * @param y Array of target values
     */
    fit(X: Vector[], y: number[]): void {
        this.X = X.map(x => [...x]);
        this.y = [...y];

        const n = this.X.length;
        if (n === 0) {
            this.fitted = false;
            return;
        }

        // Estimate length scale if not provided
        if (this.config.lengthScale <= 0) {
            this.estimatedLengthScale = this.estimateLengthScale();
        } else {
            this.estimatedLengthScale = this.config.lengthScale;
        }

        // Compute kernel matrix
        this.K = this.computeKernelMatrix(this.X, this.X);

        // Add noise and jitter for numerical stability
        const noise = this.config.noiseLevel + this.config.jitter;
        for (let i = 0; i < n; i++) {
            this.K[i][i] += noise;
        }

        // Cholesky decomposition
        this.L = this.choleskyDecomposition(this.K);

        // Solve L * L' * alpha = y for alpha
        // First solve L * z = y
        const z = this.solveTriangularLower(this.L, this.y);
        // Then solve L' * alpha = z
        this.alpha = this.solveTriangularUpper(this.transposeMatrix(this.L), z);

        this.fitted = true;
    }

    /**
     * Add new observations and update the GP.
     */
    addObservation(x: Vector, yValue: number): void {
        this.X.push([...x]);
        this.y.push(yValue);
        // Refit (could be optimized with incremental updates)
        this.fit(this.X, this.y);
    }

    // -------------------------------------------------------------------------
    // Prediction
    // -------------------------------------------------------------------------

    /**
     * Predict mean and variance at a single point.
     */
    predict(x: Vector): GPPrediction {
        if (!this.fitted || this.X.length === 0) {
            return {
                mean: 0,
                variance: this.config.outputScale,
                std: Math.sqrt(this.config.outputScale),
            };
        }

        // k_* = kernel vector between x and training points
        const kStar = this.X.map(xi => this.kernel(x, xi));

        // Mean: k_*' * alpha
        const mean = dot(kStar, this.alpha);

        // Variance: k(x,x) - k_*' * K^-1 * k_*
        //         = k(x,x) - v' * v where L * v = k_*
        const kxx = this.kernel(x, x);
        const v = this.solveTriangularLower(this.L, kStar);
        const variance = Math.max(0, kxx - dot(v, v));

        return {
            mean,
            variance,
            std: Math.sqrt(variance),
        };
    }

    /**
     * Predict mean and variance at multiple points.
     */
    predictBatch(X: Vector[]): GPPrediction[] {
        return X.map(x => this.predict(x));
    }

    /**
     * Get the training data size.
     */
    getTrainingSize(): number {
        return this.X.length;
    }

    /**
     * Get the estimated length scale.
     */
    getLengthScale(): number {
        return this.estimatedLengthScale;
    }

    // -------------------------------------------------------------------------
    // Kernel Functions
    // -------------------------------------------------------------------------

    /**
     * RBF (Squared Exponential) kernel.
     * k(x, x') = σ² * exp(-||x - x'||² / (2 * l²))
     */
    private kernel(x1: Vector, x2: Vector): number {
        const diff = vectorSub(x1, x2);
        const squaredDist = dot(diff, diff);
        const l = this.estimatedLengthScale;
        return this.config.outputScale * Math.exp(-squaredDist / (2 * l * l));
    }

    /**
     * Compute kernel matrix K[i,j] = k(X[i], X[j]).
     */
    private computeKernelMatrix(X1: Vector[], X2: Vector[]): Matrix {
        const n = X1.length;
        const m = X2.length;
        const K: Matrix = [];

        for (let i = 0; i < n; i++) {
            K[i] = [];
            for (let j = 0; j < m; j++) {
                K[i][j] = this.kernel(X1[i], X2[j]);
            }
        }

        return K;
    }

    // -------------------------------------------------------------------------
    // Length Scale Estimation
    // -------------------------------------------------------------------------

    /**
     * Estimate length scale as median pairwise distance.
     */
    private estimateLengthScale(): number {
        if (this.X.length < 2) return 1.0;

        const distances: number[] = [];
        for (let i = 0; i < this.X.length; i++) {
            for (let j = i + 1; j < this.X.length; j++) {
                const dist = norm(vectorSub(this.X[i], this.X[j]));
                distances.push(dist);
            }
        }

        // Use median distance
        distances.sort((a, b) => a - b);
        const median = distances[Math.floor(distances.length / 2)];

        // Clamp to reasonable bounds
        return Math.max(0.01, Math.min(10.0, median));
    }

    // -------------------------------------------------------------------------
    // Linear Algebra Helpers
    // -------------------------------------------------------------------------

    /**
     * Cholesky decomposition A = L * L'.
     * Returns lower triangular L.
     */
    private choleskyDecomposition(A: Matrix): Matrix {
        const n = A.length;
        const L = zeroMatrix(n, n);

        for (let i = 0; i < n; i++) {
            for (let j = 0; j <= i; j++) {
                let sum = 0;

                if (i === j) {
                    for (let k = 0; k < j; k++) {
                        sum += L[j][k] * L[j][k];
                    }
                    const val = A[i][i] - sum;
                    if (val <= 0) {
                        // Handle numerical issues: add small regularization
                        L[i][j] = Math.sqrt(this.config.jitter);
                    } else {
                        L[i][j] = Math.sqrt(val);
                    }
                } else {
                    for (let k = 0; k < j; k++) {
                        sum += L[i][k] * L[j][k];
                    }
                    L[i][j] = (A[i][j] - sum) / L[j][j];
                }
            }
        }

        return L;
    }

    /**
     * Solve L * x = b for x, where L is lower triangular.
     */
    private solveTriangularLower(L: Matrix, b: Vector): Vector {
        const n = b.length;
        const x = new Array(n).fill(0);

        for (let i = 0; i < n; i++) {
            let sum = 0;
            for (let j = 0; j < i; j++) {
                sum += L[i][j] * x[j];
            }
            x[i] = (b[i] - sum) / L[i][i];
        }

        return x;
    }

    /**
     * Solve U * x = b for x, where U is upper triangular.
     */
    private solveTriangularUpper(U: Matrix, b: Vector): Vector {
        const n = b.length;
        const x = new Array(n).fill(0);

        for (let i = n - 1; i >= 0; i--) {
            let sum = 0;
            for (let j = i + 1; j < n; j++) {
                sum += U[i][j] * x[j];
            }
            x[i] = (b[i] - sum) / U[i][i];
        }

        return x;
    }

    /**
     * Transpose a matrix.
     */
    private transposeMatrix(A: Matrix): Matrix {
        const n = A.length;
        const m = A[0].length;
        const result: Matrix = [];

        for (let j = 0; j < m; j++) {
            result[j] = [];
            for (let i = 0; i < n; i++) {
                result[j][i] = A[i][j];
            }
        }

        return result;
    }
}
