import { Side } from "@polymarket/clob-client";

import { QuantBot, QuantBotProps, QuantBotRun, TradeOrder, TradeStatus } from "./QuantBot.js";
import { MarketSchedule } from "../types/interfaces.js";
import { MultiSignalPEQ, MultiSignalPEQConfig } from "../utils/MultiSignalPEQ.js";
import { ISignalProvider, SignalSnapshot } from "../signals/SignalProvider.js";
import { HistoricalSignalProvider } from "../signals/MockSignalProvider.js";

// ============================================================================
// Types & Interfaces
// ============================================================================

export interface MarketMakerMSPEQProps extends QuantBotProps {
    // Base spread configuration
    spreadSize: number;              // Number of price levels to buy
    baseSpreadDistance: number;      // Base distance from market price to start spread
    baseProfitMargin: number;        // Base profit margin (cents above buy price)

    // Base price bounds (dynamically scaled by MSPEQs)
    baseMinPrice: number;            // Base min price (never buy below this after scaling)
    baseMaxPrice: number;            // Base max price (never buy above this after scaling)

    // Base risk management
    baseStopLossAmount: number;      // Base stop-loss distance
    buyExpirySeconds?: number;       // Cancel live buy orders older than this

    // Position limits
    totalActiveTrades: number;       // Max concurrent positions

    // Base volatility filter
    maxVolatility: number;
    minVolatility: number;
    volatilityLookbackPeriods: number;

    // Standard parameters
    targetDollars: number;
    baseCutoffMinute: number;

    // Reference values for signal normalization
    candleSizeReference: number;

    // Multi-Signal PEQ configs (6 MSPEQs)
    profitMarginMSPEQ: MultiSignalPEQConfig;
    spreadDistanceMSPEQ: MultiSignalPEQConfig;
    stopLossAmountMSPEQ: MultiSignalPEQConfig;
    cutoffMinuteMSPEQ: MultiSignalPEQConfig;
    minPriceMSPEQ: MultiSignalPEQConfig;
    maxPriceMSPEQ: MultiSignalPEQConfig;

    // Optional signal provider (for testing/simulation)
    signalProvider?: ISignalProvider;
}

interface ActivePosition {
    buyOrder: TradeOrder;
    sellOrder?: TradeOrder;
    entryPrice: number;
    spreadOffset: number;
    tokenDirection: 'UP' | 'DOWN';
    stopLossPrice: number;
    stopLossTriggered?: boolean;
    buyExpired?: boolean;
    tokensSold: number;
    sellOrderHistory: string[];
    buyMatchedAt?: number;
    sellOrderCreatedAt?: number;
    stoplossCreatedAt?: number;
}

type TokenDirection = 'UP' | 'DOWN';

// ============================================================================
// MarketMakerMSPEQ Class
// ============================================================================

/**
 * MarketMakerMSPEQ - Market Maker with Multi-Signal PEQ
 *
 * Extends the basic MarketMaker strategy by using multiple market signals
 * (candleSize, volatility, momentum) to dynamically compute:
 *
 * - profitMargin: Dynamically scale profit targets based on volatility/momentum
 * - minPrice: Dynamically adjust minimum buy price threshold
 * - maxPrice: Dynamically adjust maximum buy price threshold
 * - spreadDistance: Adjust distance from market based on market conditions
 * - stopLossAmount: Scale stop-loss based on volatility
 * - cutoffMinute: Adjust cutoff time based on signals
 *
 * Each MSPEQ combines weighted polynomial outputs from multiple signals,
 * allowing the genetic optimizer to learn complex relationships.
 */
export class MarketMakerMSPEQ extends QuantBot implements QuantBotRun {

    // --- Configuration Constants ---
    private readonly MIN_ORDER_SIZE = 5;
    private readonly MIN_ORDER_VALUE = 1.00;
    private readonly MAX_SELL_PRICE = 0.95;
    private readonly SPREAD_STEP = 0.01;

    // --- Base Properties ---
    private spreadSize: number;
    private baseSpreadDistance: number;
    private baseProfitMargin: number;
    private baseMinPrice: number;
    private baseMaxPrice: number;
    private baseStopLossAmount: number;
    private buyExpirySeconds: number | null;
    private totalActiveTrades: number;
    private maxVolatility: number;
    private minVolatility: number;
    private volatilityLookbackPeriods: number;
    private targetDollars: number;
    private baseCutoffMinute: number;
    private candleSizeReference: number;

    // --- Multi-Signal PEQs (6 total) ---
    private profitMarginMSPEQ: MultiSignalPEQ;
    private spreadDistanceMSPEQ: MultiSignalPEQ;
    private stopLossAmountMSPEQ: MultiSignalPEQ;
    private cutoffMinuteMSPEQ: MultiSignalPEQ;
    private minPriceMSPEQ: MultiSignalPEQ;
    private maxPriceMSPEQ: MultiSignalPEQ;

