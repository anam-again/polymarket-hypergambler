/**
 * Optimization Module Interfaces
 *
 * Defines the common interfaces for all optimizers (Genetic, Bayesian, CMA-ES)
 * using an ask-tell pattern for flexible integration with various fitness functions.
 */

// ============================================================================
// Parameter Bounds (re-exported from GeneticOptimizer for convenience)
// ============================================================================

export interface ParameterBound {
    min: number;
    max: number;
    step?: number;
    type?: 'continuous' | 'discrete';
}

export interface ParameterBounds {
    [key: string]: ParameterBound;
}

// ============================================================================
// Evaluation Results
// ============================================================================

export interface EvaluationResult {
    params: Record<string, number>;
    fitness: number;
    // Extended metrics for analysis
    rawPnl?: number;
    sharpeRatio?: number;
    maxDrawdown?: number;
    winRate?: number;
    tradeCount?: number;
}

// ============================================================================
// Core Optimizer Interface (Ask-Tell Pattern)
// ============================================================================

export interface StopCondition {
    stop: boolean;
    reason: string;
}

export interface IOptimizer {
    /** Optimizer name for logging */
    readonly name: string;

    /**
     * Initialize the optimizer with parameter bounds.
     * Must be called before ask().
     */
    initialize(bounds: ParameterBounds): void;

    /**
     * Get the next batch of parameter sets to evaluate.
     * Returns an array of parameter configurations to test.
     */
    ask(): Record<string, number>[];

    /**
     * Report evaluation results back to the optimizer.
     * Results should correspond to the params returned by the last ask().
     */
    tell(results: EvaluationResult[]): void;

    /**
     * Check if the optimizer should stop.
     * Returns { stop: true, reason: "..." } when convergence/max iterations reached.
     */
    shouldStop(): StopCondition;

    /**
     * Get the best solution found so far.
     * Returns null if no evaluations have been completed.
     */
    getBest(): EvaluationResult | null;

    /**
     * Get the current iteration/generation number.
     */
    getIteration(): number;
}

// ============================================================================
// Base Optimizer Configuration
// ============================================================================

export interface BaseOptimizerConfig {
    /** Maximum number of iterations/generations */
    maxIterations: number;

    /** Convergence threshold for stopping */
    convergenceThreshold: number;

    /** Number of iterations to check for convergence */
    convergenceIterations: number;

    /** Use relative convergence (percentage-based) */
    useRelativeConvergence: boolean;

    /** Percentage threshold for relative convergence (default: 0.01 = 1%) */
    convergenceThresholdPercent: number;
}

// ============================================================================
// Bayesian Optimizer Configuration
// ============================================================================

export interface BayesianConfig extends BaseOptimizerConfig {
    /** Number of initial random samples before fitting GP */
    nInitialSamples: number;

    /** Batch size for parallel evaluations */
    batchSize: number;

    /** Acquisition function: 'ei' (Expected Improvement), 'ucb', 'pi' */
    acquisitionFunction: 'ei' | 'ucb' | 'pi';

    /** UCB exploration parameter (kappa) */
    ucbKappa: number;

    /** Number of restarts for acquisition optimization */
    acquisitionRestarts: number;

    /** Noise level for GP (observation noise variance) */
    noiseLevel: number;

    /** Length scale for RBF kernel (auto if <= 0) */
    lengthScale: number;
}

export const DEFAULT_BAYESIAN_CONFIG: BayesianConfig = {
    maxIterations: 100,
    convergenceThreshold: 1.0,
    convergenceIterations: 10,
    useRelativeConvergence: true,
    convergenceThresholdPercent: 0.01,
    nInitialSamples: 10,
    batchSize: 4,
    acquisitionFunction: 'ei',
    ucbKappa: 2.0,
    acquisitionRestarts: 5,
    noiseLevel: 1e-6,
    lengthScale: 0, // Auto
};

// ============================================================================
// CMA-ES Optimizer Configuration
// ============================================================================

export interface CMAESConfig extends BaseOptimizerConfig {
    /** Population size (lambda). Auto-calculated if <= 0 */
    populationSize: number;

    /** Number of parents/selected points (mu). Auto-calculated if <= 0 */
    mu: number;

    /** Initial step-size (sigma). Auto-calculated if <= 0 */
    sigma: number;

    /** Seed for random number generator (for reproducibility) */
    seed?: number;
}

export const DEFAULT_CMAES_CONFIG: CMAESConfig = {
    maxIterations: 1000,
    convergenceThreshold: 1e-8,
    convergenceIterations: 10,
    useRelativeConvergence: false,
    convergenceThresholdPercent: 0.01,
    populationSize: 0, // Auto
    mu: 0, // Auto
    sigma: 0, // Auto
};

// ============================================================================
// Genetic Optimizer Configuration (for adapter)
// ============================================================================

export interface GeneticAdapterConfig extends BaseOptimizerConfig {
    /** Population size per generation */
    populationSize: number;

    /** Mutation rate (0-1) */
    mutationRate: number;

    /** Mutation strength (0-1, as fraction of range) */
    mutationStrength: number;

    /** Number of top performers to keep unchanged */
    eliteCount: number;

    /** Probability of crossover vs clone */
    crossoverRate: number;

    /** Minimum trades required */
    minTradeCount: number;

    /** Penalty multiplier when below minTradeCount */
    minTradePenalty: number;

    /** Population diversity threshold before injection */
    diversityThreshold: number;

    /** Fraction of population to replace if low diversity */
    diversityInjectionRate: number;
}

export const DEFAULT_GENETIC_CONFIG: GeneticAdapterConfig = {
    maxIterations: 50,
    convergenceThreshold: 1.0,
    convergenceIterations: 5,
    useRelativeConvergence: true,
    convergenceThresholdPercent: 0.01,
    populationSize: 20,
    mutationRate: 0.2,
    mutationStrength: 0.3,
    eliteCount: 2,
    crossoverRate: 0.7,
    minTradeCount: 10,
    minTradePenalty: 0.5,
    diversityThreshold: 0.1,
    diversityInjectionRate: 0.2,
};

// ============================================================================
// Iterative Refinement Configuration
// ============================================================================

export interface IterativeRefinementConfig {
    /** Maximum outer iterations (alternating between stages) */
    maxOuterIterations: number;

    /** Convergence threshold for outer loop (fitness improvement) */
    outerConvergenceThreshold: number;

    /** Optimizer type for Stage 1 (base params) */
    stage1Optimizer: 'genetic' | 'bayesian' | 'cmaes';

    /** Optimizer type for Stage 2 (MSPEQ coefficients) */
    stage2Optimizer: 'genetic' | 'bayesian' | 'cmaes';

    /** Configuration for Stage 1 optimizer */
    stage1Config: Partial<BayesianConfig | CMAESConfig | GeneticAdapterConfig>;

    /** Configuration for Stage 2 optimizer */
    stage2Config: Partial<BayesianConfig | CMAESConfig | GeneticAdapterConfig>;

    /** Minimum fitness improvement between outer iterations to continue */
    minImprovementPerIteration: number;
}

export const DEFAULT_ITERATIVE_CONFIG: IterativeRefinementConfig = {
    maxOuterIterations: 5,
    outerConvergenceThreshold: 1.0,
    stage1Optimizer: 'bayesian',
    stage2Optimizer: 'cmaes',
    stage1Config: {},
    stage2Config: {},
    minImprovementPerIteration: 0.5,
};

// ============================================================================
// Optimizer Type Enum
// ============================================================================

export type OptimizerType = 'genetic' | 'bayesian' | 'cmaes';
