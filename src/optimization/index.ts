/**
 * Optimization Module
 *
 * Provides multiple optimization strategies for parameter tuning:
 * - Genetic Algorithm (existing, adapted)
 * - Bayesian Optimization (GP + acquisition functions)
 * - CMA-ES (Covariance Matrix Adaptation Evolution Strategy)
 * - Iterative Refinement (alternating two-stage optimization)
 */

// Core interfaces and types
export type {
    IOptimizer,
    ParameterBounds,
    ParameterBound,
    EvaluationResult,
    StopCondition,
    BaseOptimizerConfig,
    BayesianConfig,
    CMAESConfig,
    GeneticAdapterConfig,
    IterativeRefinementConfig,
    OptimizerType,
} from './interfaces.js';
export {
    DEFAULT_BAYESIAN_CONFIG,
    DEFAULT_CMAES_CONFIG,
    DEFAULT_GENETIC_CONFIG,
    DEFAULT_ITERATIVE_CONFIG,
} from './interfaces.js';

// Base class
export { BaseOptimizer } from './BaseOptimizer.js';

// Optimizers
export { GeneticOptimizerAdapter } from './GeneticOptimizerAdapter.js';
export { BayesianOptimizer } from './BayesianOptimizer.js';
export { CMAESOptimizer } from './CMAESOptimizer.js';

// Iterative refinement
export {
    IterativeRefinement,
    runSingleStageOptimization,
} from './IterativeRefinement.js';
export type {
    IterativeRefinementResult,
    EvaluationFunction,
    OptimizationContext,
} from './IterativeRefinement.js';

// Utilities
export { GaussianProcess, DEFAULT_GP_CONFIG } from './utils/GaussianProcess.js';
export type { GPConfig, GPPrediction } from './utils/GaussianProcess.js';
export {
    expectedImprovement,
    upperConfidenceBound,
    probabilityOfImprovement,
    computeAcquisition,
    selectDiverseBatch,
} from './utils/AcquisitionFunctions.js';
export type { AcquisitionType } from './utils/AcquisitionFunctions.js';
export type { Matrix, Vector } from './utils/MatrixUtils.js';
export {
    zeros,
    ones,
    vectorAdd,
    vectorSub,
    vectorScale,
    vectorMul,
    dot,
    norm,
    outerProduct,
    identity,
    zeroMatrix,
    transpose,
    matrixAdd,
    matrixScale,
    matrixVectorMul,
    matrixMul,
    copyMatrix,
    eigenDecomposition,
    matrixSqrt,
    matrixInvSqrt,
    choleskyDecomposition,
    randn,
    randnVector,
    sampleMultivariateNormal,
    trace,
    diag,
    isSymmetric,
    makeSymmetric,
} from './utils/MatrixUtils.js';

// ============================================================================
// Factory function for creating optimizers
// ============================================================================

import type { IOptimizer, OptimizerType, BayesianConfig, CMAESConfig, GeneticAdapterConfig } from './interfaces.js';
import { BayesianOptimizer } from './BayesianOptimizer.js';
import { CMAESOptimizer } from './CMAESOptimizer.js';
import { GeneticOptimizerAdapter } from './GeneticOptimizerAdapter.js';
import { SimulatorLogger } from '../simulation/SimulatorLogger.js';

/**
 * Create an optimizer instance by type.
 *
 * @param type Optimizer type: 'genetic', 'bayesian', or 'cmaes'
 * @param config Configuration overrides
 * @param logger Optional logger for progress output
 * @returns IOptimizer instance
 */
export function createOptimizer(
    type: OptimizerType,
    config: Partial<BayesianConfig | CMAESConfig | GeneticAdapterConfig> = {},
    logger?: SimulatorLogger
): IOptimizer {
    switch (type) {
        case 'bayesian':
            return new BayesianOptimizer(config as Partial<BayesianConfig>);
        case 'cmaes':
            return new CMAESOptimizer(config as Partial<CMAESConfig>);
        case 'genetic':
            return new GeneticOptimizerAdapter(
                config as Partial<GeneticAdapterConfig>,
                logger
            );
        default:
            throw new Error(`Unknown optimizer type: ${type}`);
    }
}
