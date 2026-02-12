import * as fs from 'fs';
import * as YAML from 'yaml';
import {
    HistoricalSimulator,
    BotParams,
    SimulatedBot,
    SimulationResult,
    CoinType,
} from './HistoricalSimulator.js';
import { TargetedMarket } from '../types/interfaces.js';
import { SimulatorLogger } from './SimulatorLogger.js';

// Import optimization module
import {
    IterativeRefinement,
    runSingleStageOptimization,
} from '../optimization/index.js';
import type { OptimizerType, EvaluationResult, OptimizationContext } from '../optimization/index.js';

// ANSI Color Codes for PnL output
const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';

/** Colors a PnL value: green for positive, red for negative */
const colorPnl = (value: number): string =>
    value >= 0 ? `${GREEN}$${value.toFixed(2)}${RESET}` : `${RED}$${value.toFixed(2)}${RESET}`;

// Import strategy definitions (bounds, factories, geneticStrategies)
import {
    geneticStrategies,
    MSPEQ_BASE_PARAM_NAMES,
    EARLYBUYER_MSPEQ_BASE_PARAM_NAMES,
    MARKETMAKER_MSPEQ_BASE_PARAM_NAMES,
    NCANDLE_MSPEQ_BASE_PARAM_NAMES,
    CROSSPERIODMOMENTUM_MSPEQ_BASE_PARAM_NAMES,
    // MSPEQ-only bounds (for two-stage optimization)
    firstCandleMSPEQOnlyBounds,
    quarterlyFirstCandleMSPEQOnlyBounds,
    earlyBuyerMSPEQOnlyBounds,
    quarterlyEarlyBuyerMSPEQOnlyBounds,
    marketMakerMSPEQOnlyBounds,
    quarterlyMarketMakerMSPEQOnlyBounds,
    nCandleMSPEQOnlyBounds,
    quarterlyNCandleMSPEQOnlyBounds,
    crossPeriodMomentumMSPEQOnlyBounds,
    quarterlyCrossPeriodMomentumMSPEQOnlyBounds,
    // Full bounds (base params + MSPEQ coefficients)
    earlyBuyerMSPEQBounds,
    quarterlyEarlyBuyerMSPEQBounds,
    marketMakerMSPEQBounds,
    quarterlyMarketMakerMSPEQBounds,
    nCandleMSPEQBounds,
    quarterlyNCandleMSPEQBounds,
    crossPeriodMomentumMSPEQBounds,
    quarterlyCrossPeriodMomentumMSPEQBounds,
    // Factory functions
    createFirstCandleMSPEQBot,
    createQuarterlyFirstCandleMSPEQBot,
    createEarlyBuyerMSPEQBot,
    createQuarterlyEarlyBuyerMSPEQBot,
    createMarketMakerMSPEQBot,
    createQuarterlyMarketMakerMSPEQBot,
    createNCandleMSPEQBot,
    createQuarterlyNCandleMSPEQBot,
    createCrossPeriodMomentumMSPEQBot,
    createQuarterlyCrossPeriodMomentumMSPEQBot,
    // Type re-export
    ParameterBounds,
} from './strategyDefinitions.js';

// Re-export adapter utilities for external use
export { createSimulatedBot, createMockClobClient, QuantBotSimulationAdapter } from './QuantBotSimulationAdapter.js';

// Re-export geneticStrategies for external use
export { geneticStrategies } from './strategyDefinitions.js';

// ============================================================================
// YAML Configuration Interface
// ============================================================================

interface YamlConfig {
    strategy: string;
    market?: string;
    coin?: string;
    days?: number;
    params: Record<string, number>;
}

// ============================================================================
// YAML-Based Custom Parameter Simulation
// ============================================================================

async function runYamlSimulation(yamlPath: string): Promise<void> {
    // 1. Read and parse YAML file
    let yamlContent: string;
    try {
        yamlContent = fs.readFileSync(yamlPath, 'utf-8');
    } catch (error) {
        console.error(`Error reading YAML file: ${yamlPath}`);
        console.error(error);
        process.exit(1);
    }

    let config: YamlConfig;
    try {
        config = YAML.parse(yamlContent) as YamlConfig;
    } catch (error) {
        console.error(`Error parsing YAML file: ${yamlPath}`);
        console.error(error);
        process.exit(1);
    }

    // 2. Validate required fields
    if (!config.strategy) {
        console.error('Error: YAML file must specify a "strategy" field');
        process.exit(1);
    }
    if (!config.params || Object.keys(config.params).length === 0) {
        console.error('Error: YAML file must specify "params" with at least one parameter');
        process.exit(1);
    }

    // 3. Look up strategy factory
    const strategy = geneticStrategies.find(
        s => s.name.toLowerCase() === config.strategy.toLowerCase()
    );
    if (!strategy) {
        console.error(`Error: Unknown strategy "${config.strategy}"`);
        console.log('Available strategies: ' + geneticStrategies.map(s => s.name).join(', '));
        process.exit(1);
    }

    // 4. Determine market and coin type
    let targetedMarket = TargetedMarket.BITCOIN_HOURLY;
    let coinType = CoinType.BTC;

    if (config.market) {
        const marketArg = config.market.toLowerCase();
        if (marketArg === 'btc-hourly' || marketArg === 'bitcoin-hourly') {
            targetedMarket = TargetedMarket.BITCOIN_HOURLY;
            coinType = CoinType.BTC;
        } else if (marketArg === 'btc-quarterly' || marketArg === 'bitcoin-quarterly') {
            targetedMarket = TargetedMarket.BITCOIN_QUARTERLY;
            coinType = CoinType.BTC;
        } else if (marketArg === 'eth-hourly' || marketArg === 'ethereum-hourly') {
            targetedMarket = TargetedMarket.ETHEREUM_HOURLY;
            coinType = CoinType.ETH;
        } else if (marketArg === 'eth-quarterly' || marketArg === 'ethereum-quarterly') {
            targetedMarket = TargetedMarket.ETHEREUM_QUARTERLY;
            coinType = CoinType.ETH;
        } else if (marketArg === 'sol-quarterly' || marketArg === 'solana-quarterly') {
            targetedMarket = TargetedMarket.SOLANA_QUARTERLY;
            coinType = CoinType.SOL;
        } else if (marketArg === 'sol-hourly' || marketArg === 'solana-hourly') {
            targetedMarket = TargetedMarket.SOLANA_HOURLY;
            coinType = CoinType.SOL;
        } else if (marketArg === 'xrp-hourly') {
            targetedMarket = TargetedMarket.XRP_HOURLY;
            coinType = CoinType.XRP;
        } else if (marketArg === 'xrp-quarterly') {
            targetedMarket = TargetedMarket.XRP_QUARTERLY;
            coinType = CoinType.XRP;
        } else {
            console.error(`Invalid market: ${config.market}`);
            process.exit(1);
        }
    }

    // Override coin if explicitly specified
    if (config.coin) {
        const coinArg = config.coin.toLowerCase();
        if (coinArg === 'btc') coinType = CoinType.BTC;
        else if (coinArg === 'eth') coinType = CoinType.ETH;
        else if (coinArg === 'sol') coinType = CoinType.SOL;
        else if (coinArg === 'xrp') coinType = CoinType.XRP;
        else {
            console.error(`Invalid coin type: ${config.coin}`);
            process.exit(1);
        }
    }

    const lookbackDays = config.days ?? 7;

    // 5. Print header
    console.log('');
    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║         CUSTOM PARAMETER SIMULATION - Historical Sim       ║');
    console.log('╚════════════════════════════════════════════════════════════╝');

    console.log('\nConfiguration:');
    console.log(`  YAML File: ${yamlPath}`);
    console.log(`  Strategy: ${strategy.name}`);
    console.log(`  Coin Type: ${coinType.toUpperCase()}`);
    console.log(`  Market: ${targetedMarket}`);
    console.log(`  Lookback Days: ${lookbackDays}`);

    console.log('\nParameters:');
    for (const [key, value] of Object.entries(config.params)) {
        console.log(`  ${key}: ${value}`);
    }

    // 6. Create simulator
    const simulator = new HistoricalSimulator({
        lookbackDays,
        tickIntervalMs: 5 * 1000,
        coinType,
        targetedMarket,
    });

    console.log('\nRunning simulation...');

    // 7. Run single simulation
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const logDirectory = `./logs/simulator/audit/yaml-${strategy.name.toLowerCase()}-${timestamp}`;

    const { result, trades } = await simulator.runSingleSimulation(
        strategy.name,
        strategy.factory,
        config.params,
        { shouldWriteLogs: true, logDirectory }
    );

    // 8. Print results
    const colorRatio = (value: number): string =>
        value >= 1 ? `${GREEN}${value.toFixed(2)}${RESET}` :
        value >= 0 ? `${value.toFixed(2)}` :
        `${RED}${value.toFixed(2)}${RESET}`;

    console.log('\nResults:');
    console.log(`  Total Trades: ${result.totalTrades}`);
    console.log(`  Matched Trades: ${result.matchedTrades}`);
    console.log(`  Expired Trades: ${result.expiredTrades}`);
    console.log(`  ${CYAN}Total PnL${RESET}: ${colorPnl(result.totalPnl)}`);
    console.log(`  Win Rate: ${result.winRate.toFixed(2)}%`);
    console.log(`  ${CYAN}Avg PnL${RESET}: ${colorPnl(result.avgPnl)}`);
    console.log(`  Max Drawdown: ${RED}$${result.maxDrawdown.toFixed(2)}${RESET}`);
    console.log(`  Sharpe Ratio: ${colorRatio(result.sharpeRatio)}`);
    console.log(`  ${CYAN}Sortino Ratio${RESET}: ${colorRatio(result.sortinoRatio)}`);
    console.log(`  Calmar Ratio: ${colorRatio(result.calmarRatio)}`);

    // 9. Generate trade audit
    const logger = new SimulatorLogger(`yaml-${strategy.name.toLowerCase()}`);
    logger.writeSimulatedTradeAudits(strategy.name, trades, logDirectory);

    console.log(`\nTrade audit written to: ${logDirectory}`);
    console.log('\n✓ Simulation complete\n');
}

