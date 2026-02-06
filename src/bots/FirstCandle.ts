import { Side } from "@polymarket/clob-client";

import { QuantBot, QuantBotProps, QuantBotRun, TradeOrder, TradeStatus } from "./QuantBot.js";
import { MarketSchedule } from "../types/interfaces.js";

// ============================================================================
// Types & Interfaces
// ============================================================================

interface FirstCandleProps extends QuantBotProps {
    candleMinutes: number;          // Duration of first candle (e.g., 30 minutes)
    breakoutBuffer: number;         // Price buffer beyond high/low to confirm breakout (e.g., 50 = $50)
    pullbackBuffer: number;         // How close price must return to broken level (e.g., 100 = within $100)
    targetBuyPrice: number;
    targetSellPrice: number;
    targetDollars: number;
    cutoffMinute: number;
}

type TradingState =
    | 'FORMING_CANDLE'      // First candle is still forming
    | 'WAITING_BREAKOUT'    // Candle formed, waiting for price to break range
    | 'WAITING_PULLBACK'    // Breakout occurred, waiting for pullback confirmation
    | 'TRADE_ENTERED'       // Trade has been placed
    | 'PAST_CUTOFF';        // Past cutoff, no more trading

type BreakoutDirection = 'UP' | 'DOWN';

// ============================================================================
// FirstCandle Class
// ============================================================================

export class FirstCandle extends QuantBot implements QuantBotRun {

    // --- Properties ---

    private candleMinutes: number;
    private breakoutBuffer: number;
    private pullbackBuffer: number;
    private targetBuyPrice: number;
    private targetSellPrice: number;
    private targetDollars: number;
    private cutoffMinute: number;

    private buyOrder?: TradeOrder;
    private sellOrder?: TradeOrder;

    // State tracking
    private state: TradingState = 'FORMING_CANDLE';
    private candleHigh: number = 0;
    private candleLow: number = Infinity;
    private breakoutDirection?: BreakoutDirection;
    private breakoutConfirmedPrice?: number;

    // --- Constructor ---

    constructor(props: FirstCandleProps) {
        super(props);

        this.candleMinutes = props.candleMinutes;
        this.breakoutBuffer = props.breakoutBuffer;
        this.pullbackBuffer = props.pullbackBuffer;
        this.targetBuyPrice = props.targetBuyPrice;
        this.targetSellPrice = props.targetSellPrice;
        this.targetDollars = props.targetDollars;
        this.cutoffMinute = props.cutoffMinute;
    }

    // --- Main Run Loop ---

    public async run(): Promise<void> {
        this.setupPeriodReset();
        this.startTradingLoop();
    }

    // -------------------------------------------------------------------------
    // Setup
    // -------------------------------------------------------------------------

    private setupPeriodReset(): void {
        this.registerResetHandler(async () => {
            await this.updateOrders();
            await this.auditAndReset();
            this.resetTradeState();
        });
    }

    protected override resetTradeState(): void {
        this.buyOrder = undefined;
        this.sellOrder = undefined;
        this.state = 'FORMING_CANDLE';
        this.candleHigh = 0;
        this.candleLow = Infinity;
        this.breakoutDirection = undefined;
        this.breakoutConfirmedPrice = undefined;
    }

    // -------------------------------------------------------------------------
    // Trading Loop
    // -------------------------------------------------------------------------

    private startTradingLoop(): void {
        this.tickWrapper(1000 * 3, 1000 * 3, async () => {
            await this.executeTradingLogic();
        });
    }

    /**
     * Core trading logic extracted for reuse by both production (tickWrapper)
     * and simulation (onSimulationTick) modes.
     */
    private async executeTradingLogic(): Promise<void> {
        await this.updateOrders();

        // Handle sell order creation if buy matched
        if (this.shouldCreateSellOrder()) {
            await this.createSellOrder();
        }

        if (this.state === 'PAST_CUTOFF' || this.state === 'TRADE_ENTERED') {
            return;
        }

        // Check cutoff
        if (this.isAfterCutoff()) {
            await this.handleCutoff();
            return;
        }

        // Execute state machine
        await this.executeStateMachine();
    }

