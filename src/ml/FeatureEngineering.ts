import {
    RawFeatures,
    NormalizationParams,
    TrainingSample,
    PredictionStyle,
    PredictionStyleConfig,
    getPredictionStyleConfig,
    PeriodPriceSnapshots,
    isQuarterlyStyle,
} from './types.js';
import { MarketSchedule } from '../types/interfaces.js';
import {
    AlignedPeriodData,
    DataPreparation,
    MinuteDataEntry,
    UpDownPriceEntry,
} from './DataPreparation.js';

// ============================================================================
// Feature Configuration
// ============================================================================

/**
 * How many minutes into the period to use for feature extraction.
 * Using first 30 minutes gives us half the period's data to predict
 * the final outcome while still leaving time to act on predictions.
 */
const EARLY_PERIOD_MINUTES = 30;

/**
 * List of features to extract and their order.
 * This determines the feature vector structure.
 *
 * IMPORTANT: All features use ONLY data available at period start:
 * - Binance prices: Historical data BEFORE period start
 * - Polymarket: First few minutes of period (early sentiment)
 * - Temporal: Period start time
 */
export const FEATURE_NAMES: (keyof RawFeatures)[] = [
    // Momentum features - using data up to 30min into period (6)
    'priceChange5m',
    'priceChange15m',
    'priceChange30m',
    'priceChange60m',
    'intraPeriodChange',  // Key signal: price change from period start to cutoff
    'velocity15m',

    // Volatility features - using pre-period data (5)
    'volatility15m',
    'volatility60m',
    'highLowRange',
    'totalChange',
    'flopCount',

    // Trend features - using pre-period data (5)
    'sma15m',
    'sma60m',
    'priceVsSma15m',
    'priceVsSma60m',
    'macdSignal',

    // Polymarket features - early period only (6)
    'upMid',
    'downMid',
    'priceImbalance',
    'upSpread',
    'downSpread',
    'spreadRatio',

    // Temporal features (5)
    'hourOfDay',
    'hourOfDaySin',
    'hourOfDayCos',
    'dayOfWeek',
    'periodProgress',
];

// ============================================================================
// FeatureEngineering Class
// ============================================================================

export class FeatureEngineering {
    private normParams: NormalizationParams | null = null;
    private earlyPeriodMinutes: number;
    private predictionStyle: PredictionStyle | null = null;
    private styleConfig: PredictionStyleConfig | null = null;
    private dataPrep: DataPreparation | null = null;
    private schedule: MarketSchedule | null = null;

    /**
     * Creates a FeatureEngineering instance.
     *
     * @param styleOrMinutes Either a PredictionStyle or the number of minutes for cutoff
     * @param dataPrep Optional DataPreparation instance for interval label computation
     */
    constructor(
        styleOrMinutes: PredictionStyle | number = EARLY_PERIOD_MINUTES,
        dataPrep?: DataPreparation
    ) {
        if (typeof styleOrMinutes === 'number') {
            this.earlyPeriodMinutes = styleOrMinutes;
            this.predictionStyle = null;
            this.styleConfig = null;
            this.schedule = null;
        } else {
            this.predictionStyle = styleOrMinutes;
            this.styleConfig = getPredictionStyleConfig(styleOrMinutes);
            this.earlyPeriodMinutes = this.styleConfig.featureCutoffMinutes;
            // Infer schedule from prediction style
            this.schedule = isQuarterlyStyle(styleOrMinutes)
                ? MarketSchedule.QUARTERLY
                : MarketSchedule.HOURLY;
        }
        this.dataPrep = dataPrep ?? null;
    }

    /**
     * Gets the prediction style being used (if any).
     */
    public getPredictionStyle(): PredictionStyle | null {
        return this.predictionStyle;
    }

    /**
     * Gets the feature cutoff minutes.
     */
    public getFeatureCutoffMinutes(): number {
        return this.earlyPeriodMinutes;
    }

    // -------------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------------

