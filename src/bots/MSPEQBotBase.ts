import { QuantBot, QuantBotProps } from "./QuantBot.js";
import { MarketSchedule } from "../types/interfaces.js";
import { ISignalProvider, SignalSnapshot } from "../signals/SignalProvider.js";
import { HistoricalSignalProvider } from "../signals/MockSignalProvider.js";
import { TradeGate, RegimeDetector, RegimeType } from "../regime/index.js";
import { MLPredictionService, MLPrediction, TradeOutcome } from "../ml/MLPredictionService.js";
import { MarketRegime } from "../ml/MarketRegimeDetector.js";

// ============================================================================
// Types & Interfaces
// ============================================================================

export interface MSPEQBotProps extends QuantBotProps {
    candleSizeReference: number;
    signalProvider?: ISignalProvider;
    // Regime-aware trading (optional)
    tradeGate?: TradeGate;
    regimeDetector?: RegimeDetector;

    // ML Integration (optional)
    /** MLPredictionService instance for ML-powered predictions */
    mlService?: MLPredictionService;
    /** Enable ML gating (reject trades below minMLConfidence) */
    useMLGating?: boolean;
    /** Minimum ML confidence threshold to proceed with trade (default: 0.5) */
    minMLConfidence?: number;
    /** Position size multiplier based on ML confidence (default: 1.0) */
    mlPositionMultiplier?: number;
}

// ============================================================================
// MSPEQBotBase Class
// ============================================================================

/**
 * MSPEQBotBase - Base class for bots using Multi-Signal PEQ
 *
 * Provides common signal management functionality:
 * - Signal provider initialization and period timing
 * - Throttled price and orderbook updates
 * - Signal caching and retrieval
 *
 * Subclasses must call updateSignals() in their trading loop
 * and can use getSignalRecord() to get current signal values.
 */
export abstract class MSPEQBotBase extends QuantBot {

    // --- Signal Provider ---
    protected signalProvider: ISignalProvider;
    protected lastSignals?: SignalSnapshot;
    protected candleSizeReference: number;

    // --- Signal Caching ---
    protected lastPriceUpdateTime: number = 0;
    protected lastOrderBookUpdateTime: number = 0;
    protected cachedPrice: number | null = null;
    protected cachedUpMid: number = 0.5;
    protected cachedDownMid: number = 0.5;

    // --- Update Intervals ---
    protected readonly PRICE_UPDATE_INTERVAL_MS = 5000;      // 5 seconds
    protected readonly ORDERBOOK_UPDATE_INTERVAL_MS = 30000; // 30 seconds

    // --- Candle Data (subclasses must update these) ---
    protected candleHigh: number = 0;
    protected candleLow: number = Infinity;

    // --- Regime-Aware Trading ---
    protected tradeGate?: TradeGate;
    protected regimeDetector?: RegimeDetector;
    protected currentRegime: RegimeType = RegimeType.LOW_VOL_RANGING;

    // --- ML Integration ---
    protected mlService?: MLPredictionService;
    protected useMLGating: boolean = false;
    protected minMLConfidence: number = 0.5;
    protected mlPositionMultiplier: number = 1.0;
    protected lastMLPrediction?: MLPrediction;
    protected lastMLFeatures?: Record<string, number>;

    // --- Constructor ---

    constructor(props: MSPEQBotProps) {
        super(props);

        this.candleSizeReference = props.candleSizeReference;
        this.tradeGate = props.tradeGate;
        this.regimeDetector = props.regimeDetector;

        // ML Integration
        this.mlService = props.mlService;
        this.useMLGating = props.useMLGating ?? false;
        this.minMLConfidence = props.minMLConfidence ?? 0.5;
        this.mlPositionMultiplier = props.mlPositionMultiplier ?? 1.0;

        // Signal provider (default to HistoricalSignalProvider for simulation)
        this.signalProvider = props.signalProvider ?? new HistoricalSignalProvider({
            candleSizeReference: this.candleSizeReference,
            periodLengthMs: this.marketSchedule === MarketSchedule.QUARTERLY
                ? 15 * 60 * 1000
                : 60 * 60 * 1000,
            clock: this.clock,
        });
    }

