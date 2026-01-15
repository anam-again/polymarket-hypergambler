import { Side } from '@polymarket/clob-client';
import { SimulationClock } from './SimulationClock.js';
import { MockCDMarketData } from './MockCDMarketData.js';
import { MockMarketInfo } from './MockMarketInfo.js';
import { analyzeWithRegression, LinearRegression, RegressionResult } from './LinearRegression.js';
import { GeneticOptimizer, GeneticConfig, ParameterBounds, OptimizationResult, CoinType } from './GeneticOptimizer.js';
import { SimulatorLogger } from './SimulatorLogger.js';

// Re-export CoinType for convenience
export { CoinType } from './GeneticOptimizer.js';

// ============================================================================
// Types & Interfaces
// ============================================================================

export interface SimulationConfig {
    lookbackDays: number;
    tickIntervalMs?: number;  // Virtual time increment (default: 60000 = 1 minute)
    coinType?: CoinType;      // Coin type to simulate (default: BTC)
}

export interface BotConfig {
    name: string;
    factory: (params: BotParams) => SimulatedBot;
    parameterSets: Record<string, unknown>[];
}

export interface BotParams {
    name: string;
    clock: SimulationClock;
    marketInfo: MockMarketInfo;
    cdMarketData: MockCDMarketData;
    params: Record<string, unknown>;
}

export interface SimulatedBot {
    name: string;
    onTick: () => Promise<void>;
    onHourChange: () => Promise<void>;
    getTrades: () => SimulatedTrade[];
    reset: () => void;
}

export interface SimulatedTrade {
    timestamp: number;
    botName: string;
    side: Side;
    tokenId: string;
    price: number;
    amount: number;
    status: 'PENDING' | 'MATCHED' | 'EXPIRED' | 'CANCELED';
    pnl?: number;
}

export interface SimulationResult {
    botName: string;
    params: Record<string, unknown>;
    totalTrades: number;
    matchedTrades: number;
    expiredTrades: number;
    totalPnl: number;
    winRate: number;
    avgPnl: number;
    maxDrawdown: number;
    sharpeRatio: number;
}

// ============================================================================
// HistoricalSimulator Class
// ============================================================================

export class HistoricalSimulator {
    private config: SimulationConfig;
    private clock!: SimulationClock;
    private marketInfo!: MockMarketInfo;
    private cdMarketData!: MockCDMarketData;
    private logger: SimulatorLogger;

    constructor(config: SimulationConfig) {
        this.config = {
            ...config,
            tickIntervalMs: config.tickIntervalMs ?? 60 * 1000,
            coinType: config.coinType ?? CoinType.BTC,
        };
        this.logger = new SimulatorLogger(`sim-${this.config.coinType}`);
    }

    // -------------------------------------------------------------------------
    // Main Entry Point
    // -------------------------------------------------------------------------

    /**
     * Runs the simulation with multiple bot configurations (parameter sweep).
     */
    public async runParameterSweep(botConfigs: BotConfig[]): Promise<SimulationResult[]> {
        const allResults: SimulationResult[] = [];

        for (const botConfig of botConfigs) {
            this.logger.log(`\n${'='.repeat(60)}`);
            this.logger.log(`Running parameter sweep for: ${botConfig.name}`);
            this.logger.log(`${'='.repeat(60)}`);

            for (let i = 0; i < botConfig.parameterSets.length; i++) {
                const params = botConfig.parameterSets[i];
                this.logger.log(`\n[${i + 1}/${botConfig.parameterSets.length}] Testing parameters: ${JSON.stringify(params)}`);

                const result = await this.runSingleSimulation(botConfig, params);
                allResults.push(result);

                this.printResult(result);
            }
        }

        return allResults;
    }

