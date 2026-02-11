import { Side } from '@polymarket/clob-client';
import { SimulationClock } from './SimulationClock.js';
import { MockCDMarketData } from './MockCDMarketData.js';
import { MockMarketInfo } from './MockMarketInfo.js';
import { GeneticOptimizer, GeneticConfig, ParameterBounds, OptimizationResult, CoinType, ValidationResult, StabilityResult } from './GeneticOptimizer.js';
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
    coinType: CoinType;       // Coin type to simulate
    auditTradesCount?: number; // Number of top trades to write to audit (0 = disabled)
    targetedMarket: TargetedMarket; // Market to simulate
    // Anti-overfitting validation settings
    validationConfig?: ValidationConfig;
}

export interface ValidationConfig {
    // Walk-forward validation
    enableWalkForward: boolean;     // Enable walk-forward validation (default: true)
    trainRatio: number;             // Ratio of data for training (default: 0.7)

    // Cross-period validation
    enableCrossPeriod: boolean;     // Enable cross-period validation (default: true)
    numCrossPeriods: number;        // Number of periods to test (default: 3)

    // Out-of-sample hold-back
    enableHoldout: boolean;         // Enable holdout set (default: true)
    holdoutRatio: number;           // Ratio of data to hold back (default: 0.2)

    // Stability testing
    enableStabilityTest: boolean;   // Enable parameter stability testing (default: true)
    stabilityPerturbations: number; // Number of perturbation tests (default: 10)
    stabilityStrength: number;      // Perturbation strength as fraction of range (default: 0.1)
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
    dispose?: () => void;  // Optional cleanup method to help GC
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

interface PeriodAssignment {
    periodStart: number;
    periodEnd: number;
    bucket: 'train' | 'validation' | 'holdout';
}

interface CrossPeriodAssignment {
    periodStart: number;
    periodEnd: number;
    bucket: number;
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
        const defaultValidationConfig: ValidationConfig = {
            enableWalkForward: true,
            trainRatio: 0.7,
            enableCrossPeriod: true,
            numCrossPeriods: 3,
            enableHoldout: true,
            holdoutRatio: 0.2,
            enableStabilityTest: true,
            stabilityPerturbations: 10,
            stabilityStrength: 0.1,
        };

