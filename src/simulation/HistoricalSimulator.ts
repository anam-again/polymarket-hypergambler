import { Side } from '@polymarket/clob-client';
import { SimulationClock } from './SimulationClock.js';
import { MockCDMarketData } from './MockCDMarketData.js';
import { MockMarketInfo } from './MockMarketInfo.js';
import { GeneticOptimizer, GeneticConfig, ParameterBounds, OptimizationResult, CoinType } from './GeneticOptimizer.js';
import { SimulatorLogger } from './SimulatorLogger.js';
import { TargetedMarket } from '../types/interfaces.js';

// Re-export CoinType and TargetedMarket for convenience
export { CoinType } from './GeneticOptimizer.js';
export { TargetedMarket } from '../types/interfaces.js';

// ============================================================================
// Types & Interfaces
// ============================================================================

export interface SimulationConfig {
    lookbackDays: number;
    tickIntervalMs?: number;  // Virtual time increment (default: 60000 = 1 minute)
    coinType?: CoinType;      // Coin type to simulate (default: BTC)
    auditTradesCount?: number; // Number of top trades to write to audit (0 = disabled)
    targetedMarket?: TargetedMarket; // Market to simulate (default: BITCOIN_HOURLY)
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
    targetedMarket: TargetedMarket;
    shouldWriteLogs?: boolean;   // Optional - defaults to false for simulation
    logDirectory?: string;       // Optional - custom log directory for audit runs
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
    private lastAuditLogDir: string | null = null;

    constructor(config: SimulationConfig) {
        this.config = {
            ...config,
            tickIntervalMs: config.tickIntervalMs ?? 60 * 1000,
            coinType: config.coinType ?? CoinType.BTC,
            auditTradesCount: config.auditTradesCount ?? 0,
            targetedMarket: config.targetedMarket ?? TargetedMarket.BITCOIN_HOURLY,
        };
        this.logger = new SimulatorLogger(`sim-${this.config.coinType}`);
    }