    /**
     * Runs a single simulation with specific parameters.
     */
    private async runSingleSimulation(
        botConfig: BotConfig,
        params: Record<string, unknown>
    ): Promise<SimulationResult> {
        // Initialize simulation components
        this.initializeSimulation();

        // Create the bot
        const bot = botConfig.factory({
            name: botConfig.name,
            clock: this.clock,
            marketInfo: this.marketInfo,
            cdMarketData: this.cdMarketData,
            params,
        });

        // Register hour change handler
        this.clock.on('hourly', async () => {
            await bot.onHourChange();
        });

        // Run the simulation
        let tickCount = 0;
        const startTime = Date.now();

        while (!this.clock.isComplete()) {
            await bot.onTick();
            this.clock.tick();
            tickCount++;

            // Progress update every 1000 ticks
            if (tickCount % 1000 === 0) {
                const progress = this.clock.getProgress().toFixed(1);
                this.logger.progress(`  Progress: ${progress}%`);
            }
        }

        const elapsedMs = Date.now() - startTime;
        this.logger.clearProgress();
        this.logger.log(`  Completed ${tickCount} ticks in ${(elapsedMs / 1000).toFixed(2)}s`);

        // Calculate results
        const trades = bot.getTrades();
        const result = this.calculateResults(botConfig.name, params, trades);

        // Write trade audits
        this.logger.createAuditFile(botConfig.name);
        this.logger.writeSimulatedTradeAudits(botConfig.name, trades);

        // Cleanup
        this.clock.clearListeners();

        return result;
    }

    // -------------------------------------------------------------------------
    // Initialization
    // -------------------------------------------------------------------------

    private initializeSimulation(): void {
        // Calculate time range
        const endTime = Date.now();
        const startTime = endTime - (this.config.lookbackDays * 24 * 60 * 60 * 1000);
        const coinType = this.config.coinType!;

        // Create components
        this.clock = new SimulationClock(startTime, endTime, this.config.tickIntervalMs);
        this.marketInfo = new MockMarketInfo(this.clock, coinType);
        this.cdMarketData = new MockCDMarketData(this.clock, coinType);

        // Validate data availability
        const marketDataRange = this.marketInfo.getDataRange();
        const btcDataRange = this.cdMarketData.getDataRange();

        if (!marketDataRange || !btcDataRange) {
            throw new Error(`No historical data available for ${coinType.toUpperCase()}. Please ensure log files exist.`);
        }

        const timeRange = this.clock.getTimeRange();
        this.logger.log(`\n  Simulation period: ${timeRange.start.toISOString()} to ${timeRange.end.toISOString()}`);
        this.logger.log(`  Coin type: ${coinType.toUpperCase()}`);
        this.logger.log(`  Duration: ${timeRange.durationDays.toFixed(1)} days`);
    }

    // -------------------------------------------------------------------------
    // Results Calculation
    // -------------------------------------------------------------------------

    private calculateResults(
        botName: string,
        params: Record<string, unknown>,
        trades: SimulatedTrade[]
    ): SimulationResult {
        const matchedTrades = trades.filter(t => t.status === 'MATCHED');
        const expiredTrades = trades.filter(t => t.status === 'EXPIRED');
        const completedTrades = [...matchedTrades, ...expiredTrades];

        const pnls = completedTrades.map(t => t.pnl ?? 0);
        const totalPnl = pnls.reduce((sum, pnl) => sum + pnl, 0);
        const winningTrades = pnls.filter(pnl => pnl > 0);

        // Calculate max drawdown
        let peak = 0;
        let maxDrawdown = 0;
        let cumulative = 0;
        for (const pnl of pnls) {
            cumulative += pnl;
            peak = Math.max(peak, cumulative);
            maxDrawdown = Math.min(maxDrawdown, cumulative - peak);
        }

        // Calculate Sharpe ratio (simplified, assuming risk-free rate = 0)
        const avgReturn = pnls.length > 0 ? totalPnl / pnls.length : 0;
        const variance = pnls.length > 1
            ? pnls.reduce((sum, pnl) => sum + Math.pow(pnl - avgReturn, 2), 0) / (pnls.length - 1)
            : 0;
        const stdDev = Math.sqrt(variance);
        const sharpeRatio = stdDev > 0 ? avgReturn / stdDev : 0;

        return {
            botName,
            params,
            totalTrades: trades.length,
            matchedTrades: matchedTrades.length,
            expiredTrades: expiredTrades.length,
            totalPnl,
            winRate: completedTrades.length > 0 ? (winningTrades.length / completedTrades.length) * 100 : 0,
            avgPnl: completedTrades.length > 0 ? totalPnl / completedTrades.length : 0,
            maxDrawdown,
            sharpeRatio,
        };
    }

    // -------------------------------------------------------------------------
    // Output
    // -------------------------------------------------------------------------

