/**
 * PipelineBotManager - Bridges the pipeline with live bot arrays.
 *
 * Manages adding/removing bots from the runtime testBots[] and prodBots[]
 * arrays. Tracks which bots are managed by the pipeline vs. manually configured.
 */
import { QuantBotRun, runBotsWithRestartOnFailure } from '../bots/QuantBot.js';

export class PipelineBotManager {
    private managedTestBots: Map<string, QuantBotRun> = new Map();
    private managedProdBots: Map<string, QuantBotRun> = new Map();

    constructor(
        private testBots: QuantBotRun[],
        private prodBots: QuantBotRun[],
    ) {}

    /**
     * Adds a bot to the test runtime.
     * Starts the bot and adds it to the testBots array.
     */
    public addTestBot(bot: QuantBotRun, botId: string): void {
        if (this.managedTestBots.has(botId)) {
            console.warn(`[PipelineBotManager] Test bot ${botId} already exists, skipping`);
            return;
        }

        console.log(`[PipelineBotManager] Adding test bot: ${botId} (${bot.name})`);
        runBotsWithRestartOnFailure([bot], 'PIPELINE-TEST');
        this.managedTestBots.set(botId, bot);
        this.testBots.push(bot);
    }

    /**
     * Adds a bot to the prod runtime.
     * Starts the bot and adds it to the prodBots array.
     */
    public addProdBot(bot: QuantBotRun, botId: string): void {
        if (this.managedProdBots.has(botId)) {
            console.warn(`[PipelineBotManager] Prod bot ${botId} already exists, skipping`);
            return;
        }

        console.log(`[PipelineBotManager] Adding prod bot: ${botId} (${bot.name})`);
        runBotsWithRestartOnFailure([bot], 'PIPELINE-PROD');
        this.managedProdBots.set(botId, bot);
        this.prodBots.push(bot);
    }

    /**
     * Removes a bot from the runtime (test or prod).
     * Stops the bot and removes it from the appropriate array.
     */
    public removeBot(botId: string): boolean {
        // Try test bots first
        const testBot = this.managedTestBots.get(botId);
        if (testBot) {
            console.log(`[PipelineBotManager] Removing test bot: ${botId}`);
            try {
                testBot.stop();
            } catch (e) {
                console.error(`[PipelineBotManager] Error stopping test bot ${botId}:`, e);
            }
            const idx = this.testBots.indexOf(testBot);
            if (idx >= 0) this.testBots.splice(idx, 1);
            this.managedTestBots.delete(botId);
            return true;
        }

        // Try prod bots
        const prodBot = this.managedProdBots.get(botId);
        if (prodBot) {
            console.log(`[PipelineBotManager] Removing prod bot: ${botId}`);
            try {
                prodBot.stop();
            } catch (e) {
                console.error(`[PipelineBotManager] Error stopping prod bot ${botId}:`, e);
            }
            const idx = this.prodBots.indexOf(prodBot);
            if (idx >= 0) this.prodBots.splice(idx, 1);
            this.managedProdBots.delete(botId);
            return true;
        }

        console.warn(`[PipelineBotManager] Bot ${botId} not found in managed bots`);
        return false;
    }

    /**
     * Checks if a bot is currently managed by the pipeline.
     */
    public isManagedBot(botId: string): boolean {
        return this.managedTestBots.has(botId) || this.managedProdBots.has(botId);
    }

    /**
     * Returns the count of actively managed bots.
     */
    public getActiveBotCount(): { test: number; prod: number } {
        return {
            test: this.managedTestBots.size,
            prod: this.managedProdBots.size,
        };
    }

    /**
     * Returns the IDs of all managed bots.
     */
    public getManagedBotIds(): { test: string[]; prod: string[] } {
        return {
            test: [...this.managedTestBots.keys()],
            prod: [...this.managedProdBots.keys()],
        };
    }

    /**
     * Stops all managed bots and clears the tracking maps.
     */
    public stopAll(): void {
        console.log(`[PipelineBotManager] Stopping all managed bots (${this.managedTestBots.size} test, ${this.managedProdBots.size} prod)`);

        for (const [id, bot] of this.managedTestBots) {
            try {
                bot.stop();
                const idx = this.testBots.indexOf(bot);
                if (idx >= 0) this.testBots.splice(idx, 1);
            } catch (e) {
                console.error(`[PipelineBotManager] Error stopping test bot ${id}:`, e);
            }
        }

        for (const [id, bot] of this.managedProdBots) {
            try {
                bot.stop();
                const idx = this.prodBots.indexOf(bot);
                if (idx >= 0) this.prodBots.splice(idx, 1);
            } catch (e) {
                console.error(`[PipelineBotManager] Error stopping prod bot ${id}:`, e);
            }
        }

        this.managedTestBots.clear();
        this.managedProdBots.clear();
    }
}
