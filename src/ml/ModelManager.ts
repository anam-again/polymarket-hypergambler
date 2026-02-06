import { existsSync, readFileSync, mkdirSync } from 'fs';
import { CoinType } from '../simulation/GeneticOptimizer.js';
import { MarketSchedule } from '../types/interfaces.js';
import { PredictionStyle, SerializedModel } from './types.js';
import { MarketPredictor } from './MarketPredictor.js';
import { DataPreparation, splitByTime } from './DataPreparation.js';
import { FeatureEngineering } from './FeatureEngineering.js';

// ============================================================================
// Types
// ============================================================================

interface CachedModel {
    predictor: MarketPredictor;
    createdAt: number;
}

// ============================================================================
// ModelManager Class
// ============================================================================

/**
 * Manages ML model lifecycle including loading, training, caching, and expiry.
 * Handles model freshness checks and automatic retraining when models are stale.
 */
export class ModelManager {
    private models: Map<string, CachedModel> = new Map();
    private modelDir: string;

    constructor(modelDir: string = './models') {
        this.modelDir = modelDir;

        // Ensure model directory exists
        if (!existsSync(this.modelDir)) {
            mkdirSync(this.modelDir, { recursive: true });
        }
    }

    // -------------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------------

    /**
     * Generates a model key for the given parameters.
     * Format: yolo-{coin}-{schedule}-{style}
     */
    public static getModelKey(
        coinType: CoinType,
        schedule: MarketSchedule,
        style: PredictionStyle
    ): string {
        const scheduleStr = schedule === MarketSchedule.QUARTERLY ? 'quarterly' : 'hourly';
        return `yolo-${coinType}-${scheduleStr}-${style}`;
    }

    /**
     * Gets the file path for a model.
     */
    public getModelPath(
        coinType: CoinType,
        schedule: MarketSchedule,
        style: PredictionStyle
    ): string {
        const key = ModelManager.getModelKey(coinType, schedule, style);
        return `${this.modelDir}/${key}.json`;
    }

    /**
     * Checks if a model exists and is fresh (less than maxAgeHours old).
     */
    public isModelFresh(
        coinType: CoinType,
        schedule: MarketSchedule,
        style: PredictionStyle,
        maxAgeHours: number = 3
    ): boolean {
        const modelPath = this.getModelPath(coinType, schedule, style);

        if (!existsSync(modelPath)) {
            return false;
        }

        try {
            const content = readFileSync(modelPath, 'utf-8');
            const modelData: SerializedModel = JSON.parse(content);

            const createdAt = new Date(modelData.createdAt).getTime();
            const ageMs = Date.now() - createdAt;
            const ageHours = ageMs / (1000 * 60 * 60);

            return ageHours < maxAgeHours;
        } catch {
            return false;
        }
    }

    /**
     * Gets the creation timestamp of a saved model.
     */
    public getModelCreatedAt(
        coinType: CoinType,
        schedule: MarketSchedule,
        style: PredictionStyle
    ): number | null {
        const modelPath = this.getModelPath(coinType, schedule, style);

        if (!existsSync(modelPath)) {
            return null;
        }

        try {
            const content = readFileSync(modelPath, 'utf-8');
            const modelData: SerializedModel = JSON.parse(content);
            return new Date(modelData.createdAt).getTime();
        } catch {
            return null;
        }
    }

    /**
     * Gets or trains a model. Loads from disk if fresh, otherwise trains new.
     * Caches models in memory for subsequent calls.
     */
    public async getOrTrainModel(
        coinType: CoinType,
        schedule: MarketSchedule,
        style: PredictionStyle,
        maxAgeHours: number = 3
    ): Promise<MarketPredictor> {
        const key = ModelManager.getModelKey(coinType, schedule, style);

        // Check in-memory cache first
        const cached = this.models.get(key);
        if (cached) {
            const ageMs = Date.now() - cached.createdAt;
            const ageHours = ageMs / (1000 * 60 * 60);

            if (ageHours < maxAgeHours) {
                console.log(`[ModelManager] Using cached model: ${key}`);
                return cached.predictor;
            }
        }

        // Check if saved model is fresh
        if (this.isModelFresh(coinType, schedule, style, maxAgeHours)) {
            console.log(`[ModelManager] Loading fresh model from disk: ${key}`);
            return this.loadModel(coinType, schedule, style);
        }

        // Train new model
        console.log(`[ModelManager] Training new model: ${key}`);
        return this.trainAndSaveModel(coinType, schedule, style);
    }

