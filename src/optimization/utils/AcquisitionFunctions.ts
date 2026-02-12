/**
 * Acquisition Functions for Bayesian Optimization
 *
 * These functions guide the search by balancing exploration (high uncertainty)
 * and exploitation (high predicted value).
 */

import type { GPPrediction } from './GaussianProcess.js';

// ============================================================================
// Standard Normal Distribution Helpers
// ============================================================================

/**
 * Standard normal CDF using error function approximation.
 */
export function normalCDF(x: number): number {
    return 0.5 * (1 + erf(x / Math.sqrt(2)));
}

/**
 * Standard normal PDF.
 */
export function normalPDF(x: number): number {
    return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

/**
 * Error function approximation (Abramowitz and Stegun).
 */
function erf(x: number): number {
    const sign = x >= 0 ? 1 : -1;
    x = Math.abs(x);

    const a1 = 0.254829592;
    const a2 = -0.284496736;
    const a3 = 1.421413741;
    const a4 = -1.453152027;
    const a5 = 1.061405429;
    const p = 0.3275911;

    const t = 1 / (1 + p * x);
    const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);

    return sign * y;
}

// ============================================================================
// Acquisition Functions
// ============================================================================

/**
 * Expected Improvement (EI)
 *
 * EI(x) = (μ - f_best) * Φ(Z) + σ * φ(Z)
 * where Z = (μ - f_best) / σ
 *
 * Balances exploration and exploitation naturally.
 *
 * @param prediction GP prediction at point x
 * @param fBest Best observed value so far
 * @param xi Exploration parameter (default: 0.01)
 * @returns Expected improvement value
 */
export function expectedImprovement(
    prediction: GPPrediction,
    fBest: number,
    xi: number = 0.01
): number {
    const { mean, std } = prediction;

    if (std < 1e-10) {
        // No uncertainty - no exploration value
        return Math.max(0, mean - fBest - xi);
    }

    const improvement = mean - fBest - xi;
    const Z = improvement / std;

    return improvement * normalCDF(Z) + std * normalPDF(Z);
}

/**
 * Upper Confidence Bound (UCB)
 *
 * UCB(x) = μ + κ * σ
 *
 * Simple, interpretable, with explicit exploration-exploitation tradeoff via κ.
 *
 * @param prediction GP prediction at point x
 * @param kappa Exploration parameter (higher = more exploration, typically 2-3)
 * @returns UCB value
 */
export function upperConfidenceBound(
    prediction: GPPrediction,
    kappa: number = 2.0
): number {
    return prediction.mean + kappa * prediction.std;
}

/**
 * Probability of Improvement (PI)
 *
 * PI(x) = Φ((μ - f_best - xi) / σ)
 *
 * Conservative - prefers likely improvements over large uncertain ones.
 *
 * @param prediction GP prediction at point x
 * @param fBest Best observed value so far
 * @param xi Exploration parameter (default: 0.01)
 * @returns Probability of improvement
 */
export function probabilityOfImprovement(
    prediction: GPPrediction,
    fBest: number,
    xi: number = 0.01
): number {
    const { mean, std } = prediction;

    if (std < 1e-10) {
        return mean > fBest + xi ? 1.0 : 0.0;
    }

    const Z = (mean - fBest - xi) / std;
    return normalCDF(Z);
}

// ============================================================================
// Batch Acquisition (for parallel evaluations)
// ============================================================================

/**
 * Select diverse points using k-means++ style initialization.
 * Useful for batch Bayesian optimization.
 *
 * @param candidates Array of candidate points
 * @param scores Acquisition function scores for candidates
 * @param batchSize Number of points to select
 * @param diversityWeight Weight for diversity vs acquisition score (0-1)
 * @returns Indices of selected candidates
 */
export function selectDiverseBatch(
    candidates: number[][],
    scores: number[],
    batchSize: number,
    diversityWeight: number = 0.5
): number[] {
    const n = candidates.length;
    if (batchSize >= n) {
        return Array.from({ length: n }, (_, i) => i);
    }

    const selected: number[] = [];
    const remaining = new Set(Array.from({ length: n }, (_, i) => i));

    // Select first point by best score
    let bestIdx = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < n; i++) {
        if (scores[i] > bestScore) {
            bestScore = scores[i];
            bestIdx = i;
        }
    }
    selected.push(bestIdx);
    remaining.delete(bestIdx);

    // Select remaining points with diversity consideration
    while (selected.length < batchSize && remaining.size > 0) {
        let nextBest = -1;
        let nextBestScore = -Infinity;

        for (const idx of remaining) {
            // Compute minimum distance to selected points
            let minDist = Infinity;
            for (const selIdx of selected) {
                const dist = euclideanDistance(candidates[idx], candidates[selIdx]);
                minDist = Math.min(minDist, dist);
            }

            // Combined score: acquisition + diversity
            const combinedScore =
                (1 - diversityWeight) * scores[idx] + diversityWeight * minDist;

            if (combinedScore > nextBestScore) {
                nextBestScore = combinedScore;
                nextBest = idx;
            }
        }

        if (nextBest !== -1) {
            selected.push(nextBest);
            remaining.delete(nextBest);
        }
    }

    return selected;
}

/**
 * Euclidean distance between two points.
 */
function euclideanDistance(a: number[], b: number[]): number {
    let sum = 0;
    for (let i = 0; i < a.length; i++) {
        const diff = a[i] - b[i];
        sum += diff * diff;
    }
    return Math.sqrt(sum);
}

// ============================================================================
// Acquisition Function Interface
// ============================================================================

export type AcquisitionType = 'ei' | 'ucb' | 'pi';

/**
 * Compute acquisition function value given prediction and parameters.
 */
export function computeAcquisition(
    type: AcquisitionType,
    prediction: GPPrediction,
    fBest: number,
    params: { kappa?: number; xi?: number } = {}
): number {
    switch (type) {
        case 'ei':
            return expectedImprovement(prediction, fBest, params.xi ?? 0.01);
        case 'ucb':
            return upperConfidenceBound(prediction, params.kappa ?? 2.0);
        case 'pi':
            return probabilityOfImprovement(prediction, fBest, params.xi ?? 0.01);
        default:
            return expectedImprovement(prediction, fBest, params.xi ?? 0.01);
    }
}
