import { Side } from "@polymarket/clob-client";

import { QuantBotRun, TradeOrder, TradeStatus } from "./QuantBot.js";
import { MSPEQBotBase, MSPEQBotProps } from "./MSPEQBotBase.js";
import { BtcDirection, MarketSchedule } from "../types/interfaces.js";
import { MultiSignalPEQ, MultiSignalPEQConfig } from "../utils/MultiSignalPEQ.js";

// ============================================================================
// Types & Interfaces
// ============================================================================

export interface OrderFlowImbalanceMSPEQProps extends MSPEQBotProps {
    // Base parameters
    targetDollars: number;
    baseImbalanceThreshold: number;   // Min imbalance ratio to trigger trade (e.g., 1.5)
    depthLookbackLevels: number;      // Number of order book levels to analyze (e.g., 5)
    baseBuyPrice: number;             // Base buy price (e.g., 0.50)
    baseSellPrice: number;            // Base sell price (e.g., 0.80)
    baseCutoffMinute: number;
    minProfitMargin: number;

    // MSPEQ configs
    imbalanceThresholdMSPEQ: MultiSignalPEQConfig;
    buyPriceMSPEQ: MultiSignalPEQConfig;
    sellPriceMSPEQ: MultiSignalPEQConfig;
    cutoffMinuteMSPEQ: MultiSignalPEQConfig;
    earlySellTimeMSPEQ: MultiSignalPEQConfig;
    earlySellPriceMSPEQ: MultiSignalPEQConfig;
}

// ============================================================================
// OrderFlowImbalanceMSPEQ Class
// ============================================================================

/**
 * OrderFlowImbalanceMSPEQ - Trades on bid/ask depth imbalance in order books.
 *
 * Uses MarketInfo.getLiveData() to compute depth ratios:
 * - When total bid depth >> total ask depth = buying pressure -> buy UP
 * - When total ask depth >> total bid depth = selling pressure -> buy DOWN
 *
 * MSPEQ dynamically adjusts imbalance threshold, buy/sell prices, and timing.
 */
export class OrderFlowImbalanceMSPEQ extends MSPEQBotBase implements QuantBotRun {

    // --- Configuration ---
    private targetDollars: number;
    private baseImbalanceThreshold: number;
    private depthLookbackLevels: number;
    private baseBuyPrice: number;
    private baseSellPrice: number;
    private baseCutoffMinute: number;
    private minProfitMargin: number;

    // --- Multi-Signal PEQs ---
    private imbalanceThresholdMSPEQ: MultiSignalPEQ;
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

    // --- Order Flow State ---
    private lastImbalanceRatio: number = 1.0;

    // --- Constructor ---

    constructor(props: OrderFlowImbalanceMSPEQProps) {
        super(props);

        this.targetDollars = props.targetDollars;
        this.baseImbalanceThreshold = props.baseImbalanceThreshold;
        this.depthLookbackLevels = props.depthLookbackLevels;
        this.baseBuyPrice = props.baseBuyPrice;
        this.baseSellPrice = props.baseSellPrice;
        this.baseCutoffMinute = props.baseCutoffMinute;
        this.minProfitMargin = props.minProfitMargin;

        this.imbalanceThresholdMSPEQ = new MultiSignalPEQ(props.imbalanceThresholdMSPEQ);
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
        this.lastImbalanceRatio = 1.0;
        this.resetSignalState();
    }

    // -------------------------------------------------------------------------
    // Order Flow Analysis
    // -------------------------------------------------------------------------

    /**
     * Computes the bid/ask depth imbalance ratio for the UP token.
     * Returns the ratio bidDepth / askDepth.
     * - > 1.0 means more buying pressure (bullish)
     * - < 1.0 means more selling pressure (bearish)
     */
    private computeImbalanceRatio(
        bids: { price: string; size: string }[],
        asks: { price: string; size: string }[],
    ): number {
        const levels = this.depthLookbackLevels;

        let totalBidDepth = 0;
        for (let i = 0; i < Math.min(levels, bids.length); i++) {
            totalBidDepth += parseFloat(bids[i].size);
        }

        let totalAskDepth = 0;
        for (let i = 0; i < Math.min(levels, asks.length); i++) {
            totalAskDepth += parseFloat(asks[i].size);
        }

        // Avoid division by zero
        if (totalAskDepth === 0) return totalBidDepth > 0 ? 10.0 : 1.0;
        if (totalBidDepth === 0) return 0.1;

        return totalBidDepth / totalAskDepth;
    }

    // -------------------------------------------------------------------------
    // MSPEQ Parameter Computation
    // -------------------------------------------------------------------------

    private computeDynamicImbalanceThreshold(): number {
        const signals = this.getSignalRecord();
        const mspeqOutput = this.imbalanceThresholdMSPEQ.compute(signals);
        return Math.max(1.01, this.baseImbalanceThreshold * mspeqOutput);
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

        // 3. Update orders
        await this.updateOrders();

        // 4. Compute order flow imbalance
        const orderBooks = await this.marketInfo.getLiveData(this.targetedMarket);
        this.lastImbalanceRatio = this.computeImbalanceRatio(
            orderBooks.BtcUp.bids, orderBooks.BtcUp.asks
        );

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

        // 9. Check buy based on imbalance
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

        const threshold = this.computeDynamicImbalanceThreshold();

        // Need significant imbalance in either direction
        if (this.lastImbalanceRatio >= threshold) {
            // Strong buying pressure -> bet UP
            this.computedDirection = BtcDirection.UP;
        } else if (this.lastImbalanceRatio <= (1.0 / threshold)) {
            // Strong selling pressure -> bet DOWN
            this.computedDirection = BtcDirection.DOWN;
        } else {
            return false; // No clear signal
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

        if (mspeqOutput < OrderFlowImbalanceMSPEQ.MIN_MSPEQ_OUTPUT) {
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
            'orderflow-mspeq-buy',
            tokenId,
            targetBuyPrice,
            targetSize,
            Side.BUY
        );

        if (this.buyOrder) {
            this.writeLog(
                `createBuyOrder: placed (direction=${this.computedDirection}, ` +
                `price=${targetBuyPrice.toFixed(3)}, imbalance=${this.lastImbalanceRatio.toFixed(3)})`
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
            'orderflow-mspeq-sell',
            tokenId,
            targetSellPrice,
            this.buyOrder.amount,
            Side.SELL
        );

        if (this.sellOrder) {
            this.writeLog(
                `createSellOrder: placed (price=${targetSellPrice.toFixed(3)})`
            );
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
            'orderflow-mspeq-early-sell',
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
