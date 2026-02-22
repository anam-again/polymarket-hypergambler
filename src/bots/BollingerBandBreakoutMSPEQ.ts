import { Side } from "@polymarket/clob-client";

import { QuantBotRun, TradeOrder, TradeStatus } from "./QuantBot.js";
import { MSPEQBotBase, MSPEQBotProps } from "./MSPEQBotBase.js";
import { BtcDirection, MarketSchedule } from "../types/interfaces.js";
import { MultiSignalPEQ, MultiSignalPEQConfig } from "../utils/MultiSignalPEQ.js";

// ============================================================================
// Types & Interfaces
// ============================================================================

export interface BollingerBandBreakoutMSPEQProps extends MSPEQBotProps {
    // Base parameters
    targetDollars: number;
    lookbackPeriods: number;         // Number of price samples for rolling mean/stddev
    baseBandWidth: number;           // Base multiplier for stddev bands (e.g., 2.0)
    baseBuyPrice: number;            // Base buy price (e.g., 0.50)
    baseSellPrice: number;           // Base sell price (e.g., 0.80)
    baseCutoffMinute: number;
    minProfitMargin: number;

    // MSPEQ configs
    bandWidthMSPEQ: MultiSignalPEQConfig;
    buyPriceMSPEQ: MultiSignalPEQConfig;
    sellPriceMSPEQ: MultiSignalPEQConfig;
    cutoffMinuteMSPEQ: MultiSignalPEQConfig;
    earlySellTimeMSPEQ: MultiSignalPEQConfig;
    earlySellPriceMSPEQ: MultiSignalPEQConfig;
}

// ============================================================================
// BollingerBandBreakoutMSPEQ Class
// ============================================================================

/**
 * BollingerBandBreakoutMSPEQ - Bollinger Band strategy with MSPEQ.
 *
 * Computes rolling mean and standard deviation of UP token mid prices.
 * Upper band = mean + bandWidth * stddev
 * Lower band = mean - bandWidth * stddev
 *
 * Trading logic:
 * - Breakout above upper band = momentum buy (bet UP, price moving strongly upward)
 * - Breakdown below lower band = mean reversion buy (bet DOWN or buy UP cheap)
 *
 * MSPEQ dynamically adjusts band width, buy/sell prices, and timing.
 */
export class BollingerBandBreakoutMSPEQ extends MSPEQBotBase implements QuantBotRun {

    // --- Configuration ---
    private targetDollars: number;
    private lookbackPeriods: number;
    private baseBandWidth: number;
    private baseBuyPrice: number;
    private baseSellPrice: number;
    private baseCutoffMinute: number;
    private minProfitMargin: number;

    // --- Multi-Signal PEQs ---
    private bandWidthMSPEQ: MultiSignalPEQ;
    private buyPriceMSPEQ: MultiSignalPEQ;
    private sellPriceMSPEQ: MultiSignalPEQ;
    private cutoffMinuteMSPEQ: MultiSignalPEQ;
    private earlySellTimeMSPEQ: MultiSignalPEQ;
    private earlySellPriceMSPEQ: MultiSignalPEQ;

    // --- Trading State ---
    private buyOrder?: TradeOrder;
    private sellOrder?: TradeOrder;
    private earlySellOrder?: TradeOrder;
    private isPastCutoff: boolean = false;
    private actualBuyPrice: number = 0;
    private computedDirection?: BtcDirection;

    // --- Bollinger Band State ---
    private priceHistory: number[] = [];
    private rollingMean: number = 0.5;
    private rollingStddev: number = 0;
    private upperBand: number = 1.0;
    private lowerBand: number = 0.0;

    // --- Constructor ---