    // --- Signal Provider ---
    private signalProvider: ISignalProvider;
    private lastSignals?: SignalSnapshot;

    // --- Signal Update Tracking ---
    private lastPriceUpdateTime: number = 0;
    private lastOrderBookUpdateTime: number = 0;
    private cachedPrice: number | null = null;
    private cachedUpMid: number = 0.5;
    private cachedDownMid: number = 0.5;
    private readonly PRICE_UPDATE_INTERVAL_MS = 5000;
    private readonly ORDERBOOK_UPDATE_INTERVAL_MS = 30000;

    // --- Position Tracking ---
    private upPositions: Map<string, ActivePosition> = new Map();
    private downPositions: Map<string, ActivePosition> = new Map();

    // --- State ---
    private isPastCutoff: boolean = false;

    // --- Constructor ---

    constructor(props: MarketMakerMSPEQProps) {
        super(props);

        // Base parameters
        this.spreadSize = props.spreadSize;
        this.baseSpreadDistance = props.baseSpreadDistance;
        this.baseProfitMargin = props.baseProfitMargin;
        this.baseMinPrice = props.baseMinPrice;
        this.baseMaxPrice = props.baseMaxPrice;
        this.baseStopLossAmount = props.baseStopLossAmount;
        this.buyExpirySeconds = props.buyExpirySeconds ?? null;
        this.totalActiveTrades = props.totalActiveTrades;
        this.maxVolatility = props.maxVolatility;
        this.minVolatility = props.minVolatility;
        this.volatilityLookbackPeriods = props.volatilityLookbackPeriods;
        this.targetDollars = props.targetDollars;
        this.baseCutoffMinute = props.baseCutoffMinute;
        this.candleSizeReference = props.candleSizeReference;

        // Multi-Signal PEQs (6 total)
        this.profitMarginMSPEQ = new MultiSignalPEQ(props.profitMarginMSPEQ);
        this.spreadDistanceMSPEQ = new MultiSignalPEQ(props.spreadDistanceMSPEQ);
        this.stopLossAmountMSPEQ = new MultiSignalPEQ(props.stopLossAmountMSPEQ);
        this.cutoffMinuteMSPEQ = new MultiSignalPEQ(props.cutoffMinuteMSPEQ);
        this.minPriceMSPEQ = new MultiSignalPEQ(props.minPriceMSPEQ);
        this.maxPriceMSPEQ = new MultiSignalPEQ(props.maxPriceMSPEQ);

        // Signal provider (default to HistoricalSignalProvider for simulation)
        this.signalProvider = props.signalProvider ?? new HistoricalSignalProvider({
            candleSizeReference: this.candleSizeReference,
            periodLengthMs: this.marketSchedule === MarketSchedule.QUARTERLY
                ? 15 * 60 * 1000
                : 60 * 60 * 1000,
            clock: this.clock,
        });
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
        this.upPositions.clear();
        this.downPositions.clear();
        this.isPastCutoff = false;
        this.lastSignals = undefined;
        this.lastPriceUpdateTime = 0;
        this.lastOrderBookUpdateTime = 0;

        // Clear signal provider history to avoid carrying stale data across periods
        if (this.signalProvider instanceof HistoricalSignalProvider) {
            (this.signalProvider as HistoricalSignalProvider).clearHistory();
        }

        this.updateSignalProviderTiming();

        // Seed signal provider with pre-period historical data for accurate signals
        this.seedSignalProviderHistory();
    }

    private seedSignalProviderHistory(): void {
        if (!(this.signalProvider instanceof HistoricalSignalProvider)) {
            return;
        }

        try {
            const cdMarketData = this.getCdMarketData();
            // Get 10 minutes of historical data (covers volatility and momentum windows)
            const recentPrices = cdMarketData.getRecentPrices(10, this.targetedMarket);

            if (recentPrices.length > 0) {
                const entries = recentPrices.map(entry => ({
                    timestamp: entry.timestamp.getTime(),
                    price: entry.price,
                }));
                (this.signalProvider as HistoricalSignalProvider).seedWithHistory(entries);
            }
        } catch {
            // Silently fail - signal provider will accumulate data during period
        }
    }

    private updateSignalProviderTiming(): void {
        const now = this.clock.now();
        const periodLength = this.marketSchedule === MarketSchedule.QUARTERLY
            ? 15 * 60 * 1000
            : 60 * 60 * 1000;

        const periodStart = Math.floor(now / periodLength) * periodLength;
        const periodEnd = periodStart + periodLength;

        this.signalProvider.setPeriodTiming(periodStart, periodEnd);
    }

    // -------------------------------------------------------------------------
    // Signal Management
    // -------------------------------------------------------------------------

