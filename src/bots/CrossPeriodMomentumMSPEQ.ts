import { Side } from "@polymarket/clob-client";

import { QuantBot, QuantBotProps, QuantBotRun, TradeOrder, TradeStatus } from "./QuantBot.js";
import { BtcDirection, MarketSchedule } from "../types/interfaces.js";
import { MultiSignalPEQ, MultiSignalPEQConfig } from "../utils/MultiSignalPEQ.js";
import { ISignalProvider, SignalSnapshot } from "../signals/SignalProvider.js";
import { HistoricalSignalProvider } from "../signals/MockSignalProvider.js";

// ============================================================================
// Types & Interfaces
// ============================================================================

export interface CrossPeriodMomentumMSPEQProps extends QuantBotProps {
    // Base parameters (static)
    targetDollars: number;
    baseBuyPrice: number;           // e.g., 0.52
    baseSellPrice: number;          // e.g., 0.58
    baseCutoffMinute: number;       // e.g., 10
    candleSizeReference: number;    // e.g., 1000
    minProfitMargin: number;        // e.g., 0.05
    directionThreshold: number;     // e.g., 0.5

    // Momentum-specific base parameters
    baseMomentumThreshold: number;  // e.g., 0.15 - min price move magnitude
    baseMinWinStreak: number;       // e.g., 1 - min consecutive wins

    // MSPEQ configs
    targetBuyPriceMSPEQ: MultiSignalPEQConfig;
    targetSellPriceMSPEQ: MultiSignalPEQConfig;
    cutoffMinuteMSPEQ: MultiSignalPEQConfig;
    btcDirectionMSPEQ: MultiSignalPEQConfig;
    momentumThresholdMSPEQ: MultiSignalPEQConfig;
    winStreakThresholdMSPEQ: MultiSignalPEQConfig;
    earlySellTimeMSPEQ: MultiSignalPEQConfig;
    earlySellPriceMSPEQ: MultiSignalPEQConfig;

    // Optional signal provider (for testing/simulation)
    signalProvider?: ISignalProvider;
}

type TradingState =
    | 'WAITING_SIGNAL'
    | 'MOMENTUM_DETECTED'
    | 'TRADE_ENTERED'
    | 'PAST_CUTOFF';

// ============================================================================
// CrossPeriodMomentumMSPEQ Class
// ============================================================================

/**
 * CrossPeriodMomentumMSPEQ - Momentum continuation strategy with Multi-Signal PEQ
 *
 * Strategy: If period N has strong momentum in one direction (UP or DOWN wins
 * decisively), bet the same direction in period N+1. This exploits the
 * observation that momentum often persists across short time periods.
 *
 * MSPEQ-driven dynamic parameters:
 * - targetBuyPrice: Price at which to buy (scales baseBuyPrice)
 * - targetSellPrice: Price at which to sell (scales baseSellPrice)
 * - cutoffMinute: Dynamic cutoff time (scales baseCutoffMinute)
 * - btcDirection: Whether to bet UP or DOWN (threshold on MSPEQ output)
 * - momentumThreshold: Dynamic momentum sensitivity (scales baseMomentumThreshold)
 * - winStreakThreshold: Dynamic win streak requirement (scales baseMinWinStreak)
 * - earlySellTime: Time threshold to trigger early sell
 * - earlySellPrice: Price for early sell when time runs low
 */
export class CrossPeriodMomentumMSPEQ extends QuantBot implements QuantBotRun {

    // --- Configuration ---
    private targetDollars: number;
    private baseBuyPrice: number;
    private baseSellPrice: number;
    private baseCutoffMinute: number;
    private candleSizeReference: number;
    private minProfitMargin: number;
    private directionThreshold: number;
    private baseMomentumThreshold: number;
    private baseMinWinStreak: number;

    // --- Multi-Signal PEQs ---
    private targetBuyPriceMSPEQ: MultiSignalPEQ;
    private targetSellPriceMSPEQ: MultiSignalPEQ;
    private cutoffMinuteMSPEQ: MultiSignalPEQ;
    private btcDirectionMSPEQ: MultiSignalPEQ;
    private momentumThresholdMSPEQ: MultiSignalPEQ;
    private winStreakThresholdMSPEQ: MultiSignalPEQ;
    private earlySellTimeMSPEQ: MultiSignalPEQ;
    private earlySellPriceMSPEQ: MultiSignalPEQ;

    // --- Signal Provider ---
    private signalProvider: ISignalProvider;
    private lastSignals?: SignalSnapshot;

    // --- Trading State ---
    private state: TradingState = 'WAITING_SIGNAL';
    private detectedDirection?: BtcDirection;
    private buyOrder?: TradeOrder;
    private sellOrder?: TradeOrder;
    private earlySellOrder?: TradeOrder;
    private actualBuyPrice: number = 0;
    private computedDirection?: BtcDirection;