    private printResult(result: SimulationResult): void {
        this.logger.log(`\n  Results:`);
        this.logger.log(`    Total Trades:   ${result.totalTrades}`);
        this.logger.log(`    Matched:        ${result.matchedTrades}`);
        this.logger.log(`    Expired:        ${result.expiredTrades}`);
        this.logger.log(`    Total PnL:      $${result.totalPnl.toFixed(2)}`);
        this.logger.log(`    Win Rate:       ${result.winRate.toFixed(1)}%`);
        this.logger.log(`    Avg PnL:        $${result.avgPnl.toFixed(2)}`);
        this.logger.log(`    Max Drawdown:   $${result.maxDrawdown.toFixed(2)}`);
        this.logger.log(`    Sharpe Ratio:   ${result.sharpeRatio.toFixed(3)}`);
    }

    public printSummary(results: SimulationResult[]): void {
        this.logger.log(`\n${'='.repeat(60)}`);
        this.logger.log('SIMULATION SUMMARY');
        this.logger.log(`${'='.repeat(60)}`);

        // Sort by total PnL
        const sorted = [...results].sort((a, b) => b.totalPnl - a.totalPnl);

        this.logger.log('\nTop Performers (by Total PnL):');
        this.logger.log('-'.repeat(60));

        for (let i = 0; i < Math.min(10, sorted.length); i++) {
            const r = sorted[i];
            this.logger.log(`${i + 1}. ${r.botName}`);
            this.logger.log(`   Params: ${JSON.stringify(r.params)}`);
            this.logger.log(`   PnL: $${r.totalPnl.toFixed(2)} | Win Rate: ${r.winRate.toFixed(1)}% | Sharpe: ${r.sharpeRatio.toFixed(3)}`);
        }

        // Best by different metrics
        this.logger.log('\n' + '-'.repeat(60));
        this.logger.log('Best by Metric:');

        const bestWinRate = sorted.reduce((best, r) => r.winRate > best.winRate ? r : best);
        this.logger.log(`  Highest Win Rate: ${bestWinRate.botName} (${bestWinRate.winRate.toFixed(1)}%)`);

        const bestSharpe = sorted.reduce((best, r) => r.sharpeRatio > best.sharpeRatio ? r : best);
        this.logger.log(`  Highest Sharpe:   ${bestSharpe.botName} (${bestSharpe.sharpeRatio.toFixed(3)})`);

        const lowestDrawdown = sorted.reduce((best, r) => r.maxDrawdown > best.maxDrawdown ? r : best);
        this.logger.log(`  Lowest Drawdown:  ${lowestDrawdown.botName} ($${lowestDrawdown.maxDrawdown.toFixed(2)})`);

        // Run regression analysis per bot strategy
        this.printRegressionAnalysis(results);
    }

    // -------------------------------------------------------------------------
    // Regression Analysis
    // -------------------------------------------------------------------------

    private printRegressionAnalysis(results: SimulationResult[]): void {
        this.logger.log(`\n${'='.repeat(60)}`);
        this.logger.log('LINEAR REGRESSION ANALYSIS');
        this.logger.log(`${'='.repeat(60)}`);

        // Group results by bot name
        const botGroups = new Map<string, SimulationResult[]>();
        for (const result of results) {
            const group = botGroups.get(result.botName) ?? [];
            group.push(result);
            botGroups.set(result.botName, group);
        }

        // Run regression for each bot
        for (const [botName, botResults] of botGroups) {
            this.logger.log(`\n${'-'.repeat(60)}`);
            this.logger.log(`Strategy: ${botName}`);
            this.logger.log(`${'-'.repeat(60)}`);

            if (botResults.length < 3) {
                this.logger.log('  Insufficient data points for regression (need at least 3)');
                continue;
            }

            const regressionResult = analyzeWithRegression(botResults);

            if (!regressionResult) {
                this.logger.log('  Regression analysis failed');
                continue;
            }

            this.printRegressionResult(regressionResult);
        }

        // Overall regression across all results
        if (results.length >= 3) {
            this.logger.log(`\n${'='.repeat(60)}`);
            this.logger.log('OVERALL REGRESSION (All Strategies Combined)');
            this.logger.log(`${'='.repeat(60)}`);

            const overallRegression = analyzeWithRegression(results);
            if (overallRegression) {
                this.printRegressionResult(overallRegression);
            }
        }
    }