        this.config = {
            ...config,
            tickIntervalMs: config.tickIntervalMs ?? 60 * 1000,
            coinType: config.coinType,
            auditTradesCount: config.auditTradesCount ?? 0,
            targetedMarket: config.targetedMarket,
            validationConfig: config.validationConfig ?? defaultValidationConfig,
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

        // Filter out trades with invalid/extreme PnL values
        // Reasonable PnL bounds: max loss per trade is ~$1000, max gain is similar
        const MAX_REASONABLE_PNL = 10000;
        const pnls = completedTrades
            .map(t => t.pnl ?? 0)
            .filter(pnl => !isNaN(pnl) && isFinite(pnl) && Math.abs(pnl) < MAX_REASONABLE_PNL);
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

                // Update running sum for average
                runningPnlSum += result.totalPnl;

                // Track best performer for audit (only keep trades for the best one)
                if (result.totalPnl > bestFitness) {
                    bestFitness = result.totalPnl;
                    bestTrades = trades;
                }
                // Note: trades from non-best performers are discarded to save memory

                // Track top N performers for re-run with logging (only params, not trades)
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

            // Clear results array to help GC (optimizer has already extracted what it needs)
            results.length = 0;

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

        // Get optimization result
        const optimizationResult = optimizer.getResult();
        const bestParams = optimizationResult.bestIndividual.params;
        const trainPnl = optimizationResult.bestIndividual.rawPnl ?? optimizationResult.bestIndividual.fitness;

        // Run validation suite if enabled
        if (this.config.validationConfig) {
            const { validationResult, stabilityResult } = await this.runValidationSuite(
                botName, botFactory, optimizer, bestParams, trainPnl
            );
            optimizationResult.validationResult = validationResult;
            optimizationResult.stabilityResult = stabilityResult;
        }

        // Write trade audit file for the best individual
        const auditPath = this.logger.createAuditFile(botName, optimizer.getGeneration());
        this.logger.writeSimulatedTradeAudits(botName, bestTrades);
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

        return optimizationResult;
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

        // Copy trades before cleanup (bot.getTrades returns internal array)
        const tradesCopy = [...trades];

        // Cleanup - clear listeners and dispose bot to help GC
        this.clock.clearListeners();
        bot.reset();
        if (bot.dispose) {
            bot.dispose();
        }

        // Null out references to help GC
        (this as any).clock = null;
        (this as any).marketInfo = null;
        (this as any).cdMarketData = null;

        return { result, trades: tradesCopy };
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
     * Initializes simulation for a specific time window.
     */
    private initializeSimulationForWindow(startTime: number, endTime: number): void {
        const coinType = this.config.coinType!;
        this.clock = new SimulationClock(startTime, endTime, this.config.tickIntervalMs);
        this.marketInfo = new MockMarketInfo(this.clock, coinType);
        this.cdMarketData = new MockCDMarketData(this.clock, coinType);
    }

    /**
     * Generates random period assignments for train/validation/holdout buckets.
     * Periods are randomly shuffled and assigned to buckets based on ratios.
     */
    private generateRandomPeriodAssignments(
        startTime: number,
        endTime: number,
        trainRatio: number,
        holdoutRatio: number
    ): PeriodAssignment[] {
        const isQuarterly = this.config.targetedMarket?.toString().includes('Quarterly');
        const periodMs = isQuarterly ? 15 * 60 * 1000 : 60 * 60 * 1000; // 15min or 1hr

        const assignments: PeriodAssignment[] = [];
        let currentTime = startTime;

        // Create period entries
        while (currentTime < endTime) {
            const periodEnd = Math.min(currentTime + periodMs, endTime);
            assignments.push({
                periodStart: currentTime,
                periodEnd,
                bucket: 'train' // Will be assigned randomly below
            });
            currentTime = periodEnd;
        }

        // Shuffle and assign buckets
        const shuffled = [...assignments].sort(() => Math.random() - 0.5);
        const trainCount = Math.floor(shuffled.length * trainRatio);
        const holdoutCount = Math.floor(shuffled.length * holdoutRatio);

        shuffled.forEach((period, i) => {
            if (i < trainCount) {
                period.bucket = 'train';
            } else if (i < trainCount + holdoutCount) {
                period.bucket = 'holdout';
            } else {
                period.bucket = 'validation';
            }
        });

        return assignments;
    }

    /**
     * Classifies trades by their period assignment bucket.
     */
    private classifyTradesByPeriod(
        trades: SimulatedTrade[],
        assignments: PeriodAssignment[]
    ): { train: SimulatedTrade[]; validation: SimulatedTrade[]; holdout: SimulatedTrade[] } {
        const result: { train: SimulatedTrade[]; validation: SimulatedTrade[]; holdout: SimulatedTrade[] } = {
            train: [],
            validation: [],
            holdout: []
        };

        for (const trade of trades) {
            const assignment = assignments.find(
                a => trade.timestamp >= a.periodStart && trade.timestamp < a.periodEnd
            );
            if (assignment) {
                result[assignment.bucket].push(trade);
            }
        }

        return result;
    }

    /**
     * Generates random cross-period assignments for N buckets.
     */
    private generateRandomCrossPeriodAssignments(
        startTime: number,
        endTime: number,
        numBuckets: number
    ): CrossPeriodAssignment[] {
        const isQuarterly = this.config.targetedMarket?.toString().includes('Quarterly');
        const periodMs = isQuarterly ? 15 * 60 * 1000 : 60 * 60 * 1000;

        const assignments: CrossPeriodAssignment[] = [];
        let currentTime = startTime;

        while (currentTime < endTime) {
            const periodEnd = Math.min(currentTime + periodMs, endTime);
            assignments.push({
                periodStart: currentTime,
                periodEnd,
                bucket: Math.floor(Math.random() * numBuckets) // Random bucket 0 to N-1
            });
            currentTime = periodEnd;
        }

        return assignments;
    }

    /**
     * Runs simulation on a specific time window.
     */
    private async runSimulationOnWindow(
        botName: string,
        botFactory: (params: BotParams) => SimulatedBot,
        params: Record<string, number>,
        startTime: number,
        endTime: number
    ): Promise<SimulationResult> {
        // Initialize for this specific window
        this.initializeSimulationForWindow(startTime, endTime);

        // Create the bot
        const bot = botFactory({
            name: botName,
            clock: this.clock,
            marketInfo: this.marketInfo,
            cdMarketData: this.cdMarketData,
            params,
            targetedMarket: this.config.targetedMarket!,
            shouldWriteLogs: false,
        });

        // Register period change handler
        const isQuarterly = this.config.targetedMarket?.toString().includes('Quarterly');
        if (isQuarterly) {
            this.clock.on('quarterly', async () => {
                await bot.onHourChange();
            });
        } else {
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
                if (!errorMessage.includes('No data available')) {
                    throw error;
                }
            }
            await this.clock.tick();
        }

        // Calculate results
        const trades = bot.getTrades();
        const result = this.calculateResults(botName, params, trades);

        // Cleanup
        this.clock.clearListeners();

        return result;
    }