    // -------------------------------------------------------------------------
    // Signal Management
    // -------------------------------------------------------------------------

    /**
     * Updates signals from the signal provider with throttled data fetching.
     * Subclasses should call this at the start of their trading logic.
     */
    protected async updateSignals(): Promise<SignalSnapshot> {
        // Update candle data in signal provider
        this.signalProvider.setCandleData(this.candleHigh, this.candleLow);

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

    /**
     * Returns the current signals as a record for MSPEQ computation.
     * Returns default values if signals haven't been updated yet.
     */
    protected getSignalRecord(): Record<string, number> {
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
    // Regime-Aware Trading
    // -------------------------------------------------------------------------

    /**
     * Updates the current regime based on signals.
     * Should be called after updateSignals() if regime-aware trading is enabled.
     */
    protected updateRegime(): void {
        if (this.regimeDetector && this.lastSignals) {
            this.currentRegime = this.regimeDetector.detect(this.lastSignals);
        }
    }

    /**
     * Checks if trading should proceed based on TradeGate evaluation.
     * If no TradeGate is configured, always returns true (allow trading).
     *
     * @returns true if trading should proceed, false if gated
     */
    protected shouldTrade(): boolean {
        if (!this.tradeGate) {
            return true; // No gate configured, allow all trades
        }

        const signals = this.getSignalRecord();
        const result = this.tradeGate.evaluate(signals, this.currentRegime);

        if (!result.shouldTrade) {
            this.writeLog(`TradeGate blocked trade: confidence=${result.confidence.toFixed(3)}, regime=${this.currentRegime}`);
        }

        return result.shouldTrade;
    }

    /**
     * Gets the current regime type.
     */
    protected getRegime(): RegimeType {
        return this.currentRegime;
    }

    // -------------------------------------------------------------------------
    // ML Integration
    // -------------------------------------------------------------------------

    /**
     * Computes ML features from current market state.
     * Returns a feature record suitable for FairValueModel (56 features).
     *
     * Subclasses can override this to add strategy-specific features.
     */
    protected computeMLFeatures(): Record<string, number> {
        const now = this.clock.now();
        const signals = this.getSignalRecord();

        // Time features
        const date = new Date(now);
        const minuteInHour = date.getMinutes() / 60;
        const secondInMinute = date.getSeconds() / 60;
        const periodLength = this.marketSchedule === MarketSchedule.QUARTERLY
            ? 15 * 60 * 1000
            : 60 * 60 * 1000;
        const periodStart = Math.floor(now / periodLength) * periodLength;
        const periodProgress = (now - periodStart) / periodLength;
        const timeToHourEnd = 1 - periodProgress;
        const isFirstQuarter = periodProgress < 0.25 ? 1 : 0;
        const isLastQuarter = periodProgress > 0.75 ? 1 : 0;

        // Cyclic time encoding
        const minuteSin = Math.sin(2 * Math.PI * minuteInHour);
        const minuteCos = Math.cos(2 * Math.PI * minuteInHour);
        const hourSin = Math.sin(2 * Math.PI * date.getHours() / 24);
        const hourCos = Math.cos(2 * Math.PI * date.getHours() / 24);

        // Base features from signals
        const features: Record<string, number> = {
            // Price candle features (use signals where available)
            candle10s: signals.candleSize * 0.1,
            candle20s: signals.candleSize * 0.2,
            candle30s: signals.candleSize * 0.3,
            candle60s: signals.candleSize * 0.6,
            candle5m: signals.candleSize,

            // Moving average features
            ma30s: 0,
            ma60s: 0,
            ma5m: 0,

            // Volatility features
            volatility30s: signals.volatility,
            volatility60s: signals.volatility * 0.9,

            // Momentum and trend
            momentum: signals.momentum,
            priceVsMa: signals.momentum * 5,

            // Token prices
            upMid: this.cachedUpMid,
            downMid: this.cachedDownMid,
            upSpread: 0.02,
            downSpread: 0.02,
            imbalance: signals.priceImbalance,

            // Order book depth (placeholder - filled by subclasses with real data)
            upBidDepth1pct: 0,
            upAskDepth1pct: 0,
            upBidDepth5pct: 0,
            upAskDepth5pct: 0,
            upVolumeImbalance: 0,
            upBidVWAP: 0.5,
            upAskVWAP: 0.5,
            upBookPressure: 1,

            downBidDepth1pct: 0,
            downAskDepth1pct: 0,
            downBidDepth5pct: 0,
            downAskDepth5pct: 0,
            downVolumeImbalance: 0,
            downBidVWAP: 0.5,
            downAskVWAP: 0.5,
            downBookPressure: 1,

            // Time features
            minuteInHour,
            secondInMinute,
            timeToHourEnd,
            isFirstQuarter,
            isLastQuarter,
            minuteSin,
            minuteCos,
            hourSin,
            hourCos,
            periodProgress,

            // Order flow features
            upBidAskRatio: 1,
            downBidAskRatio: 1,
            upTopBidConcentration: 0,
            upTopAskConcentration: 0,
            downTopBidConcentration: 0,
            downTopAskConcentration: 0,

            // Cross-token features
            upDownCorrelation: 0,
            upDownSpreadRatio: 1,
            combinedLiquidity: 0,
            imbalanceVelocity: 0,

            // Period start features
            upPriceVsPeriodStart: 0,
            downPriceVsPeriodStart: 0,
            binancePriceVsPeriodStart: 0,
        };

        // Cache for training
        this.lastMLFeatures = features;

        return features;
    }

    /**
     * Checks if trading should proceed based on ML confidence.
     * Returns { shouldTrade, confidence, reason? }
     *
     * If ML gating is disabled or no ML service, returns { shouldTrade: true }.
     */
    protected shouldTradeML(): { shouldTrade: boolean; confidence: number; reason?: string } {
        if (!this.useMLGating || !this.mlService) {
            return { shouldTrade: true, confidence: 1.0 };
        }

        const features = this.computeMLFeatures();
        const result = this.mlService.shouldTrade(features, this.minMLConfidence);

        if (!result.shouldTrade) {
            this.writeLog(`ML gate blocked: ${result.reason}`);
        }

        // Cache the prediction for later use
        this.lastMLPrediction = this.mlService.predictFairValue(features);

        return result;
    }

    /**
     * Gets ML-adjusted position size based on confidence and regime.
     *
     * @param baseSize Base position size in dollars
     * @returns Adjusted position size
     */
    protected getMLAdjustedPositionSize(baseSize: number): number {
        if (!this.mlService) {
            return baseSize;
        }

        const features = this.lastMLFeatures ?? this.computeMLFeatures();
        return this.mlService.getAdjustedPositionSize(
            baseSize,
            features,
            this.mlPositionMultiplier
        );
    }

    /**
     * Gets the ML prediction for the current market state.
     * Updates cached prediction if needed.
     */
    protected getMLPrediction(): MLPrediction | undefined {
        if (!this.mlService) {
            return undefined;
        }

        if (!this.lastMLPrediction) {
            const features = this.computeMLFeatures();
            this.lastMLPrediction = this.mlService.predictFairValue(features);
        }

        return this.lastMLPrediction;
    }

    /**
     * Finds optimal exit price using ML ExitModel.
     *
     * @param direction Trade direction ('UP' or 'DOWN')
     * @param currentMidPrice Current mid price of the token
     * @returns Enhanced exit prediction or undefined if no ML service
     */
    protected findMLOptimalExitPrice(
        direction: 'UP' | 'DOWN',
        currentMidPrice: number
    ) {
        if (!this.mlService) {
            return undefined;
        }

        const features = this.lastMLFeatures ?? this.computeMLFeatures();
        return this.mlService.findOptimalExitPrice(features, direction, currentMidPrice);
    }

    /**
     * Trains ML models on trade outcome.
     * Should be called when a trade completes (fills or expires).
     *
     * @param entryPrice The price at which the trade was entered
     * @param exitPrice The price at which the trade exited (if filled)
     * @param tokenId The token ID (used to determine UP/DOWN direction)
     * @param filled Whether the order filled
     * @param pnl Realized profit/loss
     * @param actualUpPrice Actual UP token price at outcome time
     * @param actualDownPrice Actual DOWN token price at outcome time
     */
    protected onTradeOutcome(
        entryPrice: number,
        exitPrice: number | undefined,
        tokenId: string,
        filled: boolean,
        pnl: number,
        actualUpPrice: number,
        actualDownPrice: number
    ): void {
        if (!this.mlService || !this.lastMLFeatures) {
            return;
        }

        const outcome: TradeOutcome = {
            entryFeatures: this.lastMLFeatures,
            actualUpPrice,
            actualDownPrice,
            pnl,
            filled,
            entryPrice,
            exitPrice: filled ? exitPrice : undefined,
            direction: tokenId.toLowerCase().includes('up') ? 'UP' : 'DOWN',
        };

        this.mlService.trainOnOutcome(outcome);
    }

    /**
     * Gets the current ML regime (different from TradeGate regime).
     */
    protected getMLRegime(): MarketRegime | undefined {
        return this.mlService?.getCurrentRegime();
    }

    /**
     * Gets ML regime multipliers for position sizing and timeouts.
     */
    protected getMLRegimeMultipliers() {
        return this.mlService?.getRegimeMultipliers();
    }

    /**
     * Saves ML model weights to disk.
     */
    protected saveMLModels(): void {
        this.mlService?.save();
    }

    /**
     * Resets ML models to fresh state.
     * Used for fresh simulation starts.
     */
    protected resetMLModels(): void {
        this.mlService?.reset();
        this.lastMLPrediction = undefined;
        this.lastMLFeatures = undefined;
    }

    /**
     * Updates the signal provider's period timing.
     * Should be called on period reset.
     */
    protected updateSignalProviderTiming(): void {
        // Use clock.now() for simulation compatibility
        const now = this.clock.now();
        const periodLength = this.marketSchedule === MarketSchedule.QUARTERLY
            ? 15 * 60 * 1000
            : 60 * 60 * 1000;

        // Align to period boundary
        const periodStart = Math.floor(now / periodLength) * periodLength;
        const periodEnd = periodStart + periodLength;

        this.signalProvider.setPeriodTiming(periodStart, periodEnd);
    }

    /**
     * Returns the last computed signals for regime detection.
     * This is used by the simulator to determine the market regime.
     */
    public getLastSignals(): Record<string, number> | null {
        if (!this.lastSignals) return null;
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

    /**
     * Resets signal-related state. Should be called from resetTradeState().
     */
    protected resetSignalState(): void {
        this.lastSignals = undefined;
        this.lastPriceUpdateTime = 0;
        this.lastOrderBookUpdateTime = 0;
        this.candleHigh = 0;
        this.candleLow = Infinity;

        // Clear ML prediction cache (but keep model weights)
        this.lastMLPrediction = undefined;
        this.lastMLFeatures = undefined;

        // Clear signal provider history to avoid carrying stale data across periods
        if (this.signalProvider instanceof HistoricalSignalProvider) {
            (this.signalProvider as HistoricalSignalProvider).clearHistory();
        }

        // Reset signal provider period timing
        this.updateSignalProviderTiming();

        // Seed signal provider with pre-period historical data for accurate signals
        this.seedSignalProviderHistory();
    }

    /**
     * Seeds the signal provider with historical price data from before the period.
     * This ensures volatility/momentum signals are accurate from period start.
     */
    protected seedSignalProviderHistory(): void {
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
}
