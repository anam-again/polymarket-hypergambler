import { Side } from "@polymarket/clob-client";

import { QuantBot, QuantBotProps, QuantBotRun, TradeOrder, TradeStatus } from "./QuantBot.js";
import { MarketSchedule } from "../types/interfaces.js";

// ============================================================================
// Types & Interfaces
// ============================================================================

interface EsotericNormalizationProps extends QuantBotProps {
    // Distribution shape parameters
    baseStdDev: number;              // Initial std dev in $ at period start (e.g., 150)
    minStdDevRatio: number;          // Min std dev as ratio of base at period end (e.g., 0.25)
    timeDecayPower: number;          // How fast std dev shrinks (higher = faster, e.g., 1.5)
    priceScaleMultiplier: number;    // Multiplier for price sensitivity (e.g., 1.0)
    priceScaleConstant: number;      // Constant offset for price calc (e.g., 0)

    // Trading parameters
    purchaseThreshold: number;       // Min diff to trigger buy (e.g., 0.08)
    sellPremium: number;             // Sell this much above expected (e.g., 0.04)
    targetSize: number;
    cutoffMinute: number;
    maxTradesPerPeriod: number;      // Max trades per hour/quarter (e.g., 2)
}

type TokenDirection = 'UP' | 'DOWN';

// ============================================================================
// Normal Distribution Helper
// ============================================================================

/**
 * Approximation of standard normal cumulative distribution function (CDF)
 * Returns probability that a standard normal random variable is <= x
 */
function normalCDF(x: number): number {
    const a1 = 0.254829592;
    const a2 = -0.284496736;
    const a3 = 1.421413741;
    const a4 = -1.453152027;
    const a5 = 1.061405429;
    const p = 0.3275911;

    const sign = x < 0 ? -1 : 1;
    const absX = Math.abs(x) / Math.sqrt(2);

    const t = 1.0 / (1.0 + p * absX);
    const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX);

    return 0.5 * (1.0 + sign * y);
}

// ============================================================================
// EsotericNormalization Class
// ============================================================================

/**
 * EsotericNormalization Bot - Uses normal distribution to predict token prices
 *
 * The bot calculates an "expected token price" based on:
 * 1. BTC price movement from period start (determines mean/direction)
 * 2. Time elapsed in period (affects distribution spread - flattens over time)
 *
 * Early in period: Large price movements still uncertain, token ~0.50
 * Late in period: Same price movements more decisive, token approaches 0 or 1
 *
 * Trades when actual token price differs significantly from expected price.
 */
export class EsotericNormalization extends QuantBot implements QuantBotRun {

    // --- Properties ---

    // Distribution shape parameters
    private baseStdDev: number;
    private minStdDevRatio: number;
    private timeDecayPower: number;
    private priceScaleMultiplier: number;
    private priceScaleConstant: number;

    // Trading parameters
    private purchaseThreshold: number;
    private sellPremium: number;
    private targetSize: number;
    private cutoffMinute: number;
    private maxTradesPerPeriod: number;

    // State tracking
    private buyOrder?: TradeOrder;
    private sellOrder?: TradeOrder;
    private startPrice: number | null = null;
    private tradesThisPeriod: number = 0;
    private selectedDirection?: TokenDirection;
    private isPastCutoff: boolean = false;

    private readonly MAX_SELL_PRICE = 0.95;

    // --- Constructor ---

    constructor(props: EsotericNormalizationProps) {
        super(props);

        this.baseStdDev = props.baseStdDev;
        this.minStdDevRatio = props.minStdDevRatio;
        this.timeDecayPower = props.timeDecayPower;
        this.priceScaleMultiplier = props.priceScaleMultiplier;
        this.priceScaleConstant = props.priceScaleConstant;

        this.purchaseThreshold = props.purchaseThreshold;
        this.sellPremium = props.sellPremium;
        this.targetSize = props.targetSize;
        this.cutoffMinute = props.cutoffMinute;
        this.maxTradesPerPeriod = props.maxTradesPerPeriod;
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
        this.startPrice = null;
        this.tradesThisPeriod = 0;
        this.selectedDirection = undefined;
        this.isPastCutoff = false;
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
        await this.updateOrders();

        if (this.isPastCutoff) {
            return;
        }

        // Handle sell order creation/update if buy matched
        if (this.shouldCreateSellOrder()) {
            await this.createSellOrder();
        }

        // Update sell order price based on current expected value
        if (this.sellOrder && this.sellOrder.status === TradeStatus.LIVE) {
            await this.updateSellOrderPrice();
        }

        // Check cutoff
        if (this.isAfterCutoff()) {
            await this.handleCutoff();
            return;
        }

        // Look for new trade opportunities
        await this.evaluateTradeOpportunity();
    }