    /**
     * Called on each simulation tick. Executes the bot's trading logic
     * without relying on real-time intervals.
     */
    public override async onSimulationTick(): Promise<void> {
        await this.executeTradingLogic();
    }

    // -------------------------------------------------------------------------
    // State Machine
    // -------------------------------------------------------------------------

    private async executeStateMachine(): Promise<void> {
        const currentPrice = await this.getCurrentBtcPrice();
        if (!currentPrice) return;

        switch (this.state) {
            case 'FORMING_CANDLE':
                this.handleFormingCandle(currentPrice);
                break;

            case 'WAITING_BREAKOUT':
                this.handleWaitingBreakout(currentPrice);
                break;

            case 'WAITING_PULLBACK':
                await this.handleWaitingPullback(currentPrice);
                break;
        }
    }

    private handleFormingCandle(currentPrice: number): void {
        // Update high/low
        this.candleHigh = Math.max(this.candleHigh, currentPrice);
        this.candleLow = Math.min(this.candleLow, currentPrice);

        const minuteInPeriod = this.getMinuteInPeriod();

        if (minuteInPeriod >= this.candleMinutes) {
            this.state = 'WAITING_BREAKOUT';
            this.writeLog(`First candle formed: High=${this.candleHigh.toFixed(2)}, Low=${this.candleLow.toFixed(2)}, Range=${(this.candleHigh - this.candleLow).toFixed(2)}`);
        }
    }

    private getMinuteInPeriod(): number {
        const currentMinute = this.clock.getMinutes();
        if (this.marketSchedule === MarketSchedule.QUARTERLY) {
            return currentMinute % 15;
        }
        return currentMinute;
    }

    private handleWaitingBreakout(currentPrice: number): void {
        const brokeAbove = currentPrice > this.candleHigh + this.breakoutBuffer;
        const brokeBelow = currentPrice < this.candleLow - this.breakoutBuffer;

        if (brokeAbove) {
            this.breakoutDirection = 'UP';
            this.breakoutConfirmedPrice = this.candleHigh;
            this.state = 'WAITING_PULLBACK';
            this.writeLog(`Breakout UP detected at ${currentPrice.toFixed(2)}, waiting for pullback to ${this.candleHigh.toFixed(2)}`);
        } else if (brokeBelow) {
            this.breakoutDirection = 'DOWN';
            this.breakoutConfirmedPrice = this.candleLow;
            this.state = 'WAITING_PULLBACK';
            this.writeLog(`Breakout DOWN detected at ${currentPrice.toFixed(2)}, waiting for pullback to ${this.candleLow.toFixed(2)}`);
        }
    }

    private async handleWaitingPullback(currentPrice: number): Promise<void> {
        if (!this.breakoutDirection || !this.breakoutConfirmedPrice) return;

        const isPullbackConfirmed = this.checkPullbackConfirmation(currentPrice);

        if (isPullbackConfirmed) {
            this.writeLog(`Pullback confirmed at ${currentPrice.toFixed(2)}, entering ${this.breakoutDirection} trade`);
            await this.createBuyOrder();
        }
    }

    private checkPullbackConfirmation(currentPrice: number): boolean {
        if (!this.breakoutDirection || !this.breakoutConfirmedPrice) return false;

        if (this.breakoutDirection === 'UP') {
            // For bullish breakout, price should pull back close to the high (now support)
            // and still be above it
            const pullbackToSupport = Math.abs(currentPrice - this.breakoutConfirmedPrice) <= this.pullbackBuffer;
            const stillAboveSupport = currentPrice >= this.breakoutConfirmedPrice;
            return pullbackToSupport && stillAboveSupport;
        } else {
            // For bearish breakout, price should pull back close to the low (now resistance)
            // and still be below it
            const pullbackToResistance = Math.abs(currentPrice - this.breakoutConfirmedPrice) <= this.pullbackBuffer;
            const stillBelowResistance = currentPrice <= this.breakoutConfirmedPrice;
            return pullbackToResistance && stillBelowResistance;
        }
    }

