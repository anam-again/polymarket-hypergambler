/**
 * Bayesian Optimizer
 *
 * Uses Gaussian Process regression with acquisition function optimization
 * to efficiently search the parameter space. Particularly effective for
 * low-dimensional problems (< 20 dimensions) where evaluations are expensive.
 */

import { BaseOptimizer } from './BaseOptimizer.js';
import type { EvaluationResult, BayesianConfig } from './interfaces.js';
import { DEFAULT_BAYESIAN_CONFIG } from './interfaces.js';
import { GaussianProcess } from './utils/GaussianProcess.js';
import {
    computeAcquisition,
    selectDiverseBatch,
} from './utils/AcquisitionFunctions.js';
import type { AcquisitionType } from './utils/AcquisitionFunctions.js';

export class BayesianOptimizer extends BaseOptimizer {
    readonly name = 'Bayesian';

    private bayesConfig: BayesianConfig;
    private gp: GaussianProcess;
    private observedX: number[][] = [];   // Normalized observations
    private observedY: number[] = [];     // Fitness values
    private currentBatch: { normalized: number[]; params: Record<string, number> }[] = [];
    private inInitialPhase = true;

    constructor(config: Partial<BayesianConfig> = {}) {
        const fullConfig = { ...DEFAULT_BAYESIAN_CONFIG, ...config };
        super(fullConfig);
        this.bayesConfig = fullConfig;
        this.gp = new GaussianProcess({
            noiseLevel: fullConfig.noiseLevel,
            lengthScale: fullConfig.lengthScale,
        });
    }

    // -------------------------------------------------------------------------
    // Initialization
    // -------------------------------------------------------------------------

    protected onInitialize(): void {
        this.observedX = [];
        this.observedY = [];
        this.currentBatch = [];
        this.inInitialPhase = true;

        // Reset GP
        this.gp = new GaussianProcess({
            noiseLevel: this.bayesConfig.noiseLevel,
            lengthScale: this.bayesConfig.lengthScale,
        });
    }

    // -------------------------------------------------------------------------
    // Ask: Generate next batch of candidates
    // -------------------------------------------------------------------------

    ask(): Record<string, number>[] {
        if (!this.initialized) {
            throw new Error('BayesianOptimizer: Must call initialize() before ask()');
        }

        this.currentBatch = [];

        // Initial random exploration phase
        if (this.inInitialPhase && this.observedX.length < this.bayesConfig.nInitialSamples) {
            const remaining = this.bayesConfig.nInitialSamples - this.observedX.length;
            const batchSize = Math.min(remaining, this.bayesConfig.batchSize);

            for (let i = 0; i < batchSize; i++) {
                const normalized = this.randomNormalizedVector();
                const params = this.denormalizeVector(normalized);
                this.currentBatch.push({ normalized, params });
            }

            return this.currentBatch.map(c => c.params);
        }

        // Switch to GP-guided search
        this.inInitialPhase = false;

        // Fit GP to current observations
        if (this.observedX.length > 0) {
            this.gp.fit(this.observedX, this.observedY);
        }

        // Generate candidate points and select best by acquisition function
        const candidates = this.generateCandidates();
        const selectedCandidates = this.selectByAcquisition(candidates);

        for (const normalized of selectedCandidates) {
            const params = this.denormalizeVector(normalized);
            this.currentBatch.push({ normalized, params });
        }

        return this.currentBatch.map(c => c.params);
    }

    // -------------------------------------------------------------------------
    // Tell: Update with evaluation results
    // -------------------------------------------------------------------------

    protected onTell(results: EvaluationResult[]): void {
        // Add observations to history
        for (let i = 0; i < results.length && i < this.currentBatch.length; i++) {
            this.observedX.push([...this.currentBatch[i].normalized]);
            this.observedY.push(results[i].fitness);
        }

        // Clear current batch
        this.currentBatch = [];
    }

    // -------------------------------------------------------------------------
    // Candidate Generation
    // -------------------------------------------------------------------------