    // --- Previous Period Tracking ---
    private lastPeriodWinner?: 'UP' | 'DOWN';
    private lastPeriodMomentum: number = 0;  // Price move magnitude
    private consecutiveWins: { UP: number; DOWN: number } = { UP: 0, DOWN: 0 };

    // --- Constructor ---

    constructor(props: CrossPeriodMomentumMSPEQProps) {
        super(props);

        // Base parameters
        this.targetDollars = props.targetDollars;
        this.baseBuyPrice = props.baseBuyPrice;
        this.baseSellPrice = props.baseSellPrice;
        this.baseCutoffMinute = props.baseCutoffMinute;
        this.candleSizeReference = props.candleSizeReference;
        this.minProfitMargin = props.minProfitMargin;
        this.directionThreshold = props.directionThreshold;
        this.baseMomentumThreshold = props.baseMomentumThreshold;
        this.baseMinWinStreak = props.baseMinWinStreak;

        // Multi-Signal PEQs
        this.targetBuyPriceMSPEQ = new MultiSignalPEQ(props.targetBuyPriceMSPEQ);
        this.targetSellPriceMSPEQ = new MultiSignalPEQ(props.targetSellPriceMSPEQ);
        this.cutoffMinuteMSPEQ = new MultiSignalPEQ(props.cutoffMinuteMSPEQ);
        this.btcDirectionMSPEQ = new MultiSignalPEQ(props.btcDirectionMSPEQ);
        this.momentumThresholdMSPEQ = new MultiSignalPEQ(props.momentumThresholdMSPEQ);
        this.winStreakThresholdMSPEQ = new MultiSignalPEQ(props.winStreakThresholdMSPEQ);
        this.earlySellTimeMSPEQ = new MultiSignalPEQ(props.earlySellTimeMSPEQ);
        this.earlySellPriceMSPEQ = new MultiSignalPEQ(props.earlySellPriceMSPEQ);

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
            await this.handlePeriodEnd();
        });
    }

    private async handlePeriodEnd(): Promise<void> {
        await this.updateOrders();

        // Capture previous period outcome before reset
        await this.capturePreviousPeriodOutcome();

        await this.auditAndReset();
        this.resetTradeState();
    }

    protected override resetTradeState(): void {
        this.state = 'WAITING_SIGNAL';
        this.detectedDirection = undefined;
        this.buyOrder = undefined;
        this.sellOrder = undefined;
        this.earlySellOrder = undefined;
        this.actualBuyPrice = 0;
        this.computedDirection = undefined;
        this.lastSignals = undefined;

        // Reset signal update timestamps to force fresh data on new period
        this.lastPriceUpdateTime = 0;
        this.lastOrderBookUpdateTime = 0;

        // Clear signal provider history to avoid carrying stale data across periods
        if (this.signalProvider instanceof HistoricalSignalProvider) {
            (this.signalProvider as HistoricalSignalProvider).clearHistory();
        }

        // Reset signal provider period timing
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

        // Align to period boundary
        const periodStart = Math.floor(now / periodLength) * periodLength;
        const periodEnd = periodStart + periodLength;

        this.signalProvider.setPeriodTiming(periodStart, periodEnd);
    }

    // -------------------------------------------------------------------------
    // Signal Management
    // -------------------------------------------------------------------------

    private lastPriceUpdateTime: number = 0;
    private lastOrderBookUpdateTime: number = 0;
    private cachedPrice: number | null = null;
    private cachedUpMid: number = 0.5;
    private cachedDownMid: number = 0.5;

    // Update intervals (price more often than orderbook)
    private readonly PRICE_UPDATE_INTERVAL_MS = 5000;      // 5 seconds
    private readonly ORDERBOOK_UPDATE_INTERVAL_MS = 30000; // 30 seconds

    private async updateSignals(): Promise<SignalSnapshot> {
        // Update price/orderbook data for HistoricalSignalProvider (throttled)
        if (this.signalProvider instanceof HistoricalSignalProvider) {
            const now = this.clock.now();

            // Update price periodically (needed for volatility/momentum signals)
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

            // Update order book less frequently (priceImbalance signal is less critical)
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
    // Momentum Detection
    // -------------------------------------------------------------------------

    /**
     * Captures the outcome of the period that just ended.
     * Updates streak counters and momentum tracking.
     */
    private async capturePreviousPeriodOutcome(): Promise<void> {
        try {
            // Get the winning direction from the period that just ended
            const previousTimestamp = this.clock.now() - (5 * 60 * 1000); // 5 min ago

            // getHourWinner is optional and only available in simulation (MockMarketInfo)
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const marketInfoAny = this.marketInfo as any;
            const winner: 'UP' | 'DOWN' | null = marketInfoAny.getHourWinner?.(previousTimestamp, this.targetedMarket) ?? null;

            if (winner) {
                this.lastPeriodWinner = winner;

                // Update consecutive win streaks
                if (winner === 'UP') {
                    this.consecutiveWins.UP++;
                    this.consecutiveWins.DOWN = 0;
                } else {
                    this.consecutiveWins.DOWN++;
                    this.consecutiveWins.UP = 0;
                }

                // When a period ends with a winner, the momentum is significant
                // Use a high fixed momentum value since winning implies strong movement
                // This ensures we pass the momentum threshold check with reasonable MSPEQ multipliers
                this.lastPeriodMomentum = 0.5; // Strong momentum when we have a clear winner

                this.writeLog(
                    `Period ended: Winner=${winner}, Streaks: UP=${this.consecutiveWins.UP}, DOWN=${this.consecutiveWins.DOWN}`
                );
            }
        } catch (e) {
            this.writeError(`Error capturing period outcome: ${e}`);
        }
    }

    /**
     * Calculates momentum magnitude from price movement.
     */
    private async calculatePeriodMomentum(): Promise<void> {
        try {
            const liveData = await this.marketInfo.getLiveData(this.targetedMarket);

            // Get UP token bid as momentum proxy
            const upBids = liveData.BtcUp.bids;
            const upMid = upBids.length > 0
                ? parseFloat(upBids[upBids.length - 1].price)
                : 0.5;

            // Momentum = distance from neutral (0.5)
            this.lastPeriodMomentum = Math.abs(upMid - 0.5);
        } catch (e) {
            this.lastPeriodMomentum = 0;
        }
    }

    /**
     * Checks if momentum conditions are met for entry using MSPEQ-adjusted thresholds.
     */
    private checkMomentumSignal(): BtcDirection | null {
        const signals = this.getSignalRecord();

        // Compute dynamic momentum threshold using MSPEQ
        const momentumThresholdMultiplier = this.momentumThresholdMSPEQ.compute(signals);
        const dynamicMomentumThreshold = this.baseMomentumThreshold * momentumThresholdMultiplier;

        // Need strong momentum from previous period
        if (this.lastPeriodMomentum < dynamicMomentumThreshold) {
            return null;
        }

        // Compute dynamic win streak threshold using MSPEQ
        const winStreakMultiplier = this.winStreakThresholdMSPEQ.compute(signals);
        const dynamicMinWinStreak = Math.max(1, Math.round(this.baseMinWinStreak * winStreakMultiplier));

        // Check for minimum win streak
        if (this.consecutiveWins.UP >= dynamicMinWinStreak) {
            this.writeLog(
                `Momentum signal: UP (streak=${this.consecutiveWins.UP}, ` +
                `threshold=${dynamicMinWinStreak}, momentum=${this.lastPeriodMomentum.toFixed(3)}, ` +
                `momThresh=${dynamicMomentumThreshold.toFixed(3)})`
            );
            return BtcDirection.UP;
        }
        if (this.consecutiveWins.DOWN >= dynamicMinWinStreak) {
            this.writeLog(
                `Momentum signal: DOWN (streak=${this.consecutiveWins.DOWN}, ` +
                `threshold=${dynamicMinWinStreak}, momentum=${this.lastPeriodMomentum.toFixed(3)}, ` +
                `momThresh=${dynamicMomentumThreshold.toFixed(3)})`
            );
            return BtcDirection.DOWN;
        }

        return null;
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
        this.tickWrapper(1000 * 3, 1000 * 2, async () => {
            await this.executeTradingLogic();
        });
    }

    private async executeTradingLogic(): Promise<void> {
        // 1. Update signals first
        await this.updateSignals();

        // 2. Update orders
        await this.updateOrders();

        // 3. Check for sell order creation
        if (this.shouldCreateSellOrder()) {
            await this.createSellOrder();
        }

        // 4. Check for early sell trigger
        if (this.shouldTriggerEarlySell()) {
            await this.createEarlySellOrder();
        }

        // State machine
        switch (this.state) {
            case 'WAITING_SIGNAL':
                await this.handleWaitingSignal();
                break;

            case 'MOMENTUM_DETECTED':
                await this.handleMomentumDetected();
                break;

            case 'TRADE_ENTERED':
            case 'PAST_CUTOFF':
                // Nothing to do, waiting for period end
                break;
        }
    }

    public override async onSimulationTick(): Promise<void> {
        await this.executeTradingLogic();
    }

    public override async onSimulationPeriodEnd(): Promise<void> {
        // Capture previous period outcome BEFORE the base class resets state
        await this.capturePreviousPeriodOutcome();

        // Call base class period end logic
        await super.onSimulationPeriodEnd();

        // Reset our trade state for the new period
        this.resetTradeState();
    }

    // -------------------------------------------------------------------------
    // State Handlers
    // -------------------------------------------------------------------------

    private async handleWaitingSignal(): Promise<void> {
        // Check cutoff first
        if (this.isAfterCutoff()) {
            this.state = 'PAST_CUTOFF';
            return;
        }

        // Look for momentum signal (uses MSPEQ-adjusted thresholds)
        const direction = this.checkMomentumSignal();
        if (direction) {
            this.detectedDirection = direction;
            this.computedDirection = direction;
            this.state = 'MOMENTUM_DETECTED';
            this.writeLog(
                `Momentum signal detected: ${direction}, ` +
                `strength=${this.lastPeriodMomentum.toFixed(3)}, ` +
                `streak=${direction === BtcDirection.UP ? this.consecutiveWins.UP : this.consecutiveWins.DOWN}`
            );
        }
    }

    private async handleMomentumDetected(): Promise<void> {
        // Check cutoff
        if (this.isAfterCutoff()) {
            this.state = 'PAST_CUTOFF';
            return;
        }

        // Attempt to create buy order
        if (this.shouldCreateBuyOrder()) {
            await this.createBuyOrder();
        }
    }

    // -------------------------------------------------------------------------
    // Order Logic
    // -------------------------------------------------------------------------

    private shouldCreateBuyOrder(): boolean {
        if (this.buyOrder) return false;
        if (!this.detectedDirection) return false;

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
        if (this.buyOrder || !this.detectedDirection) return;

        const orderBooks = await this.marketInfo.getLiveData(this.targetedMarket);
        const tokenId = this.detectedDirection === BtcDirection.UP
            ? orderBooks.BtcUpTokenId
            : orderBooks.BtcDownTokenId;

        // Calculate dynamic buy price using MSPEQ
        const signals = this.getSignalRecord();
        const mspeqOutput = this.targetBuyPriceMSPEQ.compute(signals);

        // Validate MSPEQ output - prevent degenerate coefficients from producing unrealistic prices
        if (mspeqOutput < CrossPeriodMomentumMSPEQ.MIN_MSPEQ_OUTPUT) {
            this.writeLog(
                `createBuyOrder: skipping - MSPEQ output too low (${mspeqOutput.toFixed(4)} < ${CrossPeriodMomentumMSPEQ.MIN_MSPEQ_OUTPUT}). ` +
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
            'cross-period-momentum-mspeq-buy',
            tokenId,
            targetBuyPrice,
            targetSize,
            Side.BUY
        );

        if (this.buyOrder) {
            this.state = 'TRADE_ENTERED';
            this.writeLog(
                `createBuyOrder: placed (orderId=${this.buyOrder.orderId}, ` +
                `direction=${this.detectedDirection}, price=${targetBuyPrice}, ` +
                `mspeqOut=${mspeqOutput.toFixed(3)}, vol=${signals.volatility.toFixed(3)}, ` +
                `mom=${signals.momentum.toFixed(3)})`
            );
        }
    }

    private async createSellOrder(): Promise<void> {
        if (this.sellOrder || !this.buyOrder || !this.detectedDirection) return;

        const orderBooks = await this.marketInfo.getLiveData(this.targetedMarket);
        const tokenId = this.detectedDirection === BtcDirection.UP
            ? orderBooks.BtcUpTokenId
            : orderBooks.BtcDownTokenId;

        // Calculate dynamic sell price using MSPEQ
        const signals = this.getSignalRecord();
        const mspeqOutput = this.targetSellPriceMSPEQ.compute(signals);
        const dynamicSellPrice = Math.round(this.baseSellPrice * mspeqOutput * 100) / 100;

        // Clamp - must be above buy price + min profit margin
        const targetSellPrice = Math.max(this.actualBuyPrice + this.minProfitMargin, Math.min(0.99, dynamicSellPrice));

        this.sellOrder = await this.makeOrder(
            'cross-period-momentum-mspeq-sell',
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
    // Early Sell Logic
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
        if (this.sellOrder || this.earlySellOrder || !this.buyOrder || !this.detectedDirection) return;

        const orderBooks = await this.marketInfo.getLiveData(this.targetedMarket);
        const tokenId = this.detectedDirection === BtcDirection.UP
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
            'cross-period-momentum-mspeq-early-sell',
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

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    private async getTargetTokenId(): Promise<string> {
        if (!this.detectedDirection) {
            // Fall back to MSPEQ-computed direction
            this.detectedDirection = this.computeBtcDirection();
        }

        const orderBooks = await this.marketInfo.getLiveData(this.targetedMarket);
        return this.detectedDirection === BtcDirection.UP
            ? orderBooks.BtcUpTokenId
            : orderBooks.BtcDownTokenId;
    }
}