    public override async onSimulationTick(): Promise<void> {
        await this.executeTradingLogic();
    }

    // -------------------------------------------------------------------------
    // Expected Price Calculation
    // -------------------------------------------------------------------------

    private getPeriodMinutes(): number {
        return this.marketSchedule === MarketSchedule.QUARTERLY ? 15 : 60;
    }

    private getMinuteInPeriod(): number {
        const currentMinute = this.clock.getMinutes();
        if (this.marketSchedule === MarketSchedule.QUARTERLY) {
            return currentMinute % 15;
        }
        return currentMinute;
    }

    /**
     * Calculate the expected token price based on BTC price movement and time
     * Returns expected price for UP token (0-1)
     */
    private calculateExpectedPrice(currentBtcPrice: number, minuteInPeriod: number): number {
        if (this.startPrice === null) return 0.5;

        const periodMinutes = this.getPeriodMinutes();

        // Price difference from start (positive = BTC went up)
        const priceChange = (currentBtcPrice - this.startPrice) * this.priceScaleMultiplier + this.priceScaleConstant;

        // Time factor: 0 at start, 1 at end
        const timeFactor = Math.min(1, minuteInPeriod / periodMinutes);

        // Standard deviation shrinks over time (curve gets steeper)
        // At start: stdDev = baseStdDev
        // At end: stdDev = baseStdDev * minStdDevRatio
        const stdDev = this.baseStdDev * (1 - (1 - this.minStdDevRatio) * Math.pow(timeFactor, this.timeDecayPower));

        // Z-score: how many std devs is the price change
        const zScore = priceChange / stdDev;

        // CDF gives probability that UP wins (expected UP token price)
        const expectedUpPrice = normalCDF(zScore);

        // Clamp to reasonable range
        return Math.max(0.02, Math.min(0.98, expectedUpPrice));
    }

    // -------------------------------------------------------------------------
    // Order Logic
    // -------------------------------------------------------------------------

    private shouldCreateSellOrder(): boolean {
        if (this.sellOrder) return false;
        if (!this.buyOrder) return false;
        return this.buyOrder.status === TradeStatus.MATCHED;
    }

    private async evaluateTradeOpportunity(): Promise<void> {
        // Don't create new trades if we already have one or hit max
        if (this.buyOrder) return;
        if (this.tradesThisPeriod >= this.maxTradesPerPeriod) return;

        const currentBtcPrice = await this.getCurrentBtcPrice();
        if (!currentBtcPrice) return;

        // Capture start price at beginning of period
        if (this.startPrice === null) {
            this.startPrice = currentBtcPrice;
            this.writeLog(`Period start price captured: ${currentBtcPrice.toFixed(2)}`);
        }

        const minuteInPeriod = this.getMinuteInPeriod();
        const expectedUpPrice = this.calculateExpectedPrice(currentBtcPrice, minuteInPeriod);
        const expectedDownPrice = 1 - expectedUpPrice;

        // Get actual market prices
        const orderBooks = await this.marketInfo.getLiveData(this.targetedMarket);
        const actualUpPrice = parseFloat(orderBooks.BtcUp.asks[0]?.price ?? '0.50');
        const actualDownPrice = parseFloat(orderBooks.BtcDown.asks[0]?.price ?? '0.50');

        // Look for mispriced tokens
        const upDiff = expectedUpPrice - actualUpPrice;
        const downDiff = expectedDownPrice - actualDownPrice;

        let selectedToken: TokenDirection | null = null;
        let buyPrice = 0;

        if (upDiff >= this.purchaseThreshold && upDiff >= downDiff) {
            selectedToken = 'UP';
            buyPrice = actualUpPrice;
        } else if (downDiff >= this.purchaseThreshold) {
            selectedToken = 'DOWN';
            buyPrice = actualDownPrice;
        }

        if (selectedToken) {
            this.writeLog(
                `Mispricing detected: ${selectedToken} token ` +
                `(expected=${selectedToken === 'UP' ? expectedUpPrice.toFixed(3) : expectedDownPrice.toFixed(3)}, ` +
                `actual=${buyPrice.toFixed(3)}, diff=${selectedToken === 'UP' ? upDiff.toFixed(3) : downDiff.toFixed(3)})`
            );
            await this.createBuyOrder(selectedToken, buyPrice);
        }
    }