    /**
     * Runs walk-forward validation with random period assignment.
     * Runs ONE full simulation, then classifies trades by randomly assigned periods.
     */
    private async runWalkForwardValidation(
        botName: string,
        botFactory: (params: BotParams) => SimulatedBot,
        params: Record<string, number>
    ): Promise<{ trainPnl: number; validationPnl: number }> {
        const valConfig = this.config.validationConfig!;
        const endTime = Date.now();
        const totalMs = this.config.lookbackDays * 24 * 60 * 60 * 1000;
        const startTime = endTime - totalMs;

        // Generate random period assignments
        const assignments = this.generateRandomPeriodAssignments(
            startTime, endTime, valConfig.trainRatio, 0 // No holdout for walk-forward
        );

        // Run full simulation
        const { trades } = await this.runSingleBotSimulationWithTrades(
            botName, botFactory, params
        );

        // Classify trades by period
        const classified = this.classifyTradesByPeriod(trades, assignments);

        // Calculate PnL for each bucket
        const trainPnl = classified.train.reduce((sum, t) => sum + (t.pnl ?? 0), 0);
        const validationPnl = classified.validation.reduce((sum, t) => sum + (t.pnl ?? 0), 0);

        return { trainPnl, validationPnl };
    }

    /**
     * Runs cross-period validation with random bucket assignment.
     * Runs ONE full simulation, then classifies trades into N random buckets.
     */
    private async runCrossPeriodValidation(
        botName: string,
        botFactory: (params: BotParams) => SimulatedBot,
        params: Record<string, number>
    ): Promise<{ pnls: number[]; avg: number; stdDev: number }> {
        const valConfig = this.config.validationConfig!;
        const endTime = Date.now();
        const totalMs = this.config.lookbackDays * 24 * 60 * 60 * 1000;
        const startTime = endTime - totalMs;

        // Generate periods and randomly assign to buckets
        const assignments = this.generateRandomCrossPeriodAssignments(
            startTime, endTime, valConfig.numCrossPeriods
        );

        // Run full simulation
        const { trades } = await this.runSingleBotSimulationWithTrades(
            botName, botFactory, params
        );

        // Calculate PnL per bucket
        const pnls: number[] = [];
        for (let bucket = 0; bucket < valConfig.numCrossPeriods; bucket++) {
            const bucketTrades = trades.filter(t => {
                const assignment = assignments.find(
                    a => t.timestamp >= a.periodStart && t.timestamp < a.periodEnd
                );
                return assignment?.bucket === bucket;
            });
            const pnl = bucketTrades.reduce((sum, t) => sum + (t.pnl ?? 0), 0);
            pnls.push(pnl);
        }

        const avg = pnls.reduce((a, b) => a + b, 0) / pnls.length;
        const variance = pnls.reduce((sum, pnl) => sum + Math.pow(pnl - avg, 2), 0) / pnls.length;
        const stdDev = Math.sqrt(variance);

        return { pnls, avg, stdDev };
    }

