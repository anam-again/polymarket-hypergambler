import { CoinType } from '../simulation/GeneticOptimizer.js';
import { MarketSchedule } from '../types/interfaces.js';
import { MarketPredictor } from './MarketPredictor.js';

// ============================================================================
// PredictionStyle Types
// ============================================================================

/**
 * Prediction style determines:
 * 1. When to extract features (cutoff time)
 * 2. What to predict (target label - EOP winner or interval direction)
 */
export enum PredictionStyle {
    // End-of-Period predictions (predict final hour winner)
    HOURLY_10M_EOP = 'Hourly10m-EOP',   // Uses 10min data → predicts EOP winner
    HOURLY_20M_EOP = 'Hourly20m-EOP',   // Uses 20min data → predicts EOP winner
    HOURLY_30M_EOP = 'Hourly30m-EOP',   // Uses 30min data → predicts EOP winner
    HOURLY_40M_EOP = 'Hourly40m-EOP',   // Uses 40min data → predicts EOP winner
    HOURLY_50M_EOP = 'Hourly50m-EOP',   // Uses 50min data → predicts EOP winner

    // Interval predictions (predict price direction at next checkpoint)
    HOURLY_10M_20M = 'Hourly10m-20m',   // Uses 10min data → predicts UP/DOWN at 20min
    HOURLY_20M_30M = 'Hourly20m-30m',   // Uses 20min data → predicts UP/DOWN at 30min
    HOURLY_30M_40M = 'Hourly30m-40m',   // Uses 30min data → predicts UP/DOWN at 40min
    HOURLY_40M_50M = 'Hourly40m-50m',   // Uses 40min data → predicts UP/DOWN at 50min

    // Extended interval predictions (longer intervals)
    HOURLY_10M_30M = 'Hourly10m-30m',   // Uses 10min data → predicts UP/DOWN at 30min
    HOURLY_10M_40M = 'Hourly10m-40m',   // Uses 10min data → predicts UP/DOWN at 40min
    HOURLY_10M_50M = 'Hourly10m-50m',   // Uses 10min data → predicts UP/DOWN at 50min
    HOURLY_20M_40M = 'Hourly20m-40m',   // Uses 20min data → predicts UP/DOWN at 40min
    HOURLY_20M_50M = 'Hourly20m-50m',   // Uses 20min data → predicts UP/DOWN at 50min
    HOURLY_30M_50M = 'Hourly30m-50m',   // Uses 30min data → predicts UP/DOWN at 50min

    // Quarterly EOP predictions (predict 15-min period winner)
    QUARTERLY_3M_EOP = 'Quarterly3m-EOP',   // 3 min cutoff → predict EOP
    QUARTERLY_5M_EOP = 'Quarterly5m-EOP',   // 5 min cutoff → predict EOP
    QUARTERLY_8M_EOP = 'Quarterly8m-EOP',   // 8 min cutoff → predict EOP
    QUARTERLY_10M_EOP = 'Quarterly10m-EOP', // 10 min cutoff → predict EOP

    // Quarterly interval predictions
    QUARTERLY_3M_5M = 'Quarterly3m-5m',     // 3 min cutoff → predict at 5min
    QUARTERLY_5M_8M = 'Quarterly5m-8m',     // 5 min cutoff → predict at 8min
    QUARTERLY_5M_10M = 'Quarterly5m-10m',   // 5 min cutoff → predict at 10min
    QUARTERLY_3M_8M = 'Quarterly3m-8m',     // 3 min cutoff → predict at 8min
}

/**
 * Configuration derived from a PredictionStyle.
 */
export interface PredictionStyleConfig {
    style: PredictionStyle;
    featureCutoffMinutes: number;   // When to stop collecting features
    targetType: 'EOP' | 'INTERVAL'; // End-of-period or interval prediction
    targetMinutes: number;          // When to measure the outcome (60 for EOP, varies for INTERVAL)
}