    private async updateSignals(): Promise<SignalSnapshot> {
        if (this.signalProvider instanceof HistoricalSignalProvider) {
            const now = this.clock.now();

            // Update price periodically
            if (now - this.lastPriceUpdateTime >= this.PRICE_UPDATE_INTERVAL_MS) {
                this.lastPriceUpdateTime = now;
                try {
                    const cdMarketData = this.getCdMarketData();
                    this.cachedPrice = await cdMarketData.getCurrentPriceByMarket(this.targetedMarket);
                    (this.signalProvider as HistoricalSignalProvider).addPricePoint(now, this.cachedPrice);
                } catch {
                    // Use cached price on error
                }
            }

            // Update order book less frequently
            if (now - this.lastOrderBookUpdateTime >= this.ORDERBOOK_UPDATE_INTERVAL_MS) {
                this.lastOrderBookUpdateTime = now;
                try {
                    const liveData = await this.marketInfo.getLiveData(this.targetedMarket);
                    const upBids = liveData.BtcUp.bids;
                    const upAsks = liveData.BtcUp.asks;
                    const downBids = liveData.BtcDown.bids;
                    const downAsks = liveData.BtcDown.asks;

                    const upBid = upBids.length > 0 ? parseFloat(upBids[upBids.length - 1].price) : 0;
                    const upAsk = upAsks.length > 0 ? parseFloat(upAsks[upAsks.length - 1].price) : 1;
                    const downBid = downBids.length > 0 ? parseFloat(downBids[downBids.length - 1].price) : 0;
                    const downAsk = downAsks.length > 0 ? parseFloat(downAsks[downAsks.length - 1].price) : 1;

                    this.cachedUpMid = (upBid + upAsk) / 2;
                    this.cachedDownMid = (downBid + downAsk) / 2;
                    (this.signalProvider as HistoricalSignalProvider).setOrderBookMids(this.cachedUpMid, this.cachedDownMid);
                } catch {
                    // Use cached orderbook on error
                }
            }
        }

        this.lastSignals = await this.signalProvider.getSignals();
        return this.lastSignals;
    }

    private getSignalRecord(): Record<string, number> {
        if (!this.lastSignals) {
            return {
                candleSize: 0,
                timeLeft: 1,
                volatility: 0.5,
                momentum: 0,
                priceImbalance: 0,
                rangePosition: 0.5,
                trendStrength: 0,
                volatilityTrend: 0,
                hourOfDay: 0.5,
            };
        }
        return {
            candleSize: this.lastSignals.candleSize,
            timeLeft: this.lastSignals.timeLeft,
            volatility: this.lastSignals.volatility,
            momentum: this.lastSignals.momentum,
            priceImbalance: this.lastSignals.priceImbalance,
            rangePosition: this.lastSignals.rangePosition,
            trendStrength: this.lastSignals.trendStrength,
            volatilityTrend: this.lastSignals.volatilityTrend,
            hourOfDay: this.lastSignals.hourOfDay,
        };
    }

    // -------------------------------------------------------------------------
    // MSPEQ Parameter Computation
    // -------------------------------------------------------------------------

    private computeDynamicProfitMargin(): number {
        const signals = this.getSignalRecord();
        const mspeqOutput = this.profitMarginMSPEQ.compute(signals);
        const dynamicMargin = Math.round(this.baseProfitMargin * mspeqOutput * 100) / 100;
        // Clamp to reasonable range [0.02, 0.30]
        return Math.max(0.02, Math.min(0.30, dynamicMargin));
    }

    private computeDynamicSpreadDistance(): number {
        const signals = this.getSignalRecord();
        const mspeqOutput = this.spreadDistanceMSPEQ.compute(signals);
        const dynamicDistance = Math.round(this.baseSpreadDistance * mspeqOutput * 100) / 100;
        // Clamp to reasonable range [0.01, 0.10]
        return Math.max(0.01, Math.min(0.10, dynamicDistance));
    }

    private computeDynamicStopLossAmount(): number {
        const signals = this.getSignalRecord();
        const mspeqOutput = this.stopLossAmountMSPEQ.compute(signals);
        const dynamicStopLoss = Math.round(this.baseStopLossAmount * mspeqOutput * 100) / 100;
        // Clamp to reasonable range [0.03, 0.20]
        return Math.max(0.03, Math.min(0.20, dynamicStopLoss));
    }

    private computeDynamicCutoffMinute(): number {
        const signals = this.getSignalRecord();
        const mspeqOutput = this.cutoffMinuteMSPEQ.compute(signals);
        const dynamicCutoff = Math.round(this.baseCutoffMinute * mspeqOutput);
        const maxCutoff = this.marketSchedule === MarketSchedule.QUARTERLY ? 14 : 59;
        return Math.max(5, Math.min(maxCutoff, dynamicCutoff));
    }

