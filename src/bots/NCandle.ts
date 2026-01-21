import { Side } from "@polymarket/clob-client";

import { QuantBot, QuantBotProps, QuantBotRun, TradeOrder, TradeStatus } from "./QuantBot.js";
import { CDMarketData } from "../nonBots/CDMarketData.js";
import { MarketSchedule } from "../types/interfaces.js";

// ============================================================================
// Types & Interfaces
// ============================================================================

interface NCandleProps extends QuantBotProps {
    candleMinutes: number;          // Duration of each candle (e.g., 10 minutes)
    breakoutBuffer: number;         // Price buffer beyond high/low to confirm breakout (e.g., 50 = $50)
    pullbackBuffer: number;         // How close price must return to broken level (e.g., 100 = within $100)
    buyPriceBuffer: number;         // How much above current best price to place buy order (e.g., 0.02 = 2 cents)
    sellPriceBuffer: number;        // How much below current best bid to place sell order (e.g., 0.02 = 2 cents)
    minProfitMargin: number;        // Minimum profit margin above buy price (e.g., 0.05 = 5 cents)
    stopLossMultiplier: number;     // Stop-loss as multiplier of candle range (e.g., 1.5 = 1.5x range)
    targetSize: number;             // Target position size
    cutoffMinute: number;           // Minute after which no new trades are entered
    maxTradesPerHour: number;       // Maximum number of trades per hour
}

type TradingState =
    | 'FORMING_CANDLE'      // Current candle is forming
    | 'WAITING_BREAKOUT'    // Candle formed, waiting for price to break range
    | 'WAITING_PULLBACK'    // Breakout occurred, waiting for pullback confirmation
    | 'TRADE_ACTIVE'        // Trade has been placed, monitoring for exit
    | 'PAST_CUTOFF';        // Past cutoff, no more trading

type BreakoutDirection = 'UP' | 'DOWN';

interface Candle {
    high: number;
    low: number;
    open: number;
    close: number;
    startMinute: number;
}

// ============================================================================
// NCandle Class
// ============================================================================

export class NCandle extends QuantBot implements QuantBotRun {

    // --- Configuration ---
    private readonly MIN_ORDER_SIZE = 5;
    private readonly MIN_ORDER_VALUE = 1.00;
    private readonly MAX_SELL_PRICE = 0.95;

    // --- Properties ---
    private candleMinutes: number;
    private breakoutBuffer: number;
    private pullbackBuffer: number;
    private buyPriceBuffer: number;
    private sellPriceBuffer: number;
    private minProfitMargin: number;
    private stopLossMultiplier: number;
    private targetSize: number;
    private cutoffMinute: number;
    private maxTradesPerHour: number;

    // --- Trade Tracking ---
    private buyOrder?: TradeOrder;
    private sellOrder?: TradeOrder;

    // --- State Tracking ---
    private state: TradingState = 'FORMING_CANDLE';
    private currentCandle: Candle | null = null;
    private previousCandles: Candle[] = [];
    private lastCandleIndex: number = -1;
    private breakoutDirection?: BreakoutDirection;
    private breakoutConfirmedPrice?: number;
    private actualBuyPrice?: number;
    private stopLossPrice?: number;
    private entryTokenId?: string;

    // --- Constructor ---

