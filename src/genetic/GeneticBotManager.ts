import { ClobClient } from '@polymarket/clob-client';
import { MarketInfo } from '../nonBots/MarketInfo.js';
import { QuantBotRun, runBotsWithRestartOnFailure } from '../bots/QuantBot.js';
import { GeneticOptimizedReader, BotOverrides } from './GeneticOptimizedReader.js';
import { BotStyle } from './YamlBotSchema.js';
import { TargetedMarket } from '../types/interfaces.js';
import { formatDuration, getMsUntilNextHour } from '../utils/utils.js';

// ============================================================================
// Types
// ============================================================================

export interface GeneticBotSpec {
    botStyle: BotStyle;
    market: TargetedMarket | string;
    overrides?: BotOverrides;
}

export interface GeneticBotManagerOptions {
    client: ClobClient;
    marketInfo: MarketInfo;
    refreshIntervalHours?: number;  // Default: 1 hour
    yamlDir?: string;
}

// ============================================================================
// GeneticBotManager Class
// ============================================================================

/**
 * Manages genetic bots with periodic refresh capability.
 * Bots are reloaded from YAML files at each refresh interval,
 * picking up any parameter changes from the GeneticOptimizedWriter.
 */
export class GeneticBotManager {
    private reader: GeneticOptimizedReader;
    private refreshIntervalMs: number;
    private refreshTimer: ReturnType<typeof setTimeout> | null = null;
    private isRunning: boolean = false;

    // Bot specifications (what bots to load)
    private testBotSpecs: GeneticBotSpec[] = [];
    private prodBotSpecs: GeneticBotSpec[] = [];

    // Currently running bot instances
    private activeTestBots: QuantBotRun[] = [];
    private activeProdBots: QuantBotRun[] = [];

    constructor(options: GeneticBotManagerOptions) {
        this.reader = new GeneticOptimizedReader({
            client: options.client,
            marketInfo: options.marketInfo,
            yamlDir: options.yamlDir,
        });
        this.refreshIntervalMs = (options.refreshIntervalHours ?? 1) * 60 * 60 * 1000;
    }

    // -------------------------------------------------------------------------
    // Configuration
    // -------------------------------------------------------------------------

    /**
     * Adds a test bot specification. The bot will be loaded from YAML on each refresh.
     */
    public addTestBot(spec: GeneticBotSpec): this {
        this.testBotSpecs.push(spec);
        return this;
    }

    /**
     * Adds a prod bot specification. The bot will be loaded from YAML on each refresh.
     */
    public addProdBot(spec: GeneticBotSpec): this {
        this.prodBotSpecs.push(spec);
        return this;
    }

    /**
     * Adds multiple test bot specifications.
     */
    public addTestBots(specs: GeneticBotSpec[]): this {
        this.testBotSpecs.push(...specs);
        return this;
    }

    /**
     * Adds multiple prod bot specifications.
     */
    public addProdBots(specs: GeneticBotSpec[]): this {
        this.prodBotSpecs.push(...specs);
        return this;
    }

    // -------------------------------------------------------------------------
    // Lifecycle
    // -------------------------------------------------------------------------

    /**
     * Starts the manager: loads bots and schedules periodic refresh.
     */
    public start(): void {
        if (this.isRunning) {
            console.log('[GeneticBotManager] Already running');
            return;
        }

        console.log('[GeneticBotManager] Starting...');
        console.log(`[GeneticBotManager] Test bot specs: ${this.testBotSpecs.length}`);
        console.log(`[GeneticBotManager] Prod bot specs: ${this.prodBotSpecs.length}`);
        console.log(`[GeneticBotManager] Refresh interval: ${this.refreshIntervalMs / (60 * 60 * 1000)} hours`);

        this.isRunning = true;

        // Load and start bots immediately
        this.loadAndStartBots();

        // Schedule refresh at the top of each hour (aligned with GeneticOptimizedWriter)
        this.scheduleNextRefresh();
    }

    /**
     * Stops the manager and all managed bots.
     */
    public stop(): void {
        if (!this.isRunning) {
            return;
        }

        console.log('[GeneticBotManager] Stopping...');

        // Cancel scheduled refresh
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
            this.refreshTimer = null;
        }