    /**
     * Extracts features from aligned period data.
     *
     * Uses data available within the first N minutes of the period:
     * - Binance prices: Historical data up to cutoff time (periodStart + earlyPeriodMinutes)
     * - Polymarket: Snapshots within the first N minutes of period
     * - No end-of-period data is used (avoids look-ahead bias)
     */
    public extractFeatures(period: AlignedPeriodData): RawFeatures {
        const periodStart = period.timestamp;
        const cutoffTime = periodStart + this.earlyPeriodMinutes * 60 * 1000;
        const date = new Date(periodStart);

        // Get Polymarket prices from first N minutes of period
        const earlyPmarketEntry = this.getEarlyPeriodSnapshot(
            period.pmarketSnapshots,
            periodStart,
            this.earlyPeriodMinutes
        );

        // Get minute prices up to cutoff time (includes first N minutes of period)
        const availablePrices = period.minutePrices.filter(
            p => p.timestamp < cutoffTime
        );

        // Calculate all features using data available at cutoff time
        return {
            timestamp: periodStart,

            // Momentum features - uses prices up to cutoff
            ...this.calculateMomentumFeatures(availablePrices, periodStart, cutoffTime),

            // Volatility features - uses prices up to cutoff
            ...this.calculateVolatilityFeatures(availablePrices, period.hourlyData, cutoffTime),

            // Trend features - uses prices up to cutoff
            ...this.calculateTrendFeatures(availablePrices, cutoffTime),

            // Polymarket features - uses first N minutes of period
            ...this.calculatePolymarketFeatures(earlyPmarketEntry),

            // Temporal features - period start time
            ...this.calculateTemporalFeatures(date),
        };
    }

    /**
     * Converts periods to training samples with features and labels.
     *
     * For EOP styles: Uses the existing Polymarket-based outcome
     * For INTERVAL styles: Uses Binance price direction from cutoff to target
     *
     * @param periods Array of aligned period data
     * @param normalize Whether to normalize features
     * @param forPrediction If true, skips label validation (used for real-time prediction where future data is unavailable)
     */
    public prepareSamples(
        periods: AlignedPeriodData[],
        normalize: boolean = true,
        forPrediction: boolean = false
    ): TrainingSample[] {
        // Extract raw features and determine labels for all periods
        const rawFeatures: Array<{
            features: RawFeatures;
            label: number;
            timestamp: number;
            periodKey: string;
            prices: PeriodPriceSnapshots;
        }> = [];

        for (const p of periods) {
            // Determine the label based on prediction style
            let outcome: 'UP' | 'DOWN' | null;

            if (forPrediction) {
                // For real-time prediction, we don't need a valid label
                // (we can't know the future outcome yet)
                outcome = 'UP'; // Dummy value - label won't be used for prediction
            } else if (this.predictionStyle && this.styleConfig) {
                if (this.styleConfig.targetType === 'INTERVAL' && this.dataPrep) {
                    // For interval styles, use DataPreparation to compute interval label
                    outcome = this.dataPrep.determineLabelForStyle(p, this.predictionStyle);
                } else {
                    // For EOP styles, use the existing outcome
                    outcome = p.outcome;
                }
            } else {
                // No style specified, use existing behavior
                outcome = p.outcome;
            }

            // Skip periods with no determinable outcome (unless forPrediction)
            if (outcome === null) {
                continue;
            }

            rawFeatures.push({
                features: this.extractFeatures(p),
                label: outcome === 'UP' ? 1 : 0,
                timestamp: p.timestamp,
                periodKey: p.periodKey,
                prices: this.extractPriceSnapshots(p, this.schedule ?? undefined),
            });
        }

        // Compute normalization params from training data
        if (normalize && !this.normParams) {
            this.normParams = this.computeNormalizationParams(
                rawFeatures.map(s => s.features)
            );
        }

        // Convert to feature vectors
        return rawFeatures.map(s => ({
            features: this.featuresToVector(s.features, normalize),
            label: s.label,
            timestamp: s.timestamp,
            periodKey: s.periodKey,
            prices: s.prices,
        }));
    }

    /**
     * Gets the current normalization parameters.
     */
    public getNormalizationParams(): NormalizationParams | null {
        return this.normParams;
    }

    /**
     * Sets normalization parameters (for loading a trained model).
     */
    public setNormalizationParams(params: NormalizationParams): void {
        this.normParams = params;
    }

    /**
     * Gets feature names in order.
     */
    public getFeatureNames(): string[] {
        return [...FEATURE_NAMES];
    }

