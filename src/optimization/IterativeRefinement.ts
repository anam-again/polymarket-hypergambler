/**
 * Iterative Refinement Controller
 *
 * Manages alternating optimization between two stages:
 * - Stage 1: Base parameters (8-14 dimensions) using Bayesian Optimization
 * - Stage 2: MSPEQ coefficients (60-90 dimensions) using CMA-ES
 *
 * Each outer iteration allows Stage 2 to refine MSPEQ given frozen base params,
 * then optionally re-optimizes base params given the learned MSPEQ.
 */

import type {
    IOptimizer,
    ParameterBounds,
    EvaluationResult,
    IterativeRefinementConfig,
    OptimizerType,
    BayesianConfig,
    CMAESConfig,
    GeneticAdapterConfig,
} from './interfaces.js';
import {
    DEFAULT_ITERATIVE_CONFIG,
    DEFAULT_BAYESIAN_CONFIG,
    DEFAULT_CMAES_CONFIG,
    DEFAULT_GENETIC_CONFIG,
} from './interfaces.js';
import { BayesianOptimizer } from './BayesianOptimizer.js';
import { CMAESOptimizer } from './CMAESOptimizer.js';
import { GeneticOptimizerAdapter } from './GeneticOptimizerAdapter.js';
import { SimulatorLogger } from '../simulation/SimulatorLogger.js';

// ============================================================================
// Types
// ============================================================================

export interface IterativeRefinementResult {
    bestParams: Record<string, number>;
    bestFitness: number;
    stage1Params: Record<string, number>;
    stage2Params: Record<string, number>;
    outerIterations: number;
    converged: boolean;
    convergenceReason: string;
    iterationHistory: {
        iteration: number;
        stage1Fitness: number;
        stage2Fitness: number;
        combinedFitness: number;
    }[];
}

export type EvaluationFunction = (params: Record<string, number>[]) => Promise<EvaluationResult[]>;

// ============================================================================
// IterativeRefinement Controller
// ============================================================================

export class IterativeRefinement {
    private config: IterativeRefinementConfig;
    private stage1Bounds: ParameterBounds = {};
    private stage2Bounds: ParameterBounds = {};
    private stage1ParamNames: string[] = [];
    private stage2ParamNames: string[] = [];

    private currentStage1Params: Record<string, number> = {};
    private currentStage2Params: Record<string, number> = {};
    private bestCombinedParams: Record<string, number> = {};
    private bestFitness: number = -Infinity;

    private iterationHistory: {
        iteration: number;
        stage1Fitness: number;
        stage2Fitness: number;
        combinedFitness: number;
    }[] = [];

    private logger: SimulatorLogger | null;
    private strategyName: string = '';

    constructor(
        config: Partial<IterativeRefinementConfig> = {},
        logger?: SimulatorLogger,
        strategyName?: string
    ) {
        this.config = { ...DEFAULT_ITERATIVE_CONFIG, ...config };
        this.logger = logger ?? null;
        this.strategyName = strategyName ?? '';
    }

    // -------------------------------------------------------------------------
    // Main Entry Point
    // -------------------------------------------------------------------------

