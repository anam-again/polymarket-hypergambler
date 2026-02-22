import { Side } from "@polymarket/clob-client";

import { QuantBotRun, TradeOrder, TradeStatus } from "./QuantBot.js";
import { MSPEQBotBase, MSPEQBotProps } from "./MSPEQBotBase.js";
import { BtcDirection, MarketSchedule } from "../types/interfaces.js";
import { MultiSignalPEQ, MultiSignalPEQConfig } from "../utils/MultiSignalPEQ.js";

// ============================================================================
// Types & Interfaces
// ============================================================================

export interface VWAPMSPEQProps extends MSPEQBotProps {
    // Base parameters
    targetDollars: number;
    vwapLookbackMinutes: number;   // How many minutes of data for VWAP calculation
    baseBuyDistance: number;        // Distance below VWAP to trigger buy (e.g., 0.03)
    baseSellDistance: number;       // Distance above VWAP to trigger sell (e.g., 0.03)
    baseCutoffMinute: number;      // Cutoff minute for placing orders
    minProfitMargin: number;       // Minimum profit margin (e.g., 0.05)

    // MSPEQ configs
    buyDistanceMSPEQ: MultiSignalPEQConfig;
    sellDistanceMSPEQ: MultiSignalPEQConfig;
    cutoffMinuteMSPEQ: MultiSignalPEQConfig;
    earlySellTimeMSPEQ: MultiSignalPEQConfig;
    earlySellPriceMSPEQ: MultiSignalPEQConfig;
}

// ============================================================================
// VWAPMSPEQ Class
// ============================================================================

/**
 * VWAPMSPEQ - Volume-Weighted Average Price strategy with MSPEQ
 *
 * Tracks a synthetic VWAP of the UP token price across the period.
 * Buys when price is below VWAP (undervalued), sells when above (overvalued).
 * MSPEQ dynamically adjusts distance thresholds, cutoff time, and early sell.
 *
 * Since Polymarket doesn't provide volume data directly, we approximate
 * VWAP using time-weighted average of mid prices observed during the period.
 */
export class VWAPMSPEQ extends MSPEQBotBase implements QuantBotRun {

    // --- Configuration ---
    private targetDollars: number;
    private vwapLookbackMinutes: number;
    private baseBuyDistance: number;
    private baseSellDistance: number;
    private baseCutoffMinute: number;
    private minProfitMargin: number;

    // --- Multi-Signal PEQs ---
    private buyDistanceMSPEQ: MultiSignalPEQ;
    private sellDistanceMSPEQ: MultiSignalPEQ;
    private cutoffMinuteMSPEQ: MultiSignalPEQ;
    private earlySellTimeMSPEQ: MultiSignalPEQ;
    private earlySellPriceMSPEQ: MultiSignalPEQ;

    // --- Trading State ---
    private buyOrder?: TradeOrder;
    private sellOrder?: TradeOrder;
    private earlySellOrder?: TradeOrder;
    private isPastCutoff: boolean = false;
    private actualBuyPrice: number = 0;

    // --- VWAP Tracking ---
    private priceHistory: { price: number; timestamp: number }[] = [];
    private vwap: number = 0.5;

    // --- Constructor ---

    constructor(props: VWAPMSPEQProps) {
        super(props);

        this.targetDollars = props.targetDollars;
        this.vwapLookbackMinutes = props.vwapLookbackMinutes;
        this.baseBuyDistance = props.baseBuyDistance;
        this.baseSellDistance = props.baseSellDistance;
        this.baseCutoffMinute = props.baseCutoffMinute;
        this.minProfitMargin = props.minProfitMargin;

        this.buyDistanceMSPEQ = new MultiSignalPEQ(props.buyDistanceMSPEQ);
        this.sellDistanceMSPEQ = new MultiSignalPEQ(props.sellDistanceMSPEQ);
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
        this.priceHistory = [];
        this.vwap = 0.5;
        this.resetSignalState();
    }

    // -------------------------------------------------------------------------
    // VWAP Computation
    // -------------------------------------------------------------------------

    private updateVWAP(): void {
        const now = this.clock.now();
        const cutoffTime = now - (this.vwapLookbackMinutes * 60 * 1000);

        // Record current mid price
        this.priceHistory.push({ price: this.cachedUpMid, timestamp: now });

        // Remove old entries
        this.priceHistory = this.priceHistory.filter(p => p.timestamp >= cutoffTime);

        if (this.priceHistory.length === 0) {
            return;
        }

        // Time-weighted average (approximates VWAP without volume)
        let weightedSum = 0;
        let totalWeight = 0;

        for (let i = 0; i < this.priceHistory.length; i++) {
            // More recent prices get higher weight
            const recency = (this.priceHistory[i].timestamp - cutoffTime) / (now - cutoffTime + 1);
            const weight = 1 + recency;
            weightedSum += this.priceHistory[i].price * weight;
            totalWeight += weight;
        }

        this.vwap = totalWeight > 0 ? weightedSum / totalWeight : this.cachedUpMid;
    }

