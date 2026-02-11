import { Side } from "@polymarket/clob-client";

import { QuantBotRun, TradeOrder, TradeStatus } from "./QuantBot.js";
import { MSPEQBotBase, MSPEQBotProps } from "./MSPEQBotBase.js";
import { MarketSchedule } from "../types/interfaces.js";
import { MultiSignalPEQ, MultiSignalPEQConfig } from "../utils/MultiSignalPEQ.js";
import { ISignalProvider } from "../signals/SignalProvider.js";

// ============================================================================
// Types & Interfaces
// ============================================================================

export interface FirstCandleMSPEQProps extends MSPEQBotProps {
    // Base parameters (static, genetically optimized)
    candleMinutes: number;
    breakoutBuffer: number;
    pullbackBuffer: number;
    targetDollars: number;
    cutoffMinute: number;

    // Reference values
    baseBuyPrice: number;
    minProfitMargin: number;

    // Multi-Signal PEQ configs (replace single-signal PEQs)
    targetBuyPriceMSPEQ: MultiSignalPEQConfig;
    targetSellPriceMSPEQ: MultiSignalPEQConfig;
    earlySellTimeMSPEQ: MultiSignalPEQConfig;
    earlySellPriceMSPEQ: MultiSignalPEQConfig;
}

type TradingState =
    | 'FORMING_CANDLE'
    | 'WAITING_BREAKOUT'
    | 'WAITING_PULLBACK'
    | 'TRADE_ENTERED'
    | 'PAST_CUTOFF';

type BreakoutDirection = 'UP' | 'DOWN';

// ============================================================================
// FirstCandleMSPEQ Class
// ============================================================================

/**
 * FirstCandleMSPEQ - First Candle strategy with Multi-Signal PEQ
 *
 * Extends the basic FirstCandle strategy by using multiple market signals
 * (candleSize, timeLeft, volatility, momentum, priceImbalance) to dynamically
 * compute trading parameters:
 *
 * - targetBuyPrice: Price at which to buy after pullback confirmation
 * - targetSellPrice: Price at which to sell for profit
 * - earlySellTime: Time threshold to trigger early sell
 * - earlySellPrice: Price for early sell when time runs low
 *
 * Each MSPEQ combines weighted polynomial outputs from multiple signals,
 * allowing the genetic optimizer to learn complex relationships.
 */
export class FirstCandleMSPEQ extends MSPEQBotBase implements QuantBotRun {

    // --- Configuration ---
    private candleMinutes: number;
    private breakoutBuffer: number;
    private pullbackBuffer: number;
    private targetDollars: number;
    private cutoffMinute: number;
    private baseBuyPrice: number;
    private minProfitMargin: number;

    // --- Multi-Signal PEQs ---
    private targetBuyPriceMSPEQ: MultiSignalPEQ;
    private targetSellPriceMSPEQ: MultiSignalPEQ;
    private earlySellTimeMSPEQ: MultiSignalPEQ;
    private earlySellPriceMSPEQ: MultiSignalPEQ;

    // --- Trading State ---
    private actualBuyPrice: number = 0;
    private buyOrder?: TradeOrder;
    private sellOrder?: TradeOrder;
    private earlySellOrder?: TradeOrder;
    private state: TradingState = 'FORMING_CANDLE';
    private breakoutDirection?: BreakoutDirection;
    private breakoutConfirmedPrice?: number;

    // --- Constructor ---

    constructor(props: FirstCandleMSPEQProps) {
        super(props);

        // Base parameters
        this.candleMinutes = props.candleMinutes;
        this.breakoutBuffer = props.breakoutBuffer;
        this.pullbackBuffer = props.pullbackBuffer;
        this.targetDollars = props.targetDollars;
        this.cutoffMinute = props.cutoffMinute;
        this.baseBuyPrice = props.baseBuyPrice;
        this.minProfitMargin = props.minProfitMargin;

        // Multi-Signal PEQs
        this.targetBuyPriceMSPEQ = new MultiSignalPEQ(props.targetBuyPriceMSPEQ);
        this.targetSellPriceMSPEQ = new MultiSignalPEQ(props.targetSellPriceMSPEQ);
        this.earlySellTimeMSPEQ = new MultiSignalPEQ(props.earlySellTimeMSPEQ);
        this.earlySellPriceMSPEQ = new MultiSignalPEQ(props.earlySellPriceMSPEQ);
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
        this.earlySellOrder = undefined;
        this.actualBuyPrice = 0;
        this.state = 'FORMING_CANDLE';
        this.breakoutDirection = undefined;
        this.breakoutConfirmedPrice = undefined;

        // Reset signal state (from base class)
        this.resetSignalState();
    }

