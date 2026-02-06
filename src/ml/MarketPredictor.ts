import { writeFileSync, readFileSync, existsSync } from 'fs';
import {
    ModelWeights,
    TrainingConfig,
    TrainingHistory,
    Prediction,
    ModelMetrics,
    FeatureImportance,
    TrainingSample,
    NormalizationParams,
    SerializedModel,
    PredictionStyle,
} from './types.js';
import { CoinType } from '../simulation/GeneticOptimizer.js';
import { MarketSchedule } from '../types/interfaces.js';
import { FEATURE_NAMES } from './FeatureEngineering.js';

// ============================================================================
// Default Configuration
// ============================================================================

const DEFAULT_TRAINING_CONFIG: TrainingConfig = {
    learningRate: 0.01,
    epochs: 1000,
    batchSize: 32,
    l2Lambda: 0.001,
    earlyStopPatience: 50,
    validationSplit: 0.1,
    verbose: true,
};

// ============================================================================
// MarketPredictor Class (Logistic Regression)
// ============================================================================

export class MarketPredictor {
    private weights: number[] = [];
    private bias: number = 0;
    private featureNames: string[] = [];
    private normParams: NormalizationParams | null = null;
    private config: TrainingConfig;
    private history: TrainingHistory | null = null;

    private coinType: CoinType;
    private schedule: MarketSchedule;
    private predictionStyle: PredictionStyle | null = null;

    constructor(
        coinType: CoinType = CoinType.BTC,
        schedule: MarketSchedule = MarketSchedule.HOURLY,
        config: Partial<TrainingConfig> = {},
        predictionStyle?: PredictionStyle
    ) {
        this.coinType = coinType;
        this.schedule = schedule;
        this.config = { ...DEFAULT_TRAINING_CONFIG, ...config };
        this.featureNames = [...FEATURE_NAMES];
        this.predictionStyle = predictionStyle ?? null;
    }

    /**
     * Gets the prediction style used by this model.
     */
    public getPredictionStyle(): PredictionStyle | null {
        return this.predictionStyle;
    }

    /**
     * Sets the prediction style for this model.
     */
    public setPredictionStyle(style: PredictionStyle): void {
        this.predictionStyle = style;
    }

    // -------------------------------------------------------------------------
    // Training
    // -------------------------------------------------------------------------

    /**
     * Trains the logistic regression model on the provided samples.
     * Uses gradient descent with L2 regularization.
     */
    public train(
        trainSamples: TrainingSample[],
        valSamples?: TrainingSample[]
    ): TrainingHistory {
        console.log(`\n[MarketPredictor] Training on ${trainSamples.length} samples...`);

        // Initialize weights
        const numFeatures = trainSamples[0].features.length;
        this.initializeWeights(numFeatures);

        // Split validation from training if not provided
        let trainData = trainSamples;
        let valData = valSamples;

        if (!valData && this.config.validationSplit > 0) {
            const splitIdx = Math.floor(trainSamples.length * (1 - this.config.validationSplit));
            trainData = trainSamples.slice(0, splitIdx);
            valData = trainSamples.slice(splitIdx);
        }

        // Training history
        this.history = {
            epochs: [],
            trainLoss: [],
            trainAccuracy: [],
            valLoss: valData ? [] : undefined,
            valAccuracy: valData ? [] : undefined,
        };

        let bestValLoss = Infinity;
        let bestWeights = [...this.weights];
        let bestBias = this.bias;
        let patienceCounter = 0;

        // Training loop
        for (let epoch = 0; epoch < this.config.epochs; epoch++) {
            // Shuffle training data
            const shuffled = this.shuffleArray([...trainData]);

            // Mini-batch gradient descent
            const batchSize = this.config.batchSize || shuffled.length;
            let epochLoss = 0;

            for (let i = 0; i < shuffled.length; i += batchSize) {
                const batch = shuffled.slice(i, i + batchSize);
                const { loss } = this.updateWeights(batch);
                epochLoss += loss * batch.length;
            }

            epochLoss /= shuffled.length;

            // Calculate metrics
            const trainMetrics = this.evaluate(trainData);

            this.history.epochs.push(epoch);
            this.history.trainLoss.push(epochLoss);
            this.history.trainAccuracy.push(trainMetrics.accuracy);

            // Validation metrics
            let valLoss = epochLoss;
            if (valData && valData.length > 0) {
                const valMetrics = this.evaluate(valData);
                valLoss = this.calculateLoss(valData);
                this.history.valLoss!.push(valLoss);
                this.history.valAccuracy!.push(valMetrics.accuracy);
            }

            // Early stopping
            if (valLoss < bestValLoss) {
                bestValLoss = valLoss;
                bestWeights = [...this.weights];
                bestBias = this.bias;
                patienceCounter = 0;
            } else {
                patienceCounter++;
            }

            // Log progress
            if (this.config.verbose && (epoch % 100 === 0 || epoch === this.config.epochs - 1)) {
                const valMsg = valData ? ` | val_loss: ${valLoss.toFixed(4)}` : '';
                console.log(
                    `Epoch ${epoch}: loss=${epochLoss.toFixed(4)}, ` +
                    `acc=${(trainMetrics.accuracy * 100).toFixed(1)}%${valMsg}`
                );
            }

            // Check early stopping
            if (patienceCounter >= this.config.earlyStopPatience) {
                console.log(`[MarketPredictor] Early stopping at epoch ${epoch}`);
                break;
            }
        }

        // Restore best weights
        this.weights = bestWeights;
        this.bias = bestBias;

        console.log(`[MarketPredictor] Training complete. Final loss: ${bestValLoss.toFixed(4)}`);

        return this.history;
    }

