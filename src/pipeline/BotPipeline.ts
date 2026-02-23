/**
 * BotPipeline - Central orchestrator for the autonomous bot lifecycle system.
 *
 * Creates and manages all 5 pipeline stages:
 * 1. SimulationRunner - Discovers profitable strategies via genetic optimization
 * 2. BotPromoter - Promotes best SIMULATED bots to TEST_RUNNING
 * 3. TestEvaluator - Evaluates TEST_RUNNING bots after 48h, promotes or retires
 * 4. ProdPromotion - Monitors PROD_CANDIDATE bots awaiting user approval
 * 5. ProdMonitor - Monitors PROD_RUNNING bots, retires underperformers
 *
 * Key design: No auto-promotion to PROD. PROD_CANDIDATE requires user approval
 * via the dashboard API (approveProdCandidate / rejectProdCandidate).
 */
import { QuantBotRun } from '../bots/QuantBot.js';
import { TradingDatabase } from '../db/TradingDatabase.js';
import { PipelineDatabase } from './PipelineDatabase.js';
import { PipelineBotManager } from './PipelineBotManager.js';
import { loadBotFromLifecycleRecord, type PipelineBotProps } from './botFactory.js';
import { BotLifecycleState, DEFAULT_PIPELINE_CONFIG } from './types.js';
import type { PipelineConfig } from './types.js';
import { SimulationRunnerStage } from './SimulationRunnerStage.js';
import { BotPromoterStage } from './BotPromoterStage.js';
import { TestEvaluatorStage } from './TestEvaluatorStage.js';
import { ProdPromotionStage } from './ProdPromotionStage.js';
import { ProdMonitorStage } from './ProdMonitorStage.js';

// ============================================================================
// Constructor Props
// ============================================================================

export interface BotPipelineProps {
    tradingDb: TradingDatabase;
    testBots: QuantBotRun[];
    prodBots: QuantBotRun[];
    commonTestProps: PipelineBotProps;
    commonProdProps: PipelineBotProps;
    config?: Partial<PipelineConfig>;
}

// ============================================================================
// BotPipeline
// ============================================================================

export class BotPipeline {
    private pipelineDb: PipelineDatabase;
    private botManager: PipelineBotManager;
    private config: PipelineConfig;

    // Pipeline stages
    private simRunner: SimulationRunnerStage;
    private promoter: BotPromoterStage;
    private evaluator: TestEvaluatorStage;
    private prodPromotion: ProdPromotionStage;
    private prodMonitor: ProdMonitorStage;

    // Props for creating bots
    private commonTestProps: PipelineBotProps;
    private commonProdProps: PipelineBotProps;

    constructor(props: BotPipelineProps) {
        // Merge user config with defaults
        this.config = { ...DEFAULT_PIPELINE_CONFIG, ...props.config };

        // Initialize database layer
        this.pipelineDb = new PipelineDatabase(props.tradingDb);

        // Initialize bot manager (bridges pipeline with runtime arrays)
        this.botManager = new PipelineBotManager(props.testBots, props.prodBots);

        this.commonTestProps = props.commonTestProps;
        this.commonProdProps = props.commonProdProps;

        // Create all 5 stages
        this.simRunner = new SimulationRunnerStage(
            this.pipelineDb,
            this.config.simulation,
            this.config.simPromotionCriteria,
        );

        this.promoter = new BotPromoterStage(
            this.pipelineDb,
            { ...this.config.promoter, globalTestLimit: this.config.maxConcurrentBots.test },
            this.botManager,
            { ...this.commonTestProps, PROD_MODE: false },
        );

        this.evaluator = new TestEvaluatorStage(
            this.pipelineDb,
            this.config.evaluator,
            this.config.testEvaluationCriteria,
            this.botManager,
        );

        this.prodPromotion = new ProdPromotionStage(
            this.pipelineDb,
            this.config.prodPromotion,
        );

        this.prodMonitor = new ProdMonitorStage(
            this.pipelineDb,
            this.config.prodMonitor,
            this.config.prodRetirementCriteria,
            this.botManager,
        );
    }

    // =========================================================================
    // Lifecycle
    // =========================================================================

    /**
     * Starts all pipeline stages. Called from startAllServices() in index.ts.
     */
    public start(): void {
        console.log('[BotPipeline] Starting...');

        // Recover any bots that were running before process restart
        this.recoverRunningBots();

        // Start all stages
        this.simRunner.start();
        this.promoter.start();
        this.evaluator.start();
        this.prodPromotion.start();
        this.prodMonitor.start();

        console.log('[BotPipeline] All stages started.');
    }

    /**
     * Stops all pipeline stages. Called from stopAllServices() in index.ts.
     */
    public stop(): void {
        console.log('[BotPipeline] Stopping...');

        this.simRunner.stop();
        this.promoter.stop();
        this.evaluator.stop();
        this.prodPromotion.stop();
        this.prodMonitor.stop();

        // Stop all managed bots
        this.botManager.stopAll();

        console.log('[BotPipeline] All stages stopped.');
    }

    // =========================================================================
    // User Approval API (called from dashboard)
    // =========================================================================