    constructor(props: BollingerBandBreakoutMSPEQProps) {
        super(props);

        this.targetDollars = props.targetDollars;
        this.lookbackPeriods = props.lookbackPeriods;
        this.baseBandWidth = props.baseBandWidth;
        this.baseBuyPrice = props.baseBuyPrice;
        this.baseSellPrice = props.baseSellPrice;
        this.baseCutoffMinute = props.baseCutoffMinute;
        this.minProfitMargin = props.minProfitMargin;

        this.bandWidthMSPEQ = new MultiSignalPEQ(props.bandWidthMSPEQ);
        this.buyPriceMSPEQ = new MultiSignalPEQ(props.buyPriceMSPEQ);
        this.sellPriceMSPEQ = new MultiSignalPEQ(props.sellPriceMSPEQ);
        this.cutoffMinuteMSPEQ = new MultiSignalPEQ(props.cutoffMinuteMSPEQ);
        this.earlySellTimeMSPEQ = new MultiSignalPEQ(props.earlySellTimeMSPEQ);
        this.earlySellPriceMSPEQ = new MultiSignalPEQ(props.earlySellPriceMSPEQ);
    }

    // --- Main Run Loop ---

    public async run(): Promise<void> {
        this.setupPeriodReset();
        this.startTradingLoop();
    }

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
        this.isPastCutoff = false;
        this.actualBuyPrice = 0;
        this.computedDirection = undefined;
        this.priceHistory = [];
        this.rollingMean = 0.5;
        this.rollingStddev = 0;
        this.upperBand = 1.0;
        this.lowerBand = 0.0;
        this.resetSignalState();
    }

    // -------------------------------------------------------------------------
    // Bollinger Band Computation
    // -------------------------------------------------------------------------

    private updateBollingerBands(): void {
        // Add current UP mid price to history
        this.priceHistory.push(this.cachedUpMid);

        // Trim to lookback window
        if (this.priceHistory.length > this.lookbackPeriods) {
            this.priceHistory = this.priceHistory.slice(-this.lookbackPeriods);
        }

        if (this.priceHistory.length < 3) {
            // Not enough data yet
            this.rollingMean = this.cachedUpMid;
            this.rollingStddev = 0;
            this.upperBand = 1.0;
            this.lowerBand = 0.0;
            return;
        }

        // Compute mean
        const sum = this.priceHistory.reduce((a, b) => a + b, 0);
        this.rollingMean = sum / this.priceHistory.length;

        // Compute stddev
        const squaredDiffs = this.priceHistory.map(p => (p - this.rollingMean) ** 2);
        const variance = squaredDiffs.reduce((a, b) => a + b, 0) / (this.priceHistory.length - 1);
        this.rollingStddev = Math.sqrt(variance);

        // Compute dynamic band width via MSPEQ
        const bandWidth = this.computeDynamicBandWidth();

        this.upperBand = Math.min(0.99, this.rollingMean + bandWidth * this.rollingStddev);
        this.lowerBand = Math.max(0.01, this.rollingMean - bandWidth * this.rollingStddev);
    }

    // -------------------------------------------------------------------------
    // MSPEQ Parameter Computation
    // -------------------------------------------------------------------------

    private computeDynamicBandWidth(): number {
        const signals = this.getSignalRecord();
        const mspeqOutput = this.bandWidthMSPEQ.compute(signals);
        return Math.max(0.5, this.baseBandWidth * mspeqOutput);
    }

    private computeDynamicBuyPrice(): number {
        const signals = this.getSignalRecord();
        const mspeqOutput = this.buyPriceMSPEQ.compute(signals);
        const dynamicPrice = Math.round(this.baseBuyPrice * mspeqOutput * 100) / 100;
        return Math.max(0.01, Math.min(0.99, dynamicPrice));
    }

    private computeDynamicSellPrice(): number {
        const signals = this.getSignalRecord();
        const mspeqOutput = this.sellPriceMSPEQ.compute(signals);
        const dynamicPrice = Math.round(this.baseSellPrice * mspeqOutput * 100) / 100;
        return Math.max(this.actualBuyPrice + this.minProfitMargin, Math.min(0.99, dynamicPrice));
    }

    private computeDynamicCutoffMinute(): number {
        const signals = this.getSignalRecord();
        const mspeqOutput = this.cutoffMinuteMSPEQ.compute(signals);
        const dynamicCutoff = Math.round(this.baseCutoffMinute * mspeqOutput);
        const maxCutoff = this.marketSchedule === MarketSchedule.QUARTERLY ? 14 : 59;
        return Math.max(1, Math.min(maxCutoff, dynamicCutoff));
    }

    // -------------------------------------------------------------------------
    // Trading Loop
    // -------------------------------------------------------------------------

    private startTradingLoop(): void {
        this.tickWrapper(1000 * 5, 1000 * 2, async () => {
            await this.executeTradingLogic();
        });
    }

    private async executeTradingLogic(): Promise<void> {
        // 1. Update signals
        await this.updateSignals();

        // 2. Update regime
        this.updateRegime();

        // 3. Update Bollinger Bands
        this.updateBollingerBands();

        // 4. Update orders
        await this.updateOrders();

        // 5. Check sell order creation
        if (this.shouldCreateSellOrder()) {
            await this.createSellOrder();
        }

        // 6. Check early sell
        if (this.shouldTriggerEarlySell()) {
            await this.createEarlySellOrder();
        }

        if (this.isPastCutoff) return;

        // 7. Check cutoff
        if (this.isAfterCutoff()) {
            await this.handleCutoff();
            return;
        }

        // 8. Check TradeGate
        if (!this.shouldTrade()) return;

        // 9. Check for breakout buy opportunity
        if (this.shouldCreateBuyOrder()) {
            await this.createBuyOrder();
        }
    }

    public override async onSimulationTick(): Promise<void> {
        await this.executeTradingLogic();
    }

    // -------------------------------------------------------------------------
    // Order Logic
    // -------------------------------------------------------------------------

    private shouldCreateBuyOrder(): boolean {
        if (this.buyOrder) return false;

        // Need enough data for meaningful bands
        if (this.priceHistory.length < 5) return false;
        if (this.rollingStddev === 0) return false;

        // Check for breakout: price above upper band = momentum UP
        if (this.cachedUpMid > this.upperBand) {
            this.computedDirection = BtcDirection.UP;
        }
        // Check for breakdown: price below lower band = mean reversion, buy UP cheap
        else if (this.cachedUpMid < this.lowerBand) {
            this.computedDirection = BtcDirection.UP; // Buy UP at low price, expecting reversion
        }
        else {
            return false; // Price within bands, no signal
        }

        const targetBuyPrice = this.computeDynamicBuyPrice();
        const targetSize = this.dollarToTokens(this.targetDollars, targetBuyPrice);
        if (targetSize === null) return false;
        if (!this.checkIfOrderIsValid(targetBuyPrice, targetSize)) return false;
        if (!this.canSpend(targetBuyPrice * targetSize)) return false;
        return true;
    }

    private shouldCreateSellOrder(): boolean {
        if (this.sellOrder) return false;
        if (!this.buyOrder) return false;
        return this.buyOrder.status === TradeStatus.MATCHED;
    }

    private static readonly MIN_MSPEQ_OUTPUT = 0.1;

    private async createBuyOrder(): Promise<void> {
        if (this.buyOrder || !this.computedDirection) return;

        const orderBooks = await this.marketInfo.getLiveData(this.targetedMarket);
        const tokenId = this.computedDirection === BtcDirection.UP
            ? orderBooks.BtcUpTokenId
            : orderBooks.BtcDownTokenId;

        const signals = this.getSignalRecord();
        const mspeqOutput = this.buyPriceMSPEQ.compute(signals);

        if (mspeqOutput < BollingerBandBreakoutMSPEQ.MIN_MSPEQ_OUTPUT) {
            this.writeLog(`createBuyOrder: skipping - MSPEQ output too low (${mspeqOutput.toFixed(4)})`);
            return;
        }

        const dynamicBuyPrice = Math.round(this.baseBuyPrice * mspeqOutput * 100) / 100;
        const targetBuyPrice = Math.max(0.01, Math.min(0.99, dynamicBuyPrice));
        this.actualBuyPrice = targetBuyPrice;

        const targetSize = this.dollarToTokens(this.targetDollars, targetBuyPrice);
        if (targetSize === null) return;
        if (!this.checkIfOrderIsValid(targetBuyPrice, targetSize)) return;
        if (!this.canSpend(targetBuyPrice * targetSize)) return;

        this.buyOrder = await this.makeOrder(
            'bollinger-mspeq-buy',
            tokenId,
            targetBuyPrice,
            targetSize,
            Side.BUY
        );

        if (this.buyOrder) {
            const breakoutType = this.cachedUpMid > this.upperBand ? 'UPPER_BREAKOUT' : 'LOWER_BREAKDOWN';
            this.writeLog(
                `createBuyOrder: placed (${breakoutType}, price=${targetBuyPrice.toFixed(3)}, ` +
                `mean=${this.rollingMean.toFixed(3)}, upper=${this.upperBand.toFixed(3)}, ` +
                `lower=${this.lowerBand.toFixed(3)})`
            );
        }
    }

    private async createSellOrder(): Promise<void> {
        if (this.sellOrder || !this.buyOrder || !this.computedDirection) return;

        const orderBooks = await this.marketInfo.getLiveData(this.targetedMarket);
        const tokenId = this.computedDirection === BtcDirection.UP
            ? orderBooks.BtcUpTokenId
            : orderBooks.BtcDownTokenId;

        const targetSellPrice = this.computeDynamicSellPrice();

        this.sellOrder = await this.makeOrder(
            'bollinger-mspeq-sell',
            tokenId,
            targetSellPrice,
            this.buyOrder.amount,
            Side.SELL
        );

        if (this.sellOrder) {
            this.writeLog(`createSellOrder: placed (price=${targetSellPrice.toFixed(3)})`);
        }
    }

    // -------------------------------------------------------------------------
    // Early Sell Logic
    // -------------------------------------------------------------------------

    private shouldTriggerEarlySell(): boolean {
        if (!this.buyOrder || this.buyOrder.status !== TradeStatus.MATCHED) return false;
        if (this.sellOrder || this.earlySellOrder) return false;

        const signals = this.getSignalRecord();
        const timeThreshold = this.earlySellTimeMSPEQ.compute(signals);
        return signals.timeLeft < timeThreshold;
    }

    private async createEarlySellOrder(): Promise<void> {
        if (this.sellOrder || this.earlySellOrder || !this.buyOrder || !this.computedDirection) return;

        const orderBooks = await this.marketInfo.getLiveData(this.targetedMarket);
        const tokenId = this.computedDirection === BtcDirection.UP
            ? orderBooks.BtcUpTokenId
            : orderBooks.BtcDownTokenId;

        const signals = this.getSignalRecord();
        const mspeqOutput = this.earlySellPriceMSPEQ.compute(signals);
        const earlySellPrice = Math.round(this.actualBuyPrice * mspeqOutput * 100) / 100;
        const targetPrice = Math.max(
            this.actualBuyPrice + this.minProfitMargin * 0.5,
            Math.min(0.99, earlySellPrice)
        );

        this.earlySellOrder = await this.makeOrder(
            'bollinger-mspeq-early-sell',
            tokenId,
            targetPrice,
            this.buyOrder.amount,
            Side.SELL
        );

        if (this.earlySellOrder) {
            this.writeLog(`createEarlySellOrder: placed (price=${targetPrice.toFixed(3)})`);
        }
    }

    // -------------------------------------------------------------------------
    // Cutoff Logic
    // -------------------------------------------------------------------------

    private isAfterCutoff(): boolean {
        const cutoffMinute = this.computeDynamicCutoffMinute();
        return this.clock.getMinutes() >= cutoffMinute;
    }

    private async handleCutoff(): Promise<void> {
        this.isPastCutoff = true;

        if (this.buyOrder && this.buyOrder.status !== TradeStatus.MATCHED) {
            await this.cancelTrade(this.buyOrder);
            this.writeLog('handleCutoff: canceled pending buy order');
        }
    }
}
