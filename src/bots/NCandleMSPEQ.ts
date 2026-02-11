import { Side } from "@polymarket/clob-client";

import { QuantBotRun, TradeOrder, TradeStatus } from "./QuantBot.js";
import { MSPEQBotBase, MSPEQBotProps } from "./MSPEQBotBase.js";
import { MarketSchedule } from "../types/interfaces.js";
import { MultiSignalPEQ, MultiSignalPEQConfig } from "../utils/MultiSignalPEQ.js";

// ============================================================================
// Types & Interfaces
// ============================================================================

export interface NCandleMSPEQProps extends MSPEQBotProps {
    // Base parameters (static, from NCandle)
    candleMinutes: number;
    buyPriceBuffer: number;
    sellPriceBuffer: number;
    minProfitMargin: number;
    stopLossMultiplier: number;
    stoplossTimeout: number;
    sellTimeout: number;
    stoplossFailureTimeout: number;
    earlySellScalar: number;
    targetDollars: number;
    cutoffMinute: number;
    maxTradesPerHour: number;

    // MSPEQ configs (replace ScalingPEQ)
    buyPriceBufferMSPEQ: MultiSignalPEQConfig;
    minProfitMarginMSPEQ: MultiSignalPEQConfig;
    stoplossTimeoutMSPEQ: MultiSignalPEQConfig;
    sellTimeoutMSPEQ: MultiSignalPEQConfig;
    stoplossFailureTimeoutMSPEQ: MultiSignalPEQConfig;
}

type TradingState =
    | 'FORMING_CANDLE'
    | 'TRADE_ACTIVE'
    | 'PAST_CUTOFF';

type BreakoutDirection = 'UP' | 'DOWN';

interface Candle {
    high: number;
    low: number;
    open: number;
    close: number;
    startMinute: number;
}

// ============================================================================
// NCandleMSPEQ Class
// ============================================================================

/**
 * NCandleMSPEQ - NCandle strategy with Multi-Signal PEQ
 *
 * Extends the NCandle strategy by using multiple market signals
 * (candleSize, volatility, momentum) to dynamically compute trading parameters:
 *
 * - buyPriceBuffer: Buffer above ask for buy orders
 * - minProfitMargin: Minimum profit target
 * - stoplossTimeout: Wait time before stop-loss triggers
 * - sellTimeout: Force-sell timeout
 * - stoplossFailureTimeout: Repricing timeout for unfilled stops
 *
 * Each MSPEQ combines weighted polynomial outputs from multiple signals,
 * allowing the genetic optimizer to learn complex relationships.
 */
export class NCandleMSPEQ extends MSPEQBotBase implements QuantBotRun {

    // --- Configuration ---
    private readonly MIN_ORDER_SIZE = 5;
    private readonly MIN_ORDER_VALUE = 1.00;
    private readonly MAX_SELL_PRICE = 0.95;

    // --- Properties ---
    private candleMinutes: number;
    private buyPriceBuffer: number;
    private sellPriceBuffer: number;
    private minProfitMargin: number;
    private stopLossMultiplier: number;
    private stoplossTimeout: number;
    private sellTimeout: number;
    private stoplossFailureTimeout: number;
    private earlySellScalar: number;
    private targetDollars: number;
    private cutoffMinute: number;
    private maxTradesPerHour: number;

    // --- Multi-Signal PEQs ---
    private buyPriceBufferMSPEQ: MultiSignalPEQ;
    private minProfitMarginMSPEQ: MultiSignalPEQ;
    private stoplossTimeoutMSPEQ: MultiSignalPEQ;
    private sellTimeoutMSPEQ: MultiSignalPEQ;
    private stoplossFailureTimeoutMSPEQ: MultiSignalPEQ;

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
    private completedCandle?: Candle;

    // --- Timeout Tracking ---
    private stoplossBelowSince?: number;
    private buyMatchedAt?: number;
    private originalSellPrice?: number;
    private isStoplossOrder: boolean = false;
    private stoplossCreatedAt?: number;

    // --- Constructor ---

