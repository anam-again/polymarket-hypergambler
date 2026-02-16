import { FairValueModel, PredictionWithUncertainty } from './FairValueModel.js';
import { MarketRegime } from './MarketRegimeDetector.js';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

/**
 * Multi-horizon prediction results.
 */
export interface MultiHorizonPrediction {
    // Predicted prices at each horizon
    price5s: { up: number; down: number };
    price15s: { up: number; down: number };
    price30s: { up: number; down: number };
    price60s: { up: number; down: number };

    // Confidence estimates
    confidence5s: number;
    confidence15s: number;
    confidence30s: number;
    confidence60s: number;

    // Expected convergence time in milliseconds
    convergenceTimeMs: number;

    // Best horizon for trading (highest confidence)
    recommendedHorizon: number;
}

/**
 * Training sample for horizon model.
 */
interface HorizonSample {
    features: Record<string, number>;
    actualUpPrice: number;
    actualDownPrice: number;
    horizonMs: number;
    timestamp: number;
}

/**
 * Multi-Horizon Predictor
 *
 * Maintains separate FairValueModels for different time horizons.
 * Useful for determining optimal trade exit timing.
 *
 * Horizons:
 * - 5s: Very short-term, high-frequency adjustments
 * - 15s: Short-term, quick mean reversion
 * - 30s: Medium-term, default convergence
 * - 60s: Longer-term, larger price moves
 */
export class MultiHorizonPredictor {
    private models: Map<number, FairValueModel> = new Map();
    private horizons: number[];
    private savePath: string;

    // Pending samples waiting for their horizon to elapse
    private pendingSamples: Map<number, HorizonSample[]> = new Map();

    // Track which horizons have enough training
    private trainingSamplesByHorizon: Map<number, number> = new Map();
    private readonly minSamplesForPrediction = 50;

    constructor(
        horizons: number[] = [5, 15, 30, 60],
        learningRate: number = 0.01,
        savePath: string = './models/multihorizon'
    ) {
        this.horizons = horizons;
        this.savePath = savePath;

        // Ensure directory exists
        if (!existsSync(savePath)) {
            mkdirSync(savePath, { recursive: true });
        }

        // Create a model for each horizon
        for (const horizon of horizons) {
            const model = new FairValueModel(
                learningRate,
                `${savePath}/horizon_${horizon}s.json`
            );
            model.loadIfExists();
            this.models.set(horizon, model);
            this.pendingSamples.set(horizon, []);
            this.trainingSamplesByHorizon.set(horizon, model.getTrainingSamples());
        }
    }

    /**
     * Predicts prices at all horizons.
     */
    predict(features: Record<string, number>, regime?: MarketRegime): MultiHorizonPrediction {
        const predictions: Map<number, PredictionWithUncertainty> = new Map();

        for (const horizon of this.horizons) {
            const model = this.models.get(horizon)!;
            const pred = model.predictWithUncertainty(features, regime);
            predictions.set(horizon, pred);
        }

        const pred5s = predictions.get(5)!;
        const pred15s = predictions.get(15)!;
        const pred30s = predictions.get(30)!;
        const pred60s = predictions.get(60)!;

        // Estimate convergence time based on predictions
        // Find horizon where price change is largest
        const price5sChange = Math.abs(pred5s.upPrice - 0.5) + Math.abs(pred5s.downPrice - 0.5);
        const price15sChange = Math.abs(pred15s.upPrice - 0.5) + Math.abs(pred15s.downPrice - 0.5);
        const price30sChange = Math.abs(pred30s.upPrice - 0.5) + Math.abs(pred30s.downPrice - 0.5);
        const price60sChange = Math.abs(pred60s.upPrice - 0.5) + Math.abs(pred60s.downPrice - 0.5);

        // Estimate convergence as horizon with max expected change
        const changes = [
            { horizon: 5, change: price5sChange },
            { horizon: 15, change: price15sChange },
            { horizon: 30, change: price30sChange },
            { horizon: 60, change: price60sChange },
        ];
        const maxChange = changes.reduce((a, b) => a.change > b.change ? a : b);
        const convergenceTimeMs = maxChange.horizon * 1000;

        // Find recommended horizon (highest confidence with meaningful change)
        const horizonsWithConfidence = [
            { horizon: 5, confidence: pred5s.upConfidence, change: price5sChange },
            { horizon: 15, confidence: pred15s.upConfidence, change: price15sChange },
            { horizon: 30, confidence: pred30s.upConfidence, change: price30sChange },
            { horizon: 60, confidence: pred60s.upConfidence, change: price60sChange },
        ];

        // Score = confidence * change (want both high confidence and meaningful price movement)
        const scored = horizonsWithConfidence.map(h => ({
            ...h,
            score: h.confidence * Math.min(1, h.change * 5),  // Scale change to 0-1 range
        }));
        const recommended = scored.reduce((a, b) => a.score > b.score ? a : b);

        return {
            price5s: { up: pred5s.upPrice, down: pred5s.downPrice },
            price15s: { up: pred15s.upPrice, down: pred15s.downPrice },
            price30s: { up: pred30s.upPrice, down: pred30s.downPrice },
            price60s: { up: pred60s.upPrice, down: pred60s.downPrice },
            confidence5s: pred5s.upConfidence,
            confidence15s: pred15s.upConfidence,
            confidence30s: pred30s.upConfidence,
            confidence60s: pred60s.upConfidence,
            convergenceTimeMs,
            recommendedHorizon: recommended.horizon,
        };
    }