    /**
     * Gets the last audit log directory path, if audit mode was used.
     * Returns null if no audit has been run yet.
     */
    public getLastAuditLogDir(): string | null {
        return this.lastAuditLogDir;
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

        // Initialize status bar
        this.logger.initStatusBar();

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

        // Track top N performers for audit logging (stores {params, fitness})
        const auditCount = this.config.auditTradesCount ?? 0;
        const topPerformers: Array<{ params: Record<string, number>; fitness: number }> = [];

        // Evolution loop
        while (true) {
            const generation = optimizer.getGeneration();
            this.logger.log(`\n--- Generation ${generation} ---`);

            // Run simulations for all individuals in population
            const results: SimulationResult[] = [];
            const tradesPerIndividual: SimulatedTrade[][] = [];

            // Track running totals for average calculation
            let runningPnlSum = 0;

            for (let i = 0; i < paramSets.length; i++) {
                const params = paramSets[i];

                // Update status bar
                const currentAvg = i > 0 ? runningPnlSum / i : 0;
                this.logger.updateSimulationStatus(
                    generation,
                    i + 1,
                    paramSets.length,
                    bestFitness === -Infinity ? 0 : bestFitness,
                    currentAvg
                );

                const { result, trades } = await this.runSingleBotSimulationWithTrades(botName, botFactory, params);
                results.push(result);
                tradesPerIndividual.push(trades);

                // Update running sum for average
                runningPnlSum += result.totalPnl;

                // Track best performer for audit
                if (result.totalPnl > bestFitness) {
                    bestFitness = result.totalPnl;
                    bestTrades = trades;
                }

                // Track top N performers for re-run with logging
                if (auditCount > 0) {
                    topPerformers.push({ params: { ...params }, fitness: result.totalPnl });
                    topPerformers.sort((a, b) => b.fitness - a.fitness);
                    if (topPerformers.length > auditCount) {
                        topPerformers.pop();
                    }
                }
            }

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

        // Write top trades and average stats if enabled
        const bestParams = optimizer.getResult().bestIndividual.params;
        if (auditCount > 0) {
            this.logger.writeTopTradesWithParams(bestTrades, bestParams, auditCount);
            this.logger.writeAverageTradeStats(bestTrades, bestParams);

            // Re-run top N performers with logging enabled
            this.logger.log(`\n${'='.repeat(60)}`);
            this.logger.log(`Re-running top ${topPerformers.length} performers with logging...`);
            this.logger.log(`${'='.repeat(60)}`);

            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            const auditLogDir = `./logs/simulator/audit/${botName.toLowerCase()}-${timestamp}`;

            for (let rank = 0; rank < topPerformers.length; rank++) {
                const performer = topPerformers[rank];
                const logDirectory = `${auditLogDir}/run${rank + 1}`;

                this.logger.log(`\n[${rank + 1}/${topPerformers.length}] Re-running with PnL=$${performer.fitness.toFixed(2)}...`);
                this.logger.log(`  Parameters:`);
                for (const [key, value] of Object.entries(performer.params)) {
                    this.logger.log(`    ${key}: ${value.toFixed(4)}`);
                }
                this.logger.log(`  Log directory: ${logDirectory}`);

                const { result, trades } = await this.runSingleBotSimulationWithTrades(
                    `run${rank + 1}-${botName}`,
                    botFactory,
                    performer.params,
                    { shouldWriteLogs: true, logDirectory }
                );

                // Write trade audit in production format
                this.logger.writeSimulatedTradeAudits(`run${rank + 1}-${botName}`, trades, logDirectory);

                this.logger.log(`  Logs written for run ${rank + 1}`);
            }

            // Copy sim-... and strategy audit logs to the audit directory
            this.logger.copyLogsToDirectory(auditLogDir);
            this.lastAuditLogDir = auditLogDir;

            this.logger.log(`\nAudit logs written to: ${auditLogDir}`);
        }
        this.logger.log(`\nTrade audit written to: ${auditPath}`);

        // Clean up status bar
        this.logger.clearStatusBar();

        return optimizer.getResult();
    }

    /**
     * Public method to run a single bot simulation with specified parameters.
     * Used by YAML-based custom parameter simulation.
     */
    public async runSingleSimulation(
        botName: string,
        botFactory: (params: BotParams) => SimulatedBot,
        params: Record<string, number>,
        options?: { shouldWriteLogs?: boolean; logDirectory?: string }
    ): Promise<{ result: SimulationResult; trades: SimulatedTrade[] }> {
        return this.runSingleBotSimulationWithTrades(botName, botFactory, params, options);
    }

    /**
     * Runs a single bot simulation and returns both results and trades.
     */
    private async runSingleBotSimulationWithTrades(
        botName: string,
        botFactory: (params: BotParams) => SimulatedBot,
        params: Record<string, number>,
        options?: { shouldWriteLogs?: boolean; logDirectory?: string }
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
            targetedMarket: this.config.targetedMarket!,
            shouldWriteLogs: options?.shouldWriteLogs ?? false,
            logDirectory: options?.logDirectory,
        });

        // Register period change handler based on market type
        const isQuarterly = this.config.targetedMarket?.toString().includes('Quarterly');
        if (isQuarterly) {
            // For quarterly markets, reset every 15 minutes
            this.clock.on('quarterly', async () => {
                await bot.onHourChange();
            });
        } else {
            // For hourly markets, reset every hour
            this.clock.on('hourly', async () => {
                await bot.onHourChange();
            });
        }

        // Run the simulation
        while (!this.clock.isComplete()) {
            try {
                await bot.onTick();
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                if (errorMessage.includes('No data available for current 15-minute period')) {
                    // Log warning but continue - data gap at period boundary
                    // This can happen at the start of a new 15-minute period before data is logged
                    // Silently skip this tick to avoid spamming logs
                } else {
                    throw error; // Re-throw other errors
                }
            }
            await this.clock.tick();  // Now properly awaits period change handlers
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