    private computeDynamicMinPrice(): number {
        const signals = this.getSignalRecord();
        const mspeqOutput = this.minPriceMSPEQ.compute(signals);
        const dynamicMinPrice = Math.round(this.baseMinPrice * mspeqOutput * 100) / 100;
        // Clamp to valid price range [0.05, 0.50]
        return Math.max(0.05, Math.min(0.50, dynamicMinPrice));
    }

    private computeDynamicMaxPrice(): number {
        const signals = this.getSignalRecord();
        const mspeqOutput = this.maxPriceMSPEQ.compute(signals);
        const dynamicMaxPrice = Math.round(this.baseMaxPrice * mspeqOutput * 100) / 100;
        // Clamp to valid price range [0.50, 0.95]
        return Math.max(0.50, Math.min(0.95, dynamicMaxPrice));
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

        // 2. Update all order statuses
        await this.updateOrders();

        // 3. Sync positions with updated orders
        this.syncPositionsWithOrders();

        // 4. Check for expired buy orders
        await this.checkExpiredBuyOrders();

        // 5. Retry expired buy orders
        await this.retryExpiredBuyOrders();

        // 6. Check stop-losses for all matched positions
        await this.checkAllStopLosses();

        // 7. Check for stop-loss recovery
        await this.checkStopLossRecovery();

        // 8. Create sell orders for newly matched buys
        await this.createSellOrdersForMatchedBuys();

        // 9. Handle completed sells (trade recycling)
        await this.handleCompletedSells();

        // 10. Check cutoff using dynamic cutoff
        if (this.isAfterCutoff()) {
            if (!this.isPastCutoff) {
                this.isPastCutoff = true;
                await this.cancelAllLiveBuyOrders();
            }
            return;
        }

        // 11. Check volatility filter
        const volatility = await this.calculateVolatility();
        if (volatility < this.minVolatility || volatility > this.maxVolatility) {
            return;
        }

        // 12. Refresh spread orders if under limit
        const activeCount = this.countActiveTrades();
        if (activeCount < this.totalActiveTrades) {
            await this.refreshSpreadOrders();
        }
    }

    public override async onSimulationTick(): Promise<void> {
        await this.executeTradingLogic();
    }

    // -------------------------------------------------------------------------
    // Position Management
    // -------------------------------------------------------------------------

    private syncPositionsWithOrders(): void {
        for (const [_, position] of this.upPositions) {
            this.updatePositionFromOrders(position);
        }
        for (const [_, position] of this.downPositions) {
            this.updatePositionFromOrders(position);
        }
    }

    private updatePositionFromOrders(position: ActivePosition): void {
        const buyTrade = this.trades.find(t => t.orderId === position.buyOrder.orderId);
        if (buyTrade) {
            position.buyOrder = buyTrade;
        }

        if (position.sellOrder) {
            const sellTrade = this.trades.find(t => t.orderId === position.sellOrder!.orderId);
            if (sellTrade) {
                position.sellOrder = sellTrade;
            }
        }

        this.syncSoldTokensFromHistory(position);
    }

    private syncSoldTokensFromHistory(position: ActivePosition): void {
        let totalSold = 0;

        for (const orderId of position.sellOrderHistory) {
            const trade = this.trades.find(t => t.orderId === orderId);
            if (trade && trade.status === TradeStatus.MATCHED) {
                totalSold += trade.amount;
            }
        }

        if (totalSold > position.tokensSold) {
            position.tokensSold = totalSold;
        }
    }

    private countActiveTrades(): number {
        let count = 0;

        for (const position of this.upPositions.values()) {
            if (position.buyOrder.status === TradeStatus.LIVE) {
                count++;
            } else if (position.buyOrder.status === TradeStatus.MATCHED) {
                if (!position.sellOrder || position.sellOrder.status !== TradeStatus.MATCHED) {
                    count++;
                }
            }
        }

        for (const position of this.downPositions.values()) {
            if (position.buyOrder.status === TradeStatus.LIVE) {
                count++;
            } else if (position.buyOrder.status === TradeStatus.MATCHED) {
                if (!position.sellOrder || position.sellOrder.status !== TradeStatus.MATCHED) {
                    count++;
                }
            }
        }

        return count;
    }

    private getPositionKey(direction: TokenDirection, spreadOffset: number): string {
        return `${direction}-offset-${spreadOffset}`;
    }

    // -------------------------------------------------------------------------
    // Buy Order Expiry Logic
    // -------------------------------------------------------------------------

    private async checkExpiredBuyOrders(): Promise<void> {
        if (this.buyExpirySeconds === null) return;

        const now = this.clock.now();
        const expiryMs = this.buyExpirySeconds * 1000;

        for (const [_, position] of this.upPositions) {
            if (this.isBuyOrderExpired(position, now, expiryMs)) {
                await this.handleExpiredBuy(position);
            }
        }

        for (const [_, position] of this.downPositions) {
            if (this.isBuyOrderExpired(position, now, expiryMs)) {
                await this.handleExpiredBuy(position);
            }
        }
    }