    // -------------------------------------------------------------------------
    // Trading Loop
    // -------------------------------------------------------------------------

    private startTradingLoop(): void {
        this.tickWrapper(1000 * 3, 1000 * 3, async () => {
            await this.executeTradingLogic();
        });
    }

    private async executeTradingLogic(): Promise<void> {
        // Update signals first
        await this.updateSignals();

        await this.updateOrders();

        // Handle sell order creation if buy matched
        if (this.shouldCreateSellOrder()) {
            await this.createSellOrder();
        }

        // Check for early sell trigger
        if (this.shouldTriggerEarlySell()) {
            await this.createEarlySellOrder();
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
        this.candleHigh = Math.max(this.candleHigh, currentPrice);
        this.candleLow = Math.min(this.candleLow, currentPrice);

        const minuteInPeriod = this.getMinuteInPeriod();

        if (minuteInPeriod >= this.candleMinutes) {
            this.state = 'WAITING_BREAKOUT';
            this.writeLog(
                `First candle formed: High=${this.candleHigh.toFixed(2)}, ` +
                `Low=${this.candleLow.toFixed(2)}, Range=${(this.candleHigh - this.candleLow).toFixed(2)}`
            );
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
            this.writeLog(
                `Breakout UP detected at ${currentPrice.toFixed(2)}, ` +
                `waiting for pullback to ${this.candleHigh.toFixed(2)}`
            );
        } else if (brokeBelow) {
            this.breakoutDirection = 'DOWN';
            this.breakoutConfirmedPrice = this.candleLow;
            this.state = 'WAITING_PULLBACK';
            this.writeLog(
                `Breakout DOWN detected at ${currentPrice.toFixed(2)}, ` +
                `waiting for pullback to ${this.candleLow.toFixed(2)}`
            );
        }
    }

    private async handleWaitingPullback(currentPrice: number): Promise<void> {
        if (!this.breakoutDirection || !this.breakoutConfirmedPrice) return;

        const isPullbackConfirmed = this.checkPullbackConfirmation(currentPrice);

        if (isPullbackConfirmed) {
            this.writeLog(
                `Pullback confirmed at ${currentPrice.toFixed(2)}, ` +
                `entering ${this.breakoutDirection} trade`
            );
            await this.createBuyOrder();
        }
    }

    private checkPullbackConfirmation(currentPrice: number): boolean {
        if (!this.breakoutDirection || !this.breakoutConfirmedPrice) return false;

        if (this.breakoutDirection === 'UP') {
            const pullbackToSupport = Math.abs(currentPrice - this.breakoutConfirmedPrice) <= this.pullbackBuffer;
            const stillAboveSupport = currentPrice >= this.breakoutConfirmedPrice;
            return pullbackToSupport && stillAboveSupport;
        } else {
            const pullbackToResistance = Math.abs(currentPrice - this.breakoutConfirmedPrice) <= this.pullbackBuffer;
            const stillBelowResistance = currentPrice <= this.breakoutConfirmedPrice;
            return pullbackToResistance && stillBelowResistance;
        }
    }

    // -------------------------------------------------------------------------
    // Order Logic with Multi-Signal PEQ
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

        // Calculate dynamic buy price using MSPEQ with multiple signals
        const signals = this.getSignalRecord();
        const mspeqOutput = this.targetBuyPriceMSPEQ.compute(signals);

        // MSPEQ output scales the base buy price
        const dynamicBuyPrice = Math.round(this.baseBuyPrice * mspeqOutput * 100) / 100;

        // Clamp to valid range [0.01, 0.99]
        const targetBuyPrice = Math.max(0.01, Math.min(0.99, dynamicBuyPrice));
        this.actualBuyPrice = targetBuyPrice;

        const targetSize = this.dollarToTokens(this.targetDollars, targetBuyPrice);
        if (targetSize === null) {
            this.writeLog(
                `createBuyOrder: dollarToTokens returned null ` +
                `(targetDollars=${this.targetDollars}, targetBuyPrice=${targetBuyPrice})`
            );
            return;
        }

        const totalCost = targetBuyPrice * targetSize;

        if (!this.checkIfOrderIsValid(targetBuyPrice, targetSize)) {
            this.writeLog(
                `createBuyOrder: order invalid (price=${targetBuyPrice}, size=${targetSize})`
            );
            return;
        }
        if (!this.canSpend(totalCost)) {
            this.writeLog(
                `createBuyOrder: cannot spend (totalCost=${totalCost.toFixed(2)})`
            );
            return;
        }

        this.buyOrder = await this.makeOrder(
            'firstcandle-mspeq-buy',
            tokenId,
            targetBuyPrice,
            targetSize,
            Side.BUY
        );

        if (this.buyOrder) {
            this.writeLog(
                `createBuyOrder: placed (orderId=${this.buyOrder.orderId}, ` +
                `price=${targetBuyPrice}, mspeqOut=${mspeqOutput.toFixed(3)}, ` +
                `vol=${signals.volatility.toFixed(3)}, mom=${signals.momentum.toFixed(3)})`
            );
        }

        this.state = 'TRADE_ENTERED';
    }