// ============================================================================
// Two-Stage Optimization for MSPEQ Strategies
// ============================================================================

interface TwoStageConfig {
    lookbackDays: number;
    populationSize: number;
    maxGenerations: number;
    convergenceThreshold: number;
    coinType: CoinType;
    targetedMarket: TargetedMarket;
    auditTradesCount: number;
    isQuarterly: boolean;
    fitnessMode?: 'pnl' | 'sharpe' | 'sortino' | 'calmar';
}

/**
 * Runs two-stage optimization for MSPEQ strategies:
 * Stage 1: Optimize base parameters using FirstCandle (fast, ~12 params)
 * Stage 2: Freeze base params, optimize only MSPEQ coefficients (~60 params)
 */
async function runTwoStageOptimization(config: TwoStageConfig): Promise<void> {
    const logger = new SimulatorLogger(`two-stage-${config.coinType}`);

    logger.log('');
    logger.log('╔════════════════════════════════════════════════════════════╗');
    logger.log('║     TWO-STAGE MSPEQ OPTIMIZATION - Historical Sim          ║');
    logger.log('╚════════════════════════════════════════════════════════════╝');
    logger.log('');
    logger.log('Stage 1: Optimize base parameters with FirstCandle');
    logger.log('Stage 2: Freeze base params, optimize MSPEQ coefficients');
    logger.log('');

    // ========== STAGE 1: Optimize base parameters ==========
    logger.log('═══════════════════════════════════════════════════════════════');
    logger.log('STAGE 1: Base Parameter Optimization (FirstCandle)');
    logger.log('═══════════════════════════════════════════════════════════════');

    const stage1Simulator = new HistoricalSimulator({
        lookbackDays: config.lookbackDays,
        tickIntervalMs: 5 * 1000,
        coinType: config.coinType,
        targetedMarket: config.targetedMarket,
        auditTradesCount: 0, // No audit in Stage 1
    });

    // Use FirstCandle or QuarterlyFirstCandle based on market type
    const stage1Strategy = config.isQuarterly
        ? geneticStrategies.find(s => s.name === 'QuarterlyFirstCandle')!
        : geneticStrategies.find(s => s.name === 'FirstCandle')!;

    const stage1GeneticConfig = {
        populationSize: Math.min(config.populationSize, 100), // Cap Stage 1 population
        maxGenerations: Math.min(config.maxGenerations, 50),  // Cap Stage 1 generations
        convergenceThreshold: config.convergenceThreshold,
        convergenceGenerations: 5,
        mutationRate: 0.25,
        mutationStrength: 0.3,
        eliteCount: 2,
        crossoverRate: 0.7,
        fitnessMode: config.fitnessMode ?? 'sortino',  // Risk-adjusted fitness
    };

    logger.log(`\nConfiguration:`);
    logger.log(`  Strategy: ${stage1Strategy.name}`);
    logger.log(`  Population: ${stage1GeneticConfig.populationSize}`);
    logger.log(`  Max Generations: ${stage1GeneticConfig.maxGenerations}`);
    logger.log(`  Parameters: ~12 (base only)`);

    const stage1Result = await stage1Simulator.runGeneticOptimization(
        stage1Strategy.name,
        stage1Strategy.factory,
        stage1Strategy.bounds,
        stage1GeneticConfig
    );

    const stage1BestParams = stage1Result.bestIndividual.params;
    const stage1Fitness = stage1Result.bestIndividual.fitness;

    logger.log(`\nStage 1 Complete!`);
    logger.log(`  ${CYAN}Best Fitness${RESET}: ${colorPnl(stage1Fitness)}`);
    logger.log(`  Generations: ${stage1Result.totalGenerations}`);
    logger.log(`  Converged: ${stage1Result.converged} (${stage1Result.convergenceReason})`);
    logger.log(`\nFrozen Base Parameters:`);
    for (const paramName of MSPEQ_BASE_PARAM_NAMES) {
        if (stage1BestParams[paramName] !== undefined) {
            logger.log(`  ${paramName}: ${stage1BestParams[paramName]}`);
        }
    }

    // ========== STAGE 2: Optimize MSPEQ coefficients ==========
    logger.log('\n═══════════════════════════════════════════════════════════════');
    logger.log('STAGE 2: MSPEQ Coefficient Optimization (base params frozen)');
    logger.log('═══════════════════════════════════════════════════════════════');

    const stage2Simulator = new HistoricalSimulator({
        lookbackDays: config.lookbackDays,
        tickIntervalMs: 5 * 1000,
        coinType: config.coinType,
        targetedMarket: config.targetedMarket,
        auditTradesCount: config.auditTradesCount,
    });

    // Get Stage 2 bounds (MSPEQ only)
    const stage2Bounds = config.isQuarterly
        ? quarterlyFirstCandleMSPEQOnlyBounds
        : firstCandleMSPEQOnlyBounds;

    // Create a factory that injects frozen base params
    const stage2StrategyName = config.isQuarterly ? 'QuarterlyFirstCandleMSPEQ' : 'FirstCandleMSPEQ';
    const stage2Factory = config.isQuarterly ? createQuarterlyFirstCandleMSPEQBot : createFirstCandleMSPEQBot;

    // Create wrapper factory that merges frozen base params with MSPEQ params
    const stage2FactoryWithFrozenParams = (botParams: BotParams): SimulatedBot => {
        // Merge frozen base params from Stage 1 with MSPEQ params from Stage 2
        const mergedParams = {
            ...botParams,
            params: {
                ...stage1BestParams,  // Frozen base params
                ...botParams.params,   // MSPEQ params being optimized
            }
        };
        return stage2Factory(mergedParams);
    };

    const stage2GeneticConfig = {
        populationSize: config.populationSize,
        maxGenerations: config.maxGenerations,
        convergenceThreshold: config.convergenceThreshold,
        convergenceGenerations: 5,
        mutationRate: 0.25,
        mutationStrength: 0.3,
        eliteCount: 2,
        crossoverRate: 0.7,
        fitnessMode: config.fitnessMode ?? 'sortino',  // Risk-adjusted fitness
    };

    const stage2ParamCount = Object.keys(stage2Bounds).length;
    logger.log(`\nConfiguration:`);
    logger.log(`  Strategy: ${stage2StrategyName}`);
    logger.log(`  Population: ${stage2GeneticConfig.populationSize}`);
    logger.log(`  Max Generations: ${stage2GeneticConfig.maxGenerations}`);
    logger.log(`  Parameters: ${stage2ParamCount} (MSPEQ only)`);

    const stage2Result = await stage2Simulator.runGeneticOptimization(
        stage2StrategyName + '-Stage2',
        stage2FactoryWithFrozenParams,
        stage2Bounds,
        stage2GeneticConfig
    );

    const stage2BestParams = stage2Result.bestIndividual.params;
    const stage2Fitness = stage2Result.bestIndividual.fitness;

    // ========== FINAL RESULTS ==========
    logger.log('\n═══════════════════════════════════════════════════════════════');
    logger.log('TWO-STAGE OPTIMIZATION COMPLETE');
    logger.log('═══════════════════════════════════════════════════════════════');

    logger.log(`\nPerformance Comparison:`);
    logger.log(`  Stage 1 (FirstCandle base):     ${colorPnl(stage1Fitness)}`);
    logger.log(`  Stage 2 (with MSPEQ):           ${colorPnl(stage2Fitness)}`);
    const improvement = stage2Fitness - stage1Fitness;
    const improvementColor = improvement >= 0 ? GREEN : RED;
    logger.log(`  Improvement:                    ${improvementColor}$${improvement.toFixed(2)}${RESET} (${((stage2Fitness / stage1Fitness - 1) * 100).toFixed(1)}%)`);

    // Combine all params for final output
    const finalParams = {
        ...stage1BestParams,
        ...stage2BestParams,
    };

    logger.log(`\nFinal Combined Parameters:`);
    logger.log('--- Base Parameters (from Stage 1) ---');
    for (const paramName of MSPEQ_BASE_PARAM_NAMES) {
        if (finalParams[paramName] !== undefined) {
            logger.log(`  ${paramName}: ${finalParams[paramName]}`);
        }
    }

    logger.log('\n--- MSPEQ Parameters (from Stage 2) ---');
    for (const [key, value] of Object.entries(stage2BestParams)) {
        logger.log(`  ${key}: ${value}`);
    }

    // Save combined params to YAML
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const yamlOutput = {
        strategy: stage2StrategyName,
        market: config.isQuarterly ? 'btc-quarterly' : 'btc-hourly',
        coin: config.coinType,
        days: config.lookbackDays,
        twoStageOptimization: {
            stage1Fitness: stage1Fitness,
            stage2Fitness: stage2Fitness,
            improvement: stage2Fitness - stage1Fitness,
        },
        params: finalParams,
    };

    const yamlPath = `./logs/simulator/two-stage-${stage2StrategyName.toLowerCase()}-${timestamp}.yaml`;
    fs.writeFileSync(yamlPath, YAML.stringify(yamlOutput));
    logger.log(`\nParameters saved to: ${yamlPath}`);

    // Copy logs to audit directory if audit mode was used
    const auditLogDir = stage2Simulator.getLastAuditLogDir();
    if (auditLogDir) {
        logger.copyLogsToDirectory(auditLogDir);
        logger.log(`\nAll logs consolidated to: ${auditLogDir}`);
    }

    logger.log('\n✓ Two-stage optimization complete\n');
    logger.log(`Results saved to: ${logger.getLogFilePath()}`);
}

