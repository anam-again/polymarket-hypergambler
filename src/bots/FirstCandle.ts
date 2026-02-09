import { Side } from "@polymarket/clob-client";

import { QuantBot, QuantBotProps, QuantBotRun, TradeOrder, TradeStatus } from "./QuantBot.js";
import { MarketSchedule } from "../types/interfaces.js";
import { ScalingPEQ, ScalingPEQCoefficients } from "../utils/ScalingPEQ.js";

// ============================================================================
// Types & Interfaces
// ============================================================================

interface FirstCandleProps extends QuantBotProps {
    candleMinutes: number;          // Duration of first candle (e.g., 30 minutes)
    breakoutBuffer: number;         // Price buffer beyond high/low to confirm breakout (e.g., 50 = $50)
    pullbackBuffer: number;         // How close price must return to broken level (e.g., 100 = within $100)
    targetDollars: number;
    cutoffMinute: number;

    // ScalingPEQ configuration
    candleSizeReference: number;    // Divisor to normalize candle size (e.g., 1000 for BTC)
    baseBuyPrice: number;           // Base buy price before scaling
    minProfitMargin: number;        // Minimum profit margin above buy price

    // PEQs
    targetBuyPricePEQ: ScalingPEQCoefficients;   // Scales baseBuyPrice by candle size
    targetSellPricePEQ: ScalingPEQCoefficients;  // Scales (buyPrice + minProfit) by candle size
    earlySellTimePEQ: ScalingPEQCoefficients;    // Outputs time threshold for early sell decision
    earlySellPricePEQ: ScalingPEQCoefficients;   // Scales early sell price by time left
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
    private targetDollars: number;
    private cutoffMinute: number;

    // ScalingPEQ configuration
    private candleSizeReference: number;
    private baseBuyPrice: number;
    private minProfitMargin: number;
    private targetBuyPricePEQ: ScalingPEQ;
    private targetSellPricePEQ: ScalingPEQ;
    private earlySellTimePEQ: ScalingPEQ;
    private earlySellPricePEQ: ScalingPEQ;

    // Track actual buy price for sell calculations
    private actualBuyPrice: number = 0;

    private buyOrder?: TradeOrder;
    private sellOrder?: TradeOrder;
    private earlySellOrder?: TradeOrder;

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
        this.targetDollars = props.targetDollars;
        this.cutoffMinute = props.cutoffMinute;

        // ScalingPEQ configuration
        this.candleSizeReference = props.candleSizeReference;
        this.baseBuyPrice = props.baseBuyPrice;
        this.minProfitMargin = props.minProfitMargin;
        this.targetBuyPricePEQ = new ScalingPEQ(props.targetBuyPricePEQ);
        this.targetSellPricePEQ = new ScalingPEQ(props.targetSellPricePEQ);
        this.earlySellTimePEQ = new ScalingPEQ(props.earlySellTimePEQ);
        this.earlySellPricePEQ = new ScalingPEQ(props.earlySellPricePEQ);
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

        // Check for early sell trigger (when we have matched buy but no sell yet)
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

    private getCandleSizeNormalized(): number {
        const candleSize = this.candleHigh - this.candleLow;
        return candleSize / this.candleSizeReference;
    }

    private getTimeLeftRatio(): number {
        const minuteInPeriod = this.getMinuteInPeriod();
        const periodLength = this.marketSchedule === MarketSchedule.QUARTERLY ? 15 : 60;
        return Math.max(0, (periodLength - minuteInPeriod) / periodLength);
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

        // Calculate dynamic buy price using candle size
        const candleSizeNormalized = this.getCandleSizeNormalized();
        const dynamicBuyPrice = Math.round(
            this.targetBuyPricePEQ.scale(this.baseBuyPrice, candleSizeNormalized) * 100
        ) / 100;

        // Clamp to valid range [0.01, 0.99]
        const targetBuyPrice = Math.max(0.01, Math.min(0.99, dynamicBuyPrice));

        // Store actual buy price for sell calculations
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
                `createBuyOrder: order invalid ` +
                `(price=${targetBuyPrice}, size=${targetSize})`
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
            targetBuyPrice,
            targetSize,
            Side.BUY
        );

        if (this.buyOrder) {
            this.writeLog(
                `createBuyOrder: order placed successfully ` +
                `(orderId=${this.buyOrder.orderId}, size=${targetSize}, price=${targetBuyPrice}, candleSize=${candleSizeNormalized.toFixed(3)})`
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

        // Calculate dynamic sell price: (buyPrice + minProfit) scaled by candle size
        const candleSizeNormalized = this.getCandleSizeNormalized();
        const baseValue = this.actualBuyPrice + this.minProfitMargin;
        const dynamicSellPrice = Math.round(
            this.targetSellPricePEQ.scale(baseValue, candleSizeNormalized) * 100
        ) / 100;

        // Clamp to valid range, must be above buy price
        const targetSellPrice = Math.max(this.actualBuyPrice + 0.01, Math.min(0.99, dynamicSellPrice));

        this.sellOrder = await this.makeOrder(
            'firstcandle-sell',
            tokenId,
            targetSellPrice,
            this.buyOrder.amount,
            Side.SELL
        );

        if (this.sellOrder) {
            this.writeLog(
                `createSellOrder: order placed (price=${targetSellPrice}, candleSize=${candleSizeNormalized.toFixed(3)})`
            );
        }
    }

    // -------------------------------------------------------------------------
    // Early Sell Logic
    // -------------------------------------------------------------------------

    private shouldTriggerEarlySell(): boolean {
        // Only check if we have a matched buy order and no sell order yet
        if (!this.buyOrder || this.buyOrder.status !== TradeStatus.MATCHED) return false;
        if (this.sellOrder || this.earlySellOrder) return false;

        // Calculate threshold from candle size
        const candleSizeNormalized = this.getCandleSizeNormalized();
        const timeThreshold = this.earlySellTimePEQ.compute(candleSizeNormalized);

        // Check if time left ratio is below threshold
        const timeLeftRatio = this.getTimeLeftRatio();
        return timeLeftRatio < timeThreshold;
    }

    private async createEarlySellOrder(): Promise<void> {
        if (this.sellOrder || this.earlySellOrder || !this.buyOrder || !this.breakoutDirection) return;

        const orderBooks = await this.marketInfo.getLiveData(this.targetedMarket);
        const tokenId = this.breakoutDirection === 'UP'
            ? orderBooks.BtcUpTokenId
            : orderBooks.BtcDownTokenId;

        // Calculate early sell price using time left
        const timeLeftRatio = this.getTimeLeftRatio();
        const baseValue = this.actualBuyPrice + this.minProfitMargin;
        const dynamicSellPrice = Math.round(
            this.earlySellPricePEQ.scale(baseValue, timeLeftRatio) * 100
        ) / 100;

        // Clamp price
        const earlySellPrice = Math.max(this.actualBuyPrice + 0.01, Math.min(0.99, dynamicSellPrice));

        this.writeLog(`Early sell triggered: timeLeftRatio=${timeLeftRatio.toFixed(3)}, price=${earlySellPrice}`);

        this.earlySellOrder = await this.makeOrder(
            'firstcandle-early-sell',
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