    /**
     * Initializes weights with small random values (Xavier initialization).
     */
    private initializeWeights(numFeatures: number): void {
        const scale = Math.sqrt(2 / numFeatures);
        this.weights = Array(numFeatures).fill(0).map(() => (Math.random() - 0.5) * scale);
        this.bias = 0;
    }

    /**
     * Updates weights using gradient descent on a batch.
     */
    private updateWeights(batch: TrainingSample[]): { loss: number } {
        const lr = this.config.learningRate;
        const lambda = this.config.l2Lambda;
        const n = batch.length;

        // Initialize gradients
        const weightGradients = Array(this.weights.length).fill(0);
        let biasGradient = 0;
        let totalLoss = 0;

        // Compute gradients
        for (const sample of batch) {
            const prediction = this.sigmoid(this.linearCombination(sample.features));
            const error = prediction - sample.label;

            // Gradient for each weight
            for (let j = 0; j < this.weights.length; j++) {
                weightGradients[j] += error * sample.features[j];
            }
            biasGradient += error;

            // Binary cross-entropy loss
            const eps = 1e-15; // Numerical stability
            const clippedPred = Math.max(eps, Math.min(1 - eps, prediction));
            totalLoss += -(sample.label * Math.log(clippedPred) +
                (1 - sample.label) * Math.log(1 - clippedPred));
        }

        // Average gradients and add L2 regularization
        for (let j = 0; j < this.weights.length; j++) {
            weightGradients[j] = weightGradients[j] / n + lambda * this.weights[j];
            this.weights[j] -= lr * weightGradients[j];
        }
        this.bias -= lr * (biasGradient / n);

        // Add L2 regularization to loss
        const l2Loss = (lambda / 2) * this.weights.reduce((sum, w) => sum + w * w, 0);
        totalLoss = totalLoss / n + l2Loss;

        return { loss: totalLoss };
    }

    // -------------------------------------------------------------------------
    // Prediction
    // -------------------------------------------------------------------------

    /**
     * Predicts the probability of UP winning for a single feature vector.
     */
    public predict(features: number[]): Prediction {
        const linearOutput = this.linearCombination(features);
        const probability = this.sigmoid(linearOutput);

        const prediction = probability >= 0.5 ? 'UP' : 'DOWN';
        const confidence = Math.abs(probability - 0.5) * 2;

        return {
            probability,
            prediction,
            confidence,
            timestamp: Date.now(),
        };
    }

    /**
     * Predicts for multiple samples.
     */
    public predictBatch(samples: TrainingSample[]): Prediction[] {
        return samples.map(s => ({
            ...this.predict(s.features),
            timestamp: s.timestamp,
        }));
    }