    private async createSellOrder(): Promise<void> {
        if (this.sellOrder || !this.buyOrder || !this.breakoutDirection) return;

        const orderBooks = await this.marketInfo.getLiveData(this.targetedMarket);
        const tokenId = this.breakoutDirection === 'UP'
            ? orderBooks.BtcUpTokenId
            : orderBooks.BtcDownTokenId;

        // Calculate dynamic sell price using MSPEQ
        const signals = this.getSignalRecord();
        const mspeqOutput = this.targetSellPriceMSPEQ.compute(signals);

        // Base sell price is buyPrice + minProfitMargin
        const baseValue = this.actualBuyPrice + this.minProfitMargin;
        const dynamicSellPrice = Math.round(baseValue * mspeqOutput * 100) / 100;

        // Clamp - must be above buy price
        const targetSellPrice = Math.max(this.actualBuyPrice + 0.01, Math.min(0.99, dynamicSellPrice));

        this.sellOrder = await this.makeOrder(
            'firstcandle-mspeq-sell',
            tokenId,
            targetSellPrice,
            this.buyOrder.amount,
            Side.SELL
        );

        if (this.sellOrder) {
            this.writeLog(
                `createSellOrder: placed (price=${targetSellPrice}, mspeqOut=${mspeqOutput.toFixed(3)})`
            );
        }
    }

    // -------------------------------------------------------------------------
    // Early Sell Logic with Multi-Signal PEQ
    // -------------------------------------------------------------------------

    private shouldTriggerEarlySell(): boolean {
        if (!this.buyOrder || this.buyOrder.status !== TradeStatus.MATCHED) return false;
        if (this.sellOrder || this.earlySellOrder) return false;

        // Calculate threshold from MSPEQ (uses multiple signals)
        const signals = this.getSignalRecord();
        const timeThreshold = this.earlySellTimeMSPEQ.compute(signals);

        // Check if time left is below threshold
        return signals.timeLeft < timeThreshold;
    }

    private async createEarlySellOrder(): Promise<void> {
        if (this.sellOrder || this.earlySellOrder || !this.buyOrder || !this.breakoutDirection) return;

        const orderBooks = await this.marketInfo.getLiveData(this.targetedMarket);
        const tokenId = this.breakoutDirection === 'UP'
            ? orderBooks.BtcUpTokenId
            : orderBooks.BtcDownTokenId;

        // Calculate early sell price using MSPEQ
        const signals = this.getSignalRecord();
        const mspeqOutput = this.earlySellPriceMSPEQ.compute(signals);

        const baseValue = this.actualBuyPrice + this.minProfitMargin;
        const dynamicSellPrice = Math.round(baseValue * mspeqOutput * 100) / 100;

        // Clamp price
        const earlySellPrice = Math.max(this.actualBuyPrice + 0.01, Math.min(0.99, dynamicSellPrice));

        this.writeLog(
            `Early sell triggered: timeLeft=${signals.timeLeft.toFixed(3)}, ` +
            `price=${earlySellPrice}, mspeqOut=${mspeqOutput.toFixed(3)}`
        );

        this.earlySellOrder = await this.makeOrder(
            'firstcandle-mspeq-early-sell',
            tokenId,
            earlySellPrice,
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