// ============================================================================
// Iterative Refinement Optimization (Hybrid Approach)
// ============================================================================

interface IterativeOptimizationConfig {
    lookbackDays: number;
    populationSize: number;
    maxGenerations: number;
    convergenceThreshold: number;
    coinType: CoinType;
    targetedMarket: TargetedMarket;
    auditTradesCount: number;
    isQuarterly: boolean;
    maxOuterIterations: number;
    strategyFilter?: string;
    stage1Optimizer: OptimizerType;
    stage2Optimizer: OptimizerType;
    optimizerOverride?: OptimizerType;
    fitnessMode?: 'pnl' | 'sharpe' | 'sortino' | 'calmar';
}

/**
 * Runs iterative refinement optimization using hybrid approach:
 * - Stage 1: Bayesian Optimization for base params
 * - Stage 2: CMA-ES for MSPEQ coefficients
 * - Alternates until convergence
 */
async function runIterativeOptimization(config: IterativeOptimizationConfig): Promise<void> {
    const logger = new SimulatorLogger(`iterative-${config.coinType}`);

    logger.log('');
    logger.log('╔════════════════════════════════════════════════════════════╗');
    logger.log('║     ITERATIVE REFINEMENT OPTIMIZATION - Hybrid Approach    ║');
    logger.log('╚════════════════════════════════════════════════════════════╝');
    logger.log('');
    logger.log(`Stage 1 Optimizer: ${config.stage1Optimizer.toUpperCase()}`);
    logger.log(`Stage 2 Optimizer: ${config.stage2Optimizer.toUpperCase()}`);
    logger.log(`Max Outer Iterations: ${config.maxOuterIterations}`);
    logger.log(`Lookback Days: ${config.lookbackDays}`);
    logger.log(`Market: ${config.targetedMarket}`);
    if (config.optimizerOverride) {
        logger.log(`Optimizer Override: ${config.optimizerOverride.toUpperCase()} (single-stage)`);
    }
    logger.log('');

    // Determine strategy and bounds
    const strategyName = config.strategyFilter ?? (config.isQuarterly ? 'QuarterlyFirstCandleMSPEQ' : 'FirstCandleMSPEQ');
    const strategy = geneticStrategies.find(s =>
        s.name.toLowerCase() === strategyName.toLowerCase()
    );

    if (!strategy) {
        logger.error(`Strategy '${strategyName}' not found.`);
        logger.log('Available strategies: ' + geneticStrategies.map(s => s.name).join(', '));
        process.exit(1);
    }

    // Get stage-specific bounds
    const stage1Bounds = getBaseParamBounds(strategyName, config.isQuarterly);
    const stage2Bounds = getMSPEQBounds(strategyName, config.isQuarterly);

    logger.log(`Strategy: ${strategy.name}`);
    logger.log(`Stage 1 Parameters: ${Object.keys(stage1Bounds).length}`);
    logger.log(`Stage 2 Parameters: ${Object.keys(stage2Bounds).length}`);

    // Create simulator
    const simulator = new HistoricalSimulator({
        lookbackDays: config.lookbackDays,
        tickIntervalMs: 5 * 1000,
        coinType: config.coinType,
        targetedMarket: config.targetedMarket,
        auditTradesCount: config.auditTradesCount,
    });

    // Create evaluation function with risk-adjusted fitness
    const calculateFitness = (result: SimulationResult): number => {
        const mode = config.fitnessMode ?? 'sortino';
        const RATIO_SCALE = 20;
        const CALMAR_SCALE = 10;

        switch (mode) {
            case 'sharpe':
                return result.sharpeRatio * RATIO_SCALE;
            case 'sortino':
                return result.sortinoRatio * RATIO_SCALE;
            case 'calmar':
                return result.calmarRatio * CALMAR_SCALE;
            case 'pnl':
            default:
                return result.totalPnl;
        }
    };

    const evaluate = async (paramSets: Record<string, number>[]): Promise<EvaluationResult[]> => {
        const results: EvaluationResult[] = [];

        for (const params of paramSets) {
            const { result } = await simulator.runSingleSimulation(
                strategy.name,
                strategy.factory,
                params,
                { shouldWriteLogs: false }
            );

            results.push({
                params,
                fitness: calculateFitness(result),  // Risk-adjusted fitness
                rawPnl: result.totalPnl,
                sharpeRatio: result.sharpeRatio,
                maxDrawdown: result.maxDrawdown,
                winRate: result.winRate,
                tradeCount: result.matchedTrades + result.expiredTrades,
            });
        }

        return results;
    };

    // Single-stage mode with optimizer override
    if (config.optimizerOverride) {
        logger.log('\n--- Single-Stage Optimization ---');

        const allBounds = { ...stage1Bounds, ...stage2Bounds };
        const optimizerConfig = {
            maxIterations: config.maxGenerations,
            convergenceThreshold: config.convergenceThreshold,
            populationSize: config.populationSize,
            batchSize: Math.min(4, config.populationSize),
            nInitialSamples: Math.min(10, config.populationSize),
        };

        const result = await runSingleStageOptimization(
            allBounds,
            evaluate,
            config.optimizerOverride,
            optimizerConfig,
            logger,
            {
                strategyName: strategy.name,
                phase: 'Single-Stage',
                maxIterations: config.maxGenerations,
            }
        );

        logger.log(`\nFinal Result:`);
        logger.log(`  ${CYAN}Best Fitness${RESET}: ${colorPnl(result.fitness)}`);
        logger.log(`  Iterations: ${result.iterations}`);
        logger.log(`\nBest Parameters:`);
        for (const [key, value] of Object.entries(result.params)) {
            logger.log(`  ${key}: ${typeof value === 'number' ? value.toFixed(4) : value}`);
        }

        // Create output directory for results
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const outputDir = `./logs/simulator/${config.optimizerOverride}-${strategy.name.toLowerCase()}-${timestamp}`;
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

        // Run final simulation with best params to generate trade audit
        logger.log('\n--- Running Final Simulation with Best Params ---');
        const { result: finalResult, trades: finalTrades } = await simulator.runSingleSimulation(
            strategy.name,
            strategy.factory,
            result.params,
            { shouldWriteLogs: true, logDirectory: outputDir }
        );

        logger.log(`Final Simulation Results:`);
        logger.log(`  Total Trades: ${finalResult.totalTrades}`);
        logger.log(`  ${CYAN}Total PnL${RESET}: ${colorPnl(finalResult.totalPnl)}`);
        logger.log(`  ${CYAN}Avg PnL${RESET}: ${colorPnl(finalResult.avgPnl)}`);
        logger.log(`  Sharpe: ${finalResult.sharpeRatio.toFixed(3)} | Sortino: ${finalResult.sortinoRatio.toFixed(3)}`);
        logger.log(`  Win Rate: ${finalResult.winRate.toFixed(1)}%`);

        // Write trade audit for dashboard inspection
        logger.writeSimulatedTradeAudits(strategy.name, finalTrades, outputDir);
        logger.log(`\nTrade audit written to: ${outputDir}/tradeAudit.log`);

        // Save to YAML in GeneticYamlConfig format (compatible with MSPEQsYamls)
        const yamlPath = `${outputDir}/params.yaml`;
        const yamlOutput = {
            schemaVersion: 1,
            botStyle: strategy.name,
            targetedMarket: config.targetedMarket,
            optimization: {
                bestPnl: finalResult.totalPnl,
                avgPnl: finalResult.avgPnl,
                generations: result.iterations,
                converged: true,
                convergenceReason: `${config.optimizerOverride} optimization complete`,
                timestamp: new Date().toISOString(),
                lookbackDays: config.lookbackDays,
                populationSize: config.populationSize,
                maxGenerations: config.maxGenerations,
                // Extended metrics
                fitnessMode: config.fitnessMode ?? 'sortino',
                optimizationFitness: result.fitness,
                sharpeRatio: finalResult.sharpeRatio,
                sortinoRatio: finalResult.sortinoRatio,
                calmarRatio: finalResult.calmarRatio,
                winRate: finalResult.winRate,
                totalTrades: finalResult.totalTrades,
            },
            params: result.params,
            runtime: {
                enabled: false,  // Set to true after review
                prodMode: false,
                hourlyDollarLimit: 50,
            },
        };
        fs.writeFileSync(yamlPath, YAML.stringify(yamlOutput));
        logger.log(`Parameters saved to: ${yamlPath}`);

        // Copy main log to output directory
        logger.copyLogsToDirectory(outputDir);

        logger.log('\n✓ Single-stage optimization complete');
        logger.log(`\nAll results saved to: ${outputDir}`);

        return;
    }

    // Full iterative refinement mode
    const iterativeRefinement = new IterativeRefinement({
        maxOuterIterations: config.maxOuterIterations,
        stage1Optimizer: config.stage1Optimizer,
        stage2Optimizer: config.stage2Optimizer,
        outerConvergenceThreshold: config.convergenceThreshold,
        minImprovementPerIteration: 0.5,
        stage1Config: {
            maxIterations: Math.min(config.maxGenerations, 30),
            populationSize: Math.min(config.populationSize, 20),
            batchSize: 4,
            nInitialSamples: 8,
        },
        stage2Config: {
            maxIterations: config.maxGenerations,
            populationSize: config.populationSize,
        },
    }, logger);

    const result = await iterativeRefinement.run(stage1Bounds, stage2Bounds, evaluate);

    // Print final results
    logger.log('\n' + '═'.repeat(60));
    logger.log('ITERATIVE REFINEMENT COMPLETE');
    logger.log('═'.repeat(60));
    logger.log(`\nFinal Results:`);
    logger.log(`  ${CYAN}Best Fitness${RESET}: ${colorPnl(result.bestFitness)}`);
    logger.log(`  Outer Iterations: ${result.outerIterations}`);
    logger.log(`  Converged: ${result.converged} (${result.convergenceReason})`);

    logger.log(`\nIteration History:`);
    for (const iter of result.iterationHistory) {
        logger.log(`  Iter ${iter.iteration}: Stage1=${colorPnl(iter.stage1Fitness)} Stage2=${colorPnl(iter.stage2Fitness)} Combined=${colorPnl(iter.combinedFitness)}`);
    }

    logger.log(`\nBest Combined Parameters:`);
    logger.log('--- Stage 1 (Base) Parameters ---');
    for (const [key, value] of Object.entries(result.stage1Params)) {
        logger.log(`  ${key}: ${typeof value === 'number' ? value.toFixed(4) : value}`);
    }
    logger.log('\n--- Stage 2 (MSPEQ) Parameters ---');
    for (const [key, value] of Object.entries(result.stage2Params)) {
        logger.log(`  ${key}: ${typeof value === 'number' ? value.toFixed(4) : value}`);
    }

    // Create output directory for results
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const outputDir = `./logs/simulator/iterative-${strategy.name.toLowerCase()}-${timestamp}`;
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    // Run final simulation with best params to generate trade audit
    logger.log('\n--- Running Final Simulation with Best Params ---');
    const { result: finalResult, trades: finalTrades } = await simulator.runSingleSimulation(
        strategy.name,
        strategy.factory,
        result.bestParams,
        { shouldWriteLogs: true, logDirectory: outputDir }
    );

    logger.log(`Final Simulation Results:`);
    logger.log(`  Total Trades: ${finalResult.totalTrades}`);
    logger.log(`  ${CYAN}Total PnL${RESET}: ${colorPnl(finalResult.totalPnl)}`);
    logger.log(`  ${CYAN}Avg PnL${RESET}: ${colorPnl(finalResult.avgPnl)}`);
    logger.log(`  Sharpe: ${finalResult.sharpeRatio.toFixed(3)} | Sortino: ${finalResult.sortinoRatio.toFixed(3)}`);
    logger.log(`  Win Rate: ${finalResult.winRate.toFixed(1)}%`);

    // Write trade audit for dashboard inspection
    logger.writeSimulatedTradeAudits(strategy.name, finalTrades, outputDir);
    logger.log(`\nTrade audit written to: ${outputDir}/tradeAudit.log`);

    // Save combined params to YAML in GeneticYamlConfig format (compatible with MSPEQsYamls)
    const yamlPath = `${outputDir}/params.yaml`;
    const yamlOutput = {
        schemaVersion: 1,
        botStyle: strategy.name,
        targetedMarket: config.targetedMarket,
        optimization: {
            bestPnl: finalResult.totalPnl,
            avgPnl: finalResult.avgPnl,
            generations: result.outerIterations,
            converged: result.converged,
            convergenceReason: result.convergenceReason,
            timestamp: new Date().toISOString(),
            lookbackDays: config.lookbackDays,
            populationSize: config.populationSize,
            maxGenerations: config.maxGenerations,
            // Extended metrics
            fitnessMode: config.fitnessMode ?? 'sortino',
            optimizationFitness: result.bestFitness,
            sharpeRatio: finalResult.sharpeRatio,
            sortinoRatio: finalResult.sortinoRatio,
            calmarRatio: finalResult.calmarRatio,
            winRate: finalResult.winRate,
            totalTrades: finalResult.totalTrades,
            // Iterative refinement details
            iterativeRefinement: {
                optimizer: config.optimizerOverride ?? `stage1:${config.stage1Optimizer}, stage2:${config.stage2Optimizer}`,
                outerIterations: result.outerIterations,
                iterationHistory: result.iterationHistory,
            },
        },
        params: result.bestParams,
        runtime: {
            enabled: false,  // Set to true after review
            prodMode: false,
            hourlyDollarLimit: 50,
        },
    };

    fs.writeFileSync(yamlPath, YAML.stringify(yamlOutput));
    logger.log(`Parameters saved to: ${yamlPath}`);

    // Copy main log to output directory
    logger.copyLogsToDirectory(outputDir);

    logger.log('\n✓ Iterative refinement optimization complete');
    logger.log(`\nAll results saved to: ${outputDir}`);
}