    /**
     * Runs simulation on holdout (out-of-sample) data only.
     */
    private async runHoldoutValidation(
        botName: string,
        botFactory: (params: BotParams) => SimulatedBot,
        params: Record<string, number>
    ): Promise<number> {
        const valConfig = this.config.validationConfig!;
        const endTime = Date.now();
        const totalMs = this.config.lookbackDays * 24 * 60 * 60 * 1000;

        // Holdout is the most recent portion of data
        const holdoutMs = totalMs * valConfig.holdoutRatio;
        const holdoutStart = endTime - holdoutMs;

        const result = await this.runSimulationOnWindow(
            botName, botFactory, params, holdoutStart, endTime
        );

        return result.totalPnl;
    }

    /**
     * Runs parameter stability testing.
     */
    private async runStabilityTest(
        botName: string,
        botFactory: (params: BotParams) => SimulatedBot,
        optimizer: GeneticOptimizer,
        bestParams: Record<string, number>,
        originalPnl: number
    ): Promise<StabilityResult> {
        const valConfig = this.config.validationConfig!;

        // Generate perturbed parameter sets
        const perturbedParams = optimizer.generatePerturbedParams(
            bestParams,
            valConfig.stabilityPerturbations,
            valConfig.stabilityStrength
        );

        // Run simulations on each perturbed set
        const perturbedPnls: number[] = [];
        for (const params of perturbedParams) {
            const { result } = await this.runSingleBotSimulationWithTrades(
                botName, botFactory, params
            );
            perturbedPnls.push(result.totalPnl);
        }

        return optimizer.calculateStabilityScore(originalPnl, perturbedPnls);
    }

