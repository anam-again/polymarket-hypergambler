import { existsSync } from 'fs';
import { CoinType } from '../simulation/GeneticOptimizer.js';
import { MarketSchedule, TargetedMarket } from '../types/interfaces.js';
import { Prediction } from './types.js';
import { MarketPredictor } from './MarketPredictor.js';
import { FeatureEngineering } from './FeatureEngineering.js';
import { DataPreparation, AlignedPeriodData, UpDownPriceEntry, MinuteDataEntry } from './DataPreparation.js';

// ============================================================================
// Types
// ============================================================================

export interface PredictionRequest {
    coinType: CoinType;
    schedule: MarketSchedule;
    timestamp: number;
}

export interface PredictionResult extends Prediction {
    coinType: CoinType;
    schedule: MarketSchedule;
    periodKey: string;
    features: Record<string, number>;
}

export interface PredictionServiceConfig {
    modelDir: string;
    confidenceThreshold: number;
    logPredictions: boolean;
}

// ============================================================================
// PredictionService Class
// ============================================================================

/**
 * Service for making real-time market predictions.
 * Loads trained models and provides a simple API for predictions.
 */
export class PredictionService {
    private models: Map<string, MarketPredictor> = new Map();
    private featureEngineers: Map<string, FeatureEngineering> = new Map();
    private config: PredictionServiceConfig;

    // Cache for recent predictions to avoid redundant calculations
    private predictionCache: Map<string, PredictionResult> = new Map();
    private readonly CACHE_TTL_MS = 60 * 1000; // 1 minute cache

    constructor(config: Partial<PredictionServiceConfig> = {}) {
        this.config = {
            modelDir: './models',
            confidenceThreshold: 0.55,
            logPredictions: true,
            ...config,
        };
    }

    // -------------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------------

    /**
     * Loads a trained model for a specific coin/schedule combination.
     */
    public loadModel(coinType: CoinType, schedule: MarketSchedule): boolean {
        const modelKey = this.getModelKey(coinType, schedule);
        const modelPath = `${this.config.modelDir}/${modelKey}.json`;

        if (!existsSync(modelPath)) {
            console.warn(`[PredictionService] Model not found: ${modelPath}`);
            return false;
        }

        try {
            const model = new MarketPredictor(coinType, schedule);
            model.load(modelPath);

            const featureEngineer = new FeatureEngineering();
            const normParams = model.getWeights(); // This has feature names
            // Note: normParams should be loaded from model file

            this.models.set(modelKey, model);
            this.featureEngineers.set(modelKey, featureEngineer);

            console.log(`[PredictionService] Loaded model for ${coinType.toUpperCase()} ${schedule}`);
            return true;
        } catch (error) {
            console.error(`[PredictionService] Failed to load model: ${error}`);
            return false;
        }
    }

    /**
     * Makes a prediction for the current market period.
     */
    public async predict(
        coinType: CoinType,
        schedule: MarketSchedule,
        marketData: {
            pmarketSnapshots: UpDownPriceEntry[];
            minutePrices: MinuteDataEntry[];
            timestamp: number;
        }
    ): Promise<PredictionResult | null> {
        const modelKey = this.getModelKey(coinType, schedule);

        // Check if model is loaded
        if (!this.models.has(modelKey)) {
            const loaded = this.loadModel(coinType, schedule);
            if (!loaded) return null;
        }

        const model = this.models.get(modelKey)!;
        const featureEngineer = this.featureEngineers.get(modelKey)!;

        // Check cache
        const cacheKey = `${modelKey}-${this.getPeriodKey(marketData.timestamp, schedule)}`;
        const cached = this.predictionCache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < this.CACHE_TTL_MS) {
            return cached;
        }

        // Construct aligned period data
        const periodData: AlignedPeriodData = {
            timestamp: marketData.timestamp,
            periodKey: this.getPeriodKey(marketData.timestamp, schedule),
            outcome: null, // Unknown for real-time prediction
            pmarketSnapshots: marketData.pmarketSnapshots,
            minutePrices: marketData.minutePrices,
            hourlyData: null,
        };

        // Extract features
        const rawFeatures = featureEngineer.extractFeatures(periodData);
        const samples = featureEngineer.prepareSamples([periodData], true);

        if (samples.length === 0) {
            console.warn('[PredictionService] Failed to prepare features');
            return null;
        }

