/**
 * CMA-ES Optimizer
 *
 * Covariance Matrix Adaptation Evolution Strategy implementation
 * following Hansen 2016 tutorial (The CMA Evolution Strategy: A Tutorial).
 *
 * CMA-ES is particularly well-suited for:
 * - Non-convex, non-separable optimization
 * - High-dimensional problems (up to ~100 dimensions)
 * - Problems with rugged fitness landscapes
 */

import { BaseOptimizer } from './BaseOptimizer.js';
import type { EvaluationResult, CMAESConfig } from './interfaces.js';
import { DEFAULT_CMAES_CONFIG } from './interfaces.js';
import type { Vector, Matrix } from './utils/MatrixUtils.js';
import {
    zeros,
    vectorAdd,
    vectorSub,
    vectorScale,
    vectorMul,
    norm,
    outerProduct,
    identity,
    matrixAdd,
    matrixScale,
    matrixVectorMul,
    eigenDecomposition,
    randnVector,
    diag,
    makeSymmetric,
} from './utils/MatrixUtils.js';

export class CMAESOptimizer extends BaseOptimizer {
    readonly name = 'CMA-ES';

    private cmaConfig: CMAESConfig;

    // Strategy parameters
    private lambda!: number;  // Population size
    private mu!: number;      // Number of parents
    private weights!: Vector; // Recombination weights
    private mueff!: number;   // Variance effective selection mass

    // Adaptation parameters
    private cc!: number;      // Time constant for cumulation for C
    private cs!: number;      // Time constant for cumulation for sigma
    private c1!: number;      // Learning rate for rank-one update
    private cmu!: number;     // Learning rate for rank-mu update
    private damps!: number;   // Damping for sigma

    // State variables
    private mean!: Vector;    // Current mean (distribution center)
    private sigma!: number;   // Step size
    private C!: Matrix;       // Covariance matrix
    private pc!: Vector;      // Evolution path for C
    private ps!: Vector;      // Evolution path for sigma
    private B!: Matrix;       // Eigenvectors of C
    private D!: Vector;       // sqrt(eigenvalues) of C
    private invsqrtC!: Matrix; // C^(-1/2)

    // Population
    private currentPopulation: { x: Vector; params: Record<string, number> }[] = [];
    private chiN!: number;    // Expected length of N(0,I) vector

    constructor(config: Partial<CMAESConfig> = {}) {
        const fullConfig = { ...DEFAULT_CMAES_CONFIG, ...config };
        super(fullConfig);
        this.cmaConfig = fullConfig;
    }

    // -------------------------------------------------------------------------
    // Initialization
    // -------------------------------------------------------------------------

    protected onInitialize(): void {
        const n = this.dimension;

        // Population size (λ) - auto if not specified
        this.lambda = this.cmaConfig.populationSize > 0
            ? this.cmaConfig.populationSize
            : Math.floor(4 + 3 * Math.log(n));

        // Parent number (μ)
        this.mu = this.cmaConfig.mu > 0
            ? this.cmaConfig.mu
            : Math.floor(this.lambda / 2);

        // Recombination weights
        this.weights = this.computeWeights();
        this.mueff = 1 / this.weights.reduce((sum, w) => sum + w * w, 0);

        // Time constants for cumulation
        this.cc = (4 + this.mueff / n) / (n + 4 + 2 * this.mueff / n);
        this.cs = (this.mueff + 2) / (n + this.mueff + 5);

        // Learning rates
        this.c1 = 2 / ((n + 1.3) * (n + 1.3) + this.mueff);
        this.cmu = Math.min(
            1 - this.c1,
            2 * (this.mueff - 2 + 1 / this.mueff) / ((n + 2) * (n + 2) + this.mueff)
        );

        // Damping for sigma
        this.damps = 1 + 2 * Math.max(0, Math.sqrt((this.mueff - 1) / (n + 1)) - 1) + this.cs;

        // Expected length of N(0,I) vector
        this.chiN = Math.sqrt(n) * (1 - 1 / (4 * n) + 1 / (21 * n * n));

        // Initial mean: center of search space
        this.mean = new Array(n).fill(0.5);

        // Initial step size (σ)
        this.sigma = this.cmaConfig.sigma > 0 ? this.cmaConfig.sigma : 0.3;

        // Initial covariance matrix: identity
        this.C = identity(n);

        // Evolution paths
        this.pc = zeros(n);
        this.ps = zeros(n);

        // Initial eigendecomposition
        this.updateEigendecomposition();
    }