    // -------------------------------------------------------------------------
    // Momentum Features (Using Data Up To Cutoff Time)
    // -------------------------------------------------------------------------

    private calculateMomentumFeatures(
        availablePrices: MinuteDataEntry[],
        periodStart: number,
        cutoffTime: number
    ): Pick<RawFeatures, 'priceChange5m' | 'priceChange15m' | 'priceChange30m' | 'priceChange60m' | 'intraPeriodChange' | 'velocity5m' | 'velocity15m' | 'acceleration'> {
        // Current price = latest price before cutoff
        const currentPrice = this.getLatestPriceBefore(availablePrices, cutoffTime);

        // Price at period start (for intra-period change calculation)
        const priceAtPeriodStart = this.getPriceAt(availablePrices, periodStart);

        // Historical prices for lookback calculations
        const price5m = this.getPriceAt(availablePrices, cutoffTime - 5 * 60 * 1000);
        const price15m = this.getPriceAt(availablePrices, cutoffTime - 15 * 60 * 1000);
        const price30m = this.getPriceAt(availablePrices, cutoffTime - 30 * 60 * 1000);
        const price60m = this.getPriceAt(availablePrices, cutoffTime - 60 * 60 * 1000);

        // Calculate percentage changes relative to cutoff price
        const priceChange5m = currentPrice && price5m ? (currentPrice - price5m) / price5m : 0;
        const priceChange15m = currentPrice && price15m ? (currentPrice - price15m) / price15m : 0;
        const priceChange30m = currentPrice && price30m ? (currentPrice - price30m) / price30m : 0;
        const priceChange60m = currentPrice && price60m ? (currentPrice - price60m) / price60m : 0;

        // KEY FEATURE: Intra-period price change (from period start to cutoff)
        // This captures momentum within the current period
        const intraPeriodChange = currentPrice && priceAtPeriodStart
            ? (currentPrice - priceAtPeriodStart) / priceAtPeriodStart
            : 0;

        // Velocity (rate of change per minute)
        const velocity5m = priceChange5m / 5;
        const velocity15m = priceChange15m / 15;

        // Acceleration (change in velocity)
        const acceleration = velocity5m - velocity15m;

        return {
            priceChange5m,
            priceChange15m,
            priceChange30m,
            priceChange60m,
            intraPeriodChange,
            velocity5m,
            velocity15m,
            acceleration,
        };
    }

    // -------------------------------------------------------------------------
    // Volatility Features (Pre-Period Data Only)
    // -------------------------------------------------------------------------

    private calculateVolatilityFeatures(
        prePeriodPrices: MinuteDataEntry[],
        hourlyData: AlignedPeriodData['hourlyData'],
        periodStart: number
    ): Pick<RawFeatures, 'volatility15m' | 'volatility60m' | 'highLowRange' | 'totalChange' | 'flopCount'> {
        // Get prices from lookback windows BEFORE period start
        const prices15m = prePeriodPrices
            .filter(p => p.timestamp >= periodStart - 15 * 60 * 1000 && p.timestamp < periodStart)
            .map(p => p.price);

        const prices60m = prePeriodPrices
            .filter(p => p.timestamp >= periodStart - 60 * 60 * 1000 && p.timestamp < periodStart)
            .map(p => p.price);

        const volatility15m = this.calculateStandardDeviation(prices15m);
        const volatility60m = this.calculateStandardDeviation(prices60m);

        // From PREVIOUS hourly data if available (not current hour)
        let highLowRange = 0;
        let totalChange = 0;
        let flopCount = 0;

        if (hourlyData) {
            // Use previous hour's data
            highLowRange = hourlyData.hourlyMax - hourlyData.hourlyMin;
            totalChange = hourlyData.totalChange;
            flopCount = hourlyData.openFlops + hourlyData.averageFlops;
        } else if (prices60m.length > 0) {
            // Estimate from pre-period minute data
            highLowRange = Math.max(...prices60m) - Math.min(...prices60m);
            totalChange = this.calculateTotalChange(prices60m);
            flopCount = this.countFlops(prices60m);
        }

        return {
            volatility15m,
            volatility60m,
            highLowRange,
            totalChange,
            flopCount,
        };
    }

    // -------------------------------------------------------------------------
    // Trend Features (Pre-Period Data Only)
    // -------------------------------------------------------------------------

