/**
 * ProdMonitorStage - Monitors PROD_RUNNING bots and retires underperformers.
 *
 * Interval: Every 30 minutes (configurable)
 * - Evaluates PROD_RUNNING bots on a rolling 48h window
 * - Retires bots with PnL below threshold or win rate below minimum
 * - Updates prod metrics in bot_lifecycle on each check
 */
import { BasePipelineStage } from './BasePipelineStage.js';
import { PipelineDatabase } from './PipelineDatabase.js';
import { PipelineBotManager } from './PipelineBotManager.js';
import { BotLifecycleState } from './types.js';
import type { PipelineStageConfig, ProdRetirementCriteria } from './types.js';

// ============================================================================
// Configuration
// ============================================================================

export interface ProdMonitorConfig extends PipelineStageConfig {
    evaluationWindowMs: number;
}

// ============================================================================
// ProdMonitorStage
// ============================================================================

export class ProdMonitorStage extends BasePipelineStage {
    readonly name = 'ProdMonitor';

    private monitorConfig: ProdMonitorConfig;
    private criteria: ProdRetirementCriteria;
    private botManager: PipelineBotManager;

    constructor(
        pipelineDb: PipelineDatabase,
        monitorConfig: ProdMonitorConfig,
        criteria: ProdRetirementCriteria,
        botManager: PipelineBotManager,
    ) {
        super(pipelineDb, monitorConfig);
        this.monitorConfig = monitorConfig;
        this.criteria = criteria;
        this.botManager = botManager;
    }

    public async runOnce(): Promise<void> {
        // Get all PROD_RUNNING bots managed by the pipeline
        const prodBots = this.pipelineDb.getBotsByState(BotLifecycleState.PROD_RUNNING);

        if (prodBots.length === 0) {
            console.log(`[${this.name}] No PROD_RUNNING bots to monitor`);
            return;
        }

        let retired = 0;

        for (const bot of prodBots) {
            // Only evaluate bots managed by the pipeline
            if (!this.botManager.isManagedBot(bot.botId)) {
                continue;
            }

            // Get rolling window metrics
            const metrics = this.pipelineDb.getProdBotMetrics(
                bot.botId,
                this.monitorConfig.evaluationWindowMs,
            );

            // Update prod metrics in DB
            this.pipelineDb.updateBotState(bot.botId, BotLifecycleState.PROD_RUNNING, {
                prodPnl: metrics.pnl,
                prodWinRate: metrics.winRate,
                prodTradeCount: metrics.tradeCount,
                prodLastChecked: Date.now(),
            });

            console.log(
                `[${this.name}] ${bot.botId}: PnL=$${metrics.pnl.toFixed(2)}, ` +
                `WinRate=${metrics.winRate.toFixed(1)}%, Trades=${metrics.tradeCount}`
            );

            // Check retirement criteria (only if enough trades for evaluation)
            if (metrics.tradeCount >= this.criteria.minTradesForEvaluation) {
                const shouldRetire = (
                    metrics.pnl < this.criteria.maxNegativePnl ||
                    metrics.winRate < this.criteria.minWinRate
                );

                if (shouldRetire) {
                    const reasons: string[] = [];
                    if (metrics.pnl < this.criteria.maxNegativePnl) {
                        reasons.push(`PnL $${metrics.pnl.toFixed(2)} < $${this.criteria.maxNegativePnl}`);
                    }
                    if (metrics.winRate < this.criteria.minWinRate) {
                        reasons.push(`WinRate ${metrics.winRate.toFixed(1)}% < ${this.criteria.minWinRate}%`);
                    }
                    const retireReason = `Failed prod monitoring: ${reasons.join('; ')}`;

                    // Remove from runtime
                    this.botManager.removeBot(bot.botId);

                    // Update DB
                    this.pipelineDb.updateBotState(bot.botId, BotLifecycleState.RETIRED, {
                        prodPnl: metrics.pnl,
                        prodWinRate: metrics.winRate,
                        prodTradeCount: metrics.tradeCount,
                        prodLastChecked: Date.now(),
                        retiredAt: Date.now(),
                        retireReason,
                    });

                    this.logEvent('BOT_RETIRED', bot.botId, {
                        reason: retireReason,
                        pnl: metrics.pnl,
                        winRate: metrics.winRate,
                        tradeCount: metrics.tradeCount,
                    });

                    console.log(`[${this.name}] RETIRED ${bot.botId}: ${retireReason}`);
                    retired++;
                }
            }
        }

        this.logEvent('STAGE_RUN_COMPLETE', undefined, {
            monitored: prodBots.length,
            retired,
        });

        console.log(`[${this.name}] Run complete. Monitored ${prodBots.length} bots, retired ${retired}.`);
    }
}
