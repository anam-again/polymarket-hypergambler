/**
 * ProdPromotionStage - Monitors PROD_CANDIDATE bots awaiting user approval.
 *
 * Interval: Every 2 hours (configurable)
 * - Does NOT auto-approve - only logs PROD_CANDIDATE bots
 * - User approves via dashboard API -> BotPipeline.approveProdCandidate()
 * - Serves as a monitoring/alerting stage
 */
import { BasePipelineStage } from './BasePipelineStage.js';
import { PipelineDatabase } from './PipelineDatabase.js';
import { BotLifecycleState } from './types.js';
import type { PipelineStageConfig } from './types.js';

// ============================================================================
// ProdPromotionStage
// ============================================================================

export class ProdPromotionStage extends BasePipelineStage {
    readonly name = 'ProdPromotion';

    constructor(
        pipelineDb: PipelineDatabase,
        config: PipelineStageConfig,
    ) {
        super(pipelineDb, config);
    }

    public async runOnce(): Promise<void> {
        // Check for PROD_CANDIDATE bots awaiting approval
        const candidates = this.pipelineDb.getBotsByState(BotLifecycleState.PROD_CANDIDATE);

        if (candidates.length === 0) {
            console.log(`[${this.name}] No PROD_CANDIDATE bots awaiting approval`);
            return;
        }

        // Log each candidate for visibility
        console.log(`[${this.name}] ${candidates.length} bot(s) awaiting user approval for production:`);
        for (const bot of candidates) {
            const waitTime = Date.now() - (bot.updatedAt ?? bot.createdAt);
            const waitHours = (waitTime / (60 * 60 * 1000)).toFixed(1);

            console.log(
                `  - ${bot.botId}: ${bot.strategy}/${bot.market} | ` +
                `SimPnL=$${(bot.simPnl ?? 0).toFixed(2)} | ` +
                `TestPnL=$${(bot.testPnl ?? 0).toFixed(2)} | ` +
                `TestWinRate=${(bot.testWinRate ?? 0).toFixed(1)}% | ` +
                `Waiting ${waitHours}h`
            );
        }

        this.logEvent('STAGE_RUN_COMPLETE', undefined, {
            candidatesWaiting: candidates.length,
            candidates: candidates.map(c => ({
                botId: c.botId,
                strategy: c.strategy,
                market: c.market,
                simPnl: c.simPnl,
                testPnl: c.testPnl,
            })),
        });

        console.log(
            `[${this.name}] Run complete. ${candidates.length} candidate(s) awaiting approval.` +
            ` Approve via dashboard: POST /api/pipeline/bot/:botId/approve`
        );
    }
}