    private calculateTrendFeatures(
        prePeriodPrices: MinuteDataEntry[],
        periodStart: number
    ): Pick<RawFeatures, 'sma15m' | 'sma60m' | 'priceVsSma15m' | 'priceVsSma60m' | 'macdSignal'> {
        const currentPrice = this.getLatestPriceBefore(prePeriodPrices, periodStart);

        // Get prices for SMA calculation (all BEFORE period start)
        const prices15m = prePeriodPrices
            .filter(p => p.timestamp >= periodStart - 15 * 60 * 1000 && p.timestamp < periodStart)
            .map(p => p.price);

        const prices60m = prePeriodPrices
            .filter(p => p.timestamp >= periodStart - 60 * 60 * 1000 && p.timestamp < periodStart)
            .map(p => p.price);

        const sma15m = this.calculateMean(prices15m) || currentPrice || 0;
        const sma60m = this.calculateMean(prices60m) || currentPrice || 0;

        // Price relative to SMA
        const priceVsSma15m = currentPrice && sma15m ? (currentPrice - sma15m) / sma15m : 0;
        const priceVsSma60m = currentPrice && sma60m ? (currentPrice - sma60m) / sma60m : 0;

        // MACD-style signal (difference between short and long SMA)
        const macdSignal = sma60m > 0 ? (sma15m - sma60m) / sma60m : 0;

        return {
            sma15m,
            sma60m,
            priceVsSma15m,
            priceVsSma60m,
            macdSignal,
        };
    }

    // -------------------------------------------------------------------------
    // Polymarket Features (Early Period Only - First N Minutes)
    // -------------------------------------------------------------------------

    private calculatePolymarketFeatures(
        entry: UpDownPriceEntry | null
    ): Pick<RawFeatures, 'upBid' | 'upAsk' | 'downBid' | 'downAsk' | 'upMid' | 'downMid' | 'priceImbalance' | 'upSpread' | 'downSpread' | 'spreadRatio'> {
        if (!entry) {
            // Default to neutral 50/50 if no early data available
            return {
                upBid: 0.5,
                upAsk: 0.5,
                downBid: 0.5,
                downAsk: 0.5,
                upMid: 0.5,
                downMid: 0.5,
                priceImbalance: 0,
                upSpread: 0.02,
                downSpread: 0.02,
                spreadRatio: 1,
            };
        }

        const upMid = (entry.upBid + entry.upAsk) / 2;
        const downMid = (entry.downBid + entry.downAsk) / 2;
        const upSpread = entry.upAsk - entry.upBid;
        const downSpread = entry.downAsk - entry.downBid;

        return {
            upBid: entry.upBid,
            upAsk: entry.upAsk,
            downBid: entry.downBid,
            downAsk: entry.downAsk,
            upMid,
            downMid,
            priceImbalance: upMid - downMid,
            upSpread,
            downSpread,
            spreadRatio: downSpread > 0 ? upSpread / downSpread : 1,
        };
    }

    // -------------------------------------------------------------------------
    // Temporal Features
    // -------------------------------------------------------------------------

    private calculateTemporalFeatures(
        date: Date
    ): Pick<RawFeatures, 'hourOfDay' | 'hourOfDaySin' | 'hourOfDayCos' | 'dayOfWeek' | 'minuteOfHour' | 'periodProgress'> {
        const hour = date.getHours();
        const minute = date.getMinutes();
        const dayOfWeek = date.getDay();

        // Cyclical encoding for hour
        const hourOfDaySin = Math.sin(2 * Math.PI * hour / 24);
        const hourOfDayCos = Math.cos(2 * Math.PI * hour / 24);

        // Period progress is 0 at start (we're predicting at period start)
        const periodProgress = 0;

        return {
            hourOfDay: hour,
            hourOfDaySin,
            hourOfDayCos,
            dayOfWeek,
            minuteOfHour: minute,
            periodProgress,
        };
    }

    // -------------------------------------------------------------------------
    // Normalization
    // -------------------------------------------------------------------------