    /**
     * Run iterative refinement optimization.
     *
     * @param stage1Bounds Parameter bounds for Stage 1 (base params)
     * @param stage2Bounds Parameter bounds for Stage 2 (MSPEQ coefficients)
     * @param evaluate Function to evaluate parameter sets
     * @returns Optimization result with best combined parameters
     */
    async run(
        stage1Bounds: ParameterBounds,
        stage2Bounds: ParameterBounds,
        evaluate: EvaluationFunction
    ): Promise<IterativeRefinementResult> {
        this.stage1Bounds = stage1Bounds;
        this.stage2Bounds = stage2Bounds;
        this.stage1ParamNames = Object.keys(stage1Bounds);
        this.stage2ParamNames = Object.keys(stage2Bounds);

        this.log('');
        this.log('╔════════════════════════════════════════════════════════════╗');
        this.log('║       ITERATIVE REFINEMENT OPTIMIZATION                    ║');
        this.log('╚════════════════════════════════════════════════════════════╝');
        this.log('');
        this.log(`Stage 1 Optimizer: ${this.config.stage1Optimizer.toUpperCase()}`);
        this.log(`Stage 2 Optimizer: ${this.config.stage2Optimizer.toUpperCase()}`);
        this.log(`Stage 1 Dimensions: ${this.stage1ParamNames.length}`);
        this.log(`Stage 2 Dimensions: ${this.stage2ParamNames.length}`);
        this.log(`Max Outer Iterations: ${this.config.maxOuterIterations}`);
        this.log('');

        // Initialize with random parameters
        this.currentStage1Params = this.generateRandomParams(stage1Bounds);
        this.currentStage2Params = this.generateRandomParams(stage2Bounds);

        let previousFitness = -Infinity;

        for (let outerIter = 0; outerIter < this.config.maxOuterIterations; outerIter++) {
            this.log('═'.repeat(60));
            this.log(`OUTER ITERATION ${outerIter + 1} / ${this.config.maxOuterIterations}`);
            this.log('═'.repeat(60));

            // Stage 1: Optimize base params with frozen MSPEQ
            this.log('\n--- Stage 1: Optimizing Base Parameters ---');
            const stage1Result = await this.runStage1(evaluate);
            this.currentStage1Params = stage1Result.params;
            const stage1Fitness = stage1Result.fitness;
            this.log(`Stage 1 Best Fitness: $${stage1Fitness.toFixed(2)}`);

            // Stage 2: Optimize MSPEQ with frozen base params
            this.log('\n--- Stage 2: Optimizing MSPEQ Coefficients ---');
            const stage2Result = await this.runStage2(evaluate);
            this.currentStage2Params = stage2Result.params;
            const stage2Fitness = stage2Result.fitness;
            this.log(`Stage 2 Best Fitness: $${stage2Fitness.toFixed(2)}`);

            // Combined evaluation
            const combinedParams = { ...this.currentStage1Params, ...this.currentStage2Params };
            const [combinedResult] = await evaluate([combinedParams]);
            const combinedFitness = combinedResult.fitness;

            // Update best if improved
            if (combinedFitness > this.bestFitness) {
                this.bestFitness = combinedFitness;
                this.bestCombinedParams = { ...combinedParams };
            }

            // Record iteration history
            this.iterationHistory.push({
                iteration: outerIter + 1,
                stage1Fitness,
                stage2Fitness,
                combinedFitness,
            });

            this.log(`\nOuter Iteration ${outerIter + 1} Summary:`);
            this.log(`  Stage 1 Fitness: $${stage1Fitness.toFixed(2)}`);
            this.log(`  Stage 2 Fitness: $${stage2Fitness.toFixed(2)}`);
            this.log(`  Combined Fitness: $${combinedFitness.toFixed(2)}`);
            this.log(`  Best So Far: $${this.bestFitness.toFixed(2)}`);

            // Check convergence
            const improvement = combinedFitness - previousFitness;
            if (outerIter > 0 && improvement < this.config.minImprovementPerIteration) {
                this.log(`\nConverged: Improvement ($${improvement.toFixed(2)}) < threshold ($${this.config.minImprovementPerIteration.toFixed(2)})`);
                return this.buildResult(true, 'Converged - insufficient improvement');
            }

            previousFitness = combinedFitness;
        }

        return this.buildResult(true, `Completed ${this.config.maxOuterIterations} outer iterations`);
    }

    // -------------------------------------------------------------------------
    // Stage Runners
    // -------------------------------------------------------------------------

