// ============================================================================
// DecisionModelTrainer - Training Pipeline for Decision Networks
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import {
    DecisionNetwork,
    DecisionNetworkConfig,
    DecisionTrainingConfig,
    LabeledSample,
    SerializedDecisionNetwork,
} from './DecisionNetwork.js';
import { DecisionDataCollector, DecisionDataStats } from './DecisionDataCollector.js';

/**
 * Configuration for the training pipeline.
 */
export interface TrainingPipelineConfig {
    /** Directory containing training data */
    dataDirectory: string;
    /** Directory to save trained models */
    modelDirectory: string;
    /** Minimum number of samples required to train */
    minSamples: number;
    /** Train/validation/test split ratios */
    splitRatios: { train: number; validation: number; test: number };
    /** Whether to apply outcome-based weighting */
    useOutcomeWeighting: boolean;
    /** Whether to filter out incomplete trades */
    filterIncomplete: boolean;
}

/**
 * Training results with metrics.
 */
export interface TrainingResults {
    /** Model identifier */
    modelId: string;
    /** Path to saved model */
    modelPath: string;
    /** Training configuration used */
    trainingConfig: DecisionTrainingConfig;
    /** Number of samples used for training */
    trainingSamples: number;
    /** Number of samples used for validation */
    validationSamples: number;
    /** Number of samples used for testing */
    testSamples: number;
    /** Test set metrics */
    testMetrics: {
        mse: number;
        mae: number;
        r2: number;
        avgPnL: number;
    };
    /** Training duration in milliseconds */
    trainingDurationMs: number;
    /** Timestamp */
    timestamp: string;
}

/**
 * DecisionModelTrainer - Trains and evaluates decision networks.
 *
 * This class handles:
 * 1. Loading training data from files
 * 2. Preprocessing and splitting data
 * 3. Training the network
 * 4. Evaluating on test set
 * 5. Saving trained models
 */
export class DecisionModelTrainer {
    private config: TrainingPipelineConfig;
    private collector: DecisionDataCollector;

    constructor(config: Partial<TrainingPipelineConfig> = {}) {
        this.config = {
            dataDirectory: config.dataDirectory ?? './data/decision-samples',
            modelDirectory: config.modelDirectory ?? './models/decision-networks',
            minSamples: config.minSamples ?? 100,
            splitRatios: config.splitRatios ?? { train: 0.7, validation: 0.15, test: 0.15 },
            useOutcomeWeighting: config.useOutcomeWeighting ?? true,
            filterIncomplete: config.filterIncomplete ?? false,
        };
        this.collector = new DecisionDataCollector(this.config.dataDirectory);
    }

    /**
     * Loads training data from the data directory.
     */
    loadData(): DecisionDataStats {
        const count = this.collector.loadAllFromDirectory();
        console.log(`[DecisionModelTrainer] Loaded ${count} samples`);
        return this.collector.getStats();
    }

    /**
     * Gets all loaded samples.
     */
    getSamples(): LabeledSample[] {
        return this.collector.getSamples();
    }