    /**
     * Linear combination: w·x + b
     */
    private linearCombination(features: number[]): number {
        let sum = this.bias;
        for (let i = 0; i < this.weights.length; i++) {
            sum += this.weights[i] * (features[i] || 0);
        }
        return sum;
    }

    /**
     * Sigmoid activation: σ(z) = 1 / (1 + e^(-z))
     */
    private sigmoid(z: number): number {
        // Clip for numerical stability
        if (z > 500) return 1;
        if (z < -500) return 0;
        return 1 / (1 + Math.exp(-z));
    }

    // -------------------------------------------------------------------------
    // Evaluation
    // -------------------------------------------------------------------------

    /**
     * Evaluates model performance on a set of samples.
     */
    public evaluate(samples: TrainingSample[]): ModelMetrics {
        let tp = 0, tn = 0, fp = 0, fn = 0;

        for (const sample of samples) {
            const pred = this.predict(sample.features);
            const predicted = pred.prediction === 'UP' ? 1 : 0;
            const actual = sample.label;

            if (predicted === 1 && actual === 1) tp++;
            else if (predicted === 0 && actual === 0) tn++;
            else if (predicted === 1 && actual === 0) fp++;
            else fn++;
        }

        const accuracy = (tp + tn) / (tp + tn + fp + fn);
        const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
        const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
        const f1Score = precision + recall > 0
            ? 2 * (precision * recall) / (precision + recall)
            : 0;

        return {
            accuracy,
            precision,
            recall,
            f1Score,
            confusionMatrix: {
                truePositives: tp,
                trueNegatives: tn,
                falsePositives: fp,
                falseNegatives: fn,
            },
            sampleCount: samples.length,
        };
    }

    /**
     * Calculates cross-entropy loss on a set of samples.
     */
    private calculateLoss(samples: TrainingSample[]): number {
        let totalLoss = 0;
        const eps = 1e-15;

        for (const sample of samples) {
            const pred = this.sigmoid(this.linearCombination(sample.features));
            const clippedPred = Math.max(eps, Math.min(1 - eps, pred));
            totalLoss += -(sample.label * Math.log(clippedPred) +
                (1 - sample.label) * Math.log(1 - clippedPred));
        }

        // Add L2 regularization
        const l2Loss = (this.config.l2Lambda / 2) * this.weights.reduce((sum, w) => sum + w * w, 0);

        return totalLoss / samples.length + l2Loss;
    }

    /**
     * Gets feature importance based on absolute weight values.
     */
    public getFeatureImportance(): FeatureImportance[] {
        const importance = this.featureNames.map((name, i) => ({
            name,
            weight: this.weights[i] || 0,
            absWeight: Math.abs(this.weights[i] || 0),
            rank: 0,
        }));

        // Sort by absolute weight (descending)
        importance.sort((a, b) => b.absWeight - a.absWeight);

        // Assign ranks
        importance.forEach((f, i) => f.rank = i + 1);

        return importance;
    }

    // -------------------------------------------------------------------------
    // Model Persistence
    // -------------------------------------------------------------------------

    /**
     * Saves the model to a JSON file.
     */
    public save(filepath: string): void {
        const modelData: SerializedModel = {
            version: '1.0.0',
            createdAt: new Date().toISOString(),
            coinType: this.coinType,
            schedule: this.schedule,
            predictionStyle: this.predictionStyle ?? undefined,
            weights: {
                weights: this.weights,
                bias: this.bias,
                featureNames: this.featureNames,
            },
            normalizationParams: this.normParams!,
            trainingConfig: this.config,
            trainingMetrics: this.history
                ? this.evaluate([]) // Placeholder - should store actual metrics
                : { accuracy: 0, precision: 0, recall: 0, f1Score: 0, confusionMatrix: { truePositives: 0, trueNegatives: 0, falsePositives: 0, falseNegatives: 0 }, sampleCount: 0 },
            featureImportance: this.getFeatureImportance(),
        };

        writeFileSync(filepath, JSON.stringify(modelData, null, 2));
        console.log(`[MarketPredictor] Model saved to ${filepath}`);
    }

