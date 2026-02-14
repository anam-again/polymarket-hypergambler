import { QuantBot, QuantBotProps } from "./QuantBot.js";
import { MarketSchedule } from "../types/interfaces.js";
import { ISignalProvider, SignalSnapshot } from "../signals/SignalProvider.js";
import { HistoricalSignalProvider } from "../signals/MockSignalProvider.js";
import { TradeGate, RegimeDetector, RegimeType } from "../regime/index.js";

// ============================================================================
// Types & Interfaces
// ============================================================================

export interface MSPEQBotProps extends QuantBotProps {
    candleSizeReference: number;
    signalProvider?: ISignalProvider;
    // Regime-aware trading (optional)
    tradeGate?: TradeGate;
    regimeDetector?: RegimeDetector;
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

    // --- Constructor ---

    constructor(props: MSPEQBotProps) {
        super(props);

        this.candleSizeReference = props.candleSizeReference;
        this.tradeGate = props.tradeGate;
        this.regimeDetector = props.regimeDetector;

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
