import { Side } from "@polymarket/clob-client";

import { QuantBot, QuantBotProps, QuantBotRun, TradeOrder, TradeStatus } from "./QuantBot.js";
import { MarketSchedule } from "../types/interfaces.js";

// ============================================================================
// Types & Interfaces
// ============================================================================

interface NCandleProps extends QuantBotProps {
    candleMinutes: number;          // Duration of each candle (e.g., 10 minutes)
    buyPriceBuffer: number;         // How much above current best price to place buy order (e.g., 0.02 = 2 cents)
    buyPriceBufferScalar: number;   // Scalar for buyPriceBuffer based on time left (0-1, higher = more aggressive as time runs out)
    sellPriceBuffer: number;        // How much below current best bid to place sell order (e.g., 0.02 = 2 cents)
    minProfitMargin: number;        // Minimum profit margin above buy price (e.g., 0.05 = 5 cents)
    minProfitMarginScalar: number;  // Scalar for minProfitMargin based on time left (0-1, higher = accept lower margins as time runs out)
    stopLossMultiplier: number;     // Stop-loss as multiplier of candle range (e.g., 1.5 = 1.5x range)
    stoplossTimeout: number;        // Seconds price must be under stoploss before triggering (e.g., 30)
    stoplossTimeoutScalar: number;  // Scalar for stoplossTimeout based on time left (0-1, higher = faster stoploss as time runs out)
    sellTimeout: number;            // Seconds after buy match to force sell at market price (e.g., 300)
    sellTimeoutScalar: number;      // Scalar for sellTimeout based on time left (0-1, higher = faster timeout as time runs out)
    earlySellScalar: number;        // Scalar for early sell based on current PnL and time left (0-1, higher = more willing to take profit/loss early)
    targetDollars: number;          // Dollar amount per position
    cutoffMinute: number;           // Minute after which no new trades are entered
    maxTradesPerHour: number;       // Maximum number of trades per hour
}

