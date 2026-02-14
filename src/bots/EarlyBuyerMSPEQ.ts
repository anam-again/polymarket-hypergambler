import { Side } from "@polymarket/clob-client";

import { QuantBotRun, TradeOrder, TradeStatus } from "./QuantBot.js";
import { MSPEQBotBase, MSPEQBotProps } from "./MSPEQBotBase.js";
import { BtcDirection, MarketSchedule } from "../types/interfaces.js";
import { MultiSignalPEQ, MultiSignalPEQConfig } from "../utils/MultiSignalPEQ.js";

// ============================================================================
// Types & Interfaces
// ============================================================================

export interface EarlyBuyerMSPEQProps extends MSPEQBotProps {
    // Base parameters (static)
    targetDollars: number;
    baseBuyPrice: number;           // e.g., 0.50
    baseSellPrice: number;          // e.g., 0.80
    baseCutoffMinute: number;       // e.g., 10
    minProfitMargin: number;        // e.g., 0.05
    directionThreshold: number;     // e.g., 0.5

    // MSPEQ configs
    targetBuyPriceMSPEQ: MultiSignalPEQConfig;
    targetSellPriceMSPEQ: MultiSignalPEQConfig;
    cutoffMinuteMSPEQ: MultiSignalPEQConfig;
    btcDirectionMSPEQ: MultiSignalPEQConfig;
    earlySellTimeMSPEQ: MultiSignalPEQConfig;
    earlySellPriceMSPEQ: MultiSignalPEQConfig;
}

// ============================================================================
// EarlyBuyerMSPEQ Class
// ============================================================================

/**
 * EarlyBuyerMSPEQ - EarlyBuyer strategy with Multi-Signal PEQ
 *
 * Combines EarlyBuyer's simple two-order strategy (BUY then SELL) with
 * MSPEQ-driven dynamic parameters. Uses multiple market signals
 * (candleSize, volatility, momentum) to dynamically compute:
 *
 * - targetBuyPrice: Price at which to buy (scales baseBuyPrice)
 * - targetSellPrice: Price at which to sell (scales baseSellPrice)
 * - cutoffMinute: Dynamic cutoff time (scales baseCutoffMinute)
 * - btcDirection: Whether to bet UP or DOWN (threshold on MSPEQ output)
 * - earlySellTime: Time threshold to trigger early sell
 * - earlySellPrice: Price for early sell when time runs low
 */
export class EarlyBuyerMSPEQ extends MSPEQBotBase implements QuantBotRun {

    // --- Configuration ---
    private targetDollars: number;
    private baseBuyPrice: number;
    private baseSellPrice: number;
    private baseCutoffMinute: number;
    private minProfitMargin: number;
    private directionThreshold: number;

    // --- Multi-Signal PEQs ---
    private targetBuyPriceMSPEQ: MultiSignalPEQ;
    private targetSellPriceMSPEQ: MultiSignalPEQ;
    private cutoffMinuteMSPEQ: MultiSignalPEQ;
    private btcDirectionMSPEQ: MultiSignalPEQ;
    private earlySellTimeMSPEQ: MultiSignalPEQ;
    private earlySellPriceMSPEQ: MultiSignalPEQ;

    // --- Trading State ---
    private buyOrder?: TradeOrder;
    private sellOrder?: TradeOrder;
    private earlySellOrder?: TradeOrder;
    private isPastCutoff: boolean = false;
    private actualBuyPrice: number = 0;
    private computedDirection?: BtcDirection;

    // --- Constructor ---