    /**
     * Loads a model from a JSON file.
     */
    public load(filepath: string): void {
        if (!existsSync(filepath)) {
            throw new Error(`Model file not found: ${filepath}`);
        }

        const content = readFileSync(filepath, 'utf-8');
        const modelData: SerializedModel = JSON.parse(content);

        this.weights = modelData.weights.weights;
        this.bias = modelData.weights.bias;
        this.featureNames = modelData.weights.featureNames;
        this.normParams = modelData.normalizationParams;
        this.config = modelData.trainingConfig;
        this.coinType = modelData.coinType;
        this.schedule = modelData.schedule;
        this.predictionStyle = modelData.predictionStyle ?? null;

        console.log(`[MarketPredictor] Model loaded from ${filepath}`);
        console.log(`  - Version: ${modelData.version}`);
        console.log(`  - Created: ${modelData.createdAt}`);
        console.log(`  - Features: ${this.featureNames.length}`);
        if (this.predictionStyle) {
            console.log(`  - Style: ${this.predictionStyle}`);
        }
    }

    /**
     * Gets the current model weights.
     */
    public getWeights(): ModelWeights {
        return {
            weights: [...this.weights],
            bias: this.bias,
            featureNames: [...this.featureNames],
        };
    }

    /**
     * Sets the normalization parameters (for feature preprocessing).
     */
    public setNormalizationParams(params: NormalizationParams): void {
        this.normParams = params;
    }

    /**
     * Gets the training history.
     */
    public getTrainingHistory(): TrainingHistory | null {
        return this.history;
    }

    // -------------------------------------------------------------------------
    // Utilities
    // -------------------------------------------------------------------------

    private shuffleArray<T>(array: T[]): T[] {
        for (let i = array.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [array[i], array[j]] = [array[j], array[i]];
        }
        return array;
    }
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Prints model evaluation summary.
 */
export function printModelSummary(
    model: MarketPredictor,
    trainMetrics: ModelMetrics,
    testMetrics: ModelMetrics
): void {
    console.log('\n========================================');
    console.log('           MODEL SUMMARY');
    console.log('========================================\n');

    console.log('TRAINING SET:');
    console.log(`  Accuracy:  ${(trainMetrics.accuracy * 100).toFixed(2)}%`);
    console.log(`  Precision: ${(trainMetrics.precision * 100).toFixed(2)}%`);
    console.log(`  Recall:    ${(trainMetrics.recall * 100).toFixed(2)}%`);
    console.log(`  F1 Score:  ${(trainMetrics.f1Score * 100).toFixed(2)}%`);
    console.log(`  Samples:   ${trainMetrics.sampleCount}`);

    console.log('\nTEST SET:');
    console.log(`  Accuracy:  ${(testMetrics.accuracy * 100).toFixed(2)}%`);
    console.log(`  Precision: ${(testMetrics.precision * 100).toFixed(2)}%`);
    console.log(`  Recall:    ${(testMetrics.recall * 100).toFixed(2)}%`);
    console.log(`  F1 Score:  ${(testMetrics.f1Score * 100).toFixed(2)}%`);
    console.log(`  Samples:   ${testMetrics.sampleCount}`);

    console.log('\nCONFUSION MATRIX (Test):');
    const cm = testMetrics.confusionMatrix;
    console.log(`              Predicted`);
    console.log(`              UP    DOWN`);
    console.log(`  Actual UP   ${cm.truePositives.toString().padStart(4)}  ${cm.falseNegatives.toString().padStart(4)}`);
    console.log(`  Actual DOWN ${cm.falsePositives.toString().padStart(4)}  ${cm.trueNegatives.toString().padStart(4)}`);

    console.log('\nTOP 10 FEATURES:');
    const importance = model.getFeatureImportance().slice(0, 10);
    for (const f of importance) {
        const sign = f.weight >= 0 ? '+' : '';
        console.log(`  ${f.rank.toString().padStart(2)}. ${f.name.padEnd(20)} ${sign}${f.weight.toFixed(4)}`);
    }

    console.log('\n========================================\n');
}