    private isBuyOrderExpired(position: ActivePosition, now: number, expiryMs: number): boolean {
        if (position.buyOrder.status !== TradeStatus.LIVE) return false;
        if (position.buyExpired) return false;

        const orderAge = now - position.buyOrder.createdAt;
        return orderAge >= expiryMs;
    }

    private async handleExpiredBuy(position: ActivePosition): Promise<void> {
        await this.cancelTrade(position.buyOrder);
        position.buyExpired = true;
    }

    private async retryExpiredBuyOrders(): Promise<void> {
        const orderBooks = await this.marketInfo.getLiveData(this.targetedMarket);

        for (const [_, position] of this.upPositions) {
            if (this.positionNeedsBuyOrder(position)) {
                await this.createBuyForPosition(position, orderBooks.BtcUpTokenId, 'UP');
            }
        }

        for (const [_, position] of this.downPositions) {
            if (this.positionNeedsBuyOrder(position)) {
                await this.createBuyForPosition(position, orderBooks.BtcDownTokenId, 'DOWN');
            }
        }
    }

    private positionNeedsBuyOrder(position: ActivePosition): boolean {
        if (!position.buyExpired) return false;
        if (!position.buyOrder) return true;
        if (position.buyOrder.status === TradeStatus.CANCELED) return true;
        return false;
    }

    private async createBuyForPosition(
        position: ActivePosition,
        tokenId: string,
        direction: TokenDirection
    ): Promise<void> {
        const currentAskPrice = await this.marketInfo.getPrice(tokenId, Side.BUY, this.targetedMarket);
        const dynamicSpreadDistance = this.computeDynamicSpreadDistance();
        const buyPrice = Math.round((currentAskPrice - dynamicSpreadDistance - ((position.spreadOffset - 1) * this.SPREAD_STEP)) * 100) / 100;

        // Use dynamic min/max price bounds
        const dynamicMinPrice = this.computeDynamicMinPrice();
        const dynamicMaxPrice = this.computeDynamicMaxPrice();
        if (buyPrice < dynamicMinPrice || buyPrice > dynamicMaxPrice) {
            return;
        }

        if (this.hasLiveSellAtPrice(buyPrice, tokenId)) {
            return;
        }

        const positionSize = this.calculateValidPositionSize(buyPrice);
        if (positionSize === null) {
            return;
        }

        const totalCost = buyPrice * positionSize;
        if (!this.canSpendFromBudget(totalCost)) {
            return;
        }

        const dynamicStopLoss = this.computeDynamicStopLossAmount();
        const stopLossPrice = Math.max(0.01, buyPrice - dynamicStopLoss);

        const orderName = `mm-mspeq-buy-retry-${direction.toLowerCase()}-${position.spreadOffset}-${this.clock.now()}`;

        const buyOrder = await this.makeOrder(
            orderName,
            tokenId,
            buyPrice,
            positionSize,
            Side.BUY
        );

        if (buyOrder) {
            position.buyOrder = buyOrder;
            position.entryPrice = buyPrice;
            position.stopLossPrice = stopLossPrice;
            position.buyExpired = false;
        }
    }

    // -------------------------------------------------------------------------
    // Stop-Loss Logic
    // -------------------------------------------------------------------------

    private async checkAllStopLosses(): Promise<void> {
        const orderBooks = await this.marketInfo.getLiveData(this.targetedMarket);

        for (const [_, position] of this.upPositions) {
            if (position.buyOrder.status === TradeStatus.MATCHED) {
                await this.checkPositionStopLoss(position, orderBooks.BtcUpTokenId, 'UP');
            }
        }

        for (const [_, position] of this.downPositions) {
            if (position.buyOrder.status === TradeStatus.MATCHED) {
                await this.checkPositionStopLoss(position, orderBooks.BtcDownTokenId, 'DOWN');
            }
        }
    }