    /**
     * Predicts for a specific horizon only.
     */
    predictHorizon(
        features: Record<string, number>,
        horizonSeconds: number,
        regime?: MarketRegime
    ): PredictionWithUncertainty | null {
        const model = this.models.get(horizonSeconds);
        if (!model) return null;

        return model.predictWithUncertainty(features, regime);
    }

    /**
     * Queues a training sample to be processed when the horizon elapses.
     */
    queueTrainingSample(features: Record<string, number>): void {
        const now = Date.now();

        for (const horizon of this.horizons) {
            const pending = this.pendingSamples.get(horizon)!;
            pending.push({
                features: { ...features },
                actualUpPrice: 0,  // Will be filled when horizon elapses
                actualDownPrice: 0,
                horizonMs: horizon * 1000,
                timestamp: now,
            });

            // Limit pending samples per horizon
            while (pending.length > 100) {
                pending.shift();
            }
        }
    }

    /**
     * Processes pending samples that have reached their horizon.
     * @param currentUpPrice Current UP token price
     * @param currentDownPrice Current DOWN token price
     * @param regime Optional market regime
     */
    processPendingSamples(
        currentUpPrice: number,
        currentDownPrice: number,
        regime?: MarketRegime
    ): void {
        const now = Date.now();

        for (const horizon of this.horizons) {
            const pending = this.pendingSamples.get(horizon)!;
            const model = this.models.get(horizon)!;

            const ready: HorizonSample[] = [];
            const stillPending: HorizonSample[] = [];

            for (const sample of pending) {
                if (now - sample.timestamp >= sample.horizonMs) {
                    // Horizon elapsed - train with current prices
                    sample.actualUpPrice = currentUpPrice;
                    sample.actualDownPrice = currentDownPrice;
                    ready.push(sample);
                } else {
                    stillPending.push(sample);
                }
            }

            // Train on ready samples
            for (const sample of ready) {
                model.train(
                    sample.features,
                    sample.actualUpPrice,
                    sample.actualDownPrice,
                    regime
                );
            }

            // Update counts
            const count = this.trainingSamplesByHorizon.get(horizon) ?? 0;
            this.trainingSamplesByHorizon.set(horizon, count + ready.length);

            // Update pending
            this.pendingSamples.set(horizon, stillPending);
        }
    }

    /**
     * Directly trains a specific horizon model.
     */
    trainHorizon(
        horizonSeconds: number,
        features: Record<string, number>,
        actualUpPrice: number,
        actualDownPrice: number,
        regime?: MarketRegime
    ): void {
        const model = this.models.get(horizonSeconds);
        if (!model) return;

        model.train(features, actualUpPrice, actualDownPrice, regime);

        const count = this.trainingSamplesByHorizon.get(horizonSeconds) ?? 0;
        this.trainingSamplesByHorizon.set(horizonSeconds, count + 1);
    }

    /**
     * Returns whether a horizon has enough training to be reliable.
     */
    isHorizonReliable(horizonSeconds: number): boolean {
        const count = this.trainingSamplesByHorizon.get(horizonSeconds) ?? 0;
        return count >= this.minSamplesForPrediction;
    }

    /**
     * Returns training sample counts by horizon.
     */
    getTrainingSamplesByHorizon(): Map<number, number> {
        return new Map(this.trainingSamplesByHorizon);
    }

    /**
     * Returns the model for a specific horizon.
     */
    getModel(horizonSeconds: number): FairValueModel | undefined {
        return this.models.get(horizonSeconds);
    }

    /**
     * Saves all horizon models.
     */
    save(): void {
        for (const model of this.models.values()) {
            model.save();
        }

        // Save metadata
        try {
            const metadata = {
                horizons: this.horizons,
                trainingSamplesByHorizon: Object.fromEntries(this.trainingSamplesByHorizon),
                savedAt: new Date().toISOString(),
            };
            writeFileSync(`${this.savePath}/metadata.json`, JSON.stringify(metadata, null, 2));
        } catch (e) {
            console.error(`[MultiHorizonPredictor] Failed to save metadata: ${e}`);
        }
    }

    /**
     * Loads metadata and all horizon models.
     */
    loadIfExists(): boolean {
        const metadataPath = `${this.savePath}/metadata.json`;
        if (!existsSync(metadataPath)) return false;

        try {
            const content = readFileSync(metadataPath, 'utf-8');
            const metadata = JSON.parse(content);

            if (metadata.trainingSamplesByHorizon) {
                for (const [horizon, count] of Object.entries(metadata.trainingSamplesByHorizon)) {
                    this.trainingSamplesByHorizon.set(parseInt(horizon), count as number);
                }
            }

            // Models load themselves in constructor
            console.log(`[MultiHorizonPredictor] Loaded metadata from ${metadataPath}`);
            return true;
        } catch (e) {
            console.warn(`[MultiHorizonPredictor] Failed to load metadata: ${e}`);
            return false;
        }
    }

    /**
     * Resets all models.
     */
    reset(): void {
        for (const model of this.models.values()) {
            model.reset();
        }
        for (const horizon of this.horizons) {
            this.trainingSamplesByHorizon.set(horizon, 0);
            this.pendingSamples.set(horizon, []);
        }
    }

    /**
     * Returns all horizons.
     */
    getHorizons(): number[] {
        return [...this.horizons];
    }

    /**
     * Returns performance metrics for all horizons.
     */
    getAllPerformanceMetrics(): Map<number, ReturnType<FairValueModel['getPerformanceMetrics']>> {
        const metrics = new Map<number, ReturnType<FairValueModel['getPerformanceMetrics']>>();
        for (const horizon of this.horizons) {
            const model = this.models.get(horizon)!;
            metrics.set(horizon, model.getPerformanceMetrics());
        }
        return metrics;
    }
}