/**
 * Gets the configuration for a given prediction style.
 */
export function getPredictionStyleConfig(style: PredictionStyle): PredictionStyleConfig {
    const configs: Record<PredictionStyle, PredictionStyleConfig> = {
        // EOP styles - predict end-of-period winner
        [PredictionStyle.HOURLY_10M_EOP]: {
            style: PredictionStyle.HOURLY_10M_EOP,
            featureCutoffMinutes: 10,
            targetType: 'EOP',
            targetMinutes: 60,
        },
        [PredictionStyle.HOURLY_20M_EOP]: {
            style: PredictionStyle.HOURLY_20M_EOP,
            featureCutoffMinutes: 20,
            targetType: 'EOP',
            targetMinutes: 60,
        },
        [PredictionStyle.HOURLY_30M_EOP]: {
            style: PredictionStyle.HOURLY_30M_EOP,
            featureCutoffMinutes: 30,
            targetType: 'EOP',
            targetMinutes: 60,
        },
        [PredictionStyle.HOURLY_40M_EOP]: {
            style: PredictionStyle.HOURLY_40M_EOP,
            featureCutoffMinutes: 40,
            targetType: 'EOP',
            targetMinutes: 60,
        },
        [PredictionStyle.HOURLY_50M_EOP]: {
            style: PredictionStyle.HOURLY_50M_EOP,
            featureCutoffMinutes: 50,
            targetType: 'EOP',
            targetMinutes: 60,
        },
        // Interval styles - predict price direction at next checkpoint
        [PredictionStyle.HOURLY_10M_20M]: {
            style: PredictionStyle.HOURLY_10M_20M,
            featureCutoffMinutes: 10,
            targetType: 'INTERVAL',
            targetMinutes: 20,
        },
        [PredictionStyle.HOURLY_20M_30M]: {
            style: PredictionStyle.HOURLY_20M_30M,
            featureCutoffMinutes: 20,
            targetType: 'INTERVAL',
            targetMinutes: 30,
        },
        [PredictionStyle.HOURLY_30M_40M]: {
            style: PredictionStyle.HOURLY_30M_40M,
            featureCutoffMinutes: 30,
            targetType: 'INTERVAL',
            targetMinutes: 40,
        },
        [PredictionStyle.HOURLY_40M_50M]: {
            style: PredictionStyle.HOURLY_40M_50M,
            featureCutoffMinutes: 40,
            targetType: 'INTERVAL',
            targetMinutes: 50,
        },
        // Extended interval styles - longer intervals
        [PredictionStyle.HOURLY_10M_30M]: {
            style: PredictionStyle.HOURLY_10M_30M,
            featureCutoffMinutes: 10,
            targetType: 'INTERVAL',
            targetMinutes: 30,
        },
        [PredictionStyle.HOURLY_10M_40M]: {
            style: PredictionStyle.HOURLY_10M_40M,
            featureCutoffMinutes: 10,
            targetType: 'INTERVAL',
            targetMinutes: 40,
        },
        [PredictionStyle.HOURLY_10M_50M]: {
            style: PredictionStyle.HOURLY_10M_50M,
            featureCutoffMinutes: 10,
            targetType: 'INTERVAL',
            targetMinutes: 50,
        },
        [PredictionStyle.HOURLY_20M_40M]: {
            style: PredictionStyle.HOURLY_20M_40M,
            featureCutoffMinutes: 20,
            targetType: 'INTERVAL',
            targetMinutes: 40,
        },
        [PredictionStyle.HOURLY_20M_50M]: {
            style: PredictionStyle.HOURLY_20M_50M,
            featureCutoffMinutes: 20,
            targetType: 'INTERVAL',
            targetMinutes: 50,
        },
        [PredictionStyle.HOURLY_30M_50M]: {
            style: PredictionStyle.HOURLY_30M_50M,
            featureCutoffMinutes: 30,
            targetType: 'INTERVAL',
            targetMinutes: 50,
        },
        // Quarterly EOP styles - predict end-of-period winner (15-min periods)
        [PredictionStyle.QUARTERLY_3M_EOP]: {
            style: PredictionStyle.QUARTERLY_3M_EOP,
            featureCutoffMinutes: 3,
            targetType: 'EOP',
            targetMinutes: 15,
        },
        [PredictionStyle.QUARTERLY_5M_EOP]: {
            style: PredictionStyle.QUARTERLY_5M_EOP,
            featureCutoffMinutes: 5,
            targetType: 'EOP',
            targetMinutes: 15,
        },
        [PredictionStyle.QUARTERLY_8M_EOP]: {
            style: PredictionStyle.QUARTERLY_8M_EOP,
            featureCutoffMinutes: 8,
            targetType: 'EOP',
            targetMinutes: 15,
        },
        [PredictionStyle.QUARTERLY_10M_EOP]: {
            style: PredictionStyle.QUARTERLY_10M_EOP,
            featureCutoffMinutes: 10,
            targetType: 'EOP',
            targetMinutes: 15,
        },
        // Quarterly interval styles
        [PredictionStyle.QUARTERLY_3M_5M]: {
            style: PredictionStyle.QUARTERLY_3M_5M,
            featureCutoffMinutes: 3,
            targetType: 'INTERVAL',
            targetMinutes: 5,
        },
        [PredictionStyle.QUARTERLY_5M_8M]: {
            style: PredictionStyle.QUARTERLY_5M_8M,
            featureCutoffMinutes: 5,
            targetType: 'INTERVAL',
            targetMinutes: 8,
        },
        [PredictionStyle.QUARTERLY_5M_10M]: {
            style: PredictionStyle.QUARTERLY_5M_10M,
            featureCutoffMinutes: 5,
            targetType: 'INTERVAL',
            targetMinutes: 10,
        },
        [PredictionStyle.QUARTERLY_3M_8M]: {
            style: PredictionStyle.QUARTERLY_3M_8M,
            featureCutoffMinutes: 3,
            targetType: 'INTERVAL',
            targetMinutes: 8,
        },
    };

    return configs[style];
}