    /**
     * Loads a model from disk and caches it.
     */
    public loadModel(
        coinType: CoinType,
        schedule: MarketSchedule,
        style: PredictionStyle
    ): MarketPredictor {
        const modelPath = this.getModelPath(coinType, schedule, style);
        const key = ModelManager.getModelKey(coinType, schedule, style);

        const predictor = new MarketPredictor(coinType, schedule, {}, style);
        predictor.load(modelPath);

        // Get creation time from the loaded model file
        const createdAt = this.getModelCreatedAt(coinType, schedule, style) ?? Date.now();

        // Cache in memory
        this.models.set(key, {
            predictor,
            createdAt,
        });

        return predictor;
    }

    /**
     * Clears a specific model from the cache.
     */
    public clearCache(
        coinType: CoinType,
        schedule: MarketSchedule,
        style: PredictionStyle
    ): void {
        const key = ModelManager.getModelKey(coinType, schedule, style);
        this.models.delete(key);
    }

    /**
     * Clears all models from the cache.
     */
    public clearAllCache(): void {
        this.models.clear();
    }

    /**
     * Gets the number of cached models.
     */
    public getCacheSize(): number {
        return this.models.size;
    }

    // -------------------------------------------------------------------------
    // Private Methods
    // -------------------------------------------------------------------------

    /**
     * Trains a new model and saves it to disk.
     */
    private async trainAndSaveModel(
        coinType: CoinType,
        schedule: MarketSchedule,
        style: PredictionStyle
    ): Promise<MarketPredictor> {
        const key = ModelManager.getModelKey(coinType, schedule, style);
        const modelPath = this.getModelPath(coinType, schedule, style);

        console.log(`[ModelManager] Preparing data for ${key}...`);

        // Prepare training data
        const dataPrep = new DataPreparation(coinType, schedule);
        const dataset = dataPrep.prepare();

        if (dataset.periods.length < 100) {
            throw new Error(
                `[ModelManager] Insufficient data for training: ${dataset.periods.length} periods (need at least 100)`
            );
        }

        // Create feature engineer with the prediction style
        const featureEngineer = new FeatureEngineering(style, dataPrep);

        // Prepare samples with features
        const samples = featureEngineer.prepareSamples(dataset.periods, true);

        if (samples.length < 100) {
            throw new Error(
                `[ModelManager] Insufficient samples after feature extraction: ${samples.length} (need at least 100)`
            );
        }

        // Split data by time
        const { train, test } = splitByTime(samples, 0.8);

        console.log(`[ModelManager] Training on ${train.length} samples, testing on ${test.length}...`);

        // Create and train model
        const predictor = new MarketPredictor(coinType, schedule, {
            learningRate: 0.01,
            epochs: 500,
            batchSize: 32,
            l2Lambda: 0.001,
            earlyStopPatience: 30,
            validationSplit: 0.1,
            verbose: true,
        }, style);

        // Set normalization params from feature engineer
        const normParams = featureEngineer.getNormalizationParams();
        if (normParams) {
            predictor.setNormalizationParams(normParams);
        }

        // Train
        predictor.train(train, test);

        // Evaluate on test set
        const testMetrics = predictor.evaluate(test);
        console.log(`[ModelManager] Test accuracy: ${(testMetrics.accuracy * 100).toFixed(2)}%`);

        // Save to disk
        predictor.save(modelPath);

        // Cache in memory
        this.models.set(key, {
            predictor,
            createdAt: Date.now(),
        });

        return predictor;
    }
}