    constructor(props: NCandleMSPEQProps) {
        super(props);

        // Base parameters
        this.candleMinutes = props.candleMinutes;
        this.buyPriceBuffer = props.buyPriceBuffer;
        this.sellPriceBuffer = props.sellPriceBuffer;
        this.minProfitMargin = props.minProfitMargin;
        this.stopLossMultiplier = props.stopLossMultiplier;
        this.stoplossTimeout = props.stoplossTimeout;
        this.sellTimeout = props.sellTimeout;
        this.stoplossFailureTimeout = props.stoplossFailureTimeout ?? 15;
        this.earlySellScalar = props.earlySellScalar;
        this.targetDollars = props.targetDollars;
        this.cutoffMinute = props.cutoffMinute;
        this.maxTradesPerHour = props.maxTradesPerHour;

        // Multi-Signal PEQs
        this.buyPriceBufferMSPEQ = new MultiSignalPEQ(props.buyPriceBufferMSPEQ);
        this.minProfitMarginMSPEQ = new MultiSignalPEQ(props.minProfitMarginMSPEQ);
        this.stoplossTimeoutMSPEQ = new MultiSignalPEQ(props.stoplossTimeoutMSPEQ);
        this.sellTimeoutMSPEQ = new MultiSignalPEQ(props.sellTimeoutMSPEQ);
        this.stoplossFailureTimeoutMSPEQ = new MultiSignalPEQ(props.stoplossFailureTimeoutMSPEQ);
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
        this.stoplossCreatedAt = undefined;

        // Reset signal state (from base class)
        this.resetSignalState();
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
        this.stoplossCreatedAt = undefined;
        // Keep previousCandles and lastCandleIndex for continuity
    }

    /**
     * Override updateSignals to also update candle data from currentCandle
     */
    protected override async updateSignals() {
        if (this.currentCandle) {
            this.candleHigh = this.currentCandle.high;
            this.candleLow = this.currentCandle.low;
        }
        return super.updateSignals();
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
        // Update signals first
        await this.updateSignals();

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
                return;
            }

            // Check if stoploss order needs repricing due to timeout
            const stoplossRepriced = await this.checkStoplossFailure();
            if (stoplossRepriced) {
                return;
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

                // Trade on candle direction
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

        // Calculate effective buy price buffer using MSPEQ
        const signals = this.getSignalRecord();
        const mspeqOutput = this.buyPriceBufferMSPEQ.compute(signals);
        const effectiveBuyBuffer = this.buyPriceBuffer * mspeqOutput;

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
            `stop-loss: ${this.stopLossPrice.toFixed(2)}, mspeqOut: ${mspeqOutput.toFixed(3)})`
        );

        // Store for later reference
        this.actualBuyPrice = dynamicBuyPrice;
        this.entryTokenId = tokenId;

        this.buyOrder = await this.makeOrder(
            'ncandlemspeq-buy',
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

        // Calculate effective min profit margin using MSPEQ
        const signals = this.getSignalRecord();
        const mspeqOutput = this.minProfitMarginMSPEQ.compute(signals);
        const effectiveMinProfitMargin = this.minProfitMargin * mspeqOutput;

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
            `buy was: ${this.actualBuyPrice.toFixed(2)}, mspeqOut: ${mspeqOutput.toFixed(3)})`
        );

        this.sellOrder = await this.makeOrder(
            'ncandlemspeq-sell',
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
        const stopLossOffset = (candleRange * this.stopLossMultiplier) / 10000;
        const stopLoss = Math.max(0.01, buyPrice - stopLossOffset);
        return Math.round(stopLoss * 100) / 100;
    }