    /**
     * Runs comprehensive validation suite on best parameters.
     */
    public async runValidationSuite(
        botName: string,
        botFactory: (params: BotParams) => SimulatedBot,
        optimizer: GeneticOptimizer,
        bestParams: Record<string, number>,
        trainPnl: number
    ): Promise<{ validationResult: ValidationResult; stabilityResult: StabilityResult }> {
        const valConfig = this.config.validationConfig!;

        this.logger.log(`\n${'='.repeat(60)}`);
        this.logger.log('ANTI-OVERFITTING VALIDATION SUITE');
        this.logger.log(`${'='.repeat(60)}`);

        // Walk-forward validation
        let walkForwardResult = { trainPnl, validationPnl: trainPnl };
        if (valConfig.enableWalkForward) {
            this.logger.log('\n[1/4] Running Walk-Forward Validation...');
            walkForwardResult = await this.runWalkForwardValidation(botName, botFactory, bestParams);
            this.logger.log(`  Train PnL: $${walkForwardResult.trainPnl.toFixed(2)}`);
            this.logger.log(`  Validation PnL: $${walkForwardResult.validationPnl.toFixed(2)}`);
            const ratio = walkForwardResult.validationPnl / (walkForwardResult.trainPnl || 1);
            this.logger.log(`  Ratio (val/train): ${(ratio * 100).toFixed(1)}%`);
        }

        // Cross-period validation
        let crossPeriodResult = { pnls: [trainPnl], avg: trainPnl, stdDev: 0 };
        if (valConfig.enableCrossPeriod) {
            this.logger.log('\n[2/4] Running Cross-Period Validation...');
            crossPeriodResult = await this.runCrossPeriodValidation(botName, botFactory, bestParams);
            this.logger.log(`  Period PnLs: [${crossPeriodResult.pnls.map(p => `$${p.toFixed(2)}`).join(', ')}]`);
            this.logger.log(`  Average: $${crossPeriodResult.avg.toFixed(2)}`);
            this.logger.log(`  Std Dev: $${crossPeriodResult.stdDev.toFixed(2)}`);
        }

        // Holdout validation
        let holdoutPnl: number | undefined;
        if (valConfig.enableHoldout) {
            this.logger.log('\n[3/4] Running Out-of-Sample Holdout Validation...');
            holdoutPnl = await this.runHoldoutValidation(botName, botFactory, bestParams);
            this.logger.log(`  Holdout PnL: $${holdoutPnl.toFixed(2)}`);
            const holdoutRatio = holdoutPnl / (trainPnl || 1);
            this.logger.log(`  Ratio (holdout/train): ${(holdoutRatio * 100).toFixed(1)}%`);
        }

        // Stability testing
        let stabilityResult: StabilityResult = {
            originalPnl: trainPnl,
            perturbedPnls: [],
            avgPerturbedPnl: trainPnl,
            stabilityScore: 1.0,
            isStable: true,
        };
        if (valConfig.enableStabilityTest) {
            this.logger.log('\n[4/4] Running Parameter Stability Test...');
            stabilityResult = await this.runStabilityTest(
                botName, botFactory, optimizer, bestParams, trainPnl
            );
            this.logger.log(`  Original PnL: $${stabilityResult.originalPnl.toFixed(2)}`);
            this.logger.log(`  Avg Perturbed PnL: $${stabilityResult.avgPerturbedPnl.toFixed(2)}`);
            this.logger.log(`  Stability Score: ${(stabilityResult.stabilityScore * 100).toFixed(1)}%`);
            this.logger.log(`  Is Stable: ${stabilityResult.isStable ? 'YES ✓' : 'NO ✗'}`);
        }

        // Determine if overfit
        const validationPnl = walkForwardResult.validationPnl;
        const overfit = validationPnl < trainPnl * 0.5 ||  // Validation < 50% of training
            (holdoutPnl !== undefined && holdoutPnl < trainPnl * 0.5) ||
            crossPeriodResult.stdDev > crossPeriodResult.avg;  // High variance

        // Print summary
        this.logger.log(`\n${'-'.repeat(60)}`);
        this.logger.log('VALIDATION SUMMARY');
        this.logger.log(`${'-'.repeat(60)}`);
        this.logger.log(`  Overfit Risk: ${overfit ? 'HIGH ⚠️' : 'LOW ✓'}`);
        this.logger.log(`  Parameter Stability: ${stabilityResult.isStable ? 'STABLE ✓' : 'UNSTABLE ⚠️'}`);
        this.logger.log(`  Cross-Period Consistency: ${crossPeriodResult.stdDev < crossPeriodResult.avg * 0.5 ? 'GOOD ✓' : 'VARIABLE ⚠️'}`);

        const validationResult: ValidationResult = {
            trainPnl: walkForwardResult.trainPnl,
            validationPnl: walkForwardResult.validationPnl,
            holdoutPnl,
            crossPeriodPnls: crossPeriodResult.pnls,
            crossPeriodAvg: crossPeriodResult.avg,
            crossPeriodStdDev: crossPeriodResult.stdDev,
            overfit,
        };

        return { validationResult, stabilityResult };
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

        this.logger.log('\nStrategies Ranked by Composite Fitness:');
        this.logger.log('-'.repeat(60));

        for (let i = 0; i < sortedResults.length; i++) {
            const [name, result] = sortedResults[i];
            const best = result.bestIndividual;
            const val = result.validationResult;
            const stab = result.stabilityResult;

            this.logger.log(`\n${i + 1}. ${name}`);
            this.logger.log(`   Composite Fitness: ${best.fitness.toFixed(2)}`);
            this.logger.log(`   Raw PnL: $${(best.rawPnl ?? 0).toFixed(2)}`);
            this.logger.log(`   Sharpe: ${(best.sharpeRatio ?? 0).toFixed(3)} | Win Rate: ${(best.winRate ?? 0).toFixed(1)}%`);
            this.logger.log(`   Trades: ${best.tradeCount ?? 0} | Generations: ${result.totalGenerations}`);

            // Validation metrics if available
            if (val) {
                const overfitStr = val.overfit ? '⚠️ HIGH' : '✓ LOW';
                this.logger.log(`   Validation PnL: $${val.validationPnl.toFixed(2)} | Overfit Risk: ${overfitStr}`);
            }
            if (stab) {
                const stabStr = stab.isStable ? '✓ STABLE' : '⚠️ UNSTABLE';
                this.logger.log(`   Stability: ${(stab.stabilityScore * 100).toFixed(1)}% ${stabStr}`);
            }

            this.logger.log(`   Parameters:`);
            for (const [key, value] of Object.entries(best.params)) {
                this.logger.log(`     ${key}: ${value.toFixed(4)}`);
            }
        }
    }
}