/**
 * Parses a prediction style from a string value.
 * Returns undefined if the string doesn't match any known style.
 */
export function parsePredictionStyle(value: string): PredictionStyle | undefined {
    const normalized = value.trim();
    for (const style of Object.values(PredictionStyle)) {
        if (style === normalized || style.toLowerCase() === normalized.toLowerCase()) {
            return style as PredictionStyle;
        }
    }
    return undefined;
}

/**
 * Checks if a prediction style is a quarterly style.
 */
export function isQuarterlyStyle(style: PredictionStyle): boolean {
    return style.startsWith('Quarterly');
}

// ============================================================================
// Feature Types
// ============================================================================

/**
 * Raw features extracted from market data for a single time period.
 */
export interface RawFeatures {
    timestamp: number;

    // === CDMarketData (Binance Price) Features ===
    // Momentum features
    priceChange5m: number;      // Price change over last 5 minutes
    priceChange15m: number;     // Price change over last 15 minutes
    priceChange30m: number;     // Price change over last 30 minutes
    priceChange60m: number;     // Price change over last 60 minutes
    intraPeriodChange: number;  // Price change from period start to cutoff (key signal!)
    velocity5m: number;         // Rate of change (price per minute)
    velocity15m: number;
    acceleration: number;       // Second derivative of price

    // Volatility features
    volatility15m: number;      // Standard deviation of last 15 minutes
    volatility60m: number;      // Standard deviation of last 60 minutes
    highLowRange: number;       // High-low range from hourly data
    totalChange: number;        // From hourly log
    flopCount: number;          // Direction changes from hourly log