    /**
     * Run Stage 1 optimization (base parameters).
     */
    private async runStage1(evaluate: EvaluationFunction): Promise<{ params: Record<string, number>; fitness: number }> {
        const optimizer = this.createOptimizer(
            this.config.stage1Optimizer,
            this.config.stage1Config
        );

        optimizer.initialize(this.stage1Bounds);

        // Create evaluation wrapper that injects frozen Stage 2 params
        const wrappedEvaluate = async (stage1ParamSets: Record<string, number>[]): Promise<EvaluationResult[]> => {
            const combinedParamSets = stage1ParamSets.map(params => ({
                ...params,
                ...this.currentStage2Params,
            }));
            return evaluate(combinedParamSets);
        };

        return this.runOptimizer(optimizer, wrappedEvaluate, 'Stage 1');
    }

    /**
     * Run Stage 2 optimization (MSPEQ coefficients).
     */
    private async runStage2(evaluate: EvaluationFunction): Promise<{ params: Record<string, number>; fitness: number }> {
        const optimizer = this.createOptimizer(
            this.config.stage2Optimizer,
            this.config.stage2Config
        );

        optimizer.initialize(this.stage2Bounds);

        // Create evaluation wrapper that injects frozen Stage 1 params
        const wrappedEvaluate = async (stage2ParamSets: Record<string, number>[]): Promise<EvaluationResult[]> => {
            const combinedParamSets = stage2ParamSets.map(params => ({
                ...this.currentStage1Params,
                ...params,
            }));
            return evaluate(combinedParamSets);
        };

        return this.runOptimizer(optimizer, wrappedEvaluate, 'Stage 2');
    }

    /**
     * Run a single optimizer to completion.
     */
    private async runOptimizer(
        optimizer: IOptimizer,
        evaluate: EvaluationFunction,
        stageName: string
    ): Promise<{ params: Record<string, number>; fitness: number }> {
        let iterations = 0;
        const status = new StatusDisplay(true);

        // Wrap evaluate to show per-individual progress
        const evaluateWithProgress = async (paramSets: Record<string, number>[]): Promise<EvaluationResult[]> => {
            const results: EvaluationResult[] = [];
            const batchSize = paramSets.length;

            for (let i = 0; i < paramSets.length; i++) {
                status.update({
                    strategy: this.strategyName || undefined,
                    optimizer: optimizer.name,
                    iteration: iterations + 1,
                    individual: i + 1,
                    batchSize,
                    phase: stageName,
                    bestFitness: optimizer.getBest()?.fitness,
                    evaluating: true,
                });

                const [result] = await evaluate([paramSets[i]]);
                results.push(result);
            }

            return results;
        };

        while (true) {
            // Ask for next batch
            const paramSets = optimizer.ask();

            // Evaluate with progress
            const results = await evaluateWithProgress(paramSets);

            // Tell results
            optimizer.tell(results);

            iterations++;

            // Update status after iteration
            const best = optimizer.getBest();
            status.update({
                strategy: this.strategyName || undefined,
                optimizer: optimizer.name,
                iteration: iterations,
                phase: stageName,
                bestFitness: best?.fitness,
            });

            // Check stopping
            const stopCondition = optimizer.shouldStop();
            if (stopCondition.stop) {
                status.finalize(
                    `${ANSI.GREEN}[${stageName}/${optimizer.name}]${ANSI.RESET} ` +
                    `${stopCondition.reason} | Best: ${ANSI.BOLD}$${best?.fitness.toFixed(2) ?? 'N/A'}${ANSI.RESET}`
                );
                break;
            }
        }

        const best = optimizer.getBest();
        if (!best) {
            throw new Error(`${stageName} optimizer returned no results`);
        }

        return { params: best.params, fitness: best.fitness };
    }

    // -------------------------------------------------------------------------
    // Optimizer Factory
    // -------------------------------------------------------------------------

    private createOptimizer(
        type: OptimizerType,
        configOverrides: Partial<BayesianConfig | CMAESConfig | GeneticAdapterConfig>
    ): IOptimizer {
        switch (type) {
            case 'bayesian':
                return new BayesianOptimizer({
                    ...DEFAULT_BAYESIAN_CONFIG,
                    ...configOverrides,
                });
            case 'cmaes':
                return new CMAESOptimizer({
                    ...DEFAULT_CMAES_CONFIG,
                    ...configOverrides,
                });
            case 'genetic':
                return new GeneticOptimizerAdapter({
                    ...DEFAULT_GENETIC_CONFIG,
                    ...configOverrides,
                } as GeneticAdapterConfig, this.logger ?? undefined);
            default:
                throw new Error(`Unknown optimizer type: ${type}`);
        }
    }