    private async checkPositionStopLoss(
        position: ActivePosition,
        tokenId: string,
        direction: TokenDirection
    ): Promise<boolean> {
        if (position.buyOrder.status !== TradeStatus.MATCHED) return false;
        if (position.sellOrder?.status === TradeStatus.MATCHED) return false;
        if (position.stopLossTriggered) return false;
        if (position.tokensSold >= position.buyOrder.amount) return false;

        // Apply delay after buy match
        if (!position.buyMatchedAt) {
            position.buyMatchedAt = this.clock.now();
        }
        const stoplossDelay = 10000; // 10 second delay
        if (this.clock.now() - position.buyMatchedAt < stoplossDelay) {
            return false;
        }

        try {
            const currentBidPrice = await this.marketInfo.getPrice(tokenId, Side.SELL, this.targetedMarket);

            if (currentBidPrice <= position.stopLossPrice) {
                position.stopLossTriggered = true;

                const remainingTokens = position.buyOrder.amount - position.tokensSold;
                if (remainingTokens <= 0) return false;

                this.writeLog(
                    `STOP-LOSS: ${direction} position at ${position.entryPrice.toFixed(2)} ` +
                    `triggered at ${currentBidPrice.toFixed(2)} (stop: ${position.stopLossPrice.toFixed(2)})`
                );

                if (position.sellOrder && position.sellOrder.status === TradeStatus.LIVE) {
                    await this.cancelTrade(position.sellOrder);
                }

                if (!position.sellOrder || position.sellOrder.status === TradeStatus.CANCELED) {
                    const emergencySellPrice = Math.max(0.01, currentBidPrice - 0.01);
                    const sellOrderName = `mm-mspeq-stoploss-${direction.toLowerCase()}-${position.spreadOffset}-${this.clock.now()}`;

                    const newSellOrder = await this.makeOrder(
                        sellOrderName,
                        tokenId,
                        emergencySellPrice,
                        remainingTokens,
                        Side.SELL
                    );

                    if (newSellOrder) {
                        position.sellOrder = newSellOrder;
                        position.sellOrderHistory.push(newSellOrder.orderId);
                        position.stoplossCreatedAt = this.clock.now();
                    }
                }

                return true;
            }
        } catch (error) {
            this.writeError(`Error checking stop-loss for ${direction}: ${error}`);
        }

        return false;
    }

    // -------------------------------------------------------------------------
    // Stop-Loss Recovery Logic
    // -------------------------------------------------------------------------

    private async checkStopLossRecovery(): Promise<void> {
        const orderBooks = await this.marketInfo.getLiveData(this.targetedMarket);

        for (const [_, position] of this.upPositions) {
            await this.checkPositionStopLossRecovery(position, orderBooks.BtcUpTokenId, 'UP');
        }

        for (const [_, position] of this.downPositions) {
            await this.checkPositionStopLossRecovery(position, orderBooks.BtcDownTokenId, 'DOWN');
        }
    }

    private async checkPositionStopLossRecovery(
        position: ActivePosition,
        tokenId: string,
        direction: TokenDirection
    ): Promise<boolean> {
        if (!position.stopLossTriggered) return false;
        if (position.tokensSold >= position.buyOrder.amount) return false;

        const remainingTokens = position.buyOrder.amount - position.tokensSold;

        try {
            const currentBidPrice = await this.marketInfo.getPrice(tokenId, Side.SELL, this.targetedMarket);

            // Price recovered above entry - revert to regular profit sell
            if (currentBidPrice > position.entryPrice) {
                this.writeLog(
                    `STOP-LOSS RECOVERY: ${direction} position at ${position.entryPrice.toFixed(2)} ` +
                    `recovered to ${currentBidPrice.toFixed(2)}`
                );

                if (position.sellOrder && position.sellOrder.status === TradeStatus.LIVE) {
                    await this.cancelTrade(position.sellOrder);
                }

                position.stopLossTriggered = false;

                if (position.sellOrder?.status === TradeStatus.CANCELED) {
                    position.sellOrder = undefined;
                }

                return true;
            }

            // Update emergency sell price if stale
            if (currentBidPrice > position.stopLossPrice && position.sellOrder?.status === TradeStatus.LIVE) {
                const currentSellPrice = position.sellOrder.targetSellPrice ?? 0;
                const optimalEmergencyPrice = Math.max(0.01, currentBidPrice - 0.01);

                let stoplossTimedOut = false;
                if (position.stoplossCreatedAt) {
                    stoplossTimedOut = this.clock.now() - position.stoplossCreatedAt > 15000;
                }

                if (optimalEmergencyPrice - currentSellPrice >= 0.02 || stoplossTimedOut) {
                    await this.cancelTrade(position.sellOrder);
                    await this.updateOrders();
                    this.syncSoldTokensFromHistory(position);

                    const updatedRemaining = position.buyOrder.amount - position.tokensSold;
                    if (updatedRemaining <= 0) {
                        position.sellOrder = undefined;
                        return true;
                    }

                    const oldOrder = this.trades.find(t => t.orderId === position.sellOrder?.orderId);
                    if (oldOrder?.status === TradeStatus.MATCHED) {
                        position.sellOrder = oldOrder;
                        return true;
                    }

                    position.sellOrder = undefined;

                    const sellOrderName = `mm-mspeq-stoploss-${direction.toLowerCase()}-${position.spreadOffset}-${this.clock.now()}`;
                    const newSellOrder = await this.makeOrder(
                        sellOrderName,
                        tokenId,
                        optimalEmergencyPrice,
                        updatedRemaining,
                        Side.SELL
                    );

                    if (newSellOrder) {
                        position.sellOrder = newSellOrder;
                        position.sellOrderHistory.push(newSellOrder.orderId);
                        position.stoplossCreatedAt = this.clock.now();
                    }

                    return true;
                }
            }
        } catch (error) {
            this.writeError(`Error checking stop-loss recovery for ${direction}: ${error}`);
        }

        return false;
    }