    // Trend features
    sma15m: number;             // 15-minute simple moving average
    sma60m: number;             // 60-minute simple moving average
    priceVsSma15m: number;      // Current price relative to SMA15
    priceVsSma60m: number;      // Current price relative to SMA60
    macdSignal: number;         // MACD-style momentum (sma15 - sma60)

    // === MarketInfo (Polymarket) Features ===
    upBid: number;
    upAsk: number;
    downBid: number;
    downAsk: number;
    upMid: number;              // (upBid + upAsk) / 2
    downMid: number;            // (downBid + downAsk) / 2
    priceImbalance: number;     // upMid - downMid
    upSpread: number;           // upAsk - upBid
    downSpread: number;         // downAsk - downBid
    spreadRatio: number;        // upSpread / downSpread

    // === Temporal Features ===
    hourOfDay: number;          // 0-23
    hourOfDaySin: number;       // sin(2π * hour / 24) for cyclical encoding
    hourOfDayCos: number;       // cos(2π * hour / 24) for cyclical encoding
    dayOfWeek: number;          // 0-6 (Sunday = 0)
    minuteOfHour: number;       // 0-59
    periodProgress: number;     // How far into the period (0-1)
}

/**
 * Normalized features ready for model input.
 * All features are standardized to have mean ~0 and std ~1.
 */
export interface NormalizedFeatures {
    features: number[];         // Flat array of normalized feature values
    featureNames: string[];     // Names corresponding to each feature
}

// ============================================================================
// Price Tracking Types
// ============================================================================

/**
 * Price snapshots at various checkpoints during a period.
 * Used for PnL evaluation based on prediction styles.
 */
export interface PeriodPriceSnapshots {
    // UP token mid prices at each checkpoint (null if no data available)
    upMid0m: number | null;     // Price at period start
    upMid3m: number | null;     // Quarterly checkpoint
    upMid5m: number | null;
    upMid8m: number | null;     // Quarterly checkpoint
    upMid10m: number | null;
    upMid12m: number | null;    // Quarterly checkpoint
    upMid15m: number | null;
    upMid20m: number | null;
    upMid30m: number | null;
    upMid40m: number | null;
    upMid50m: number | null;

    // DOWN token mid prices at each checkpoint
    downMid0m: number | null;
    downMid3m: number | null;   // Quarterly checkpoint
    downMid5m: number | null;
    downMid8m: number | null;   // Quarterly checkpoint
    downMid10m: number | null;
    downMid12m: number | null;  // Quarterly checkpoint
    downMid15m: number | null;
    downMid20m: number | null;
    downMid30m: number | null;
    downMid40m: number | null;
    downMid50m: number | null;
}

/**
 * Training sample with features and label.
 */
export interface TrainingSample {
    features: number[];
    label: number;              // 1 = UP wins, 0 = DOWN wins
    timestamp: number;          // For debugging/analysis
    periodKey: string;          // Hour or quarter identifier
    prices?: PeriodPriceSnapshots;  // Optional for backward compatibility
}

/**
 * Dataset split for training and evaluation.
 */
export interface DatasetSplit {
    train: TrainingSample[];
    test: TrainingSample[];
    validation?: TrainingSample[];
}

// ============================================================================
// PnL Evaluation Types
// ============================================================================

/**
 * Result of PnL evaluation for a set of predictions.
 */
export interface PnLResult {
    totalPnL: number;           // Total PnL as a percentage
    averagePnL: number;         // Average PnL per trade
    winningTrades: number;      // Number of profitable trades
    losingTrades: number;       // Number of losing trades
    winRate: number;            // Percentage of winning trades
    maxGain: number;            // Largest single gain
    maxLoss: number;            // Largest single loss
    tradesEvaluated: number;    // Number of trades with valid price data
    tradesSkipped: number;      // Trades without sufficient price data
}