/**
 * Get base parameter bounds for a strategy (Stage 1).
 */
function getBaseParamBounds(strategyName: string, isQuarterly: boolean): ParameterBounds {
    const name = strategyName.toLowerCase();

    if (name.includes('firstcandlemspeq')) {
        return {
            targetDollars: { min: 5, max: 20, step: 1 },
            candleMinutes: isQuarterly ? { min: 1, max: 7, step: 1 } : { min: 5, max: 30, step: 2 },
            breakoutBuffer: isQuarterly ? { min: 10, max: 200 } : { min: 10, max: 300 },
            pullbackBuffer: isQuarterly ? { min: 0, max: 300 } : { min: 0, max: 500 },
            cutoffMinute: isQuarterly ? { min: 5, max: 14, step: 1 } : { min: 5, max: 55, step: 5 },
            candleSizeReference: { min: 500, max: 2000, step: 100 },
            baseBuyPrice: { min: 0.30, max: 0.70, step: 0.02 },
            minProfitMargin: { min: 0.05, max: 0.40, step: 0.02 },
        };
    }

    if (name.includes('earlybuyermspeq')) {
        return {
            targetDollars: { min: 5, max: 25, step: 1 },
            baseBuyPrice: { min: 0.02, max: 0.90 },
            baseSellPrice: { min: 0.1, max: 0.98 },
            baseCutoffMinute: isQuarterly ? { min: 4, max: 12, step: 1 } : { min: 15, max: 45, step: 1 },
            candleSizeReference: { min: 500, max: 2000, step: 100 },
            minProfitMargin: { min: 0.05, max: 0.40, step: 0.02 },
            directionThreshold: { min: 0.3, max: 0.7, step: 0.05 },
        };
    }

    if (name.includes('crossperiodmomentum')) {
        return {
            targetDollars: { min: 5, max: 25, step: 1 },
            baseBuyPrice: { min: 0.02, max: 0.90 },
            baseSellPrice: { min: 0.1, max: 0.98 },
            baseCutoffMinute: isQuarterly ? { min: 4, max: 12, step: 1 } : { min: 15, max: 45, step: 1 },
            candleSizeReference: { min: 500, max: 2000, step: 100 },
            minProfitMargin: { min: 0.05, max: 0.40, step: 0.02 },
            directionThreshold: { min: 0.3, max: 0.7, step: 0.05 },
            baseMomentumThreshold: { min: 0.5, max: 2.0, step: 0.1 },
            baseMinWinStreak: { min: 1, max: 5, step: 1 },
        };
    }

    // Default: use existing bounds for the strategy
    const strategy = geneticStrategies.find(s => s.name.toLowerCase() === strategyName.toLowerCase());
    return strategy?.bounds ?? {};
}