    // -------------------------------------------------------------------------
    // Order Logic
    // -------------------------------------------------------------------------

    private shouldCreateSellOrder(): boolean {
        if (this.sellOrder) return false;
        if (!this.buyOrder) return false;
        return this.buyOrder.status === TradeStatus.MATCHED;
    }

    private async createBuyOrder(): Promise<void> {
        if (this.buyOrder) {
            this.writeLog(`createBuyOrder: already have buyOrder, skipping`);
            return;
        }
        if (!this.breakoutDirection) {
            this.writeLog(`createBuyOrder: no breakoutDirection, skipping`);
            return;
        }

        const orderBooks = await this.marketInfo.getLiveData(this.targetedMarket);
        const tokenId = this.breakoutDirection === 'UP'
            ? orderBooks.BtcUpTokenId
            : orderBooks.BtcDownTokenId;

        const targetSize = this.dollarToTokens(this.targetDollars, this.targetBuyPrice);
        if (targetSize === null) {
            this.writeLog(
                `createBuyOrder: dollarToTokens returned null ` +
                `(targetDollars=${this.targetDollars}, targetBuyPrice=${this.targetBuyPrice})`
            );
            return;
        }

        const totalCost = this.targetBuyPrice * targetSize;

        if (!this.checkIfOrderIsValid(this.targetBuyPrice, targetSize)) {
            this.writeLog(
                `createBuyOrder: order invalid ` +
                `(price=${this.targetBuyPrice}, size=${targetSize})`
            );
            return;
        }
        if (!this.canSpend(totalCost)) {
            this.writeLog(
                `createBuyOrder: cannot spend ` +
                `(totalCost=${totalCost.toFixed(2)}, hourlyBudget check failed)`
            );
            return;
        }

        this.buyOrder = await this.makeOrder(
            'firstcandle-buy',
            tokenId,
            this.targetBuyPrice,
            targetSize,
            Side.BUY
        );

        if (this.buyOrder) {
            this.writeLog(
                `createBuyOrder: order placed successfully ` +
                `(orderId=${this.buyOrder.orderId}, size=${targetSize}, price=${this.targetBuyPrice})`
            );
        } else {
            this.writeLog(`createBuyOrder: makeOrder returned undefined`);
        }

        this.state = 'TRADE_ENTERED';
        // Sell order creation is handled by shouldCreateSellOrder() on each tick
    }

    private async createSellOrder(): Promise<void> {
        if (this.sellOrder || !this.buyOrder || !this.breakoutDirection) return;

        const orderBooks = await this.marketInfo.getLiveData(this.targetedMarket);
        const tokenId = this.breakoutDirection === 'UP'
            ? orderBooks.BtcUpTokenId
            : orderBooks.BtcDownTokenId;

        this.sellOrder = await this.makeOrder(
            'firstcandle-sell',
            tokenId,
            this.targetSellPrice,
            this.buyOrder.amount,
            Side.SELL
        );
    }

    // -------------------------------------------------------------------------
    // Price Data
    // -------------------------------------------------------------------------

    private async getCurrentBtcPrice(): Promise<number | null> {
        try {
            const cdMarketData = this.getCdMarketData();
            return await cdMarketData.getCurrentPriceByMarket(this.targetedMarket);
        } catch (error) {
            this.writeError(error);
            return null;
        }
    }

    // -------------------------------------------------------------------------
    // Cutoff Handling
    // -------------------------------------------------------------------------

    private isAfterCutoff(): boolean {
        const currentMinute = this.clock.getMinutes();
        if (this.marketSchedule === MarketSchedule.QUARTERLY) {
            return currentMinute % 15 >= this.cutoffMinute;
        } else {
            return currentMinute >= this.cutoffMinute;
        }
    }

    private async handleCutoff(): Promise<void> {
        this.state = 'PAST_CUTOFF';
        await this.cancelLiveBuyOrders();
    }

    private async cancelLiveBuyOrders(): Promise<void> {
        for (const trade of this.trades) {
            if (trade.status === TradeStatus.LIVE && trade.side === Side.BUY) {
                await this.cancelTrade(trade);
            }
        }
    }
}