    private printRegressionResult(result: RegressionResult): void {
        this.logger.log(`\n  Model Quality:`);
        this.logger.log(`    R-squared: ${(result.rSquared * 100).toFixed(2)}% (variance explained)`);

        this.logger.log(`\n  Parameter Coefficients (impact on PnL):`);
        const coefficients = Array.from(result.coefficients.entries())
            .filter(([key]) => key !== 'intercept')
            .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));

        for (const [param, coef] of coefficients) {
            const direction = coef >= 0 ? '+' : '';
            const impact = Math.abs(coef) > 1 ? 'HIGH' : Math.abs(coef) > 0.1 ? 'MEDIUM' : 'LOW';
            this.logger.log(`    ${param}: ${direction}${coef.toFixed(4)} [${impact}]`);
        }

        this.logger.log(`\n  Optimal Parameters (predicted by regression):`);
        for (const [param, value] of Object.entries(result.optimalParams)) {
            this.logger.log(`    ${param}: ${typeof value === 'number' ? value.toFixed(4) : value}`);
        }
        this.logger.log(`\n  Predicted Optimal PnL: $${result.predictedOptimalPnl.toFixed(2)}`);

        // Interpretation guidance
        this.logger.log(`\n  Interpretation:`);
        const sortedCoefs = coefficients.slice(0, 3);
        for (const [param, coef] of sortedCoefs) {
            if (coef > 0) {
                this.logger.log(`    - Increasing '${param}' tends to INCREASE PnL`);
            } else {
                this.logger.log(`    - Increasing '${param}' tends to DECREASE PnL`);
            }
        }
    }

    // -------------------------------------------------------------------------
    // Genetic Algorithm Optimization
    // -------------------------------------------------------------------------

    /**
     * Runs genetic algorithm optimization for a single bot strategy.
     * Evolves parameters until convergence or max generations.
     */
    public async runGeneticOptimization(
        botName: string,
        botFactory: (params: BotParams) => SimulatedBot,
        bounds: ParameterBounds,
        geneticConfig?: Partial<GeneticConfig>
    ): Promise<OptimizationResult> {
        this.logger.log(`\n${'='.repeat(60)}`);
        this.logger.log(`GENETIC OPTIMIZATION: ${botName}`);
        this.logger.log(`Coin: ${this.config.coinType!.toUpperCase()}`);
        this.logger.log(`${'='.repeat(60)}`);

        const optimizer = new GeneticOptimizer(geneticConfig ?? {}, bounds, this.logger);

        // Initialize first generation
        let paramSets = optimizer.initializePopulation();
        this.logger.log(`\nInitialized population of ${paramSets.length} individuals`);
        this.logger.log(`Parameter bounds:`);
        for (const [key, bound] of Object.entries(bounds)) {
            this.logger.log(`  ${key}: [${bound.min}, ${bound.max}]${bound.step ? ` step=${bound.step}` : ''}`);
        }

        // Track best trades for audit file
        let bestTrades: SimulatedTrade[] = [];
        let bestFitness = -Infinity;

        // Evolution loop
        while (true) {
            const generation = optimizer.getGeneration();
            this.logger.log(`\n--- Generation ${generation} ---`);

            // Run simulations for all individuals in population
            const results: SimulationResult[] = [];
            const tradesPerIndividual: SimulatedTrade[][] = [];

            for (let i = 0; i < paramSets.length; i++) {
                const params = paramSets[i];
                this.logger.progress(`  Evaluating individual ${i + 1}/${paramSets.length}...`);

                const { result, trades } = await this.runSingleBotSimulationWithTrades(botName, botFactory, params);
                results.push(result);
                tradesPerIndividual.push(trades);

                // Track best performer for audit
                if (result.totalPnl > bestFitness) {
                    bestFitness = result.totalPnl;
                    bestTrades = trades;
                }
            }
            this.logger.clearProgress(50);

            // Update fitness scores
            optimizer.updateFitness(results);

            // Check stopping criteria
            const stopCheck = optimizer.shouldStop();
            if (stopCheck.stop) {
                this.logger.log(`\nStopping: ${stopCheck.reason}`);
                break;
            }

            // Evolve to next generation
            paramSets = optimizer.evolve();
        }

        // Print summary
        optimizer.printSummary();

        // Write trade audit file for the best individual
        const auditPath = this.logger.createAuditFile(botName, optimizer.getGeneration());
        this.logger.writeSimulatedTradeAudits(botName, bestTrades);
        this.logger.log(`\nTrade audit written to: ${auditPath}`);

        return optimizer.getResult();
    }

    /**
     * Runs a single bot simulation with specific parameters.
     */
    private async runSingleBotSimulation(
        botName: string,
        botFactory: (params: BotParams) => SimulatedBot,
        params: Record<string, number>
    ): Promise<SimulationResult> {
        const { result } = await this.runSingleBotSimulationWithTrades(botName, botFactory, params);
        return result;
    }

    /**
     * Runs a single bot simulation and returns both results and trades.
     */
    private async runSingleBotSimulationWithTrades(
        botName: string,
        botFactory: (params: BotParams) => SimulatedBot,
        params: Record<string, number>
    ): Promise<{ result: SimulationResult; trades: SimulatedTrade[] }> {
        // Initialize fresh simulation components
        this.initializeSimulationQuiet();

        // Create the bot
        const bot = botFactory({
            name: botName,
            clock: this.clock,
            marketInfo: this.marketInfo,
            cdMarketData: this.cdMarketData,
            params,
        });

        // Register hour change handler
        this.clock.on('hourly', async () => {
            await bot.onHourChange();
        });

        // Run the simulation
        while (!this.clock.isComplete()) {
            await bot.onTick();
            this.clock.tick();
        }

        // Calculate results
        const trades = bot.getTrades();
        const result = this.calculateResults(botName, params, trades);

        // Cleanup
        this.clock.clearListeners();

        return { result, trades: [...trades] };
    }

    /**
     * Initializes simulation without verbose output.
     */
    private initializeSimulationQuiet(): void {
        const endTime = Date.now();
        const startTime = endTime - (this.config.lookbackDays * 24 * 60 * 60 * 1000);
        const coinType = this.config.coinType!;

        this.clock = new SimulationClock(startTime, endTime, this.config.tickIntervalMs);
        this.marketInfo = new MockMarketInfo(this.clock, coinType);
        this.cdMarketData = new MockCDMarketData(this.clock, coinType);
    }

    /**
     * Runs genetic optimization for multiple bot strategies.
     */
    public async runMultiStrategyGeneticOptimization(
        strategies: Array<{
            name: string;
            factory: (params: BotParams) => SimulatedBot;
            bounds: ParameterBounds;
        }>,
        geneticConfig?: Partial<GeneticConfig>
    ): Promise<Map<string, OptimizationResult>> {
        const results = new Map<string, OptimizationResult>();

        for (const strategy of strategies) {
            const result = await this.runGeneticOptimization(
                strategy.name,
                strategy.factory,
                strategy.bounds,
                geneticConfig
            );
            results.set(strategy.name, result);
        }

        // Print comparison
        this.printGeneticComparisonSummary(results);

        return results;
    }

    /**
     * Prints comparison of genetic optimization results across strategies.
     */
    private printGeneticComparisonSummary(results: Map<string, OptimizationResult>): void {
        this.logger.log(`\n${'='.repeat(60)}`);
        this.logger.log('GENETIC OPTIMIZATION COMPARISON');
        this.logger.log(`${'='.repeat(60)}`);

        const sortedResults = Array.from(results.entries())
            .sort((a, b) => b[1].bestIndividual.fitness - a[1].bestIndividual.fitness);

        this.logger.log('\nStrategies Ranked by Best PnL:');
        this.logger.log('-'.repeat(60));

        for (let i = 0; i < sortedResults.length; i++) {
            const [name, result] = sortedResults[i];
            this.logger.log(`\n${i + 1}. ${name}`);
            this.logger.log(`   Best PnL: $${result.bestIndividual.fitness.toFixed(2)}`);
            this.logger.log(`   Generations: ${result.totalGenerations}`);
            this.logger.log(`   Optimized Parameters:`);

            for (const [key, value] of Object.entries(result.bestIndividual.params)) {
                this.logger.log(`     ${key}: ${value.toFixed(4)}`);
            }
        }
    }
}