/**
 * Get MSPEQ parameter bounds for a strategy (Stage 2).
 */
function getMSPEQBounds(strategyName: string, isQuarterly: boolean): ParameterBounds {
    const name = strategyName.toLowerCase();

    if (name.includes('firstcandlemspeq')) {
        return isQuarterly ? quarterlyFirstCandleMSPEQOnlyBounds : firstCandleMSPEQOnlyBounds;
    }

    if (name.includes('earlybuyermspeq')) {
        return isQuarterly ? quarterlyEarlyBuyerMSPEQOnlyBounds : earlyBuyerMSPEQOnlyBounds;
    }

    if (name.includes('marketmakermspeq')) {
        return isQuarterly ? quarterlyMarketMakerMSPEQOnlyBounds : marketMakerMSPEQOnlyBounds;
    }

    if (name.includes('ncandlemspeq')) {
        return isQuarterly ? quarterlyNCandleMSPEQOnlyBounds : nCandleMSPEQOnlyBounds;
    }

    if (name.includes('crossperiodmomentum')) {
        return isQuarterly ? quarterlyCrossPeriodMomentumMSPEQOnlyBounds : crossPeriodMomentumMSPEQOnlyBounds;
    }

    // Default: empty (no MSPEQ params)
    return {};
}

// ============================================================================
// Stage 2 Only Optimization (with user-supplied base params)
// ============================================================================

interface Stage2OnlyConfig {
    lookbackDays: number;
    populationSize: number;
    maxGenerations: number;
    convergenceThreshold: number;
    coinType: CoinType;
    targetedMarket: TargetedMarket;
    auditTradesCount: number;
    isQuarterly: boolean;
    baseParamsFile: string;
    strategyFilter?: string;  // Optional: 'EarlyBuyerMSPEQ', 'FirstCandleMSPEQ', etc.
    fitnessMode?: 'pnl' | 'sharpe' | 'sortino' | 'calmar';
}

/**
 * Runs Stage 2 only optimization using user-supplied base parameters.
 * Useful for experimenting with MSPEQ coefficients after finding good base params.
 */