    private computeNormalizationParams(features: RawFeatures[]): NormalizationParams {
        const means: number[] = [];
        const stds: number[] = [];

        for (const featureName of FEATURE_NAMES) {
            const values = features.map(f => f[featureName] as number).filter(v => !isNaN(v));

            const mean = this.calculateMean(values) || 0;
            const std = this.calculateStandardDeviation(values) || 1;

            means.push(mean);
            stds.push(std > 0 ? std : 1); // Avoid division by zero
        }

        return {
            means,
            stds,
            featureNames: [...FEATURE_NAMES],
        };
    }

    private featuresToVector(raw: RawFeatures, normalize: boolean): number[] {
        const vector: number[] = [];

        for (let i = 0; i < FEATURE_NAMES.length; i++) {
            const featureName = FEATURE_NAMES[i];
            let value = raw[featureName] as number;

            // Handle NaN
            if (isNaN(value)) {
                value = 0;
            }

            // Normalize if params available
            if (normalize && this.normParams) {
                const mean = this.normParams.means[i];
                const std = this.normParams.stds[i];
                value = (value - mean) / std;
            }

            vector.push(value);
        }

        return vector;
    }

    // -------------------------------------------------------------------------
    // Price Snapshot Extraction
    // -------------------------------------------------------------------------

    /**
     * Extracts price snapshots at various checkpoints during a period.
     * Used for PnL evaluation based on prediction styles.
     *
     * @param period The aligned period data
     * @param schedule Optional schedule override (inferred from prediction style if not provided)
     */
    public extractPriceSnapshots(
        period: AlignedPeriodData,
        schedule?: MarketSchedule
    ): PeriodPriceSnapshots {
        const periodStart = period.timestamp;
        const effectiveSchedule = schedule ?? this.schedule;

        // Choose checkpoints based on schedule
        const checkpoints = effectiveSchedule === MarketSchedule.QUARTERLY
            ? [0, 3, 5, 8, 10, 12]       // For 15-min periods
            : [0, 5, 10, 15, 20, 30, 40, 50];  // For 60-min periods

        const result: PeriodPriceSnapshots = {
            upMid0m: null,
            upMid3m: null,
            upMid5m: null,
            upMid8m: null,
            upMid10m: null,
            upMid12m: null,
            upMid15m: null,
            upMid20m: null,
            upMid30m: null,
            upMid40m: null,
            upMid50m: null,
            downMid0m: null,
            downMid3m: null,
            downMid5m: null,
            downMid8m: null,
            downMid10m: null,
            downMid12m: null,
            downMid15m: null,
            downMid20m: null,
            downMid30m: null,
            downMid40m: null,
            downMid50m: null,
        };

        for (const minutes of checkpoints) {
            const targetTime = periodStart + minutes * 60 * 1000;
            const snapshot = this.getSnapshotNearTime(period.pmarketSnapshots, targetTime);

            if (snapshot) {
                const upMid = (snapshot.upBid + snapshot.upAsk) / 2;
                const downMid = (snapshot.downBid + snapshot.downAsk) / 2;

                switch (minutes) {
                    case 0:  result.upMid0m = upMid; result.downMid0m = downMid; break;
                    case 3:  result.upMid3m = upMid; result.downMid3m = downMid; break;
                    case 5:  result.upMid5m = upMid; result.downMid5m = downMid; break;
                    case 8:  result.upMid8m = upMid; result.downMid8m = downMid; break;
                    case 10: result.upMid10m = upMid; result.downMid10m = downMid; break;
                    case 12: result.upMid12m = upMid; result.downMid12m = downMid; break;
                    case 15: result.upMid15m = upMid; result.downMid15m = downMid; break;
                    case 20: result.upMid20m = upMid; result.downMid20m = downMid; break;
                    case 30: result.upMid30m = upMid; result.downMid30m = downMid; break;
                    case 40: result.upMid40m = upMid; result.downMid40m = downMid; break;
                    case 50: result.upMid50m = upMid; result.downMid50m = downMid; break;
                }
            }
        }

        return result;
    }

    /**
     * Gets the snapshot closest to a target time within a tolerance window.
     */
    private getSnapshotNearTime(
        snapshots: UpDownPriceEntry[],
        targetTime: number,
        toleranceMs: number = 3 * 60 * 1000  // 3 minute tolerance
    ): UpDownPriceEntry | null {
        let closest: UpDownPriceEntry | null = null;
        let closestDiff = Infinity;

        for (const s of snapshots) {
            const diff = Math.abs(s.timestamp - targetTime);
            if (diff < closestDiff && diff <= toleranceMs && this.isValidSnapshot(s)) {
                closest = s;
                closestDiff = diff;
            }
        }

        return closest;
    }