    private async checkStopLoss(): Promise<boolean> {
        if (!this.stopLossPrice || !this.entryTokenId || !this.buyOrder) return false;
        if (this.buyOrder.status !== TradeStatus.MATCHED) return false;
        if (this.isStoplossOrder) return false;

        try {
            const currentBidPrice = await this.marketInfo.getPrice(this.entryTokenId, Side.SELL, this.targetedMarket);

            if (currentBidPrice <= this.stopLossPrice) {
                const now = this.clock.now();

                if (!this.stoplossBelowSince) {
                    this.stoplossBelowSince = now;
                    this.writeLog(
                        `Price below stoploss: ${currentBidPrice.toFixed(2)} <= ${this.stopLossPrice.toFixed(2)}, ` +
                        `starting timeout countdown`
                    );
                    return false;
                }

                // Calculate effective stoploss timeout using MSPEQ
                const signals = this.getSignalRecord();
                const mspeqOutput = this.stoplossTimeoutMSPEQ.compute(signals);
                const effectiveTimeout = this.stoplossTimeout * mspeqOutput;
                const elapsedSeconds = (now - this.stoplossBelowSince) / 1000;

                if (elapsedSeconds >= effectiveTimeout) {
                    this.writeLog(
                        `STOP-LOSS TRIGGERED: Price ${currentBidPrice.toFixed(2)} below stoploss ` +
                        `${this.stopLossPrice.toFixed(2)} for ${elapsedSeconds.toFixed(1)}s ` +
                        `(timeout: ${effectiveTimeout.toFixed(1)}s, mspeqOut: ${mspeqOutput.toFixed(3)})`
                    );

                    // Cancel existing sell order if any
                    if (this.sellOrder && this.sellOrder.status === TradeStatus.LIVE) {
                        await this.cancelTrade(this.sellOrder);
                    }

                    // Create market sell (at lower price to ensure fill)
                    const emergencySellPrice = Math.max(0.01, currentBidPrice - 0.02);
                    this.sellOrder = await this.makeOrder(
                        'ncandlemspeq-stoploss',
                        this.entryTokenId,
                        emergencySellPrice,
                        this.buyOrder.amount,
                        Side.SELL
                    );
                    this.isStoplossOrder = true;
                    this.stoplossCreatedAt = this.clock.now();

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
                    'ncandlemspeq-sell-recovered',
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

    private async checkStoplossFailure(): Promise<boolean> {
        if (!this.isStoplossOrder || !this.sellOrder || !this.entryTokenId || !this.buyOrder) return false;
        if (this.sellOrder.status !== TradeStatus.LIVE) return false;
        if (!this.stoplossCreatedAt) return false;

        const now = this.clock.now();

        // Calculate effective stoploss failure timeout using MSPEQ
        const signals = this.getSignalRecord();
        const mspeqOutput = this.stoplossFailureTimeoutMSPEQ.compute(signals);
        const effectiveTimeout = this.stoplossFailureTimeout * mspeqOutput * 1000;
        const elapsedMs = now - this.stoplossCreatedAt;

        if (elapsedMs < effectiveTimeout) {
            return false;
        }

        try {
            const currentBidPrice = await this.marketInfo.getPrice(this.entryTokenId, Side.SELL, this.targetedMarket);

            // Calculate new stoploss price: below current market to encourage fill
            const newStoplossPrice = Math.max(0.01, currentBidPrice - 0.02);

            this.writeLog(
                `STOPLOSS FAILURE: Order unfilled for ${(elapsedMs / 1000).toFixed(1)}s ` +
                `(timeout: ${(effectiveTimeout / 1000).toFixed(1)}s, mspeqOut: ${mspeqOutput.toFixed(3)}), ` +
                `repricing from ${this.sellOrder.targetSellPrice?.toFixed(2)} to ${newStoplossPrice.toFixed(2)} ` +
                `(bid=${currentBidPrice.toFixed(2)})`
            );

            // Cancel current stoploss order
            await this.cancelTrade(this.sellOrder);

            // Create new stoploss order at updated price
            this.sellOrder = await this.makeOrder(
                'ncandlemspeq-stoploss-repriced',
                this.entryTokenId,
                newStoplossPrice,
                this.buyOrder.amount,
                Side.SELL
            );

            // Reset stoploss timestamp for the new order
            this.stoplossCreatedAt = this.clock.now();

            return true;
        } catch (error) {
            this.writeError(`Error in stoploss failure check: ${error}`);
        }

        return false;
    }

    private async checkSellTimeout(): Promise<boolean> {
        if (!this.buyMatchedAt || !this.sellOrder || !this.entryTokenId || !this.buyOrder) return false;
        if (this.sellOrder.status !== TradeStatus.LIVE) return false;

        const now = this.clock.now();
        const elapsedSeconds = (now - this.buyMatchedAt) / 1000;

        // Calculate effective sell timeout using MSPEQ
        const signals = this.getSignalRecord();
        const mspeqOutput = this.sellTimeoutMSPEQ.compute(signals);
        const effectiveTimeout = this.sellTimeout * mspeqOutput;

        if (elapsedSeconds >= effectiveTimeout) {
            try {
                const currentBidPrice = await this.marketInfo.getPrice(this.entryTokenId, Side.SELL, this.targetedMarket);

                this.writeLog(
                    `SELL TIMEOUT: ${elapsedSeconds.toFixed(1)}s elapsed (timeout: ${effectiveTimeout.toFixed(1)}s, ` +
                    `mspeqOut: ${mspeqOutput.toFixed(3)}), selling at market price ${currentBidPrice.toFixed(2)}`
                );

                await this.cancelTrade(this.sellOrder);

                // Sell at market price
                const marketSellPrice = Math.max(0.01, currentBidPrice - 0.01);
                this.sellOrder = await this.makeOrder(
                    'ncandlemspeq-timeout-sell',
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
            const urgency = (1 - timeLeftRatio) * this.earlySellScalar;
            const profitThreshold = this.minProfitMargin * (1 - urgency);

            // Use sellTimeoutMSPEQ for additional pressure calculation
            const signals = this.getSignalRecord();
            const sellPressureMultiplier = this.sellTimeoutMSPEQ.compute(signals);
            const combinedPressure = urgency * sellPressureMultiplier;
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
                    'ncandlemspeq-early-sell',
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
        const size = this.dollarToTokens(this.targetDollars, price);
        if (size === null) {
            return null;
        }

        if (!this.checkIfOrderIsValid(price, size)) {
            return null;
        }

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