    constructor(props: EarlyBuyerMSPEQProps) {
        super(props);

        // Base parameters
        this.targetDollars = props.targetDollars;
        this.baseBuyPrice = props.baseBuyPrice;
        this.baseSellPrice = props.baseSellPrice;
        this.baseCutoffMinute = props.baseCutoffMinute;
        this.minProfitMargin = props.minProfitMargin;
        this.directionThreshold = props.directionThreshold;

        // Multi-Signal PEQs
        this.targetBuyPriceMSPEQ = new MultiSignalPEQ(props.targetBuyPriceMSPEQ);
        this.targetSellPriceMSPEQ = new MultiSignalPEQ(props.targetSellPriceMSPEQ);
        this.cutoffMinuteMSPEQ = new MultiSignalPEQ(props.cutoffMinuteMSPEQ);
        this.btcDirectionMSPEQ = new MultiSignalPEQ(props.btcDirectionMSPEQ);
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
        this.isPastCutoff = false;
        this.actualBuyPrice = 0;
        this.computedDirection = undefined;

        // Reset signal-related state from base class
        this.resetSignalState();
    }

    // -------------------------------------------------------------------------
    // MSPEQ Parameter Computation
    // -------------------------------------------------------------------------

    private computeBtcDirection(): BtcDirection {
        const signals = this.getSignalRecord();
        const output = this.btcDirectionMSPEQ.compute(signals);
        return output >= this.directionThreshold ? BtcDirection.UP : BtcDirection.DOWN;
    }

    private computeDynamicBuyPrice(): number {
        const signals = this.getSignalRecord();
        const mspeqOutput = this.targetBuyPriceMSPEQ.compute(signals);
        const dynamicPrice = Math.round(this.baseBuyPrice * mspeqOutput * 100) / 100;
        return Math.max(0.01, Math.min(0.99, dynamicPrice));
    }

    private computeDynamicSellPrice(): number {
        const signals = this.getSignalRecord();
        const mspeqOutput = this.targetSellPriceMSPEQ.compute(signals);
        const dynamicPrice = Math.round(this.baseSellPrice * mspeqOutput * 100) / 100;
        // Must be above buy price + min profit margin
        return Math.max(this.actualBuyPrice + this.minProfitMargin, Math.min(0.99, dynamicPrice));
    }