    /**
     * Approves a PROD_CANDIDATE bot for production.
     * Instantiates the bot with PROD_MODE=true and adds to prodBots array.
     */
    public approveProdCandidate(botId: string): boolean {
        const record = this.pipelineDb.getBotById(botId);
        if (!record || record.state !== BotLifecycleState.PROD_CANDIDATE) {
            console.warn(`[BotPipeline] Cannot approve bot ${botId}: not in PROD_CANDIDATE state`);
            return false;
        }

        const activeProdBots = this.botManager.getActiveBotCount().prod;
        if (activeProdBots >= this.config.maxConcurrentBots.prod) {
            console.warn(
                `[BotPipeline] Cannot approve bot ${botId}: prod limit (${this.config.maxConcurrentBots.prod}) reached`
            );
            return false;
        }

        // Create prod bot instance first so we only stop the test bot once
        // we know the prod bot can be instantiated successfully.
        const bot = loadBotFromLifecycleRecord(record, {
            ...this.commonProdProps,
            PROD_MODE: true,
        });

        if (!bot) {
            console.error(`[BotPipeline] Failed to instantiate prod bot ${botId}`);
            return false;
        }

        // Remove any running test instance before starting prod mode to avoid
        // having duplicate bots trading simultaneously.
        const removed = this.botManager.removeBot(botId);
        if (!removed) {
            console.log(`[BotPipeline] No existing test bot ${botId} to remove (may have been stopped already).`);
        }

        // Add to prod runtime
        this.botManager.addProdBot(bot, botId);

        // Update DB
        const approved = this.pipelineDb.approveProdCandidate(botId);
        if (approved) {
            console.log(`[BotPipeline] Bot ${botId} approved for production.`);
        }

        return approved;
    }

    /**
     * Rejects a PROD_CANDIDATE bot. Removes from test runtime and retires.
     */
    public rejectProdCandidate(botId: string, reason?: string): boolean {
        // Remove from test runtime if still running
        this.botManager.removeBot(botId);

        // Update DB
        const rejected = this.pipelineDb.rejectProdCandidate(botId, reason);
        if (rejected) {
            console.log(`[BotPipeline] Bot ${botId} rejected: ${reason ?? 'No reason given'}`);
        }

        return rejected;
    }

    /**
     * Force-retires any running bot (test or prod).
     */
    public forceRetireBot(botId: string, reason?: string): boolean {
        const record = this.pipelineDb.getBotById(botId);
        if (!record) return false;

        // Remove from runtime
        this.botManager.removeBot(botId);

        // Update DB
        this.pipelineDb.updateBotState(botId, BotLifecycleState.RETIRED, {
            retiredAt: Date.now(),
            retireReason: reason ?? 'Force-retired by user',
        });

        this.pipelineDb.insertPipelineEvent({
            timestamp: Date.now(),
            stageName: 'UserAction',
            eventType: 'BOT_RETIRED',
            botId,
            detailsJson: JSON.stringify({ reason: reason ?? 'Force-retired by user' }),
            severity: 'INFO',
        });

        console.log(`[BotPipeline] Bot ${botId} force-retired: ${reason ?? 'No reason given'}`);
        return true;
    }

    // =========================================================================
    // Dashboard Query API
    // =========================================================================

    /** Returns the PipelineDatabase for dashboard queries. */
    public getDatabase(): PipelineDatabase {
        return this.pipelineDb;
    }

    /** Returns active bot counts. */
    public getActiveBotCounts(): { test: number; prod: number } {
        return this.botManager.getActiveBotCount();
    }

    /** Returns managed bot IDs. */
    public getManagedBotIds(): { test: string[]; prod: string[] } {
        return this.botManager.getManagedBotIds();
    }

    // =========================================================================
    // Internal: Recovery
    // =========================================================================

    /**
     * On process restart, re-instantiates bots that were TEST_RUNNING or PROD_RUNNING.
     */
    private recoverRunningBots(): void {
        console.log('[BotPipeline] Recovering running bots from database...');

        // Recover test bots
        const testBots = this.pipelineDb.getBotsByState(BotLifecycleState.TEST_RUNNING);
        for (const record of testBots) {
            try {
                const bot = loadBotFromLifecycleRecord(record, {
                    ...this.commonTestProps,
                    PROD_MODE: false,
                });
                if (bot) {
                    this.botManager.addTestBot(bot, record.botId);
                    console.log(`[BotPipeline] Recovered test bot: ${record.botId}`);
                } else {
                    console.warn(`[BotPipeline] Failed to recover test bot ${record.botId}, retiring`);
                    this.pipelineDb.updateBotState(record.botId, BotLifecycleState.RETIRED, {
                        retiredAt: Date.now(),
                        retireReason: 'Failed to recover after restart',
                    });
                }
            } catch (error) {
                console.error(`[BotPipeline] Error recovering test bot ${record.botId}:`, error);
            }
        }

        // Recover prod bots
        const prodBots = this.pipelineDb.getBotsByState(BotLifecycleState.PROD_RUNNING);
        for (const record of prodBots) {
            try {
                const bot = loadBotFromLifecycleRecord(record, {
                    ...this.commonProdProps,
                    PROD_MODE: true,
                });
                if (bot) {
                    this.botManager.addProdBot(bot, record.botId);
                    console.log(`[BotPipeline] Recovered prod bot: ${record.botId}`);
                } else {
                    console.warn(`[BotPipeline] Failed to recover prod bot ${record.botId}, retiring`);
                    this.pipelineDb.updateBotState(record.botId, BotLifecycleState.RETIRED, {
                        retiredAt: Date.now(),
                        retireReason: 'Failed to recover after restart',
                    });
                }
            } catch (error) {
                console.error(`[BotPipeline] Error recovering prod bot ${record.botId}:`, error);
            }
        }

        const recovered = testBots.length + prodBots.length;
        if (recovered > 0) {
            console.log(`[BotPipeline] Recovered ${testBots.length} test + ${prodBots.length} prod bots.`);
        }
    }
}
