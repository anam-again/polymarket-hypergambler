import { Side, ClobClient } from '@polymarket/clob-client';
import { QuantBot, TradeOrder, TradeStatus } from '../bots/QuantBot.js';
import { SimulationClock } from './SimulationClock.js';
import { MockMarketInfo } from './MockMarketInfo.js';
import { MockCDMarketData } from './MockCDMarketData.js';
import { SimulatedBot, SimulatedTrade } from './HistoricalSimulator.js';
import { TargetedMarket } from '../types/interfaces.js';

// ============================================================================
// QuantBotSimulationAdapter
// ============================================================================

/**
 * Adapter that wraps a real QuantBot subclass for use in historical simulation.
 * This allows the simulator to use actual bot code instead of mock implementations.
 */
export class QuantBotSimulationAdapter implements SimulatedBot {
    public name: string;
    private bot: QuantBot;
    private clock: SimulationClock;
    private marketInfo: MockMarketInfo;
    private accumulatedTrades: SimulatedTrade[] = [];

    constructor(
        bot: QuantBot,
        clock: SimulationClock,
        marketInfo: MockMarketInfo
    ) {
        this.bot = bot;
        this.name = bot.name;
        this.clock = clock;
        this.marketInfo = marketInfo;
    }

    /**
     * Called each simulation tick.
     * Triggers the bot's per-tick trading logic including order updates,
     * state machine execution, signal detection, and order placement.
     */
    public async onTick(): Promise<void> {
        try {
            // Call the bot's simulation tick handler which includes trading logic
            await this.bot.onSimulationTick();
        } catch (error) {
            console.warn(`[${this.name}] Error in onTick: ${error}`);
        }
    }

    /**
     * Called when the simulated period ends (hourly or quarterly).
     * Triggers the bot's period-end logic including audit, reset, and state cleanup.
     */
    public async onHourChange(): Promise<void> {
        try {
            // Get trades from period end (includes expiry trades created during settlement)
            const periodTrades = await this.bot.onSimulationPeriodEnd();
            const simulatedTrades = periodTrades.map(trade =>
                this.convertToSimulatedTrade(trade)
            );
            this.accumulatedTrades.push(...simulatedTrades);
        } catch (error) {
            console.warn(`[${this.name}] Error in onHourChange: ${error}`);
        }
    }

    /**
     * Gets all trades from the bot in SimulatedTrade format.
     * Returns accumulated trades from previous periods plus any current trades.
     */
    public getTrades(): SimulatedTrade[] {
        // Include any trades from current (final) period that haven't been accumulated yet
        const currentTrades = this.bot.trades.map(trade =>
            this.convertToSimulatedTrade(trade)
        );
        return [...this.accumulatedTrades, ...currentTrades];
    }

    /**
     * Resets the bot state for a new simulation run.
     */
    public reset(): void {
        // Clear all trades
        this.bot.trades = [];
        this.accumulatedTrades = [];
    }

    /**
     * Disposes of the adapter and clears all references to help GC.
     * Call this after the simulation is complete and results have been extracted.
     */
    public dispose(): void {
        // Clear accumulated trades
        this.accumulatedTrades = [];

        // Stop the bot to clear any pending timers and cleanup
        if (this.bot) {
            this.bot.stop();
            this.bot.trades = [];
        }

        // Null out references to help GC (cast to any to allow nulling)
        (this as any).bot = null;
        (this as any).clock = null;
        (this as any).marketInfo = null;
    }

    /**
     * Converts a TradeOrder to SimulatedTrade format.
     */
    private convertToSimulatedTrade(trade: TradeOrder): SimulatedTrade {
        return {
            timestamp: trade.createdAt,
            botName: this.name,
            side: trade.side,
            tokenId: trade.clobTokenId,
            price: trade.side === Side.BUY ? (trade.targetBuyPrice ?? 0) : (trade.targetSellPrice ?? 0),
            amount: trade.amount,
            status: this.convertStatus(trade.status),
            pnl: trade.finalValue,
        };
    }

    /**
     * Converts TradeStatus to SimulatedTrade status.
     */
    private convertStatus(status: TradeStatus): 'PENDING' | 'MATCHED' | 'EXPIRED' | 'CANCELED' {
        switch (status) {
            case TradeStatus.LIVE:
                return 'PENDING';
            case TradeStatus.MATCHED:
            case TradeStatus.PARTIAL:
                return 'MATCHED';
            case TradeStatus.EXPIRED:
                return 'EXPIRED';
            case TradeStatus.CANCELED:
                return 'CANCELED';
            default:
                return 'PENDING';
        }
    }

    /**
     * Gets the underlying QuantBot instance.
     */
    public getBot(): QuantBot {
        return this.bot;
    }
}

// ============================================================================
// Factory Functions for Creating Adapted Bots
// ============================================================================

/**
 * Creates a mock ClobClient for simulation (does nothing).
 */
export function createMockClobClient(): ClobClient {
    // Return a proxy that returns empty/mock values for all methods
    return new Proxy({} as ClobClient, {
        get: (target, prop) => {
            // Return mock implementations for common methods
            if (prop === 'getOrder') {
                return async () => null;
            }
            if (prop === 'cancelOrder') {
                return async () => ({ success: true });
            }
            if (prop === 'createAndPostOrder') {
                return async () => ({
                    errorMsg: '',
                    makingAmount: 'mock',
                    orderID: `mock-${Math.random().toString(36).substring(2, 22)}`,
                    status: 'LIVE',
                    success: true,
                    takingAmount: 'mock',
                    transactionsHashes: ['mock'],
                });
            }
            // Default: return a no-op function
            return () => {};
        },
    });
}

/**
 * Configuration for creating a bot with simulation dependencies.
 */
export interface SimulationBotConfig<T extends QuantBot> {
    BotClass: new (props: unknown) => T;
    name: string;
    targetedMarket: TargetedMarket;
    hourlyDollarLimit: number;
    botParams: Record<string, unknown>;
}

/**
 * Creates a QuantBot instance configured for simulation.
 */
export function createSimulatedBot<T extends QuantBot>(
    config: SimulationBotConfig<T>,
    clock: SimulationClock,
    marketInfo: MockMarketInfo,
    cdMarketData: MockCDMarketData
): QuantBotSimulationAdapter {
    const mockClient = createMockClobClient();

    // Create the bot with simulation dependencies
    const bot = new config.BotClass({
        name: config.name,
        hourlyDollarLimit: config.hourlyDollarLimit,
        client: mockClient,
        marketInfo: marketInfo,
        PROD_MODE: false,
        targetedMarket: config.targetedMarket,
        clock: clock,
        ...config.botParams,
    });

    return new QuantBotSimulationAdapter(bot, clock, marketInfo);
}