    // -------------------------------------------------------------------------
    // Utilities
    // -------------------------------------------------------------------------

    private generateRandomParams(bounds: ParameterBounds): Record<string, number> {
        const params: Record<string, number> = {};
        for (const [name, bound] of Object.entries(bounds)) {
            let value = bound.min + Math.random() * (bound.max - bound.min);
            if (bound.step) {
                value = Math.round(value / bound.step) * bound.step;
            }
            params[name] = value;
        }
        return params;
    }

    private buildResult(converged: boolean, reason: string): IterativeRefinementResult {
        return {
            bestParams: { ...this.bestCombinedParams },
            bestFitness: this.bestFitness,
            stage1Params: { ...this.currentStage1Params },
            stage2Params: { ...this.currentStage2Params },
            outerIterations: this.iterationHistory.length,
            converged,
            convergenceReason: reason,
            iterationHistory: [...this.iterationHistory],
        };
    }

    private log(message: string): void {
        if (this.logger) {
            this.logger.log(message);
        } else {
            console.log(message);
        }
    }
}

// ============================================================================
// ANSI Status Display
// ============================================================================

/** ANSI escape codes for terminal control */
const ANSI = {
    CLEAR_LINE: '\x1b[K',
    MOVE_UP: '\x1b[1A',
    MOVE_TO_COL: (n: number) => `\x1b[${n}G`,
    HIDE_CURSOR: '\x1b[?25l',
    SHOW_CURSOR: '\x1b[?25h',
    BOLD: '\x1b[1m',
    DIM: '\x1b[2m',
    RESET: '\x1b[0m',
    CYAN: '\x1b[36m',
    GREEN: '\x1b[32m',
    YELLOW: '\x1b[33m',
    MAGENTA: '\x1b[35m',
    WHITE: '\x1b[37m',
};

/** Context for optimization status display */
export interface OptimizationContext {
    strategyName?: string;
    phase?: string;
    maxIterations?: number;
}

/** Displays a single-line status that updates in place */
class StatusDisplay {
    private lastLineCount = 0;
    private enabled: boolean;

    constructor(enabled = true) {
        this.enabled = enabled && process.stdout.isTTY === true;
    }

    update(status: {
        strategy?: string;
        optimizer: string;
        iteration: number;
        maxIterations?: number;
        individual?: number;
        batchSize?: number;
        phase?: string;
        bestFitness?: number;
        evaluating?: boolean;
    }): void {
        if (!this.enabled) return;

        // Build status line
        const parts: string[] = [];

        // Strategy name
        if (status.strategy) {
            parts.push(`${ANSI.CYAN}${status.strategy}${ANSI.RESET}`);
        }

        // Phase (if provided)
        if (status.phase) {
            parts.push(`${ANSI.MAGENTA}${status.phase}${ANSI.RESET}`);
        }

        // Optimizer name
        parts.push(`${ANSI.YELLOW}${status.optimizer}${ANSI.RESET}`);

        // Iteration progress
        const iterStr = status.maxIterations
            ? `${status.iteration}/${status.maxIterations}`
            : `${status.iteration}`;
        parts.push(`Iter ${ANSI.BOLD}${iterStr}${ANSI.RESET}`);

        // Individual progress within batch
        if (status.individual !== undefined && status.batchSize !== undefined) {
            const evalStatus = status.evaluating ? `${ANSI.DIM}evaluating${ANSI.RESET}` : '';
            parts.push(`[${status.individual}/${status.batchSize}] ${evalStatus}`);
        }

        // Best fitness
        if (status.bestFitness !== undefined) {
            const fitnessColor = status.bestFitness >= 0 ? ANSI.GREEN : ANSI.YELLOW;
            parts.push(`Best: ${fitnessColor}$${status.bestFitness.toFixed(2)}${ANSI.RESET}`);
        }

        // Clear previous line and write new status
        const line = parts.join(' | ');
        process.stdout.write(`\r${ANSI.CLEAR_LINE}${line}`);
    }