    constructor(props: NCandleProps) {
        super(props);

        this.candleMinutes = props.candleMinutes;
        this.breakoutBuffer = props.breakoutBuffer;
        this.pullbackBuffer = props.pullbackBuffer;
        this.buyPriceBuffer = props.buyPriceBuffer;
        this.sellPriceBuffer = props.sellPriceBuffer;
        this.minProfitMargin = props.minProfitMargin;
        this.stopLossMultiplier = props.stopLossMultiplier;
        this.targetSize = props.targetSize;
        this.cutoffMinute = props.cutoffMinute;
        this.maxTradesPerHour = props.maxTradesPerHour;
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
            this.resetHourlyState();
        });
    }

    private resetHourlyState(): void {
        this.buyOrder = undefined;
        this.sellOrder = undefined;
        this.state = 'FORMING_CANDLE';
        this.currentCandle = null;
        this.previousCandles = [];
        this.lastCandleIndex = -1;
        this.breakoutDirection = undefined;
        this.breakoutConfirmedPrice = undefined;
        this.actualBuyPrice = undefined;
        this.stopLossPrice = undefined;
        this.entryTokenId = undefined;
    }

    private resetTradeState(): void {
        // Reset for a new trade opportunity within the same hour
        this.buyOrder = undefined;
        this.sellOrder = undefined;
        this.state = 'FORMING_CANDLE';
        this.currentCandle = null;
        this.breakoutDirection = undefined;
        this.breakoutConfirmedPrice = undefined;
        this.actualBuyPrice = undefined;
        this.stopLossPrice = undefined;
        this.entryTokenId = undefined;
        // Keep previousCandles and lastCandleIndex for continuity
    }

    // -------------------------------------------------------------------------
    // Trading Loop
    // -------------------------------------------------------------------------

    private startTradingLoop(): void {
        this.tickWrapper(1000 * 3, 1000 * 2, async () => {
            await this.updateOrders();

            // Check for stop-loss
            if (this.state === 'TRADE_ACTIVE' && this.buyOrder?.status === TradeStatus.MATCHED) {
                const stopLossTriggered = await this.checkStopLoss();
                if (stopLossTriggered) {
                    return;
                }
            }

            // Handle sell order creation if buy matched
            if (this.shouldCreateSellOrder()) {
                await this.createSellOrder();
            }

            // Check if trade completed (sell matched) - prepare for next trade
            if (this.isTradeCompleted()) {
                this.handleTradeCompletion();
                return;
            }

            // Check cutoff
            if (this.isAfterCutoff() && this.state !== 'TRADE_ACTIVE') {
                await this.handleCutoff();
                return;
            }

            if (this.state === 'PAST_CUTOFF') {
                return;
            }

            // Check if we can still trade this hour
            if (!this.canTradeThisHour(this.maxTradesPerHour)) {
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
        const currentPrice = await this.getCurrentPrice();
        if (!currentPrice) return;

        // Update candle tracking
        this.updateCandleTracking(currentPrice);

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

    private updateCandleTracking(currentPrice: number): void {
        const currentMinute = this.clock.getMinutes();
        const candleIndex = Math.floor(currentMinute / this.candleMinutes);

        // Check if we've moved to a new candle
        if (candleIndex !== this.lastCandleIndex) {
            // Finalize previous candle if it exists
            if (this.currentCandle) {
                this.currentCandle.close = currentPrice;
                this.previousCandles.push({ ...this.currentCandle });

                // Keep only last 3 candles for reference
                if (this.previousCandles.length > 3) {
                    this.previousCandles.shift();
                }
            }

            // Start new candle
            this.currentCandle = {
                high: currentPrice,
                low: currentPrice,
                open: currentPrice,
                close: currentPrice,
                startMinute: candleIndex * this.candleMinutes,
            };
            this.lastCandleIndex = candleIndex;

            // For HOURLY markets: reset state on new candles since there's plenty of time
            // For QUARTERLY markets: DON'T reset state - allow breakout/pullback patterns
            // to span multiple candles since the 15-minute period is too short for
            // patterns to develop within a single candle window
            if (this.marketSchedule === MarketSchedule.HOURLY) {
                if (this.state === 'WAITING_BREAKOUT' || this.state === 'WAITING_PULLBACK') {
                    this.state = 'FORMING_CANDLE';
                    this.breakoutDirection = undefined;
                    this.breakoutConfirmedPrice = undefined;
                }
            }
        }

        // Update current candle
        if (this.currentCandle) {
            this.currentCandle.high = Math.max(this.currentCandle.high, currentPrice);
            this.currentCandle.low = Math.min(this.currentCandle.low, currentPrice);
            this.currentCandle.close = currentPrice;
        }
    }

    private handleFormingCandle(currentPrice: number): void {
        if (!this.currentCandle) return;

        const currentMinute = this.clock.getMinutes();
        const candleEndMinute = this.currentCandle.startMinute + this.candleMinutes;

        // Check if candle is complete
        if (currentMinute >= candleEndMinute) {
            const range = this.currentCandle.high - this.currentCandle.low;
            this.state = 'WAITING_BREAKOUT';
            this.writeLog(
                `Candle formed [${this.currentCandle.startMinute}-${candleEndMinute}m]: ` +
                `High=${this.currentCandle.high.toFixed(2)}, Low=${this.currentCandle.low.toFixed(2)}, ` +
                `Range=${range.toFixed(2)}`
            );
        }
    }

    private handleWaitingBreakout(currentPrice: number): void {
        if (!this.currentCandle) return;

        const brokeAbove = currentPrice > this.currentCandle.high + this.breakoutBuffer;
        const brokeBelow = currentPrice < this.currentCandle.low - this.breakoutBuffer;

        if (brokeAbove) {
            this.breakoutDirection = 'UP';
            this.breakoutConfirmedPrice = this.currentCandle.high;
            this.state = 'WAITING_PULLBACK';
            this.writeLog(
                `Breakout UP detected at ${currentPrice.toFixed(2)}, ` +
                `waiting for pullback to ${this.currentCandle.high.toFixed(2)}`
            );
        } else if (brokeBelow) {
            this.breakoutDirection = 'DOWN';
            this.breakoutConfirmedPrice = this.currentCandle.low;
            this.state = 'WAITING_PULLBACK';
            this.writeLog(
                `Breakout DOWN detected at ${currentPrice.toFixed(2)}, ` +
                `waiting for pullback to ${this.currentCandle.low.toFixed(2)}`
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
    // Order Logic
    // -------------------------------------------------------------------------

    private shouldCreateSellOrder(): boolean {
        if (this.sellOrder) return false;
        if (!this.buyOrder) return false;
        return this.buyOrder.status === TradeStatus.MATCHED;
    }

    private async createBuyOrder(): Promise<void> {
        if (this.buyOrder || !this.breakoutDirection || !this.currentCandle) return;

        const orderBooks = await this.marketInfo.getLiveData(this.targetedMarket);
        const tokenId = this.breakoutDirection === 'UP'
            ? orderBooks.BtcUpTokenId
            : orderBooks.BtcDownTokenId;

        // Get current best ask price
        const currentAskPrice = await this.marketInfo.getPrice(tokenId, Side.BUY);

        // Calculate dynamic buy price
        const dynamicBuyPrice = Math.round((currentAskPrice + this.buyPriceBuffer) * 100) / 100;

        // Calculate position size ensuring minimums are met
        const positionSize = this.calculateValidPositionSize(dynamicBuyPrice);
        if (positionSize === null) {
            this.writeLog(`Cannot create order: position size calculation failed`);
            return;
        }

        const totalCost = dynamicBuyPrice * positionSize;

        // Check budget constraints
        if (!this.canSpendFromBudget(totalCost)) {
            this.writeLog(`Cannot create order: would exceed hourly budget`);
            return;
        }

        // Calculate stop-loss based on candle range
        const candleRange = this.currentCandle.high - this.currentCandle.low;
        this.stopLossPrice = this.calculateStopLoss(dynamicBuyPrice, candleRange);

        this.writeLog(
            `Setting buy order at ${dynamicBuyPrice.toFixed(2)} ` +
            `(ask: ${currentAskPrice.toFixed(2)}, size: ${positionSize}, ` +
            `stop-loss: ${this.stopLossPrice.toFixed(2)})`
        );

        // Store for later reference
        this.actualBuyPrice = dynamicBuyPrice;
        this.entryTokenId = tokenId;

        this.buyOrder = await this.makeOrder(
            'ncandle-buy',
            tokenId,
            dynamicBuyPrice,
            positionSize,
            Side.BUY
        );

        if (this.buyOrder) {
            this.state = 'TRADE_ACTIVE';
            this.recordTrade();

            this.buyOrder?.once('tradeMatched', () => {
                this.createSellOrder();
            });
        }
    }

    private async createSellOrder(): Promise<void> {
        if (this.sellOrder || !this.buyOrder || !this.breakoutDirection || !this.actualBuyPrice) return;

        const orderBooks = await this.marketInfo.getLiveData(this.targetedMarket);
        const tokenId = this.breakoutDirection === 'UP'
            ? orderBooks.BtcUpTokenId
            : orderBooks.BtcDownTokenId;

        // Get current best bid price
        const currentBidPrice = await this.marketInfo.getPrice(tokenId, Side.SELL);

        // Calculate dynamic sell price
        const marketSellPrice = Math.round((currentBidPrice - this.sellPriceBuffer) * 100) / 100;
        const minSellPrice = Math.round((this.actualBuyPrice + this.minProfitMargin) * 100) / 100;
        const dynamicSellPrice = Math.min(Math.max(marketSellPrice, minSellPrice), this.MAX_SELL_PRICE);

        this.writeLog(
            `Setting sell order at ${dynamicSellPrice.toFixed(2)} ` +
            `(market: ${marketSellPrice.toFixed(2)}, min: ${minSellPrice.toFixed(2)}, ` +
            `buy was: ${this.actualBuyPrice.toFixed(2)})`
        );

        this.sellOrder = await this.makeOrder(
            'ncandle-sell',
            tokenId,
            dynamicSellPrice,
            this.buyOrder.amount,
            Side.SELL
        );
    }

    // -------------------------------------------------------------------------
    // Stop-Loss Logic
    // -------------------------------------------------------------------------

    private calculateStopLoss(buyPrice: number, candleRange: number): number {
        // Stop-loss is based on candle range multiplied by the multiplier
        // For prediction markets, we translate BTC price movement to position loss
        const stopLossOffset = (candleRange * this.stopLossMultiplier) / 10000; // Normalize for position prices
        const stopLoss = Math.max(0.01, buyPrice - stopLossOffset);
        return Math.round(stopLoss * 100) / 100;
    }

    private async checkStopLoss(): Promise<boolean> {
        if (!this.stopLossPrice || !this.entryTokenId || !this.buyOrder) return false;
        if (this.buyOrder.status !== TradeStatus.MATCHED) return false;

        try {
            // Get current market price for our position
            const currentBidPrice = await this.marketInfo.getPrice(this.entryTokenId, Side.SELL);

            if (currentBidPrice <= this.stopLossPrice) {
                this.writeLog(
                    `STOP-LOSS TRIGGERED: Current bid ${currentBidPrice.toFixed(2)} <= ` +
                    `stop-loss ${this.stopLossPrice.toFixed(2)}`
                );

                // Cancel existing sell order if any
                if (this.sellOrder && this.sellOrder.status === TradeStatus.LIVE) {
                    await this.cancelTrade(this.sellOrder);
                }

                // Create market sell (at lower price to ensure fill)
                const emergencySellPrice = Math.max(0.01, currentBidPrice - 0.02);
                this.sellOrder = await this.makeOrder(
                    'ncandle-stoploss',
                    this.entryTokenId,
                    emergencySellPrice,
                    this.buyOrder.amount,
                    Side.SELL
                );

                return true;
            }
        } catch (error) {
            this.writeError(`Error checking stop-loss: ${error}`);
        }

        return false;
    }

    // -------------------------------------------------------------------------
    // Position Sizing
    // -------------------------------------------------------------------------

    private calculateValidPositionSize(price: number): number | null {
        // Start with target size
        let size = this.targetSize;

        // Ensure minimum order size
        if (size < this.MIN_ORDER_SIZE) {
            size = this.MIN_ORDER_SIZE;
        }

        // Ensure minimum order value
        if (price * size < this.MIN_ORDER_VALUE) {
            size = Math.ceil(this.MIN_ORDER_VALUE / price);
        }

        // Re-check minimum size after value adjustment
        if (size < this.MIN_ORDER_SIZE) {
            size = this.MIN_ORDER_SIZE;
        }

        // Verify final order is valid
        if (!this.checkIfOrderIsValid(price, size)) {
            return null;
        }

        // Check if we can afford it
        const totalCost = price * size;
        if (!this.canSpend(totalCost)) {
            return null;
        }

        return size;
    }

    // -------------------------------------------------------------------------
    // Trade Completion
    // -------------------------------------------------------------------------

    private isTradeCompleted(): boolean {
        if (!this.buyOrder || !this.sellOrder) return false;
        return this.sellOrder.status === TradeStatus.MATCHED;
    }

    private handleTradeCompletion(): void {
        const status = this.getBudgetStatus();
        this.writeLog(
            `Trade completed. Trades this hour: ${status.trades}/${this.maxTradesPerHour}, ` +
            `Spent: $${status.spent.toFixed(2)}/$${status.limit.toFixed(2)}`
        );

        // Check if we can trade again
        if (this.canTradeThisHour(this.maxTradesPerHour) && !this.isAfterCutoff()) {
            this.writeLog(`Resetting for potential new trade opportunity`);
            this.resetTradeState();
        } else {
            this.state = 'PAST_CUTOFF';
        }
    }

    // -------------------------------------------------------------------------
    // Price Data
    // -------------------------------------------------------------------------

    private async getCurrentPrice(): Promise<number | null> {
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