    private computeDynamicCutoffMinute(): number {
        const signals = this.getSignalRecord();
        const mspeqOutput = this.cutoffMinuteMSPEQ.compute(signals);
        const dynamicCutoff = Math.round(this.baseCutoffMinute * mspeqOutput);
        // Clamp to valid range based on market schedule
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
        // 1. Update signals first
        await this.updateSignals();

        // 2. Update regime for TradeGate evaluation
        this.updateRegime();

        // 3. Update orders
        await this.updateOrders();

        // 4. Check/create sell order if buy matched
        if (this.shouldCreateSellOrder()) {
            await this.createSellOrder();
        }

        // 5. Check for early sell trigger
        if (this.shouldTriggerEarlySell()) {
            await this.createEarlySellOrder();
        }

        if (this.isPastCutoff) {
            return;
        }

        // 6. Check cutoff (using dynamic cutoff)
        if (this.isAfterCutoff()) {
            await this.handleCutoff();
            return;
        }

        // 7. Check TradeGate before placing new buy orders
        if (!this.shouldTrade()) {
            return;
        }

        // 8. Check/create buy order (using dynamic direction and price)
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

        // Compute direction if not yet computed
        if (!this.computedDirection) {
            this.computedDirection = this.computeBtcDirection();
            this.writeLog(`Computed BTC direction: ${this.computedDirection}`);
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

    // Minimum MSPEQ output threshold - prevents unrealistic prices from degenerate coefficients
    private static readonly MIN_MSPEQ_OUTPUT = 0.1;

    private async createBuyOrder(): Promise<void> {
        if (this.buyOrder) return;

        // Compute direction if not yet computed
        if (!this.computedDirection) {
            this.computedDirection = this.computeBtcDirection();
        }

        const orderBooks = await this.marketInfo.getLiveData(this.targetedMarket);
        const tokenId = this.computedDirection === BtcDirection.UP
            ? orderBooks.BtcUpTokenId
            : orderBooks.BtcDownTokenId;

        // Calculate dynamic buy price using MSPEQ
        const signals = this.getSignalRecord();
        const mspeqOutput = this.targetBuyPriceMSPEQ.compute(signals);

        // Validate MSPEQ output - prevent degenerate coefficients from producing unrealistic prices
        if (mspeqOutput < EarlyBuyerMSPEQ.MIN_MSPEQ_OUTPUT) {
            this.writeLog(
                `createBuyOrder: skipping - MSPEQ output too low (${mspeqOutput.toFixed(4)} < ${EarlyBuyerMSPEQ.MIN_MSPEQ_OUTPUT}). ` +
                `This suggests degenerate genetic optimization coefficients.`
            );
            return;
        }

        const dynamicBuyPrice = Math.round(this.baseBuyPrice * mspeqOutput * 100) / 100;
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
            'earlybuyer-mspeq-buy',
            tokenId,
            targetBuyPrice,
            targetSize,
            Side.BUY
        );

        if (this.buyOrder) {
            this.writeLog(
                `createBuyOrder: placed (orderId=${this.buyOrder.orderId}, ` +
                `direction=${this.computedDirection}, price=${targetBuyPrice}, ` +
                `mspeqOut=${mspeqOutput.toFixed(3)}, vol=${signals.volatility.toFixed(3)}, ` +
                `mom=${signals.momentum.toFixed(3)})`
            );
        }
    }

    private async createSellOrder(): Promise<void> {
        if (this.sellOrder || !this.buyOrder || !this.computedDirection) return;

        const orderBooks = await this.marketInfo.getLiveData(this.targetedMarket);
        const tokenId = this.computedDirection === BtcDirection.UP
            ? orderBooks.BtcUpTokenId
            : orderBooks.BtcDownTokenId;

        // Calculate dynamic sell price using MSPEQ
        const signals = this.getSignalRecord();
        const mspeqOutput = this.targetSellPriceMSPEQ.compute(signals);
        const dynamicSellPrice = Math.round(this.baseSellPrice * mspeqOutput * 100) / 100;

        // Clamp - must be above buy price + min profit margin
        const targetSellPrice = Math.max(this.actualBuyPrice + this.minProfitMargin, Math.min(0.99, dynamicSellPrice));

        this.sellOrder = await this.makeOrder(
            'earlybuyer-mspeq-sell',
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
    // Early Sell Logic (copied from FirstCandleMSPEQ)
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
        if (this.sellOrder || this.earlySellOrder || !this.buyOrder || !this.computedDirection) return;

        const orderBooks = await this.marketInfo.getLiveData(this.targetedMarket);
        const tokenId = this.computedDirection === BtcDirection.UP
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
            'earlybuyer-mspeq-early-sell',
            tokenId,
            earlySellPrice,
            this.buyOrder.amount,
            Side.SELL
        );
    }

    // -------------------------------------------------------------------------
    // Cutoff Handling
    // -------------------------------------------------------------------------

    private isAfterCutoff(): boolean {
        const currentMinute = this.clock.getMinutes();
        const dynamicCutoff = this.computeDynamicCutoffMinute();

        if (this.marketSchedule === MarketSchedule.QUARTERLY) {
            return currentMinute % 15 >= dynamicCutoff;
        } else {
            return currentMinute >= dynamicCutoff;
        }
    }

    private async handleCutoff(): Promise<void> {
        this.isPastCutoff = true;
        await this.cancelLiveBuyOrders();
    }

    private async cancelLiveBuyOrders(): Promise<void> {
        for (const trade of this.trades) {
            if (trade.status === TradeStatus.LIVE && trade.side === Side.BUY) {
                await this.cancelTrade(trade);
            }
        }
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    private async getTargetTokenId(): Promise<string> {
        if (!this.computedDirection) {
            this.computedDirection = this.computeBtcDirection();
        }

        const orderBooks = await this.marketInfo.getLiveData(this.targetedMarket);
        return this.computedDirection === BtcDirection.UP
            ? orderBooks.BtcUpTokenId
            : orderBooks.BtcDownTokenId;
    }
}