    // -------------------------------------------------------------------------
    // Sell Order Creation
    // -------------------------------------------------------------------------

    private async createSellOrdersForMatchedBuys(): Promise<void> {
        const orderBooks = await this.marketInfo.getLiveData(this.targetedMarket);

        for (const [_, position] of this.upPositions) {
            if (this.positionNeedsSellOrder(position)) {
                await this.createSellForPosition(position, orderBooks.BtcUpTokenId, 'UP');
            }
        }

        for (const [_, position] of this.downPositions) {
            if (this.positionNeedsSellOrder(position)) {
                await this.createSellForPosition(position, orderBooks.BtcDownTokenId, 'DOWN');
            }
        }
    }

    private positionNeedsSellOrder(position: ActivePosition): boolean {
        if (position.buyOrder.status !== TradeStatus.MATCHED) return false;
        if (position.tokensSold >= position.buyOrder.amount) return false;
        if (!position.sellOrder) return true;
        if (position.sellOrder.status === TradeStatus.CANCELED) return true;
        return false;
    }

    private async createSellForPosition(
        position: ActivePosition,
        tokenId: string,
        direction: TokenDirection
    ): Promise<void> {
        const remainingTokens = position.buyOrder.amount - position.tokensSold;
        if (remainingTokens <= 0) return;

        let sellPrice: number;
        let orderNamePrefix: string;

        if (position.stopLossTriggered) {
            const currentBidPrice = await this.marketInfo.getPrice(tokenId, Side.SELL, this.targetedMarket);
            sellPrice = Math.max(0.01, currentBidPrice - 0.01);
            orderNamePrefix = 'mm-mspeq-stoploss';
        } else {
            // Use dynamic profit margin from MSPEQ
            const dynamicProfitMargin = this.computeDynamicProfitMargin();
            sellPrice = Math.min(
                Math.round((position.entryPrice + dynamicProfitMargin) * 100) / 100,
                this.MAX_SELL_PRICE
            );
            orderNamePrefix = 'mm-mspeq-sell';
        }

        const sellOrderName = `${orderNamePrefix}-${direction.toLowerCase()}-${position.spreadOffset}-${this.clock.now()}`;

        const newSellOrder = await this.makeOrder(
            sellOrderName,
            tokenId,
            sellPrice,
            remainingTokens,
            Side.SELL
        );

        if (newSellOrder) {
            position.sellOrder = newSellOrder;
            position.sellOrderHistory.push(newSellOrder.orderId);
            position.sellOrderCreatedAt = this.clock.now();
            if (position.stopLossTriggered) {
                position.stoplossCreatedAt = this.clock.now();
            }
        }
    }

    // -------------------------------------------------------------------------
    // Trade Recycling
    // -------------------------------------------------------------------------

    private async handleCompletedSells(): Promise<void> {
        if (this.isPastCutoff) return;

        const completedUpPositions: { offset: number }[] = [];
        const completedDownPositions: { offset: number }[] = [];

        for (const [_, position] of this.upPositions) {
            if (position.tokensSold >= position.buyOrder.amount) {
                completedUpPositions.push({ offset: position.spreadOffset });
            }
        }

        for (const [_, position] of this.downPositions) {
            if (position.tokensSold >= position.buyOrder.amount) {
                completedDownPositions.push({ offset: position.spreadOffset });
            }
        }

        for (const completed of completedUpPositions) {
            const key = this.getPositionKey('UP', completed.offset);
            this.upPositions.delete(key);
            await this.placeSpreadBuyOrder('UP', completed.offset);
        }

        for (const completed of completedDownPositions) {
            const key = this.getPositionKey('DOWN', completed.offset);
            this.downPositions.delete(key);
            await this.placeSpreadBuyOrder('DOWN', completed.offset);
        }
    }

    // -------------------------------------------------------------------------
    // Spread Order Placement
    // -------------------------------------------------------------------------

    private async refreshSpreadOrders(): Promise<void> {
        const activeCount = this.countActiveTrades();
        const slotsAvailable = this.totalActiveTrades - activeCount;

        if (slotsAvailable <= 0) return;

        let ordersPlaced = 0;

        for (let offset = 1; offset <= this.spreadSize && ordersPlaced < slotsAvailable; offset++) {
            const upKey = this.getPositionKey('UP', offset);
            if (!this.upPositions.has(upKey)) {
                const placed = await this.placeSpreadBuyOrder('UP', offset);
                if (placed) {
                    ordersPlaced++;
                    if (ordersPlaced >= slotsAvailable) break;
                }
            }

            const downKey = this.getPositionKey('DOWN', offset);
            if (!this.downPositions.has(downKey) && ordersPlaced < slotsAvailable) {
                const placed = await this.placeSpreadBuyOrder('DOWN', offset);
                if (placed) {
                    ordersPlaced++;
                }
            }
        }
    }