/**
 * Evaluates PnL for a set of predictions based on the prediction style.
 *
 * For INTERVAL predictions (e.g., Hourly30m-40m):
 * - Buy at start of interval, sell at end of interval
 * - PnL = (endPrice - startPrice) / startPrice * tradeSize
 *
 * For EOP predictions (e.g., Hourly20m-EOP):
 * - Buy at cutoff time
 * - If prediction correct: token worth 1.00
 * - If prediction wrong: token worth 0.00
 *
 * @param samples Training samples with price data
 * @param predictions Array of {prediction: 'UP' | 'DOWN', confidence: number}
 * @param style The prediction style being used
 * @param tradeSize Notional trade size (default 100 for percentage calculations)
 * @returns PnL evaluation results
 */
export function evaluatePnL(
    samples: TrainingSample[],
    predictions: Array<{ prediction: 'UP' | 'DOWN'; confidence: number }>,
    style: PredictionStyle,
    tradeSize: number = 100
): PnLResult {
    const styleConfig = getPredictionStyleConfig(style);
    const isEOP = styleConfig.targetType === 'EOP';

    let totalPnL = 0;
    let winningTrades = 0;
    let losingTrades = 0;
    let maxGain = -Infinity;
    let maxLoss = Infinity;
    let tradesEvaluated = 0;
    let tradesSkipped = 0;

    for (let i = 0; i < samples.length; i++) {
        const sample = samples[i];
        const pred = predictions[i];

        if (!sample.prices) {
            tradesSkipped++;
            continue;
        }

        const prices = sample.prices;
        let pnl: number | null = null;

        if (isEOP) {
            // EOP prediction: Buy at cutoff, settle at 1.00 or 0.00
            const cutoffPrice = getUpDownMidAtMinute(prices, styleConfig.featureCutoffMinutes, pred.prediction);
            if (cutoffPrice === null) {
                tradesSkipped++;
                continue;
            }

            // Determine if prediction was correct
            const actual = sample.label === 1 ? 'UP' : 'DOWN';
            const correct = pred.prediction === actual;

            if (correct) {
                // Token settles at 1.00
                pnl = ((1.00 - cutoffPrice) / cutoffPrice) * tradeSize;
            } else {
                // Token settles at 0.00
                pnl = ((0.00 - cutoffPrice) / cutoffPrice) * tradeSize;
            }
        } else {
            // INTERVAL prediction: Buy at cutoff, sell at target
            const startPrice = getUpDownMidAtMinute(prices, styleConfig.featureCutoffMinutes, pred.prediction);
            const endPrice = getUpDownMidAtMinute(prices, styleConfig.targetMinutes, pred.prediction);

            if (startPrice === null || endPrice === null) {
                tradesSkipped++;
                continue;
            }

            pnl = ((endPrice - startPrice) / startPrice) * tradeSize;
        }

        if (pnl !== null) {
            totalPnL += pnl;
            tradesEvaluated++;

            if (pnl > 0) {
                winningTrades++;
                maxGain = Math.max(maxGain, pnl);
            } else {
                losingTrades++;
                maxLoss = Math.min(maxLoss, pnl);
            }
        }
    }

    return {
        totalPnL,
        averagePnL: tradesEvaluated > 0 ? totalPnL / tradesEvaluated : 0,
        winningTrades,
        losingTrades,
        winRate: tradesEvaluated > 0 ? winningTrades / tradesEvaluated : 0,
        maxGain: maxGain === -Infinity ? 0 : maxGain,
        maxLoss: maxLoss === Infinity ? 0 : maxLoss,
        tradesEvaluated,
        tradesSkipped,
    };
}

/**
 * Helper to get UP or DOWN mid price at a specific minute checkpoint.
 */
function getUpDownMidAtMinute(
    prices: PeriodPriceSnapshots,
    minutes: number,
    side: 'UP' | 'DOWN'
): number | null {
    const prefix = side === 'UP' ? 'upMid' : 'downMid';
    const key = `${prefix}${minutes}m` as keyof PeriodPriceSnapshots;
    return prices[key];
}

// ============================================================================
// Model Types
// ============================================================================

