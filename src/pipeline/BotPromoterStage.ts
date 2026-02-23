/**
 * BotPromoterStage - Promotes SIMULATED bots to TEST_RUNNING.
 *
 * Interval: Every 30 minutes (configurable)
 * - Checks test bot count against limit
 * - Ranks SIMULATED bots by sim PnL
 * - Instantiates bot via botFactory, adds to runtime
 * - Transitions to TEST_RUNNING with testStartTimestamp
 */
import { BasePipelineStage } from './BasePipelineStage.js';
import { PipelineDatabase } from './PipelineDatabase.js';
import { PipelineBotManager } from './PipelineBotManager.js';
import { loadBotFromLifecycleRecord, type PipelineBotProps } from './botFactory.js';
import { BotLifecycleState } from './types.js';
import type { PipelineStageConfig } from './types.js';

// ============================================================================
// Configuration
// ============================================================================

export interface BotPromoterConfig extends PipelineStageConfig {
    maxTestBots: number;
    /** Optional global cap that includes non-pipeline managed bots */
    globalTestLimit?: number;
}

// ============================================================================
// BotPromoterStage
// ============================================================================

export class BotPromoterStage extends BasePipelineStage {
    readonly name = 'BotPromoter';

    private promoterConfig: BotPromoterConfig;
    private botManager: PipelineBotManager;
    private commonTestProps: PipelineBotProps;

    constructor(
        pipelineDb: PipelineDatabase,
        promoterConfig: BotPromoterConfig,
        botManager: PipelineBotManager,
        commonTestProps: PipelineBotProps,
    ) {
        super(pipelineDb, promoterConfig);
        this.promoterConfig = promoterConfig;
        this.botManager = botManager;
        this.commonTestProps = commonTestProps;
    }

    public async runOnce(): Promise<void> {
        const activeCount = this.botManager.getActiveBotCount().test;
        const globalLimit = this.promoterConfig.globalTestLimit ?? this.promoterConfig.maxTestBots;
        const effectiveMax = Math.min(this.promoterConfig.maxTestBots, globalLimit);
        const slotsAvailable = Math.max(0, effectiveMax - activeCount);

        if (slotsAvailable <= 0) {
            const limitReason = effectiveMax < this.promoterConfig.maxTestBots
                ? `${activeCount}/${effectiveMax} (global max reached)`
                : `${activeCount}/${this.promoterConfig.maxTestBots}`;
            console.log(`[${this.name}] No test slots available (${limitReason})`);
            return;
        }

        // Get SIMULATED bots, ranked by sim PnL descending
        const candidates = this.pipelineDb.getBotsByState(BotLifecycleState.SIMULATED);
        if (candidates.length === 0) {
            console.log(`[${this.name}] No SIMULATED bots to promote`);
            return;
        }

        // Sort by sim PnL descending (best candidates first)
        candidates.sort((a, b) => (b.simPnl ?? 0) - (a.simPnl ?? 0));

        let promoted = 0;
        for (const candidate of candidates) {
            if (promoted >= slotsAvailable) break;

            // Skip if this bot is already managed (shouldn't happen, but safety check)
            if (this.botManager.isManagedBot(candidate.botId)) {
                console.log(`[${this.name}] Bot ${candidate.botId} already managed, skipping`);
                continue;
            }

            try {
                // Create bot instance using factory
                const bot = loadBotFromLifecycleRecord(candidate, {
                    ...this.commonTestProps,
                    PROD_MODE: false,
                });

                if (!bot) {
                    console.warn(`[${this.name}] Failed to instantiate bot ${candidate.botId} (unsupported strategy?)`);
                    // Retire it since we can't create it
                    this.pipelineDb.updateBotState(candidate.botId, BotLifecycleState.RETIRED, {
                        retiredAt: Date.now(),
                        retireReason: 'Failed to instantiate bot from lifecycle record',
                    });
                    continue;
                }

                // Add to runtime
                this.botManager.addTestBot(bot, candidate.botId);

                // Update state to TEST_RUNNING
                this.pipelineDb.updateBotState(candidate.botId, BotLifecycleState.TEST_RUNNING, {
                    testStartTimestamp: Date.now(),
                });

                this.logEvent('BOT_PROMOTED_TO_TEST', candidate.botId, {
                    strategy: candidate.strategy,
                    market: candidate.market,
                    simPnl: candidate.simPnl,
                    simSharpe: candidate.simSharpe,
                });

                console.log(
                    `[${this.name}] Promoted to TEST: ${candidate.botId} ` +
                    `(${candidate.strategy}/${candidate.market}, simPnL=$${(candidate.simPnl ?? 0).toFixed(2)})`
                );

                promoted++;
            } catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                console.error(`[${this.name}] Error promoting ${candidate.botId}: ${msg}`);
            }
        }

        this.logEvent('STAGE_RUN_COMPLETE', undefined, {
            promoted,
            candidatesAvailable: candidates.length,
            slotsAvailable,
        });

        console.log(`[${this.name}] Run complete. Promoted ${promoted} bots to test.`);
    }
}