        // Make prediction
        const prediction = model.predict(samples[0].features);

        const result: PredictionResult = {
            ...prediction,
            coinType,
            schedule,
            periodKey: periodData.periodKey,
            features: rawFeatures as unknown as Record<string, number>,
        };

        // Cache result
        this.predictionCache.set(cacheKey, result);

        // Log prediction
        if (this.config.logPredictions) {
            console.log(
                `[Prediction] ${coinType.toUpperCase()} ${schedule}: ` +
                `${result.prediction} (${(result.probability * 100).toFixed(1)}% prob, ` +
                `${(result.confidence * 100).toFixed(1)}% confidence)`
            );
        }

        return result;
    }

    /**
     * Gets a trading signal based on prediction and confidence threshold.
     */
    public getTradingSignal(prediction: PredictionResult): 'BUY_UP' | 'BUY_DOWN' | 'HOLD' {
        if (prediction.confidence < this.config.confidenceThreshold) {
            return 'HOLD';
        }

        return prediction.prediction === 'UP' ? 'BUY_UP' : 'BUY_DOWN';
    }

    /**
     * Checks if a model is loaded for the given coin/schedule.
     */
    public hasModel(coinType: CoinType, schedule: MarketSchedule): boolean {
        return this.models.has(this.getModelKey(coinType, schedule));
    }

    /**
     * Gets the loaded models.
     */
    public getLoadedModels(): string[] {
        return Array.from(this.models.keys());
    }

    /**
     * Clears the prediction cache.
     */
    public clearCache(): void {
        this.predictionCache.clear();
    }

    // -------------------------------------------------------------------------
    // Static Helpers
    // -------------------------------------------------------------------------

    /**
     * Maps TargetedMarket to CoinType and MarketSchedule.
     */
    public static parseTargetedMarket(market: TargetedMarket): { coinType: CoinType; schedule: MarketSchedule } {
        switch (market) {
            case TargetedMarket.BITCOIN_HOURLY:
                return { coinType: CoinType.BTC, schedule: MarketSchedule.HOURLY };
            case TargetedMarket.BITCOIN_QUARTERLY:
                return { coinType: CoinType.BTC, schedule: MarketSchedule.QUARTERLY };
            case TargetedMarket.ETHEREUM_HOURLY:
                return { coinType: CoinType.ETH, schedule: MarketSchedule.HOURLY };
            case TargetedMarket.ETHEREUM_QUARTERLY:
                return { coinType: CoinType.ETH, schedule: MarketSchedule.QUARTERLY };
            case TargetedMarket.SOLANA_HOURLY:
                return { coinType: CoinType.SOL, schedule: MarketSchedule.HOURLY };
            case TargetedMarket.SOLANA_QUARTERLY:
                return { coinType: CoinType.SOL, schedule: MarketSchedule.QUARTERLY };
            case TargetedMarket.XRP_HOURLY:
                return { coinType: CoinType.XRP, schedule: MarketSchedule.HOURLY };
            case TargetedMarket.XRP_QUARTERLY:
                return { coinType: CoinType.XRP, schedule: MarketSchedule.QUARTERLY };
            default:
                return { coinType: CoinType.BTC, schedule: MarketSchedule.HOURLY };
        }
    }

    // -------------------------------------------------------------------------
    // Private Helpers
    // -------------------------------------------------------------------------

    private getModelKey(coinType: CoinType, schedule: MarketSchedule): string {
        return `${coinType}-${schedule.toLowerCase()}`;
    }

    private getPeriodKey(timestamp: number, schedule: MarketSchedule): string {
        const date = new Date(timestamp);
        if (schedule === MarketSchedule.QUARTERLY) {
            const quarter = Math.floor(date.getMinutes() / 15);
            return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}-${date.getHours()}-${quarter}`;
        }
        return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}-${date.getHours()}`;
    }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let predictionServiceInstance: PredictionService | null = null;

/**
 * Gets the singleton PredictionService instance.
 */
export function getPredictionService(config?: Partial<PredictionServiceConfig>): PredictionService {
    if (!predictionServiceInstance) {
        predictionServiceInstance = new PredictionService(config);
    }
    return predictionServiceInstance;
}

/**
 * Resets the singleton instance (useful for testing).
 */
export function resetPredictionService(): void {
    predictionServiceInstance = null;
}