    private async placeSpreadBuyOrder(
        direction: TokenDirection,
        spreadOffset: number
    ): Promise<boolean> {
        const orderBooks = await this.marketInfo.getLiveData(this.targetedMarket);
        const tokenId = direction === 'UP' ? orderBooks.BtcUpTokenId : orderBooks.BtcDownTokenId;

        const currentAskPrice = await this.marketInfo.getPrice(tokenId, Side.BUY, this.targetedMarket);

        // Use dynamic spread distance from MSPEQ
        const dynamicSpreadDistance = this.computeDynamicSpreadDistance();
        const buyPrice = Math.round((currentAskPrice - dynamicSpreadDistance - ((spreadOffset - 1) * this.SPREAD_STEP)) * 100) / 100;

        // Use dynamic min/max price bounds from MSPEQs
        const dynamicMinPrice = this.computeDynamicMinPrice();
        const dynamicMaxPrice = this.computeDynamicMaxPrice();
        if (buyPrice < dynamicMinPrice || buyPrice > dynamicMaxPrice) {
            return false;
        }

        if (this.hasLiveSellAtPrice(buyPrice, tokenId)) {
            return false;
        }

        const positionSize = this.calculateValidPositionSize(buyPrice);
        if (positionSize === null) {
            return false;
        }

        const totalCost = buyPrice * positionSize;
        if (!this.canSpendFromBudget(totalCost)) {
            return false;
        }

        // Use dynamic stop-loss from MSPEQ
        const dynamicStopLoss = this.computeDynamicStopLossAmount();
        const stopLossPrice = Math.max(0.01, buyPrice - dynamicStopLoss);

        const orderName = `mm-mspeq-buy-${direction.toLowerCase()}-${spreadOffset}-${this.clock.now()}`;

        const buyOrder = await this.makeOrder(
            orderName,
            tokenId,
            buyPrice,
            positionSize,
            Side.BUY
        );

        if (buyOrder) {
            const position: ActivePosition = {
                buyOrder,
                entryPrice: buyPrice,
                spreadOffset,
                tokenDirection: direction,
                stopLossPrice,
                tokensSold: 0,
                sellOrderHistory: []
            };

            const key = this.getPositionKey(direction, spreadOffset);
            if (direction === 'UP') {
                this.upPositions.set(key, position);
            } else {
                this.downPositions.set(key, position);
            }

            return true;
        }

        return false;
    }

    // -------------------------------------------------------------------------
    // Volatility Calculation
    // -------------------------------------------------------------------------

    private async calculateVolatility(): Promise<number> {
        try {
            const cdMarketData = this.getCdMarketData();
            const recentPrices = cdMarketData.getRecentPrices(
                this.volatilityLookbackPeriods,
                this.targetedMarket
            );

            if (recentPrices.length < 2) {
                return 0;
            }

            const changes: number[] = [];
            for (let i = 1; i < recentPrices.length; i++) {
                const change = recentPrices[i].price - recentPrices[i - 1].price;
                changes.push(change);
            }

            if (changes.length === 0) return 0;

            const mean = changes.reduce((a, b) => a + b, 0) / changes.length;
            const squaredDiffs = changes.map(c => Math.pow(c - mean, 2));
            const variance = squaredDiffs.reduce((a, b) => a + b, 0) / squaredDiffs.length;
            const stdDev = Math.sqrt(variance);

            return stdDev;
        } catch (error) {
            this.writeError(`Error calculating volatility: ${error}`);
            return 0;
        }
    }

    // -------------------------------------------------------------------------
    // Position Sizing
    // -------------------------------------------------------------------------

    private calculateValidPositionSize(price: number): number | null {
        let size = this.dollarToTokens(this.targetDollars, price);
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
    // Conflict Detection
    // -------------------------------------------------------------------------

    private hasLiveSellAtPrice(price: number, tokenId: string): boolean {
        for (const trade of this.trades) {
            if (
                trade.status === TradeStatus.LIVE &&
                trade.side === Side.SELL &&
                trade.clobTokenId === tokenId &&
                trade.targetSellPrice === price
            ) {
                return true;
            }
        }
        return false;
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

    private async cancelAllLiveBuyOrders(): Promise<void> {
        for (const trade of this.trades) {
            if (trade.status === TradeStatus.LIVE && trade.side === Side.BUY) {
                await this.cancelTrade(trade);
            }
        }
    }
}