type TradingState =
    | 'FORMING_CANDLE'      // Current candle is forming
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
    private buyPriceBuffer: number;
    private buyPriceBufferScalar: number;
    private sellPriceBuffer: number;
    private minProfitMargin: number;
    private minProfitMarginScalar: number;
    private stopLossMultiplier: number;
    private stoplossTimeout: number;
    private stoplossTimeoutScalar: number;
    private sellTimeout: number;
    private sellTimeoutScalar: number;
    private earlySellScalar: number;
    private targetDollars: number;
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
    private actualBuyPrice?: number;
    private stopLossPrice?: number;
    private entryTokenId?: string;
    private completedCandle?: Candle;  // The candle we're using for direction detection

    // --- Timeout Tracking ---
    private stoplossBelowSince?: number;      // Timestamp when price first went below stoploss
    private buyMatchedAt?: number;            // Timestamp when buy order was matched
    private originalSellPrice?: number;       // Target sell price before any timeout/stoploss adjustments
    private isStoplossOrder: boolean = false; // Whether current sell order is a stoploss order

    // --- Constructor ---

    constructor(props: NCandleProps) {
        super(props);

        this.candleMinutes = props.candleMinutes;
        this.buyPriceBuffer = props.buyPriceBuffer;
        this.buyPriceBufferScalar = props.buyPriceBufferScalar;
        this.sellPriceBuffer = props.sellPriceBuffer;
        this.minProfitMargin = props.minProfitMargin;
        this.minProfitMarginScalar = props.minProfitMarginScalar;
        this.stopLossMultiplier = props.stopLossMultiplier;
        this.stoplossTimeout = props.stoplossTimeout;
        this.stoplossTimeoutScalar = props.stoplossTimeoutScalar;
        this.sellTimeout = props.sellTimeout;
        this.sellTimeoutScalar = props.sellTimeoutScalar;
        this.earlySellScalar = props.earlySellScalar;
        this.targetDollars = props.targetDollars;
        this.cutoffMinute = props.cutoffMinute;
        this.maxTradesPerHour = props.maxTradesPerHour;
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
        this.currentCandle = null;
        this.previousCandles = [];
        this.lastCandleIndex = -1;
        this.breakoutDirection = undefined;
        this.actualBuyPrice = undefined;
        this.stopLossPrice = undefined;
        this.entryTokenId = undefined;
        this.completedCandle = undefined;
        // Timeout tracking
        this.stoplossBelowSince = undefined;
        this.buyMatchedAt = undefined;
        this.originalSellPrice = undefined;
        this.isStoplossOrder = false;
    }

    private resetForNewTrade(): void {
        // Reset for a new trade opportunity within the same period
        this.buyOrder = undefined;
        this.sellOrder = undefined;
        this.state = 'FORMING_CANDLE';
        this.currentCandle = null;
        this.breakoutDirection = undefined;
        this.actualBuyPrice = undefined;
        this.stopLossPrice = undefined;
        this.entryTokenId = undefined;
        this.completedCandle = undefined;
        // Timeout tracking
        this.stoplossBelowSince = undefined;
        this.buyMatchedAt = undefined;
        this.originalSellPrice = undefined;
        this.isStoplossOrder = false;
        // Keep previousCandles and lastCandleIndex for continuity
    }

    // -------------------------------------------------------------------------
    // Trading Loop
    // -------------------------------------------------------------------------

    private startTradingLoop(): void {
        this.tickWrapper(1000 * 3, 1000 * 2, async () => {
            await this.executeTradingLogic();
        });
    }

    private async executeTradingLogic(): Promise<void> {
        await this.updateOrders();

        // Track when buy order gets matched
        if (this.buyOrder?.status === TradeStatus.MATCHED && !this.buyMatchedAt) {
            this.buyMatchedAt = this.clock.now();
            this.writeLog(`Buy order matched at ${new Date(this.buyMatchedAt).toISOString()}`);
        }

        // Check for stop-loss with timeout logic
        if (this.state === 'TRADE_ACTIVE' && this.buyOrder?.status === TradeStatus.MATCHED) {
            // Check if we should recover from a stoploss order (price recovered)
            const recovered = await this.checkStoplossRecovery();
            if (recovered) {
                // Stoploss was cancelled and original sell re-posted, continue
            }

            // Check for stoploss trigger
            const stopLossTriggered = await this.checkStopLoss();
            if (stopLossTriggered) {
                return;
            }

            // Check for sell timeout
            const sellTimeoutTriggered = await this.checkSellTimeout();
            if (sellTimeoutTriggered) {
                return;
            }

            // Check for early sell opportunity
            const earlySellTriggered = await this.checkEarlySell();
            if (earlySellTriggered) {
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
    }

    public override async onSimulationTick(): Promise<void> {
        await this.executeTradingLogic();
    }

    // -------------------------------------------------------------------------
    // State Machine
    // -------------------------------------------------------------------------

    private async executeStateMachine(): Promise<void> {
        const currentPrice = await this.getCurrentPrice();
        if (!currentPrice) {
            this.writeLog('executeStateMachine: getCurrentPrice returned null');
            return;
        }

        // Update candle tracking (this may trigger a trade on candle completion)
        await this.updateCandleTracking(currentPrice);

        // Note: WAITING_BREAKOUT and WAITING_PULLBACK states are no longer used
        // Trading now happens immediately on candle completion based on direction
    }

    private async updateCandleTracking(currentPrice: number): Promise<void> {
        const currentMinute = this.clock.getMinutes();
        const candleIndex = Math.floor(currentMinute / this.candleMinutes);

        // Check if we've moved to a new candle
        if (candleIndex !== this.lastCandleIndex) {
            // Finalize previous candle if it exists
            if (this.currentCandle && this.state === 'FORMING_CANDLE') {
                this.currentCandle.close = currentPrice;
                const completedCandle = { ...this.currentCandle };
                this.previousCandles.push(completedCandle);

                // Keep only last 3 candles for reference
                if (this.previousCandles.length > 3) {
                    this.previousCandles.shift();
                }

                const range = completedCandle.high - completedCandle.low;
                this.completedCandle = completedCandle;
                this.writeLog(
                    `Candle formed [${completedCandle.startMinute}-${completedCandle.startMinute + this.candleMinutes}m]: ` +
                    `High=${completedCandle.high.toFixed(2)}, Low=${completedCandle.low.toFixed(2)}, ` +
                    `Range=${range.toFixed(2)}, Open=${completedCandle.open.toFixed(2)}, Close=${completedCandle.close.toFixed(2)}`
                );

                // Trade on candle direction (Option B: no breakout/pullback required)
                if (completedCandle.close > completedCandle.open) {
                    this.breakoutDirection = 'UP';
                    this.writeLog(`Candle closed UP (${completedCandle.open.toFixed(2)} -> ${completedCandle.close.toFixed(2)}), entering trade`);
                    await this.createBuyOrder();
                } else if (completedCandle.close < completedCandle.open) {
                    this.breakoutDirection = 'DOWN';
                    this.writeLog(`Candle closed DOWN (${completedCandle.open.toFixed(2)} -> ${completedCandle.close.toFixed(2)}), entering trade`);
                    await this.createBuyOrder();
                } else {
                    // Neutral candle (close == open), skip trading
                    this.writeLog(`Candle neutral (close == open at ${completedCandle.close.toFixed(2)}), skipping trade`);
                }
            } else if (this.currentCandle) {
                // Still finalize for non-FORMING_CANDLE states
                this.currentCandle.close = currentPrice;
                this.previousCandles.push({ ...this.currentCandle });
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
        }

        // Update current candle
        if (this.currentCandle) {
            this.currentCandle.high = Math.max(this.currentCandle.high, currentPrice);
            this.currentCandle.low = Math.min(this.currentCandle.low, currentPrice);
            this.currentCandle.close = currentPrice;
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
        const currentAskPrice = await this.marketInfo.getPrice(tokenId, Side.BUY, this.targetedMarket);

        // Calculate effective buy price buffer (more aggressive as time runs out)
        const timeLeftRatio = this.getTimeLeftRatio();
        const effectiveBuyBuffer = this.buyPriceBuffer * (1 + this.buyPriceBufferScalar * (1 - timeLeftRatio));

        // Calculate dynamic buy price
        const dynamicBuyPrice = Math.round((currentAskPrice + effectiveBuyBuffer) * 100) / 100;

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
        }
    }

    private async createSellOrder(): Promise<void> {
        if (this.sellOrder || !this.buyOrder || !this.breakoutDirection || !this.actualBuyPrice) return;

        const orderBooks = await this.marketInfo.getLiveData(this.targetedMarket);
        const tokenId = this.breakoutDirection === 'UP'
            ? orderBooks.BtcUpTokenId
            : orderBooks.BtcDownTokenId;

        // Get current best bid price
        const currentBidPrice = await this.marketInfo.getPrice(tokenId, Side.SELL, this.targetedMarket);

        // Calculate effective min profit margin (accept lower margins as time runs out)
        const timeLeftRatio = this.getTimeLeftRatio();
        const effectiveMinProfitMargin = this.minProfitMargin * (1 - this.minProfitMarginScalar * (1 - timeLeftRatio));

        // Calculate dynamic sell price
        const marketSellPrice = Math.round((currentBidPrice - this.sellPriceBuffer) * 100) / 100;
        const minSellPrice = Math.round((this.actualBuyPrice + effectiveMinProfitMargin) * 100) / 100;
        const dynamicSellPrice = Math.min(Math.max(marketSellPrice, minSellPrice), this.MAX_SELL_PRICE);

        // Store original sell price for potential recovery after stoploss
        this.originalSellPrice = dynamicSellPrice;
        this.isStoplossOrder = false;

        this.writeLog(
            `Setting sell order at ${dynamicSellPrice.toFixed(2)} ` +
            `(market: ${marketSellPrice.toFixed(2)}, min: ${minSellPrice.toFixed(2)}, ` +
            `buy was: ${this.actualBuyPrice.toFixed(2)}, timeLeft: ${(timeLeftRatio * 100).toFixed(1)}%)`
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
        if (this.isStoplossOrder) return false; // Already in stoploss mode

        try {
            // Get current market price for our position
            const currentBidPrice = await this.marketInfo.getPrice(this.entryTokenId, Side.SELL, this.targetedMarket);

            if (currentBidPrice <= this.stopLossPrice) {
                const now = this.clock.now();

                // Start tracking time below stoploss if not already
                if (!this.stoplossBelowSince) {
                    this.stoplossBelowSince = now;
                    this.writeLog(
                        `Price below stoploss: ${currentBidPrice.toFixed(2)} <= ${this.stopLossPrice.toFixed(2)}, ` +
                        `starting timeout countdown`
                    );
                    return false;
                }

                // Calculate effective stoploss timeout (shorter as time runs out)
                const timeLeftRatio = this.getTimeLeftRatio();
                const effectiveTimeout = this.stoplossTimeout * (1 - this.stoplossTimeoutScalar * (1 - timeLeftRatio));
                const elapsedSeconds = (now - this.stoplossBelowSince) / 1000;

                if (elapsedSeconds >= effectiveTimeout) {
                    this.writeLog(
                        `STOP-LOSS TRIGGERED: Price ${currentBidPrice.toFixed(2)} below stoploss ` +
                        `${this.stopLossPrice.toFixed(2)} for ${elapsedSeconds.toFixed(1)}s ` +
                        `(timeout: ${effectiveTimeout.toFixed(1)}s)`
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
                    this.isStoplossOrder = true;

                    return true;
                }
            } else {
                // Price recovered above stoploss, reset timeout tracking
                if (this.stoplossBelowSince) {
                    this.writeLog(
                        `Price recovered above stoploss: ${currentBidPrice.toFixed(2)} > ${this.stopLossPrice.toFixed(2)}`
                    );
                    this.stoplossBelowSince = undefined;
                }
            }
        } catch (error) {
            this.writeError(`Error checking stop-loss: ${error}`);
        }

        return false;
    }

    private async checkStoplossRecovery(): Promise<boolean> {
        if (!this.isStoplossOrder || !this.sellOrder || !this.entryTokenId || !this.buyOrder) return false;
        if (this.sellOrder.status !== TradeStatus.LIVE) return false;
        if (!this.stopLossPrice || !this.originalSellPrice) return false;

        try {
            const currentBidPrice = await this.marketInfo.getPrice(this.entryTokenId, Side.SELL, this.targetedMarket);

            // If price recovered above stoploss, cancel stoploss order and re-post original
            if (currentBidPrice > this.stopLossPrice) {
                this.writeLog(
                    `STOPLOSS RECOVERY: Price ${currentBidPrice.toFixed(2)} recovered above ` +
                    `stoploss ${this.stopLossPrice.toFixed(2)}, cancelling stoploss order`
                );

                await this.cancelTrade(this.sellOrder);

                // Re-post at original target price
                this.sellOrder = await this.makeOrder(
                    'ncandle-sell-recovered',
                    this.entryTokenId,
                    this.originalSellPrice,
                    this.buyOrder.amount,
                    Side.SELL
                );
                this.isStoplossOrder = false;
                this.stoplossBelowSince = undefined;

                this.writeLog(`Re-posted sell order at original price ${this.originalSellPrice.toFixed(2)}`);
                return true;
            }
        } catch (error) {
            this.writeError(`Error checking stoploss recovery: ${error}`);
        }

        return false;
    }

    private async checkSellTimeout(): Promise<boolean> {
        if (!this.buyMatchedAt || !this.sellOrder || !this.entryTokenId || !this.buyOrder) return false;
        if (this.sellOrder.status !== TradeStatus.LIVE) return false;

        const now = this.clock.now();
        const elapsedSeconds = (now - this.buyMatchedAt) / 1000;

        // Calculate effective sell timeout (shorter as time runs out)
        const timeLeftRatio = this.getTimeLeftRatio();
        const effectiveTimeout = this.sellTimeout * (1 - this.sellTimeoutScalar * (1 - timeLeftRatio));

        if (elapsedSeconds >= effectiveTimeout) {
            try {
                const currentBidPrice = await this.marketInfo.getPrice(this.entryTokenId, Side.SELL, this.targetedMarket);

                this.writeLog(
                    `SELL TIMEOUT: ${elapsedSeconds.toFixed(1)}s elapsed (timeout: ${effectiveTimeout.toFixed(1)}s), ` +
                    `selling at market price ${currentBidPrice.toFixed(2)}`
                );

                await this.cancelTrade(this.sellOrder);

                // Sell at market price
                const marketSellPrice = Math.max(0.01, currentBidPrice - 0.01);
                this.sellOrder = await this.makeOrder(
                    'ncandle-timeout-sell',
                    this.entryTokenId,
                    marketSellPrice,
                    this.buyOrder.amount,
                    Side.SELL
                );

                return true;
            } catch (error) {
                this.writeError(`Error in sell timeout: ${error}`);
            }
        }

        return false;
    }

    private async checkEarlySell(): Promise<boolean> {
        if (!this.buyMatchedAt || !this.sellOrder || !this.entryTokenId || !this.buyOrder || !this.actualBuyPrice) return false;
        if (this.sellOrder.status !== TradeStatus.LIVE) return false;

        try {
            const currentBidPrice = await this.marketInfo.getPrice(this.entryTokenId, Side.SELL, this.targetedMarket);
            const timeLeftRatio = this.getTimeLeftRatio();

            // Calculate current PnL ratio (positive = profit, negative = loss)
            const pnlPerToken = currentBidPrice - this.actualBuyPrice;
            const pnlRatio = pnlPerToken / this.actualBuyPrice;

            // Early sell threshold: combines time pressure and PnL
            // As time runs out (timeLeftRatio -> 0) and we have profit (pnlRatio > 0),
            // we become more willing to sell early
            const urgency = (1 - timeLeftRatio) * this.earlySellScalar;
            const profitThreshold = this.minProfitMargin * (1 - urgency);

            // Only consider early sell if:
            // 1. We're in profit (even small)
            // 2. Time pressure is high enough
            // 3. Combined with sellTimeoutScalar for additional pressure
            const combinedPressure = urgency * (1 + this.sellTimeoutScalar);
            const shouldSellEarly = pnlRatio > 0 && combinedPressure > 0.5 && pnlPerToken >= profitThreshold;

            if (shouldSellEarly) {
                this.writeLog(
                    `EARLY SELL: timeLeft=${(timeLeftRatio * 100).toFixed(1)}%, ` +
                    `PnL=${(pnlRatio * 100).toFixed(2)}% ($${pnlPerToken.toFixed(3)}/token), ` +
                    `pressure=${(combinedPressure * 100).toFixed(1)}%`
                );

                await this.cancelTrade(this.sellOrder);

                // Sell at slightly below market to ensure fill
                const earlySellPrice = Math.max(0.01, currentBidPrice - 0.01);
                this.sellOrder = await this.makeOrder(
                    'ncandle-early-sell',
                    this.entryTokenId,
                    earlySellPrice,
                    this.buyOrder.amount,
                    Side.SELL
                );

                return true;
            }
        } catch (error) {
            this.writeError(`Error in early sell check: ${error}`);
        }

        return false;
    }

    // -------------------------------------------------------------------------
    // Position Sizing
    // -------------------------------------------------------------------------

    private calculateValidPositionSize(price: number): number | null {
        // Convert dollar amount to token quantity
        const size = this.dollarToTokens(this.targetDollars, price);
        if (size === null) {
            return null;
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
            this.resetForNewTrade();
        } else {
            this.state = 'PAST_CUTOFF';
        }
    }

    // -------------------------------------------------------------------------
    // Price Data
    // -------------------------------------------------------------------------

    private async getCurrentPrice(): Promise<number | null> {
        try {
            const cdMarketData = this.getCdMarketData();
            return await cdMarketData.getCurrentPriceByMarket(this.targetedMarket);
        } catch (error) {
            this.writeError(error);
            return null;
        }
    }

    // -------------------------------------------------------------------------
    // Time-Based Helpers
    // -------------------------------------------------------------------------

    /**
     * Returns ratio of time left in the current period (0-1).
     * 1 = full period remaining, 0 = period about to end.
     */
    private getTimeLeftRatio(): number {
        const currentMinute = this.clock.getMinutes();
        let periodMinutes: number;
        let minuteInPeriod: number;

        if (this.marketSchedule === MarketSchedule.QUARTERLY) {
            periodMinutes = 15;
            minuteInPeriod = currentMinute % 15;
        } else {
            periodMinutes = 60;
            minuteInPeriod = currentMinute;
        }

        // Use cutoffMinute as the effective end of trading period
        const tradingMinutes = Math.min(this.cutoffMinute, periodMinutes);
        const minutesLeft = Math.max(0, tradingMinutes - minuteInPeriod);

        return minutesLeft / tradingMinutes;
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
