import { Side } from "@polymarket/clob-client";

import { QuantBot, QuantBotProps, QuantBotRun, TradeOrder, TradeStatus } from "./QuantBot.js";
import { CDMarketData } from "../nonBots/CDMarketData.js";
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
    targetSize: number;
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
    private targetSize: number;
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
        this.targetSize = props.targetSize;
        this.cutoffMinute = props.cutoffMinute;
    }

    // --- Main Run Loop ---

    public async run(): Promise<void> {
        this.setupHourlyReset();
        this.startTradingLoop();
    }

    // -------------------------------------------------------------------------
    // Setup
    // -------------------------------------------------------------------------

    private setupHourlyReset(): void {
        this.on('reset', async () => {
            await this.updateOrders();
            await this.auditAndReset();
            this.resetState();
        });
    }

    private resetState(): void {
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
            await this.updateOrders();

            // Handle sell order creation if buy matched
            if (this.shouldCreateSellOrder()) {
                await this.createSellOrder();
            }

            // Check cutoff
            if (this.isAfterCutoff() && this.state !== 'TRADE_ENTERED') {
                await this.handleCutoff();
                return;
            }

            if (this.state === 'PAST_CUTOFF' || this.state === 'TRADE_ENTERED') {
                return;
            }

            // Execute state machine
            await this.executeStateMachine();
        });
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
        if (this.buyOrder || !this.breakoutDirection) return;

        const orderBooks = await this.marketInfo.getLiveData(this.targetedMarket);
        const tokenId = this.breakoutDirection === 'UP'
            ? orderBooks.BtcUpTokenId
            : orderBooks.BtcDownTokenId;

        const totalCost = this.targetBuyPrice * this.targetSize;

        if (!this.checkIfOrderIsValid(this.targetBuyPrice, this.targetSize)) return;
        if (!this.canSpend(totalCost)) return;

        this.buyOrder = await this.makeOrder(
            'firstcandle-buy',
            tokenId,
            this.targetBuyPrice,
            this.targetSize,
            Side.BUY
        );

        this.state = 'TRADE_ENTERED';

        this.buyOrder?.once('tradeMatched', () => {
            this.createSellOrder();
        });
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
            this.targetSize,
            Side.SELL
        );
    }

    // -------------------------------------------------------------------------
    // Price Data
    // -------------------------------------------------------------------------

    private async getCurrentBtcPrice(): Promise<number | null> {
        try {
            const cdMarketData = CDMarketData.getInstance();
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