    // -------------------------------------------------------------------------
    // Utility Functions
    // -------------------------------------------------------------------------

    /**
     * Gets the FIRST valid snapshot from the early part of the period.
     * Only uses data from the first N minutes to avoid look-ahead bias.
     */
    private getEarlyPeriodSnapshot(
        snapshots: UpDownPriceEntry[],
        periodStart: number,
        earlyMinutes: number
    ): UpDownPriceEntry | null {
        if (snapshots.length === 0) return null;

        const earlyEndTime = periodStart + earlyMinutes * 60 * 1000;

        // Find snapshots within the early window
        const earlySnapshots = snapshots.filter(
            s => s.timestamp >= periodStart && s.timestamp <= earlyEndTime
        );

        if (earlySnapshots.length === 0) {
            // Fallback: use first snapshot of the period
            const firstSnapshot = snapshots.find(s => s.timestamp >= periodStart);
            if (firstSnapshot && this.isValidSnapshot(firstSnapshot)) {
                return firstSnapshot;
            }
            return null;
        }

        // Return the FIRST valid snapshot (not the last)
        for (const s of earlySnapshots) {
            if (this.isValidSnapshot(s)) {
                return s;
            }
        }

        return earlySnapshots[0];
    }

    private isValidSnapshot(s: UpDownPriceEntry): boolean {
        return !isNaN(s.upBid) && !isNaN(s.upAsk) &&
               !isNaN(s.downBid) && !isNaN(s.downAsk) &&
               s.upBid > 0 && s.downBid > 0;
    }

    /**
     * Gets the latest price strictly BEFORE the target time.
     */
    private getLatestPriceBefore(prices: MinuteDataEntry[], targetTime: number): number | null {
        const priorPrices = prices.filter(p => p.timestamp < targetTime);
        if (priorPrices.length === 0) return null;

        // Return the most recent price before target
        return priorPrices[priorPrices.length - 1].price;
    }

    /**
     * Gets price closest to target time (within tolerance), but only from prices BEFORE targetTime.
     */
    private getPriceAt(prices: MinuteDataEntry[], targetTime: number): number | null {
        const tolerance = 2 * 60 * 1000; // 2 minutes

        let closest: MinuteDataEntry | null = null;
        let closestDiff = Infinity;

        for (const p of prices) {
            // Only consider prices at or before target time
            if (p.timestamp > targetTime) continue;

            const diff = Math.abs(p.timestamp - targetTime);
            if (diff < closestDiff && diff <= tolerance) {
                closest = p;
                closestDiff = diff;
            }
        }

        return closest?.price ?? null;
    }

    private calculateMean(values: number[]): number | null {
        if (values.length === 0) return null;
        return values.reduce((sum, v) => sum + v, 0) / values.length;
    }

    private calculateStandardDeviation(values: number[]): number {
        if (values.length < 2) return 0;

        const mean = this.calculateMean(values)!;
        const squaredDiffs = values.map(v => Math.pow(v - mean, 2));
        const variance = squaredDiffs.reduce((sum, d) => sum + d, 0) / (values.length - 1);

        return Math.sqrt(variance);
    }

    private calculateTotalChange(prices: number[]): number {
        if (prices.length < 2) return 0;

        let totalChange = 0;
        for (let i = 1; i < prices.length; i++) {
            totalChange += Math.abs(prices[i] - prices[i - 1]);
        }

        return totalChange;
    }

    private countFlops(prices: number[]): number {
        if (prices.length < 3) return 0;

        let flops = 0;
        let lastDirection = 0; // 1 = up, -1 = down

        for (let i = 1; i < prices.length; i++) {
            const diff = prices[i] - prices[i - 1];
            const direction = diff > 0 ? 1 : diff < 0 ? -1 : 0;

            if (direction !== 0 && lastDirection !== 0 && direction !== lastDirection) {
                flops++;
            }

            if (direction !== 0) {
                lastDirection = direction;
            }
        }

        return flops;
    }
}