async function runStage2OnlyOptimization(config: Stage2OnlyConfig): Promise<void> {
    const logger = new SimulatorLogger(`stage2-only-${config.coinType}`);

    logger.log('');
    logger.log('╔════════════════════════════════════════════════════════════╗');
    logger.log('║     STAGE 2 ONLY - MSPEQ Coefficient Optimization          ║');
    logger.log('╚════════════════════════════════════════════════════════════╝');
    logger.log('');

    // Load base params from YAML file
    let baseParams: Record<string, number>;
    try {
        const yamlContent = fs.readFileSync(config.baseParamsFile, 'utf-8');
        const parsed = YAML.parse(yamlContent) as { params?: Record<string, number> } | Record<string, number>;

        // Support both flat format and nested { params: {...} } format
        if (parsed.params && typeof parsed.params === 'object') {
            baseParams = parsed.params as Record<string, number>;
        } else {
            baseParams = parsed as Record<string, number>;
        }

        logger.log(`Loaded base parameters from: ${config.baseParamsFile}`);
    } catch (error) {
        logger.error(`Failed to load base params from ${config.baseParamsFile}: ${error}`);
        process.exit(1);
    }

    // Detect strategy type from filter or base params file path
    const isEarlyBuyerMSPEQ = config.strategyFilter?.toLowerCase().includes('earlybuyermspeq') ||
        config.baseParamsFile.toLowerCase().includes('earlybuyer');
    const isMarketMakerMSPEQ = config.strategyFilter?.toLowerCase().includes('marketmakermspeq') ||
        config.baseParamsFile.toLowerCase().includes('marketmaker');
    const isNCandleMSPEQ = config.strategyFilter?.toLowerCase().includes('ncandlemspeq') ||
        config.baseParamsFile.toLowerCase().includes('ncandle');
    const isCrossPeriodMomentumMSPEQ = config.strategyFilter?.toLowerCase().includes('crossperiodmomentummspeq') ||
        config.baseParamsFile.toLowerCase().includes('crossperiodmomentum');

    // Select appropriate base param names based on strategy
    let baseParamNames: readonly string[];
    if (isMarketMakerMSPEQ) {
        baseParamNames = MARKETMAKER_MSPEQ_BASE_PARAM_NAMES;
    } else if (isNCandleMSPEQ) {
        baseParamNames = NCANDLE_MSPEQ_BASE_PARAM_NAMES;
    } else if (isCrossPeriodMomentumMSPEQ) {
        baseParamNames = CROSSPERIODMOMENTUM_MSPEQ_BASE_PARAM_NAMES;
    } else if (isEarlyBuyerMSPEQ) {
        baseParamNames = EARLYBUYER_MSPEQ_BASE_PARAM_NAMES;
    } else {
        baseParamNames = MSPEQ_BASE_PARAM_NAMES;
    }

    // Extract and validate base params
    const frozenBaseParams: Record<string, number> = {};
    logger.log('\nFrozen Base Parameters:');
    for (const paramName of baseParamNames) {
        if (baseParams[paramName] !== undefined) {
            frozenBaseParams[paramName] = baseParams[paramName];
            logger.log(`  ${paramName}: ${baseParams[paramName]}`);
        }
    }

    if (Object.keys(frozenBaseParams).length === 0) {
        logger.error('\nNo valid base parameters found in file!');
        logger.log('Expected parameters: ' + baseParamNames.join(', '));
        process.exit(1);
    }

    // ========== STAGE 2: Optimize MSPEQ coefficients ==========
    logger.log('\n═══════════════════════════════════════════════════════════════');
    logger.log('STAGE 2: MSPEQ Coefficient Optimization (base params frozen)');
    logger.log('═══════════════════════════════════════════════════════════════');

    const simulator = new HistoricalSimulator({
        lookbackDays: config.lookbackDays,
        tickIntervalMs: 5 * 1000,
        coinType: config.coinType,
        targetedMarket: config.targetedMarket,
        auditTradesCount: config.auditTradesCount,
    });

    // Get Stage 2 bounds and factory based on strategy type
    let stage2Bounds: ParameterBounds;
    let stage2StrategyName: string;
    let stage2Factory: (params: BotParams) => SimulatedBot;

    if (isMarketMakerMSPEQ) {
        stage2Bounds = config.isQuarterly
            ? quarterlyMarketMakerMSPEQOnlyBounds
            : marketMakerMSPEQOnlyBounds;
        stage2StrategyName = config.isQuarterly ? 'QuarterlyMarketMakerMSPEQ' : 'MarketMakerMSPEQ';
        stage2Factory = config.isQuarterly ? createQuarterlyMarketMakerMSPEQBot : createMarketMakerMSPEQBot;
        logger.log(`  Strategy Type: MarketMakerMSPEQ (6 MSPEQs, 90 parameters)`);
    } else if (isNCandleMSPEQ) {
        stage2Bounds = config.isQuarterly
            ? quarterlyNCandleMSPEQOnlyBounds
            : nCandleMSPEQOnlyBounds;
        stage2StrategyName = config.isQuarterly ? 'QuarterlyNCandleMSPEQ' : 'NCandleMSPEQ';
        stage2Factory = config.isQuarterly ? createQuarterlyNCandleMSPEQBot : createNCandleMSPEQBot;
        logger.log(`  Strategy Type: NCandleMSPEQ (5 MSPEQs, 75 parameters)`);
    } else if (isCrossPeriodMomentumMSPEQ) {
        stage2Bounds = config.isQuarterly
            ? quarterlyCrossPeriodMomentumMSPEQOnlyBounds
            : crossPeriodMomentumMSPEQOnlyBounds;
        stage2StrategyName = config.isQuarterly ? 'QuarterlyCrossPeriodMomentumMSPEQ' : 'CrossPeriodMomentumMSPEQ';
        stage2Factory = config.isQuarterly ? createQuarterlyCrossPeriodMomentumMSPEQBot : createCrossPeriodMomentumMSPEQBot;
        logger.log(`  Strategy Type: CrossPeriodMomentumMSPEQ (8 MSPEQs, 120 parameters)`);
    } else if (isEarlyBuyerMSPEQ) {
        stage2Bounds = config.isQuarterly
            ? quarterlyEarlyBuyerMSPEQOnlyBounds
            : earlyBuyerMSPEQOnlyBounds;
        stage2StrategyName = config.isQuarterly ? 'QuarterlyEarlyBuyerMSPEQ' : 'EarlyBuyerMSPEQ';
        stage2Factory = config.isQuarterly ? createQuarterlyEarlyBuyerMSPEQBot : createEarlyBuyerMSPEQBot;
        logger.log(`  Strategy Type: EarlyBuyerMSPEQ (6 MSPEQs, 90 parameters)`);
    } else {
        stage2Bounds = config.isQuarterly
            ? quarterlyFirstCandleMSPEQOnlyBounds
            : firstCandleMSPEQOnlyBounds;
        stage2StrategyName = config.isQuarterly ? 'QuarterlyFirstCandleMSPEQ' : 'FirstCandleMSPEQ';
        stage2Factory = config.isQuarterly ? createQuarterlyFirstCandleMSPEQBot : createFirstCandleMSPEQBot;
        logger.log(`  Strategy Type: FirstCandleMSPEQ (4 MSPEQs, 60 parameters)`);
    }

    // Create wrapper factory that merges frozen base params with MSPEQ params
    const stage2FactoryWithFrozenParams = (botParams: BotParams): SimulatedBot => {
        const mergedParams = {
            ...botParams,
            params: {
                ...frozenBaseParams,
                ...botParams.params,
            }
        };
        return stage2Factory(mergedParams);
    };

    const geneticConfig = {
        populationSize: config.populationSize,
        maxGenerations: config.maxGenerations,
        convergenceThreshold: config.convergenceThreshold,
        convergenceGenerations: 5,
        mutationRate: 0.25,
        mutationStrength: 0.3,
        eliteCount: 2,
        crossoverRate: 0.7,
        fitnessMode: config.fitnessMode ?? 'sortino',  // Risk-adjusted fitness
    };

    const paramCount = Object.keys(stage2Bounds).length;
    logger.log(`\nConfiguration:`);
    logger.log(`  Strategy: ${stage2StrategyName}`);
    logger.log(`  Population: ${geneticConfig.populationSize}`);
    logger.log(`  Max Generations: ${geneticConfig.maxGenerations}`);
    logger.log(`  Parameters: ${paramCount} (MSPEQ only)`);

    const result = await simulator.runGeneticOptimization(
        stage2StrategyName + '-Stage2Only',
        stage2FactoryWithFrozenParams,
        stage2Bounds,
        geneticConfig
    );

    const bestMSPEQParams = result.bestIndividual.params;
    const bestFitness = result.bestIndividual.fitness;

    // ========== RESULTS ==========
    logger.log('\n═══════════════════════════════════════════════════════════════');
    logger.log('STAGE 2 OPTIMIZATION COMPLETE');
    logger.log('═══════════════════════════════════════════════════════════════');

    logger.log(`\n${CYAN}Best Fitness${RESET}: ${colorPnl(bestFitness)}`);
    logger.log(`Generations: ${result.totalGenerations}`);
    logger.log(`Converged: ${result.converged} (${result.convergenceReason})`);

    // Combine all params for final output
    const finalParams = {
        ...frozenBaseParams,
        ...bestMSPEQParams,
    };

    logger.log(`\nFinal Combined Parameters:`);
    logger.log('--- Base Parameters (frozen from input) ---');
    for (const paramName of MSPEQ_BASE_PARAM_NAMES) {
        if (finalParams[paramName] !== undefined) {
            logger.log(`  ${paramName}: ${finalParams[paramName]}`);
        }
    }

    logger.log('\n--- MSPEQ Parameters (optimized) ---');
    for (const [key, value] of Object.entries(bestMSPEQParams)) {
        logger.log(`  ${key}: ${value}`);
    }

    // Save combined params to YAML
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const yamlOutput = {
        strategy: stage2StrategyName,
        market: config.isQuarterly ? 'btc-quarterly' : 'btc-hourly',
        coin: config.coinType,
        days: config.lookbackDays,
        stage2Only: {
            baseParamsFile: config.baseParamsFile,
            fitness: bestFitness,
        },
        params: finalParams,
    };

    const yamlPath = `./logs/simulator/stage2-${stage2StrategyName.toLowerCase()}-${timestamp}.yaml`;
    fs.writeFileSync(yamlPath, YAML.stringify(yamlOutput));
    logger.log(`\nParameters saved to: ${yamlPath}`);

    // Copy logs to audit directory if audit mode was used
    const auditLogDir = simulator.getLastAuditLogDir();
    if (auditLogDir) {
        logger.copyLogsToDirectory(auditLogDir);
        logger.log(`\nAll logs consolidated to: ${auditLogDir}`);
    }

    logger.log('\n✓ Stage 2 optimization complete\n');
    logger.log(`Results saved to: ${logger.getLogFilePath()}`);
}

// ============================================================================
// Main Entry Point
// ============================================================================