        // Stop all active bots
        this.stopAllBots();

        this.isRunning = false;
        console.log('[GeneticBotManager] Stopped');
    }

    /**
     * Returns the currently active test bots.
     */
    public getActiveTestBots(): QuantBotRun[] {
        return this.activeTestBots;
    }

    /**
     * Returns the currently active prod bots.
     */
    public getActiveProdBots(): QuantBotRun[] {
        return this.activeProdBots;
    }

    // -------------------------------------------------------------------------
    // Internal: Bot Loading
    // -------------------------------------------------------------------------

    private loadAndStartBots(): void {
        console.log('[GeneticBotManager] Loading bots from YAML files...');

        // Load test bots
        const newTestBots: QuantBotRun[] = [];
        for (const spec of this.testBotSpecs) {
            try {
                const bot = this.reader.getBot(spec.botStyle, spec.market, spec.overrides);
                if (bot) {
                    newTestBots.push(bot);
                }
            } catch (error) {
                console.error(`[GeneticBotManager] Failed to load test bot ${spec.botStyle}-${spec.market}: ${error}`);
            }
        }

        // Load prod bots
        const newProdBots: QuantBotRun[] = [];
        for (const spec of this.prodBotSpecs) {
            try {
                const bot = this.reader.getBot(spec.botStyle, spec.market, spec.overrides);
                if (bot) {
                    newProdBots.push(bot);
                }
            } catch (error) {
                console.error(`[GeneticBotManager] Failed to load prod bot ${spec.botStyle}-${spec.market}: ${error}`);
            }
        }

        // Store the new bots
        this.activeTestBots = newTestBots;
        this.activeProdBots = newProdBots;

        console.log(`[GeneticBotManager] Loaded ${newTestBots.length} test bots, ${newProdBots.length} prod bots`);

        // Start the bots
        if (newTestBots.length > 0) {
            console.log('[GeneticBotManager] Starting test bots...');
            runBotsWithRestartOnFailure(newTestBots, 'GENETIC-TEST');
        }

        if (newProdBots.length > 0) {
            console.log('[GeneticBotManager] Starting prod bots...');
            runBotsWithRestartOnFailure(newProdBots, 'GENETIC-PROD');
        }
    }

    private stopAllBots(): void {
        console.log('[GeneticBotManager] Stopping all active bots...');

        for (const bot of this.activeTestBots) {
            try {
                bot.stop();
            } catch (error) {
                console.error(`[GeneticBotManager] Error stopping test bot ${bot.name}: ${error}`);
            }
        }

        for (const bot of this.activeProdBots) {
            try {
                bot.stop();
            } catch (error) {
                console.error(`[GeneticBotManager] Error stopping prod bot ${bot.name}: ${error}`);
            }
        }

        this.activeTestBots = [];
        this.activeProdBots = [];
    }

    // -------------------------------------------------------------------------
    // Internal: Refresh Scheduling
    // -------------------------------------------------------------------------

    private scheduleNextRefresh(): void {
        if (!this.isRunning) {
            return;
        }

        // Align refresh to the top of the next hour + 5 minutes
        // This gives the GeneticOptimizedWriter time to finish writing new YAML files
        const msUntilNextHour = getMsUntilNextHour();
        const refreshDelay = msUntilNextHour; // 5 minutes after the hour

        console.log(`[GeneticBotManager] Next refresh in ${formatDuration(refreshDelay)}`);

        this.refreshTimer = setTimeout(() => {
            this.refresh();
        }, refreshDelay);
    }

    /**
     * Refreshes all bots: stops current bots and loads fresh ones from YAML.
     */
    private refresh(): void {
        if (!this.isRunning) {
            return;
        }

        console.log('\n' + '='.repeat(60));
        console.log(`[GeneticBotManager] Refreshing bots at ${new Date().toISOString()}`);
        console.log('='.repeat(60));

        // Stop all current bots
        this.stopAllBots();

        // Small delay to ensure clean shutdown
        setTimeout(() => {
            // Load and start fresh bots
            this.loadAndStartBots();

            // Schedule next refresh
            this.scheduleNextRefresh();
        }, 2000);
    }
}