    private computeWeights(): Vector {
        const w: Vector = [];
        for (let i = 0; i < this.mu; i++) {
            w.push(Math.log(this.mu + 0.5) - Math.log(i + 1));
        }
        // Normalize
        const sum = w.reduce((a, b) => a + b, 0);
        return w.map(v => v / sum);
    }

    private updateEigendecomposition(): void {
        // Ensure C is symmetric
        this.C = makeSymmetric(this.C);

        const { eigenvalues, eigenvectors } = eigenDecomposition(this.C);

        this.B = eigenvectors;
        this.D = eigenvalues.map(ev => Math.sqrt(Math.max(0, ev)));

        // Compute C^(-1/2) = B * D^(-1) * B^T
        const invD = this.D.map(d => d > 1e-10 ? 1 / d : 0);
        const invDMatrix = diag(invD);
        const BinvD: Matrix = [];
        for (let i = 0; i < this.dimension; i++) {
            BinvD[i] = [];
            for (let j = 0; j < this.dimension; j++) {
                let sum = 0;
                for (let k = 0; k < this.dimension; k++) {
                    sum += this.B[i][k] * invDMatrix[k][j];
                }
                BinvD[i][j] = sum;
            }
        }

        // invsqrtC = BinvD * B^T
        this.invsqrtC = [];
        for (let i = 0; i < this.dimension; i++) {
            this.invsqrtC[i] = [];
            for (let j = 0; j < this.dimension; j++) {
                let sum = 0;
                for (let k = 0; k < this.dimension; k++) {
                    sum += BinvD[i][k] * this.B[j][k];
                }
                this.invsqrtC[i][j] = sum;
            }
        }
    }

    // -------------------------------------------------------------------------
    // IOptimizer Implementation
    // -------------------------------------------------------------------------

    ask(): Record<string, number>[] {
        if (!this.initialized) {
            throw new Error('CMA-ES: Must call initialize() before ask()');
        }

        this.currentPopulation = [];

        for (let k = 0; k < this.lambda; k++) {
            // Sample from N(0, I)
            const z = randnVector(this.dimension);

            // Transform: y = B * D * z
            const y = this.transformSample(z);

            // x = mean + sigma * y
            const x = vectorAdd(this.mean, vectorScale(y, this.sigma));

            // Clamp to [0, 1]^n
            const xClamped = x.map(v => Math.max(0, Math.min(1, v)));

            // Convert to params
            const params = this.denormalizeVector(xClamped);

            this.currentPopulation.push({ x: xClamped, params });
        }

        return this.currentPopulation.map(p => p.params);
    }

    private transformSample(z: Vector): Vector {
        // y = B * D * z
        const Dz = vectorMul(this.D, z);
        return matrixVectorMul(this.B, Dz);
    }