async function main() {
    // Parse command line arguments
    const args = process.argv.slice(2);
    let lookbackDays = 7;
    let maxGenerations = 50;
    let convergenceThreshold = 1.0;
    let populationSize = 15;
    let strategyFilter: string | null = null;
    let coinType: CoinType = CoinType.BTC;
    let twoStageMode = false;
    let baseParamsFile: string | null = null;
    let auditTradesCount = 0; // Number of top trades to audit (0 = disabled)
    let targetedMarket: TargetedMarket = TargetedMarket.BITCOIN_HOURLY;
    let yamlFilePath: string | null = null;
    // Iterative refinement options
    let iterativeMode = false;
    let maxOuterIterations = 5;
    let optimizerOverride: 'genetic' | 'bayesian' | 'cmaes' | null = null;
    let stage1Optimizer: 'genetic' | 'bayesian' | 'cmaes' = 'bayesian';
    let stage2Optimizer: 'genetic' | 'bayesian' | 'cmaes' = 'cmaes';
    // Fitness mode for risk-adjusted optimization
    let fitnessMode: 'pnl' | 'sharpe' | 'sortino' | 'calmar' = 'sortino';

    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case '--yaml':
            case '-y':
                yamlFilePath = args[i + 1] || null;
                break;
            case '--days':
            case '-d':
                lookbackDays = parseInt(args[i + 1]) || 7;
                break;
            case '--max-gen':
            case '-m':
                maxGenerations = parseInt(args[i + 1]) || 50;
                break;
            case '--threshold':
            case '-t':
                convergenceThreshold = parseFloat(args[i + 1]) || 1.0;
                break;
            case '--population':
            case '-p':
                populationSize = parseInt(args[i + 1]) || 15;
                break;
            case '--strategy':
            case '-s':
                strategyFilter = args[i + 1] || null;
                break;
            case '--coin':
            case '-c':
                {
                    const coinArg = (args[i + 1] || '').toLowerCase();
                    if (coinArg === 'btc') coinType = CoinType.BTC;
                    else if (coinArg === 'eth') coinType = CoinType.ETH;
                    else if (coinArg === 'sol') coinType = CoinType.SOL;
                    else if (coinArg === 'xrp') coinType = CoinType.XRP;
                    else {
                        console.error(`Invalid coin type: ${args[i + 1]}. Valid options: btc, eth, sol, xrp`);
                        process.exit(1);
                    }
                    break;
                }
            case '--audit-trades':
            case '-a':
                auditTradesCount = parseInt(args[i + 1]) || 10;
                break;
            case '--market':
            case '-M':
                {
                    const marketArg = (args[i + 1] || '').toLowerCase();
                    if (marketArg === 'btc-hourly' || marketArg === 'bitcoin-hourly') {
                        targetedMarket = TargetedMarket.BITCOIN_HOURLY;
                    } else if (marketArg === 'btc-quarterly' || marketArg === 'bitcoin-quarterly') {
                        targetedMarket = TargetedMarket.BITCOIN_QUARTERLY;
                    } else if (marketArg === 'eth-hourly' || marketArg === 'ethereum-hourly') {
                        targetedMarket = TargetedMarket.ETHEREUM_HOURLY;
                    } else if (marketArg === 'eth-quarterly' || marketArg === 'ethereum-quarterly') {
                        targetedMarket = TargetedMarket.ETHEREUM_QUARTERLY;
                    } else if (marketArg === 'sol-quarterly' || marketArg === 'solana-quarterly') {
                        targetedMarket = TargetedMarket.SOLANA_QUARTERLY;
                    } else if (marketArg === 'solana-hourly' || marketArg === 'sol-hourly') {
                        targetedMarket = TargetedMarket.SOLANA_HOURLY
                    } else if (marketArg === 'xrp-hourly') {
                        targetedMarket = TargetedMarket.XRP_HOURLY;
                    } else if (marketArg === 'xrp-quarterly') {
                        targetedMarket = TargetedMarket.XRP_QUARTERLY;
                    } else {
                        console.error(`Invalid market: ${args[i + 1]}. Valid options: btc-hourly, btc-quarterly, eth-hourly, eth-quarterly, sol-quarterly,  sol-hourly, xrp-hourly, xrp-quarterly`);
                        process.exit(1);
                    }
                    break;
                }
            case '--base-params':
            case '-b':
                baseParamsFile = args[i + 1] || null;
                break;
            case '--two-stage':
            case '-2':
                twoStageMode = true;
                break;
            case '--iterative':
            case '-i':
                iterativeMode = true;
                break;
            case '--max-iterations':
            case '-I':
                maxOuterIterations = parseInt(args[i + 1]) || 5;
                break;
            case '--optimizer':
            case '-O':
                {
                    const optArg = (args[i + 1] || '').toLowerCase();
                    if (optArg === 'genetic' || optArg === 'bayesian' || optArg === 'cmaes') {
                        optimizerOverride = optArg;
                    } else {
                        console.error(`Invalid optimizer: ${args[i + 1]}. Valid options: genetic, bayesian, cmaes`);
                        process.exit(1);
                    }
                    break;
                }
            case '--stage1-optimizer':
                {
                    const optArg = (args[i + 1] || '').toLowerCase();
                    if (optArg === 'genetic' || optArg === 'bayesian' || optArg === 'cmaes') {
                        stage1Optimizer = optArg;
                    } else {
                        console.error(`Invalid stage1 optimizer: ${args[i + 1]}. Valid options: genetic, bayesian, cmaes`);
                        process.exit(1);
                    }
                    break;
                }
            case '--stage2-optimizer':
                {
                    const optArg = (args[i + 1] || '').toLowerCase();
                    if (optArg === 'genetic' || optArg === 'bayesian' || optArg === 'cmaes') {
                        stage2Optimizer = optArg;
                    } else {
                        console.error(`Invalid stage2 optimizer: ${args[i + 1]}. Valid options: genetic, bayesian, cmaes`);
                        process.exit(1);
                    }
                    break;
                }
            case '--fitness':
            case '-f':
                {
                    const fitArg = (args[i + 1] || '').toLowerCase();
                    if (fitArg === 'pnl' || fitArg === 'sharpe' || fitArg === 'sortino' || fitArg === 'calmar') {
                        fitnessMode = fitArg;
                    } else {
                        console.error(`Invalid fitness mode: ${args[i + 1]}. Valid options: pnl, sharpe, sortino, calmar`);
                        process.exit(1);
                    }
                    break;
                }
            case '--help':
            case '-h':
                printHelp();
                process.exit(0);
        }
    }

    // Check for Stage 2 only mode (with user-supplied base params)
    if (baseParamsFile) {
        const isQuarterly = targetedMarket.includes('QUARTERLY') ||
            (strategyFilter?.toLowerCase().includes('quarterly') ?? false);

        await runStage2OnlyOptimization({
            lookbackDays,
            populationSize,
            maxGenerations,
            convergenceThreshold,
            coinType,
            targetedMarket,
            auditTradesCount,
            isQuarterly,
            baseParamsFile,
            strategyFilter: strategyFilter ?? undefined,
            fitnessMode,
        });
        return;
    }

    // Check for two-stage MSPEQ optimization mode
    if (twoStageMode) {
        const isQuarterly = targetedMarket.includes('QUARTERLY') ||
            (strategyFilter?.toLowerCase().includes('quarterly') ?? false);

        await runTwoStageOptimization({
            lookbackDays,
            populationSize,
            maxGenerations,
            convergenceThreshold,
            coinType,
            targetedMarket,
            auditTradesCount,
            isQuarterly,
            fitnessMode,
        });
        return;
    }

    // Check for iterative refinement mode
    if (iterativeMode) {
        const isQuarterly = targetedMarket.includes('QUARTERLY') ||
            (strategyFilter?.toLowerCase().includes('quarterly') ?? false);

        await runIterativeOptimization({
            lookbackDays,
            populationSize,
            maxGenerations,
            convergenceThreshold,
            coinType,
            targetedMarket,
            auditTradesCount,
            isQuarterly,
            maxOuterIterations,
            strategyFilter: strategyFilter ?? undefined,
            stage1Optimizer,
            stage2Optimizer,
            optimizerOverride: optimizerOverride ?? undefined,
            fitnessMode,
        });
        return;
    }

    // Check for YAML mode first
    if (yamlFilePath) {
        await runYamlSimulation(yamlFilePath);
        return;
    }

    // Create logger and simulator
    const logger = new SimulatorLogger(`genetic-${coinType}`);
    logger.log(`Log file: ${logger.getLogFilePath()}`);

    const simulator = new HistoricalSimulator({
        lookbackDays,
        tickIntervalMs: 5 * 1000,
        coinType,
        auditTradesCount,
        targetedMarket,
    });

    logger.log('');
    logger.log('╔════════════════════════════════════════════════════════════╗');
    logger.log('║      GENETIC ALGORITHM OPTIMIZATION - Historical Sim       ║');
    logger.log('╚════════════════════════════════════════════════════════════╝');

    const fitnessModeDescriptions: Record<string, string> = {
        pnl: 'Raw PnL',
        sharpe: 'Sharpe Ratio (risk-adjusted)',
        sortino: 'Sortino Ratio (downside risk-adjusted)',
        calmar: 'Calmar Ratio (return/drawdown)',
    };

    logger.log(`\nConfiguration:`);
    logger.log(`  Coin Type: ${coinType.toUpperCase()}`);
    logger.log(`  Lookback Days: ${lookbackDays}`);
    logger.log(`  Max Generations: ${maxGenerations}`);
    logger.log(`  Convergence Threshold: $${convergenceThreshold.toFixed(2)} (absolute fallback)`);
    logger.log(`  Relative Convergence: enabled (1% of best fitness, min $0.10)`);
    logger.log(`  Population Size: ${populationSize}`);
    logger.log(`  ${CYAN}Fitness Mode${RESET}: ${fitnessMode} - ${fitnessModeDescriptions[fitnessMode]}`);

    const geneticConfig = {
        populationSize,
        maxGenerations,
        convergenceThreshold,
        convergenceGenerations: 5,
        mutationRate: 0.25,
        mutationStrength: 0.3,
        eliteCount: 2,
        crossoverRate: 0.7,
        fitnessMode,  // Risk-adjusted fitness
    };

    // Filter strategies if specified
    let strategies = geneticStrategies;
    if (strategyFilter) {
        strategies = geneticStrategies.filter(s =>
            s.name.toLowerCase() == strategyFilter!.toLowerCase()
        );
        if (strategies.length === 0) {
            logger.error(`\nNo strategies matching '${strategyFilter}' found.`);
            logger.log('Available strategies: ' + geneticStrategies.map(s => s.name).join(', '));
            process.exit(1);
        }
        logger.log(`  Strategy Filter: ${strategyFilter} (${strategies.length} matched)`);
    }

    try {
        await simulator.runMultiStrategyGeneticOptimization(strategies, geneticConfig);
    } catch (error) {
        logger.error(`\nGenetic optimization failed: ${error}`);
        process.exit(1);
    }

    // Copy genetic log to audit directory if audit mode was used
    const auditLogDir = simulator.getLastAuditLogDir();
    if (auditLogDir) {
        logger.copyLogsToDirectory(auditLogDir);
        logger.log(`\nAll logs consolidated to: ${auditLogDir}`);
    }

    logger.log('\n✓ Simulation complete\n');
    logger.log(`Results saved to: ${logger.getLogFilePath()}`);
}