    /**
     * Trains a decision network with the given configuration.
     */
    async train(
        networkConfig: DecisionNetworkConfig,
        trainingConfig: DecisionTrainingConfig
    ): Promise<TrainingResults> {
        const startTime = Date.now();

        // Get and preprocess samples
        let samples = this.collector.getSamples();

        if (samples.length < this.config.minSamples) {
            throw new Error(
                `Insufficient samples: ${samples.length} < ${this.config.minSamples} required`
            );
        }

        // Filter incomplete trades if configured
        if (this.config.filterIncomplete) {
            samples = samples.filter((s: LabeledSample) => s.outcome.tradeCompleted);
        }

        // Apply outcome weighting if configured
        if (this.config.useOutcomeWeighting) {
            this.collector.applyOutcomeWeighting();
            samples = this.collector.getSamples();
        }

        // Shuffle samples
        samples = [...samples].sort(() => Math.random() - 0.5);

        // Split into train/validation/test
        const trainEnd = Math.floor(samples.length * this.config.splitRatios.train);
        const valEnd = trainEnd + Math.floor(samples.length * this.config.splitRatios.validation);

        const trainSamples = samples.slice(0, trainEnd);
        const valSamples = samples.slice(trainEnd, valEnd);
        const testSamples = samples.slice(valEnd);

        console.log(`[DecisionModelTrainer] Split: ${trainSamples.length} train, ${valSamples.length} val, ${testSamples.length} test`);

        // Combine train and validation for training (validation used for early stopping)
        const trainWithVal = [...trainSamples, ...valSamples];

        // Create and train network
        const network = new DecisionNetwork(networkConfig);
        network.train(trainWithVal, trainingConfig);

        // Evaluate on test set
        const testMetrics = this.evaluate(network, testSamples);

        // Generate model ID and save
        const modelId = `decision-${Date.now()}`;
        const modelPath = this.saveModel(network, modelId);

        const trainingDurationMs = Date.now() - startTime;

        const results: TrainingResults = {
            modelId,
            modelPath,
            trainingConfig,
            trainingSamples: trainSamples.length,
            validationSamples: valSamples.length,
            testSamples: testSamples.length,
            testMetrics,
            trainingDurationMs,
            timestamp: new Date().toISOString(),
        };

        // Save training results
        this.saveResults(results);

        console.log(`[DecisionModelTrainer] Training complete in ${trainingDurationMs}ms`);
        console.log(`[DecisionModelTrainer] Test MSE: ${testMetrics.mse.toFixed(4)}, Avg PnL: ${testMetrics.avgPnL.toFixed(4)}`);

        return results;
    }

    /**
     * Evaluates a network on a set of samples.
     */
    private evaluate(network: DecisionNetwork, samples: LabeledSample[]): {
        mse: number;
        mae: number;
        r2: number;
        avgPnL: number;
    } {
        if (samples.length === 0) {
            return { mse: 0, mae: 0, r2: 0, avgPnL: 0 };
        }

        let mseSum = 0;
        let maeSum = 0;
        let pnlSum = 0;
        let meanPnL = 0;
        let ssTotal = 0;
        let ssResidual = 0;

        // Calculate mean PnL for R² calculation
        for (const sample of samples) {
            meanPnL += sample.outcome.pnl / samples.length;
        }

        for (const sample of samples) {
            const predictions = network.predict(sample.features);

            // Compare each output
            for (const [key, predicted] of Object.entries(predictions)) {
                const actual = sample.decisions[key] ?? 0;
                const predictedNum = predicted as number;
                const error = predictedNum - actual;
                mseSum += error * error;
                maeSum += Math.abs(error);
            }

            // Track PnL
            pnlSum += sample.outcome.pnl;

            // For R² on PnL (treat PnL as target)
            const pnlDeviation = sample.outcome.pnl - meanPnL;
            ssTotal += pnlDeviation * pnlDeviation;
            // Approximate residual based on prediction quality
            ssResidual += pnlDeviation * pnlDeviation * 0.5; // Placeholder
        }

        const numOutputs = Object.keys(samples[0].decisions).length;
        const n = samples.length * numOutputs;

        return {
            mse: mseSum / n,
            mae: maeSum / n,
            r2: ssTotal > 0 ? 1 - ssResidual / ssTotal : 0,
            avgPnL: pnlSum / samples.length,
        };
    }

    /**
     * Saves a trained model to disk.
     */
    private saveModel(network: DecisionNetwork, modelId: string): string {
        if (!fs.existsSync(this.config.modelDirectory)) {
            fs.mkdirSync(this.config.modelDirectory, { recursive: true });
        }

        const filepath = path.join(this.config.modelDirectory, `${modelId}.json`);
        const serialized = network.save();
        fs.writeFileSync(filepath, JSON.stringify(serialized, null, 2));

        console.log(`[DecisionModelTrainer] Model saved to ${filepath}`);
        return filepath;
    }

