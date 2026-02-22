/**
 * SimulationRunnerStage - Runs genetic optimization to discover profitable strategies.
 *
 * Interval: Every 2 hours (configurable)
 *
 * Smart Selection Logic:
 * - Prioritizes strategy/market combos based on historical success rate
 * - Applies adaptive cooldowns: successful combos run more often, failing ones less
 * - Limits simulations per run cycle to avoid overload
 * - Tracks consecutive failures to deprioritize persistently failing combos
 */
import { BasePipelineStage } from './BasePipelineStage.js';
import { PipelineDatabase } from './PipelineDatabase.js';
import { BotLifecycleState } from './types.js';
import type { PipelineStageConfig, SimPromotionCriteria } from './types.js';
import { HistoricalSimulator, CoinType } from '../simulation/HistoricalSimulator.js';
import { geneticStrategies } from '../simulation/strategyDefinitions.js';
import { TargetedMarket } from '../types/interfaces.js';

// ============================================================================
// Configuration
// ============================================================================

export interface SimulationRunnerConfig extends PipelineStageConfig {
    lookbackDays: number;
    strategies: string[];
    markets: string[];
    populationSize: number;
    maxGenerations: number;
}

/** Maximum simulations to run per cycle (to limit resource usage) */
const MAX_SIMS_PER_CYCLE = 3;

/** Base cooldown period in hours */
const BASE_COOLDOWN_HOURS = 4;

/** Minimum cooldown even for high-performing combos (hours) */
const MIN_COOLDOWN_HOURS = 2;

/** Maximum cooldown for consistently failing combos (hours) */
const MAX_COOLDOWN_HOURS = 24;

/** Number of recent results to consider for success rate */
const HISTORY_WINDOW = 10;

// ============================================================================
// Types
// ============================================================================

interface StrategyCombo {
    strategy: string;
    market: string;
    fullStrategyName: string;
    targetedMarket: TargetedMarket;
    coinType: CoinType;
    priority: number;
    cooldownMs: number;
    successRate: number;
    totalRuns: number;
    lastRunTimestamp: number | null;
    consecutiveFailures: number;
}

// ============================================================================
// Market Helpers
// ============================================================================

function marketStringToEnum(market: string): TargetedMarket {
    const mapping: Record<string, TargetedMarket> = {
        'BitcoinHourly': TargetedMarket.BITCOIN_HOURLY,
        'BitcoinQuarterly': TargetedMarket.BITCOIN_QUARTERLY,
        'EthereumHourly': TargetedMarket.ETHEREUM_HOURLY,
        'EthereumQuarterly': TargetedMarket.ETHEREUM_QUARTERLY,
        'SolanaHourly': TargetedMarket.SOLANA_HOURLY,
        'SolanaQuarterly': TargetedMarket.SOLANA_QUARTERLY,
        'XrpHourly': TargetedMarket.XRP_HOURLY,
        'XrpQuarterly': TargetedMarket.XRP_QUARTERLY,
    };
    return mapping[market] ?? TargetedMarket.BITCOIN_HOURLY;
}

function extractCoinType(market: string): CoinType {
    const lower = market.toLowerCase();
    if (lower.includes('bitcoin') || lower.includes('btc')) return CoinType.BTC;
    if (lower.includes('ethereum') || lower.includes('eth')) return CoinType.ETH;
    if (lower.includes('solana') || lower.includes('sol')) return CoinType.SOL;
    if (lower.includes('xrp')) return CoinType.XRP;
    return CoinType.BTC;
}

function isQuarterlyMarket(market: string): boolean {
    return market.toLowerCase().includes('quarterly');
}

// ============================================================================
// SimulationRunnerStage
// ============================================================================

export class SimulationRunnerStage extends BasePipelineStage {
    readonly name = 'SimulationRunner';

    private simConfig: SimulationRunnerConfig;
    private criteria: SimPromotionCriteria;

    constructor(
        pipelineDb: PipelineDatabase,
        simConfig: SimulationRunnerConfig,
        criteria: SimPromotionCriteria,
    ) {
        super(pipelineDb, simConfig);
        this.simConfig = simConfig;
        this.criteria = criteria;
    }