    /**
     * Generate candidate points for acquisition optimization.
     * Uses a combination of:
     * - Random sampling
     * - Latin hypercube sampling
     * - Local search around best points
     */
    private generateCandidates(): number[][] {
        const candidates: number[][] = [];
        const nCandidates = Math.max(100, 20 * this.dimension);

        // Random candidates
        for (let i = 0; i < nCandidates / 2; i++) {
            candidates.push(this.randomNormalizedVector());
        }

        // Latin hypercube candidates for better coverage
        const lhsCandidates = this.latinHypercube(Math.floor(nCandidates / 4));
        candidates.push(...lhsCandidates);

        // Local candidates around best observed points
        if (this.observedX.length > 0) {
            const nLocal = Math.floor(nCandidates / 4);
            const topK = Math.min(5, this.observedX.length);

            // Get indices of top k points
            const sortedIndices = this.observedY
                .map((y, i) => ({ y, i }))
                .sort((a, b) => b.y - a.y)
                .slice(0, topK)
                .map(item => item.i);

            for (let i = 0; i < nLocal; i++) {
                const baseIdx = sortedIndices[i % sortedIndices.length];
                const base = this.observedX[baseIdx];

                // Add small perturbation
                const perturbation = base.map(v => {
                    const delta = (Math.random() - 0.5) * 0.2;
                    return Math.max(0, Math.min(1, v + delta));
                });
                candidates.push(perturbation);
            }
        }

        return candidates;
    }

    /**
     * Generate Latin Hypercube samples.
     */
    private latinHypercube(n: number): number[][] {
        const samples: number[][] = [];

        // Create stratified samples for each dimension
        const strata: number[][] = [];
        for (let d = 0; d < this.dimension; d++) {
            const dimStrata = Array.from({ length: n }, (_, i) =>
                (i + Math.random()) / n
            );
            // Shuffle
            for (let i = dimStrata.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [dimStrata[i], dimStrata[j]] = [dimStrata[j], dimStrata[i]];
            }
            strata.push(dimStrata);
        }

        // Combine into samples
        for (let i = 0; i < n; i++) {
            const sample = strata.map(dimStrata => dimStrata[i]);
            samples.push(sample);
        }

        return samples;
    }

    // -------------------------------------------------------------------------
    // Acquisition Function Optimization
    // -------------------------------------------------------------------------

    /**
     * Select best candidates by acquisition function value.
     */
    private selectByAcquisition(candidates: number[][]): number[][] {
        const fBest = this.observedY.length > 0 ? Math.max(...this.observedY) : 0;

        // Compute acquisition function for all candidates
        const scores = candidates.map(x => {
            const prediction = this.gp.predict(x);
            return computeAcquisition(
                this.bayesConfig.acquisitionFunction as AcquisitionType,
                prediction,
                fBest,
                {
                    kappa: this.bayesConfig.ucbKappa,
                    xi: 0.01,
                }
            );
        });

        // Select diverse batch of top candidates
        const selectedIndices = selectDiverseBatch(
            candidates,
            scores,
            this.bayesConfig.batchSize,
            0.3 // 30% diversity weight
        );

        // Optional: Local refinement of selected points
        const refined = selectedIndices.map(idx => {
            const start = candidates[idx];
            return this.localRefinement(start, fBest);
        });

        return refined;
    }

    /**
     * Local refinement using gradient-free optimization (coordinate descent).
     */
    private localRefinement(start: number[], fBest: number, maxSteps: number = 10): number[] {
        let current = [...start];
        let currentScore = this.evaluateAcquisition(current, fBest);

        const stepSize = 0.05;

        for (let step = 0; step < maxSteps; step++) {
            let improved = false;

            for (let d = 0; d < this.dimension; d++) {
                // Try moving in positive direction
                const plusPoint = [...current];
                plusPoint[d] = Math.min(1, current[d] + stepSize);
                const plusScore = this.evaluateAcquisition(plusPoint, fBest);

                // Try moving in negative direction
                const minusPoint = [...current];
                minusPoint[d] = Math.max(0, current[d] - stepSize);
                const minusScore = this.evaluateAcquisition(minusPoint, fBest);

                // Take best direction
                if (plusScore > currentScore && plusScore > minusScore) {
                    current = plusPoint;
                    currentScore = plusScore;
                    improved = true;
                } else if (minusScore > currentScore) {
                    current = minusPoint;
                    currentScore = minusScore;
                    improved = true;
                }
            }

            if (!improved) break;
        }

        return current;
    }

    /**
     * Evaluate acquisition function at a point.
     */
    private evaluateAcquisition(x: number[], fBest: number): number {
        const prediction = this.gp.predict(x);
        return computeAcquisition(
            this.bayesConfig.acquisitionFunction as AcquisitionType,
            prediction,
            fBest,
            {
                kappa: this.bayesConfig.ucbKappa,
                xi: 0.01,
            }
        );
    }

    // -------------------------------------------------------------------------
    // Debugging & Monitoring
    // -------------------------------------------------------------------------

    getState(): {
        nObservations: number;
        inInitialPhase: boolean;
        gpLengthScale: number;
    } {
        return {
            nObservations: this.observedX.length,
            inInitialPhase: this.inInitialPhase,
            gpLengthScale: this.gp.getLengthScale(),
        };
    }
}