    /**
     * Saves training results to disk.
     */
    private saveResults(results: TrainingResults): void {
        const filepath = path.join(this.config.modelDirectory, `${results.modelId}-results.json`);
        fs.writeFileSync(filepath, JSON.stringify(results, null, 2));
    }

    /**
     * Loads a trained model from disk.
     */
    loadModel(modelPath: string): DecisionNetwork {
        const content = fs.readFileSync(modelPath, 'utf-8');
        const serialized = JSON.parse(content) as SerializedDecisionNetwork;
        return DecisionNetwork.load(serialized);
    }

    /**
     * Lists all available models in the model directory.
     */
    listModels(): string[] {
        if (!fs.existsSync(this.config.modelDirectory)) {
            return [];
        }

        return fs.readdirSync(this.config.modelDirectory)
            .filter((f) => f.endsWith('.json') && !f.includes('-results'))
            .map((f) => path.join(this.config.modelDirectory, f));
    }

    /**
     * Gets the latest trained model.
     */
    getLatestModel(): DecisionNetwork | null {
        const models = this.listModels();
        if (models.length === 0) {
            return null;
        }

        // Sort by filename (which contains timestamp)
        models.sort().reverse();
        return this.loadModel(models[0]);
    }

    /**
     * Cross-validates a network configuration.
     */
    async crossValidate(
        networkConfig: DecisionNetworkConfig,
        trainingConfig: DecisionTrainingConfig,
        folds: number = 5
    ): Promise<{
        avgMse: number;
        avgMae: number;
        avgPnL: number;
        foldResults: Array<{ mse: number; mae: number; avgPnL: number }>;
    }> {
        const samples = [...this.collector.getSamples()].sort(() => Math.random() - 0.5);
        const foldSize = Math.floor(samples.length / folds);
        const foldResults: Array<{ mse: number; mae: number; r2: number; avgPnL: number }> = [];

        for (let fold = 0; fold < folds; fold++) {
            const testStart = fold * foldSize;
            const testEnd = (fold + 1) * foldSize;

            const testSamples = samples.slice(testStart, testEnd);
            const trainSamples = [...samples.slice(0, testStart), ...samples.slice(testEnd)];

            const network = new DecisionNetwork(networkConfig);
            network.train(trainSamples, trainingConfig);

            const metrics = this.evaluate(network, testSamples);
            foldResults.push(metrics);
        }

        const avgMse = foldResults.reduce((sum, r) => sum + r.mse, 0) / folds;
        const avgMae = foldResults.reduce((sum, r) => sum + r.mae, 0) / folds;
        const avgPnL = foldResults.reduce((sum, r) => sum + r.avgPnL, 0) / folds;

        return {
            avgMse,
            avgMae,
            avgPnL,
            foldResults: foldResults.map((r) => ({ mse: r.mse, mae: r.mae, avgPnL: r.avgPnL })),
        };
    }
}

/**
 * Default network configuration for FirstCandle-style decisions.
 */
export const DEFAULT_FIRSTCANDLE_NETWORK_CONFIG: DecisionNetworkConfig = {
    inputFeatures: [
        'candleSize',
        'timeLeft',
        'volatility',
        'momentum',
        'priceImbalance',
        'hourOfDay',
        'dayOfWeek',
    ],
    hiddenLayers: [32, 16],
    outputs: [
        { name: 'targetBuyPrice', type: 'continuous', bounds: { min: 0.30, max: 0.70 } },
        { name: 'targetSellPrice', type: 'continuous', bounds: { min: 0.50, max: 0.90 } },
        { name: 'earlySellThreshold', type: 'continuous', bounds: { min: 0.1, max: 0.4 } },
    ],
    activation: 'relu',
    dropoutRate: 0.1,
};

/**
 * Default training configuration.
 */
export const DEFAULT_TRAINING_CONFIG: DecisionTrainingConfig = {
    epochs: 500,
    learningRate: 0.001,
    batchSize: 32,
    l2Lambda: 0.01,
    validationSplit: 0.2,
    lossFunction: 'weightedMSE',
    earlyStopPatience: 20,
    verbose: true,
};