    public async runOnce(): Promise<void> {
        console.log(`[${this.name}] Starting simulation run with smart selection...`);

        // Build and prioritize all strategy/market combinations
        const combos = this.buildPrioritizedCombos();

        // Filter to combos that are ready to run (cooldown expired)
        const readyCombos = combos.filter(c => this.isCooldownExpired(c));

        console.log(`[${this.name}] ${readyCombos.length}/${combos.length} combos ready (cooldown expired)`);

        if (readyCombos.length === 0) {
            console.log(`[${this.name}] No combos ready to run. Waiting for cooldowns.`);
            this.logEvent('STAGE_RUN_COMPLETE', undefined, {
                botsInserted: 0,
                combosReady: 0,
                combosTotal: combos.length,
                reason: 'All combos on cooldown',
            });
            return;
        }

        // Log priority rankings
        console.log(`[${this.name}] Priority rankings (top ${Math.min(5, readyCombos.length)}):`);
        readyCombos.slice(0, 5).forEach((c, i) => {
            console.log(`  ${i + 1}. ${c.fullStrategyName}/${c.market} - priority=${c.priority.toFixed(2)}, ` +
                `successRate=${(c.successRate * 100).toFixed(0)}%, runs=${c.totalRuns}, ` +
                `consecutiveFails=${c.consecutiveFailures}`);
        });

        // Run up to MAX_SIMS_PER_CYCLE simulations
        let totalInserted = 0;
        let simsRun = 0;

        for (const combo of readyCombos) {
            if (simsRun >= MAX_SIMS_PER_CYCLE) {
                console.log(`[${this.name}] Reached max sims per cycle (${MAX_SIMS_PER_CYCLE}), stopping.`);
                break;
            }

            // Find the strategy definition
            const strategy = geneticStrategies.find(
                s => s.name.toLowerCase() === combo.fullStrategyName.toLowerCase()
            );
            if (!strategy) {
                console.log(`[${this.name}] Strategy "${combo.fullStrategyName}" not found, skipping`);
                continue;
            }

            try {
                console.log(`[${this.name}] Running optimization: ${combo.fullStrategyName}/${combo.market} ` +
                    `(priority=${combo.priority.toFixed(2)})`);

                const simulator = new HistoricalSimulator({
                    lookbackDays: this.simConfig.lookbackDays,
                    tickIntervalMs: 5 * 1000,
                    coinType: combo.coinType,
                    targetedMarket: combo.targetedMarket,
                });

                const geneticConfig = {
                    populationSize: this.simConfig.populationSize,
                    maxGenerations: this.simConfig.maxGenerations,
                    convergenceThreshold: 1.0,
                    convergenceGenerations: 5,
                    mutationRate: 0.25,
                    mutationStrength: 0.3,
                    eliteCount: 2,
                    crossoverRate: 0.7,
                    fitnessMode: 'sortino' as const,
                };

                const result = await simulator.runGeneticOptimization(
                    strategy.name,
                    strategy.factory,
                    strategy.bounds,
                    geneticConfig,
                );

                // Run final simulation with best params to get full metrics
                const { result: simResult } = await simulator.runSingleSimulation(
                    strategy.name,
                    strategy.factory,
                    result.bestIndividual.params,
                    { shouldWriteLogs: false },
                );

                // Check against promotion criteria
                const { passes, failureReasons } = this.meetsSimCriteria(simResult);

                console.log(
                    `[${this.name}] ${combo.fullStrategyName}/${combo.market}: PnL=$${simResult.totalPnl.toFixed(2)}, ` +
                    `Sharpe=${simResult.sharpeRatio.toFixed(2)}, WinRate=${simResult.winRate.toFixed(1)}%, ` +
                    `Trades=${simResult.totalTrades}, Passes=${passes}`
                );

                if (!passes) {
                    console.log(`[${this.name}] Failed criteria: ${failureReasons.join('; ')}`);
                }

                if (passes) {
                    const botId = `pipeline-${combo.fullStrategyName}-${combo.market}-${Date.now()}`;
                    const now = Date.now();

                    this.pipelineDb.insertBotLifecycle({
                        botId,
                        strategy: combo.fullStrategyName,
                        market: combo.market,
                        state: BotLifecycleState.SIMULATED,
                        paramsJson: JSON.stringify(result.bestIndividual.params),
                        simPnl: simResult.totalPnl,
                        simSharpe: simResult.sharpeRatio,
                        simSortino: simResult.sortinoRatio,
                        simCalmar: simResult.calmarRatio,
                        simWinRate: simResult.winRate,
                        simMaxDrawdown: simResult.maxDrawdown,
                        simTotalTrades: simResult.totalTrades,
                        simTimestamp: now,
                        createdAt: now,
                        updatedAt: now,
                    });

                    this.logEvent('SIMULATION_COMPLETE', botId, {
                        strategy: combo.fullStrategyName,
                        market: combo.market,
                        pnl: simResult.totalPnl,
                        sharpe: simResult.sharpeRatio,
                        winRate: simResult.winRate,
                        trades: simResult.totalTrades,
                        priority: combo.priority,
                    });

                    totalInserted++;
                    console.log(`[${this.name}] Inserted SIMULATED bot: ${botId}`);
                } else {
                    // Log failed simulation for tracking
                    this.logEvent('SIMULATION_FAILED', undefined, {
                        strategy: combo.fullStrategyName,
                        market: combo.market,
                        pnl: simResult.totalPnl,
                        sharpe: simResult.sharpeRatio,
                        winRate: simResult.winRate,
                        trades: simResult.totalTrades,
                        consecutiveFailures: combo.consecutiveFailures + 1,
                        failureReason: failureReasons.join('; '),
                    });
                }

                simsRun++;

            } catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                console.error(`[${this.name}] Error optimizing ${combo.fullStrategyName}/${combo.market}: ${msg}`);
                simsRun++; // Count errors toward the limit
            }
        }

