// ============================================================================
// LiveSignalProvider - Real-time Signal Provider from Market Data
// ============================================================================

import {
    BaseSignalProvider,
    SignalProviderConfig,
    SignalSnapshot,
    DEFAULT_SIGNAL_CONFIG,
} from './SignalProvider.js';
import { CDMarketData } from '../nonBots/CDMarketData.js';
import { MarketInfo } from '../nonBots/MarketInfo.js';
import { TargetedMarket } from '../types/interfaces.js';

/**
 * Configuration for LiveSignalProvider.
 */
export interface LiveSignalProviderConfig extends Partial<SignalProviderConfig> {
    targetedMarket: TargetedMarket;
    marketData: CDMarketData;
    marketInfo: MarketInfo;
}

/**
 * LiveSignalProvider fetches real-time signals from market data sources.
 */
export class LiveSignalProvider extends BaseSignalProvider {
    private targetedMarket: TargetedMarket;
    private marketData: CDMarketData;
    private marketInfo: MarketInfo;
    private priceHistory: Array<{ timestamp: number; price: number }> = [];
    private lastPriceUpdate: number = 0;
    private volatilityWindowMinutes: number;
    private momentumWindowMinutes: number;

    constructor(config: LiveSignalProviderConfig) {
        super(config);
        this.targetedMarket = config.targetedMarket;
        this.marketData = config.marketData;
        this.marketInfo = config.marketInfo;

        const fullConfig = { ...DEFAULT_SIGNAL_CONFIG, ...config };
        this.volatilityWindowMinutes = fullConfig.volatilityWindowMinutes;
        this.momentumWindowMinutes = fullConfig.momentumWindowMinutes;
    }

    /**
     * Updates price history from recent Binance data.
     */
    private async updatePriceHistory(): Promise<void> {
        const now = Date.now();

        if (now - this.lastPriceUpdate < 15000) {
            return;
        }

        try {
            const recentPrices = this.marketData.getRecentPrices(
                Math.max(this.volatilityWindowMinutes, this.momentumWindowMinutes),
                this.targetedMarket
            );

            this.priceHistory = recentPrices.map((p) => ({
                timestamp: p.timestamp.getTime(),
                price: p.price,
            }));

            this.lastPriceUpdate = now;
        } catch {
            // Keep existing history on error
        }
    }

    /**
     * Gets prices within a time window (in minutes).
     */
    private getPricesInWindow(windowMinutes: number): number[] {
        if (this.priceHistory.length === 0) return [];

        const now = Date.now();
        const windowMs = windowMinutes * 60 * 1000;
        const cutoff = now - windowMs;

        return this.priceHistory.filter((p) => p.timestamp >= cutoff).map((p) => p.price);
    }

    /**
     * Computes normalized volatility from price history.
     */
    private computeVolatility(): number {
        const prices = this.getPricesInWindow(this.volatilityWindowMinutes);
        if (prices.length < 2) return 0.5;

        const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
        const variance = prices.reduce((sum, p) => sum + Math.pow(p - mean, 2), 0) / prices.length;
        const stdDev = Math.sqrt(variance);

        const normalizedVol = stdDev / (mean * 0.04);
        return Math.max(0, Math.min(1, normalizedVol));
    }

    /**
     * Computes momentum from price history.
     */
    private computeMomentum(): number {
        const prices = this.getPricesInWindow(this.momentumWindowMinutes);
        if (prices.length < 2) return 0;

        const oldPrice = prices[0];
        const newPrice = prices[prices.length - 1];

        if (oldPrice === 0) return 0;

        const change = (newPrice - oldPrice) / oldPrice;
        const normalizedMomentum = change / 0.1;

        return Math.max(-1, Math.min(1, normalizedMomentum));
    }

    /**
     * Computes price imbalance from order book mid prices.
     */
    private async computePriceImbalance(): Promise<number> {
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

            const upMid = (upBid + upAsk) / 2;
            const downMid = (downBid + downAsk) / 2;

            const imbalance = upMid - downMid;
            return Math.max(-0.5, Math.min(0.5, imbalance));
        } catch {
            return 0;
        }
    }

    async getSignals(): Promise<SignalSnapshot> {
        await this.updatePriceHistory();

        const priceImbalance = await this.computePriceImbalance();

        return {
            candleSize: this.getCandleSize(),
            timeLeft: this.getTimeLeft(),
            volatility: this.computeVolatility(),
            momentum: this.computeMomentum(),
            priceImbalance,
            timestamp: Date.now(),
        };
    }
}