function printHelp(): void {
    console.log(`
Historical Simulation & Genetic Optimization

Usage: npm run histSim -- [options]

Options:
  -y, --yaml <file>     Run custom parameter simulation from YAML file
  -d, --days <n>        Lookback days for simulation (default: 7)
  -c, --coin <type>     Coin type to simulate: btc, eth, sol, xrp (default: btc)
  -M, --market <type>   Target market: btc-hourly, btc-quarterly, eth-hourly, eth-quarterly (default: btc-hourly)
  -g, --genetic         Use genetic algorithm optimization instead of parameter sweep
  -m, --max-gen <n>     Maximum generations for genetic optimization (default: 50)
  -t, --threshold <n>   Convergence threshold - stop if improvement < n (default: 1.0)
  -p, --population <n>  Population size per generation (default: 15)
  -s, --strategy <name> Only optimize specific strategy (e.g., "FirstCandle", "QuarterlyFirstCandle")
  -a, --audit-trades <n> Write top N and avg trades with parameters to audit file (default: 10 when enabled)
  -2, --two-stage       Two-stage MSPEQ optimization: Stage 1 optimizes base params with FirstCandle,
                        Stage 2 freezes base params and optimizes MSPEQ coefficients (much faster)
  -b, --base-params <file> Stage 2 only: Load base params from YAML file and optimize only MSPEQ coefficients
  -h, --help            Show this help message

Iterative Refinement Options (Hybrid Optimization):
  -i, --iterative       Enable iterative refinement mode (alternates Stage 1 & 2 until convergence)
  -I, --max-iterations <n> Max outer iterations for iterative refinement (default: 5)
  -O, --optimizer <type> Override optimizer for single-stage: genetic, bayesian, cmaes
  --stage1-optimizer <type> Optimizer for Stage 1 base params (default: bayesian)
  --stage2-optimizer <type> Optimizer for Stage 2 MSPEQ coeffs (default: cmaes)

Risk-Adjusted Fitness Options:
  -f, --fitness <mode>  Fitness mode for optimization (default: sortino)
                        - pnl:     Raw total PnL (can overfit to lucky volatile strategies)
                        - sharpe:  Risk-adjusted (penalizes all volatility)
                        - sortino: Risk-adjusted (only penalizes downside) - RECOMMENDED
                        - calmar:  Return/drawdown ratio (avoids large drawdowns)

Available Strategies:
  Hourly Markets (60-min periods):
    Contrarian, TrendFollowing, FirstCandle, FirstCandleV2,
    EveningStar, MorningStar, MeanReversion, EarlyBuyerV2,
    EsotericNormalization, MarketMaker, FirstCandleMSPEQ, EarlyBuyerMSPEQ,
    CrossPeriodMomentumMSPEQ

  Quarterly Markets (15-min periods):
    QuarterlyFirstCandle, QuarterlyMeanReversion, QuarterlyTrendFollowing,
    QuarterlyEarlyBuyerV2, QuarterlyEsotericNormalization, QuarterlyMarketMaker,
    QuarterlyFirstCandleMSPEQ, QuarterlyEarlyBuyerMSPEQ, QuarterlyCrossPeriodMomentumMSPEQ

YAML File Format:
  strategy: QuarterlyTrendFollowing
  market: btc-quarterly
  coin: btc
  days: 4
  params:
    shortMaPeriod: 3
    longMaPeriod: 10
    ...

Examples:
  npm run histSim -- --days 14
  npm run histSim -- --coin eth --days 7
  npm run histSim -- --genetic --days 7 --max-gen 30
  npm run histSim -- -g -c sol -d 14 -m 100 -t 0.5 -p 20
  npm run histSim -- -g -s FirstCandle --max-gen 50
  npm run histSim -- -g -s QuarterlyFirstCandle --max-gen 30
  npm run histSim -- -y params.yaml

Two-Stage MSPEQ Optimization:
  npm run histSim -- --two-stage -p 100 -m 50 -c btc
  npm run histSim -- -2 -M btc-quarterly -p 75 -m 40 -c btc

Stage 2 Only (with pre-optimized base params):
  npm run histSim -- --base-params ./logs/simulator/firstcandle-params.yaml -p 150 -m 75
  npm run histSim -- -b base-params.yaml -M btc-quarterly -p 100 -m 50

Iterative Refinement (Hybrid Optimization):
  npm run histSim -- -i -I 5 -s FirstCandleMSPEQ -M btc-hourly -d 7 -p 30 -m 20
  npm run histSim -- -i -s CrossPeriodMomentumMSPEQ --stage1-optimizer bayesian --stage2-optimizer cmaes

Single-Stage with Override Optimizer:
  npm run histSim -- -i -O cmaes -s FirstCandleMSPEQ -d 7 -p 50 -m 100
  npm run histSim -- -i -O bayesian -s EarlyBuyerMSPEQ -d 14 -p 20 -m 50
`);
}

// Only run main when this file is the entry point (not when imported as a module)
const currentFile = import.meta.url;
const entryPoint = `file:///${process.argv[1].replace(/\\/g, '/')}`;
if (currentFile === entryPoint) {
    main();
}