        this.logEvent('STAGE_RUN_COMPLETE', undefined, {
            botsInserted: totalInserted,
            simsRun,
            combosReady: readyCombos.length,
            combosTotal: combos.length,
        });

        console.log(`[${this.name}] Run complete. Ran ${simsRun} sims, inserted ${totalInserted} bots.`);
    }

    /**
     * Builds all strategy/market combinations with priority scores.
     * Higher priority = should be run sooner.
     */
    private buildPrioritizedCombos(): StrategyCombo[] {
        const combos: StrategyCombo[] = [];

        for (const market of this.simConfig.markets) {
            const targetedMarket = marketStringToEnum(market);
            const coinType = extractCoinType(market);
            const quarterly = isQuarterlyMarket(market);

            for (const strategyName of this.simConfig.strategies) {
                const fullStrategyName = quarterly && !strategyName.startsWith('Quarterly')
                    ? `Quarterly${strategyName}`
                    : strategyName;

                // Get historical data for this combo
                const history = this.getComboHistory(fullStrategyName, market);

                // Calculate adaptive cooldown based on performance
                const cooldownMs = this.calculateCooldown(history);

                // Calculate priority score
                const priority = this.calculatePriority(history);

                combos.push({
                    strategy: strategyName,
                    market,
                    fullStrategyName,
                    targetedMarket,
                    coinType,
                    priority,
                    cooldownMs,
                    successRate: history.successRate,
                    totalRuns: history.totalRuns,
                    lastRunTimestamp: history.lastRunTimestamp,
                    consecutiveFailures: history.consecutiveFailures,
                });
            }
        }

        // Sort by priority descending (highest priority first)
        combos.sort((a, b) => b.priority - a.priority);

        return combos;
    }

    /**
     * Gets historical performance data for a strategy/market combo.
     * Uses pipeline_events table to track ALL simulation runs (including failures).
     */
    private getComboHistory(strategy: string, market: string): {
        successRate: number;
        totalRuns: number;
        lastRunTimestamp: number | null;
        consecutiveFailures: number;
        recentSuccesses: number;
    } {
        // Query simulation events (both COMPLETE and FAILED) from events table
        const events = this.pipelineDb.getSimulationEventsForCombo(strategy, market, HISTORY_WINDOW);

        if (events.length === 0) {
            return {
                successRate: 0.5, // Neutral for new combos
                totalRuns: 0,
                lastRunTimestamp: null,
                consecutiveFailures: 0,
                recentSuccesses: 0,
            };
        }

        // Events are already sorted by timestamp DESC (most recent first)
        const lastRunTimestamp = events[0].timestamp;

        // Count successes (SIMULATION_COMPLETE events)
        const successes = events.filter(e => e.eventType === 'SIMULATION_COMPLETE').length;
        const totalRuns = events.length;

        // Count consecutive failures from most recent
        let consecutiveFailures = 0;
        for (const event of events) {
            if (event.eventType === 'SIMULATION_FAILED') {
                consecutiveFailures++;
            } else {
                break;
            }
        }

        return {
            successRate: totalRuns > 0 ? successes / totalRuns : 0.5,
            totalRuns,
            lastRunTimestamp,
            consecutiveFailures,
            recentSuccesses: successes,
        };
    }

    /**
     * Calculates adaptive cooldown based on performance.
     * - High success rate → shorter cooldown (run more often)
     * - Low success rate → longer cooldown (run less often)
     * - Consecutive failures → exponentially longer cooldown
     */
    private calculateCooldown(history: {
        successRate: number;
        consecutiveFailures: number;
        totalRuns: number;
    }): number {
        const hoursToMs = (h: number) => h * 60 * 60 * 1000;

        // New combos get a short cooldown to gather data
        if (history.totalRuns < 3) {
            return hoursToMs(MIN_COOLDOWN_HOURS);
        }

        // Base cooldown adjusted by success rate
        // High success (80%+) → 2 hours
        // Medium success (50%) → 4 hours
        // Low success (20%) → 8 hours
        const successAdjustedHours = BASE_COOLDOWN_HOURS * (1.5 - history.successRate);

        // Add exponential penalty for consecutive failures
        // 1 fail → +2h, 2 fails → +4h, 3 fails → +8h, etc.
        const failurePenaltyHours = Math.min(
            Math.pow(2, history.consecutiveFailures) - 1,
            MAX_COOLDOWN_HOURS - successAdjustedHours
        );

        const totalHours = Math.max(
            MIN_COOLDOWN_HOURS,
            Math.min(MAX_COOLDOWN_HOURS, successAdjustedHours + failurePenaltyHours)
        );

        return hoursToMs(totalHours);
    }

    /**
     * Calculates priority score for a combo.
     * Higher score = run sooner.
     *
     * Factors:
     * - Success rate (higher = higher priority)
     * - Time since last run (longer = higher priority)
     * - New combos get a bonus to gather initial data
     * - Consecutive failures reduce priority
     */
    private calculatePriority(history: {
        successRate: number;
        totalRuns: number;
        lastRunTimestamp: number | null;
        consecutiveFailures: number;
    }): number {
        let priority = 0;

        // New combo bonus: prioritize gathering data
        if (history.totalRuns < 3) {
            priority += 50;
        }

        // Success rate contribution (0-40 points)
        priority += history.successRate * 40;

        // Time since last run contribution (0-30 points)
        // More points the longer it's been since the last run
        if (history.lastRunTimestamp) {
            const hoursSinceRun = (Date.now() - history.lastRunTimestamp) / (60 * 60 * 1000);
            priority += Math.min(30, hoursSinceRun * 2);
        } else {
            // Never run = high priority
            priority += 30;
        }

        // Penalty for consecutive failures (-5 points per failure, max -25)
        priority -= Math.min(25, history.consecutiveFailures * 5);

        return Math.max(0, priority);
    }

    /**
     * Checks if a combo's cooldown has expired and it's ready to run.
     */
    private isCooldownExpired(combo: StrategyCombo): boolean {
        if (combo.lastRunTimestamp === null) {
            return true; // Never run before
        }
        return (Date.now() - combo.lastRunTimestamp) >= combo.cooldownMs;
    }

    private meetsSimCriteria(result: {
        totalPnl: number;
        sharpeRatio: number;
        winRate: number;
        totalTrades: number;
        maxDrawdown: number;
    }): { passes: boolean; failureReasons: string[] } {
        const pnlPass = result.totalPnl >= this.criteria.minSimPnl;
        const sharpePass = result.sharpeRatio >= this.criteria.minSimSharpe;
        const winRatePass = result.winRate >= this.criteria.minSimWinRate;
        const tradesPass = result.totalTrades >= this.criteria.minSimTrades;
        const drawdownPass = result.maxDrawdown >= this.criteria.maxSimDrawdown;

        const failureReasons: string[] = [];
        if (!pnlPass) {
            failureReasons.push(`PnL $${result.totalPnl.toFixed(2)} < $${this.criteria.minSimPnl}`);
        }
        if (!sharpePass) {
            failureReasons.push(`Sharpe ${result.sharpeRatio.toFixed(2)} < ${this.criteria.minSimSharpe}`);
        }
        if (!winRatePass) {
            failureReasons.push(`WinRate ${result.winRate.toFixed(1)}% < ${this.criteria.minSimWinRate}%`);
        }
        if (!tradesPass) {
            failureReasons.push(`Trades ${result.totalTrades} < ${this.criteria.minSimTrades}`);
        }
        if (!drawdownPass) {
            failureReasons.push(`MaxDrawdown ${result.maxDrawdown.toFixed(2)} < ${this.criteria.maxSimDrawdown}`);
        }

        const passes = pnlPass && sharpePass && winRatePass && tradesPass && drawdownPass;
        return { passes, failureReasons };
    }
}