    private async createBuyOrder(direction: TokenDirection, buyPrice: number): Promise<void> {
        if (this.buyOrder) return;

        const orderBooks = await this.marketInfo.getLiveData(this.targetedMarket);
        const tokenId = direction === 'UP'
            ? orderBooks.BtcUpTokenId
            : orderBooks.BtcDownTokenId;

        const totalCost = buyPrice * this.targetSize;

        if (!this.checkIfOrderIsValid(buyPrice, this.targetSize)) return;
        if (!this.canSpend(totalCost)) return;

        this.selectedDirection = direction;
        this.tradesThisPeriod++;

        this.buyOrder = await this.makeOrder(
            'esoteric-buy',
            tokenId,
            buyPrice,
            this.targetSize,
            Side.BUY
        );

    }

    private async createSellOrder(): Promise<void> {
        if (this.sellOrder || !this.buyOrder || !this.selectedDirection) return;

        const orderBooks = await this.marketInfo.getLiveData(this.targetedMarket);
        const tokenId = this.selectedDirection === 'UP'
            ? orderBooks.BtcUpTokenId
            : orderBooks.BtcDownTokenId;

        const currentBtcPrice = await this.getCurrentBtcPrice();
        if (!currentBtcPrice) return;

        const minuteInPeriod = this.getMinuteInPeriod();
        const expectedUpPrice = this.calculateExpectedPrice(currentBtcPrice, minuteInPeriod);
        const expectedPrice = this.selectedDirection === 'UP' ? expectedUpPrice : (1 - expectedUpPrice);
        const sellPrice = Math.min(this.MAX_SELL_PRICE, expectedPrice + this.sellPremium);

        this.writeLog(
            `Creating sell order at ${sellPrice.toFixed(3)} ` +
            `(expected=${expectedPrice.toFixed(3)}, premium=${this.sellPremium})`
        );

        this.sellOrder = await this.makeOrder(
            'esoteric-sell',
            tokenId,
            sellPrice,
            this.targetSize,
            Side.SELL
        );
    }

    private async updateSellOrderPrice(): Promise<void> {
        if (!this.sellOrder || !this.selectedDirection) return;

        const currentBtcPrice = await this.getCurrentBtcPrice();
        if (!currentBtcPrice) return;

        const minuteInPeriod = this.getMinuteInPeriod();
        const expectedUpPrice = this.calculateExpectedPrice(currentBtcPrice, minuteInPeriod);
        const expectedPrice = this.selectedDirection === 'UP' ? expectedUpPrice : (1 - expectedUpPrice);
        const newSellPrice = Math.min(this.MAX_SELL_PRICE, expectedPrice + this.sellPremium);

        // Only update if price changed significantly (avoid too many updates)
        if (Math.abs(newSellPrice - (this.sellOrder.targetSellPrice ?? 0)) > 0.01) {
            // Cancel old order and create new one
            await this.cancelTrade(this.sellOrder);

            const orderBooks = await this.marketInfo.getLiveData(this.targetedMarket);
            const tokenId = this.selectedDirection === 'UP'
                ? orderBooks.BtcUpTokenId
                : orderBooks.BtcDownTokenId;

            this.sellOrder = await this.makeOrder(
                'esoteric-sell-update',
                tokenId,
                newSellPrice,
                this.targetSize,
                Side.SELL
            );

            this.writeLog(`Updated sell order to ${newSellPrice.toFixed(3)} (expected=${expectedPrice.toFixed(3)})`);
        }
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
}