/**
 * Logistic regression model parameters.
 */
export interface ModelWeights {
    weights: number[];          // Feature weights (one per feature)
    bias: number;               // Intercept term
    featureNames: string[];     // Names for interpretability
}

/**
 * Training configuration.
 */
export interface TrainingConfig {
    learningRate: number;       // Step size for gradient descent
    epochs: number;             // Number of training iterations
    batchSize: number;          // Mini-batch size (0 = full batch)
    l2Lambda: number;           // L2 regularization strength
    earlyStopPatience: number;  // Stop if no improvement for N epochs
    validationSplit: number;    // Fraction of training data for validation
    verbose: boolean;           // Print training progress
}

/**
 * Training history for monitoring.
 */
export interface TrainingHistory {
    epochs: number[];
    trainLoss: number[];
    trainAccuracy: number[];
    valLoss?: number[];
    valAccuracy?: number[];
}

/**
 * Prediction result with confidence.
 */
export interface Prediction {
    probability: number;        // P(UP) - probability that UP wins
    prediction: 'UP' | 'DOWN';  // Binary prediction
    confidence: number;         // |probability - 0.5| * 2 (0-1 scale)
    timestamp: number;
}

// ============================================================================
// Normalization Types
// ============================================================================

/**
 * Feature normalization parameters (mean/std for z-score normalization).
 */
export interface NormalizationParams {
    means: number[];
    stds: number[];
    featureNames: string[];
}

// ============================================================================
// Evaluation Types
// ============================================================================

/**
 * Model performance metrics.
 */
export interface ModelMetrics {
    accuracy: number;
    precision: number;          // TP / (TP + FP)
    recall: number;             // TP / (TP + FN)
    f1Score: number;            // 2 * (precision * recall) / (precision + recall)
    auc?: number;               // Area under ROC curve
    confusionMatrix: {
        truePositives: number;
        trueNegatives: number;
        falsePositives: number;
        falseNegatives: number;
    };
    sampleCount: number;
}

/**
 * Feature importance analysis.
 */
export interface FeatureImportance {
    name: string;
    weight: number;
    absWeight: number;
    rank: number;
}

// ============================================================================
// Backtesting Types
// ============================================================================

/**
 * Backtest configuration.
 */
export interface BacktestConfig {
    model: MarketPredictor;
    coinType: CoinType;
    schedule: MarketSchedule;
    startDate: Date;
    endDate: Date;
    confidenceThreshold: number;    // Min confidence to act on prediction
    tradeSizeUsd: number;           // Amount to trade per prediction
    trainWindowDays: number;        // Days of data for training
    retrainFrequencyDays: number;   // How often to retrain
}

/**
 * Single backtest trade result.
 */
export interface BacktestTrade {
    timestamp: number;
    periodKey: string;
    prediction: 'UP' | 'DOWN';
    confidence: number;
    actual: 'UP' | 'DOWN';
    correct: boolean;
    profitLoss: number;             // In USD
    cumulativePnL: number;
}

/**
 * Backtest summary statistics.
 */
export interface BacktestResult {
    trades: BacktestTrade[];
    totalTrades: number;
    winningTrades: number;
    losingTrades: number;
    accuracy: number;
    totalPnL: number;
    maxDrawdown: number;
    sharpeRatio: number;
    profitFactor: number;           // Gross profit / Gross loss
    averageTradeProfit: number;
    modelMetrics: ModelMetrics;
}

// ============================================================================
// Persistence Types
// ============================================================================

/**
 * Serializable model state for saving/loading.
 */
export interface SerializedModel {
    version: string;
    createdAt: string;
    coinType: CoinType;
    schedule: MarketSchedule;
    predictionStyle?: PredictionStyle;
    weights: ModelWeights;
    normalizationParams: NormalizationParams;
    trainingConfig: TrainingConfig;
    trainingMetrics: ModelMetrics;
    featureImportance: FeatureImportance[];
}