    protected onTell(results: EvaluationResult[]): void {
        // Sort by fitness (descending for maximization)
        const indexed = results.map((r, i) => ({ fitness: r.fitness, index: i }));
        indexed.sort((a, b) => b.fitness - a.fitness);

        // Get sorted x vectors for top mu individuals
        const sortedX: Vector[] = indexed
            .slice(0, this.mu)
            .map(item => this.currentPopulation[item.index].x);

        // Store old mean
        const oldMean = [...this.mean];

        // Update mean: weighted recombination
        this.mean = zeros(this.dimension);
        for (let i = 0; i < this.mu; i++) {
            this.mean = vectorAdd(this.mean, vectorScale(sortedX[i], this.weights[i]));
        }

        // Update evolution paths
        const meanDiff = vectorScale(vectorSub(this.mean, oldMean), 1 / this.sigma);
        const invsqrtCMeanDiff = matrixVectorMul(this.invsqrtC, meanDiff);

        // ps = (1 - cs) * ps + sqrt(cs*(2-cs)*mueff) * invsqrtC * (mean - oldMean) / sigma
        const psCoeff = Math.sqrt(this.cs * (2 - this.cs) * this.mueff);
        this.ps = vectorAdd(
            vectorScale(this.ps, 1 - this.cs),
            vectorScale(invsqrtCMeanDiff, psCoeff)
        );

        // hsig: stall update if ||ps|| is large
        const psNorm = norm(this.ps);
        const hsigThreshold = (1.4 + 2 / (this.dimension + 1)) * this.chiN *
            Math.sqrt(1 - Math.pow(1 - this.cs, 2 * this.iteration));
        const hsig = psNorm < hsigThreshold ? 1 : 0;

        // pc = (1 - cc) * pc + hsig * sqrt(cc*(2-cc)*mueff) * (mean - oldMean) / sigma
        const pcCoeff = hsig * Math.sqrt(this.cc * (2 - this.cc) * this.mueff);
        this.pc = vectorAdd(
            vectorScale(this.pc, 1 - this.cc),
            vectorScale(meanDiff, pcCoeff)
        );

        // Update covariance matrix
        // C = (1 - c1 - cmu) * C + c1 * (pc*pc' + (1-hsig)*cc*(2-cc)*C) + cmu * sum(w_i * y_i*y_i')
        const dhsig = (1 - hsig) * this.cc * (2 - this.cc);

        // Rank-one update term
        const rankOne = matrixScale(outerProduct(this.pc, this.pc), this.c1);

        // Rank-mu update term
        let rankMu = zeros(this.dimension).map(() => zeros(this.dimension));
        for (let i = 0; i < this.mu; i++) {
            const yi = vectorScale(vectorSub(sortedX[i], oldMean), 1 / this.sigma);
            const outerYi = outerProduct(yi, yi);
            rankMu = matrixAdd(rankMu, matrixScale(outerYi, this.weights[i] * this.cmu));
        }

        // Combine updates
        this.C = matrixScale(this.C, 1 - this.c1 - this.cmu + dhsig * this.c1);
        this.C = matrixAdd(this.C, rankOne);
        this.C = matrixAdd(this.C, rankMu);

        // Update step size sigma
        const sigmaUpdate = Math.exp(
            (this.cs / this.damps) * (psNorm / this.chiN - 1)
        );
        this.sigma *= sigmaUpdate;

        // Bound sigma to prevent explosion or collapse
        this.sigma = Math.max(1e-10, Math.min(10, this.sigma));

        // Update eigendecomposition periodically (expensive)
        if (this.iteration % Math.ceil(1 / (this.c1 + this.cmu) / this.dimension / 10) === 0) {
            this.updateEigendecomposition();
        }
    }

    // -------------------------------------------------------------------------
    // Additional Stopping Conditions (CMA-ES specific)
    // -------------------------------------------------------------------------

    shouldStop(): { stop: boolean; reason: string } {
        // Check base conditions first
        const baseStop = super.shouldStop();
        if (baseStop.stop) return baseStop;

        // Condition: sigma too small
        if (this.sigma * Math.max(...this.D) < 1e-11) {
            return { stop: true, reason: 'Step size σ collapsed to near-zero' };
        }

        // Condition: sigma too large
        if (this.sigma * Math.min(...this.D) > 1e11) {
            return { stop: true, reason: 'Step size σ exploded' };
        }

        // Condition: condition number of C too large
        const conditionNumber = Math.max(...this.D) / Math.min(...this.D);
        if (conditionNumber > 1e14) {
            return { stop: true, reason: `Covariance condition number too large (${conditionNumber.toExponential(2)})` };
        }

        // Condition: no effect (mean doesn't change)
        const effectiveStepSize = this.sigma * Math.max(...this.D);
        if (effectiveStepSize < 1e-11) {
            return { stop: true, reason: 'Effective step size too small' };
        }

        return { stop: false, reason: '' };
    }

    // -------------------------------------------------------------------------
    // Debugging & Monitoring
    // -------------------------------------------------------------------------

    getState(): {
        mean: Vector;
        sigma: number;
        conditionNumber: number;
        eigenvalues: Vector;
    } {
        const eigenvalues = this.D.map(d => d * d);
        const conditionNumber = Math.max(...this.D) / Math.min(...this.D);

        return {
            mean: [...this.mean],
            sigma: this.sigma,
            conditionNumber,
            eigenvalues,
        };
    }
}
