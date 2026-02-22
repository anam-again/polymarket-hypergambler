/**
 * TestEvaluatorStage - Evaluates TEST_RUNNING bots after 48h+.
 *
 * Interval: Every 1 hour (configurable)
 * - Finds TEST_RUNNING bots with 48h+ of live data
 * - Queries trade_audits for PnL, win rate, trade count
 * - Passes: transitions to PROD_CANDIDATE
 * - Fails: removes bot, transitions to RETIRED
 */
import { BasePipelineStage } from './BasePipelineStage.js';
import { PipelineDatabase } from './PipelineDatabase.js';
import { PipelineBotManager } from './PipelineBotManager.js';
import { BotLifecycleState } from './types.js';
import type { PipelineStageConfig, TestEvaluationCriteria } from './types.js';

// ============================================================================
// Configuration
// ============================================================================

export interface TestEvaluatorConfig extends PipelineStageConfig {
    evaluationWindowMs: number;
}

// ============================================================================
// TestEvaluatorStage
// ============================================================================

export class TestEvaluatorStage extends BasePipelineStage {
    readonly name = 'TestEvaluator';

    private evaluatorConfig: TestEvaluatorConfig;
    private criteria: TestEvaluationCriteria;
    private botManager: PipelineBotManager;

    constructor(
        pipelineDb: PipelineDatabase,
        evaluatorConfig: TestEvaluatorConfig,
        criteria: TestEvaluationCriteria,
        botManager: PipelineBotManager,
    ) {
        super(pipelineDb, evaluatorConfig);
        this.evaluatorConfig = evaluatorConfig;
        this.criteria = criteria;
        this.botManager = botManager;
    }

    public async runOnce(): Promise<void> {
        // Find TEST_RUNNING bots that have been running long enough
        const readyBots = this.pipelineDb.getTestBotsReadyForEvaluation(
            this.evaluatorConfig.evaluationWindowMs
        );

        if (readyBots.length === 0) {
            console.log(`[${this.name}] No test bots ready for evaluation`);
            return;
        }

        let passed = 0;
        let failed = 0;

        for (const bot of readyBots) {
            // Get metrics from trade_audits since test start
            const metrics = this.pipelineDb.getTestBotMetrics(
                bot.botId,
                bot.testStartTimestamp ?? (Date.now() - this.evaluatorConfig.evaluationWindowMs),
            );

            const meetsRequirements = (
                metrics.pnl >= this.criteria.minTestPnl &&
                metrics.winRate >= this.criteria.minTestWinRate &&
                metrics.tradeCount >= this.criteria.minTestTrades
            );

            console.log(
                `[${this.name}] Evaluating ${bot.botId}: ` +
                `PnL=$${metrics.pnl.toFixed(2)}, WinRate=${metrics.winRate.toFixed(1)}%, ` +
                `Trades=${metrics.tradeCount}, Sharpe=${metrics.sharpe.toFixed(2)}, ` +
                `Pass=${meetsRequirements}`
            );

            if (meetsRequirements) {
                // Transition: TEST_RUNNING -> TEST_EVALUATED -> PROD_CANDIDATE
                this.pipelineDb.updateBotState(bot.botId, BotLifecycleState.TEST_EVALUATED, {
                    testPnl: metrics.pnl,
                    testWinRate: metrics.winRate,
                    testTradeCount: metrics.tradeCount,
                    testSharpe: metrics.sharpe,
                    testEvaluatedAt: Date.now(),
                });

                this.logEvent('BOT_EVALUATED', bot.botId, {
                    result: 'PASS',
                    pnl: metrics.pnl,
                    winRate: metrics.winRate,
                    tradeCount: metrics.tradeCount,
                    sharpe: metrics.sharpe,
                });

                // Immediately promote to PROD_CANDIDATE (awaiting user approval)
                this.pipelineDb.updateBotState(bot.botId, BotLifecycleState.PROD_CANDIDATE, {
                    promotedBy: 'TestEvaluator',
                });

                this.logEvent('BOT_PROMOTED_TO_PROD_CANDIDATE', bot.botId, {
                    strategy: bot.strategy,
                    market: bot.market,
                    testPnl: metrics.pnl,
                    testWinRate: metrics.winRate,
                });

                console.log(`[${this.name}] Bot ${bot.botId} promoted to PROD_CANDIDATE (awaiting user approval)`);
                passed++;

            } else {
                // Failed evaluation - remove and retire
                this.botManager.removeBot(bot.botId);

                const reasons: string[] = [];
                if (metrics.pnl < this.criteria.minTestPnl) {
                    reasons.push(`PnL $${metrics.pnl.toFixed(2)} < $${this.criteria.minTestPnl}`);
                }
                if (metrics.winRate < this.criteria.minTestWinRate) {
                    reasons.push(`WinRate ${metrics.winRate.toFixed(1)}% < ${this.criteria.minTestWinRate}%`);
                }
                if (metrics.tradeCount < this.criteria.minTestTrades) {
                    reasons.push(`Trades ${metrics.tradeCount} < ${this.criteria.minTestTrades}`);
                }
                const retireReason = `Failed test evaluation: ${reasons.join('; ')}`;

                this.pipelineDb.updateBotState(bot.botId, BotLifecycleState.RETIRED, {
                    testPnl: metrics.pnl,
                    testWinRate: metrics.winRate,
                    testTradeCount: metrics.tradeCount,
                    testSharpe: metrics.sharpe,
                    testEvaluatedAt: Date.now(),
                    retiredAt: Date.now(),
                    retireReason,
                });

                this.logEvent('BOT_EVALUATED', bot.botId, {
                    result: 'FAIL',
                    reason: retireReason,
                    pnl: metrics.pnl,
                    winRate: metrics.winRate,
                    tradeCount: metrics.tradeCount,
                });

                console.log(`[${this.name}] Bot ${bot.botId} RETIRED: ${retireReason}`);
                failed++;
            }
        }

        this.logEvent('STAGE_RUN_COMPLETE', undefined, {
            evaluated: readyBots.length,
            passed,
            failed,
        });

        console.log(`[${this.name}] Run complete. Evaluated ${readyBots.length}: ${passed} passed, ${failed} failed.`);
    }
}