    // -------------------------------------------------------------------------
    // MSPEQ Parameter Computation
    // -------------------------------------------------------------------------

    private computeDynamicBuyDistance(): number {
        const signals = this.getSignalRecord();
        const mspeqOutput = this.buyDistanceMSPEQ.compute(signals);
        return Math.max(0.001, this.baseBuyDistance * mspeqOutput);
    }

    private computeDynamicSellDistance(): number {
        const signals = this.getSignalRecord();
        const mspeqOutput = this.sellDistanceMSPEQ.compute(signals);
        return Math.max(0.001, this.baseSellDistance * mspeqOutput);
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

        // 3. Update VWAP
        this.updateVWAP();

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

        // 9. Check buy opportunity (price below VWAP)
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

        const buyDistance = this.computeDynamicBuyDistance();
        // Buy when current price is below VWAP by at least buyDistance
        if (this.cachedUpMid >= (this.vwap - buyDistance)) return false;

        const targetBuyPrice = Math.max(0.01, Math.min(0.99, this.cachedUpMid));
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
        if (this.buyOrder) return;

        const orderBooks = await this.marketInfo.getLiveData(this.targetedMarket);
        // Always buy UP token (VWAP strategy bets on undervalued side)
        const tokenId = orderBooks.BtcUpTokenId;

        const targetBuyPrice = Math.max(0.01, Math.min(0.99, this.cachedUpMid));
        this.actualBuyPrice = targetBuyPrice;

        const targetSize = this.dollarToTokens(this.targetDollars, targetBuyPrice);
        if (targetSize === null) return;

        if (!this.checkIfOrderIsValid(targetBuyPrice, targetSize)) return;
        if (!this.canSpend(targetBuyPrice * targetSize)) return;

        this.buyOrder = await this.makeOrder(
            'vwap-mspeq-buy',
            tokenId,
            targetBuyPrice,
            targetSize,
            Side.BUY
        );

        if (this.buyOrder) {
            this.writeLog(
                `createBuyOrder: placed (price=${targetBuyPrice.toFixed(3)}, ` +
                `vwap=${this.vwap.toFixed(3)}, ` +
                `distance=${(this.vwap - this.cachedUpMid).toFixed(4)})`
            );
        }
    }

    private async createSellOrder(): Promise<void> {
        if (this.sellOrder || !this.buyOrder) return;

        const orderBooks = await this.marketInfo.getLiveData(this.targetedMarket);
        const tokenId = orderBooks.BtcUpTokenId;

        const sellDistance = this.computeDynamicSellDistance();
        const dynamicSellPrice = Math.round((this.vwap + sellDistance) * 100) / 100;
        const targetSellPrice = Math.max(
            this.actualBuyPrice + this.minProfitMargin,
            Math.min(0.99, dynamicSellPrice)
        );

        this.sellOrder = await this.makeOrder(
            'vwap-mspeq-sell',
            tokenId,
            targetSellPrice,
            this.buyOrder.amount,
            Side.SELL
        );

        if (this.sellOrder) {
            this.writeLog(
                `createSellOrder: placed (price=${targetSellPrice.toFixed(3)}, vwap=${this.vwap.toFixed(3)})`
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
        if (this.sellOrder || this.earlySellOrder || !this.buyOrder) return;

        const orderBooks = await this.marketInfo.getLiveData(this.targetedMarket);
        const tokenId = orderBooks.BtcUpTokenId;

        const signals = this.getSignalRecord();
        const mspeqOutput = this.earlySellPriceMSPEQ.compute(signals);
        const earlySellPrice = Math.round(this.actualBuyPrice * mspeqOutput * 100) / 100;
        const targetPrice = Math.max(
            this.actualBuyPrice + this.minProfitMargin * 0.5,
            Math.min(0.99, earlySellPrice)
        );

        this.earlySellOrder = await this.makeOrder(
            'vwap-mspeq-early-sell',
            tokenId,
            targetPrice,
            this.buyOrder.amount,
            Side.SELL
        );

        if (this.earlySellOrder) {
            this.writeLog(
                `createEarlySellOrder: placed (price=${targetPrice.toFixed(3)})`
            );
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