    clear(): void {
        if (!this.enabled) return;
        process.stdout.write(`\r${ANSI.CLEAR_LINE}`);
    }

    finalize(message: string): void {
        if (!this.enabled) {
            console.log(message);
            return;
        }
        process.stdout.write(`\r${ANSI.CLEAR_LINE}${message}\n`);
    }
}

// ============================================================================
// Single-Stage Optimization Helper
// ============================================================================

/**
 * Run single-stage optimization with a specified optimizer type.
 * Useful when you want to use one optimizer for all parameters.
 */
export async function runSingleStageOptimization(
    bounds: ParameterBounds,
    evaluate: EvaluationFunction,
    optimizerType: OptimizerType,
    config: Partial<BayesianConfig | CMAESConfig | GeneticAdapterConfig> = {},
    logger?: SimulatorLogger,
    context?: OptimizationContext
): Promise<{ params: Record<string, number>; fitness: number; iterations: number }> {
    let optimizer: IOptimizer;

    switch (optimizerType) {
        case 'bayesian':
            optimizer = new BayesianOptimizer({
                ...DEFAULT_BAYESIAN_CONFIG,
                ...config,
            });
            break;
        case 'cmaes':
            optimizer = new CMAESOptimizer({
                ...DEFAULT_CMAES_CONFIG,
                ...config,
            });
            break;
        case 'genetic':
            optimizer = new GeneticOptimizerAdapter({
                ...DEFAULT_GENETIC_CONFIG,
                ...config,
            } as GeneticAdapterConfig, logger);
            break;
        default:
            throw new Error(`Unknown optimizer type: ${optimizerType}`);
    }

    optimizer.initialize(bounds);

    let iterations = 0;
    const maxIterations = context?.maxIterations ?? (config as any).maxIterations;
    const log = (msg: string) => logger?.log(msg) ?? console.log(msg);
    const status = new StatusDisplay(true);

    // Wrap evaluate to show per-individual progress
    const evaluateWithProgress = async (paramSets: Record<string, number>[]): Promise<EvaluationResult[]> => {
        const results: EvaluationResult[] = [];
        const batchSize = paramSets.length;

        for (let i = 0; i < paramSets.length; i++) {
            // Update status before evaluation
            status.update({
                strategy: context?.strategyName,
                optimizer: optimizer.name,
                iteration: iterations + 1,
                maxIterations,
                individual: i + 1,
                batchSize,
                phase: context?.phase,
                bestFitness: optimizer.getBest()?.fitness,
                evaluating: true,
            });

            // Evaluate single individual
            const [result] = await evaluate([paramSets[i]]);
            results.push(result);
        }

        return results;
    };

    while (true) {
        const paramSets = optimizer.ask();
        const results = await evaluateWithProgress(paramSets);
        optimizer.tell(results);

        iterations++;

        // Update status after iteration completes
        const best = optimizer.getBest();
        status.update({
            strategy: context?.strategyName,
            optimizer: optimizer.name,
            iteration: iterations,
            maxIterations,
            phase: context?.phase,
            bestFitness: best?.fitness,
        });

        const stopCondition = optimizer.shouldStop();
        if (stopCondition.stop) {
            status.finalize(
                `${ANSI.GREEN}[${optimizer.name}]${ANSI.RESET} ` +
                `Completed ${iterations} iterations - ${stopCondition.reason} ` +
                `| Best: ${ANSI.BOLD}$${best?.fitness.toFixed(2) ?? 'N/A'}${ANSI.RESET}`
            );
            break;
        }
    }

    const best = optimizer.getBest();
    if (!best) {
        throw new Error('Optimizer returned no results');
    }

    return {
        params: best.params,
        fitness: best.fitness,
        iterations,
    };
}
