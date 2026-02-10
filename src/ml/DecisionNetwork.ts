// ============================================================================
// DecisionNetwork - Neural Network for Trading Parameter Decisions
// ============================================================================

/**
 * Configuration for a decision output.
 */
export interface DecisionOutputConfig {
    /** Name of the output parameter (e.g., 'targetBuyPrice') */
    name: string;
    /** Output type: continuous value or discrete choice */
    type: 'continuous' | 'discrete';
    /** Bounds for continuous outputs */
    bounds?: { min: number; max: number };
    /** Options for discrete outputs */
    options?: number[];
}

/**
 * Configuration for the decision network.
 */
export interface DecisionNetworkConfig {
    /** Names of input features */
    inputFeatures: string[];
    /** Hidden layer sizes (e.g., [32, 16]) */
    hiddenLayers: number[];
    /** Output configurations */
    outputs: DecisionOutputConfig[];
    /** Activation function */
    activation?: 'relu' | 'tanh' | 'sigmoid';
    /** Dropout rate for regularization */
    dropoutRate?: number;
}

/**
 * Training configuration for the network.
 */
export interface DecisionTrainingConfig {
    /** Number of training epochs */
    epochs: number;
    /** Learning rate */
    learningRate: number;
    /** Batch size (0 = full batch) */
    batchSize: number;
    /** L2 regularization strength */
    l2Lambda: number;
    /** Validation split ratio */
    validationSplit: number;
    /** Loss function */
    lossFunction: 'mse' | 'weightedMSE' | 'huber';
    /** Early stopping patience */
    earlyStopPatience: number;
    /** Print training progress */
    verbose: boolean;
}

/**
 * Feature vector for network input.
 */
export interface FeatureVector {
    [key: string]: number;
}

/**
 * Decision outputs from the network.
 */
export interface DecisionOutputs {
    [key: string]: number;
}

/**
 * Labeled sample for training.
 */
export interface LabeledSample {
    /** Input features at decision time */
    features: FeatureVector;
    /** Decisions made (parameters used) */
    decisions: DecisionOutputs;
    /** Outcome of the trade */
    outcome: {
        pnl: number;
        tradeCompleted: boolean;
        holdTimeMs: number;
    };
    /** Sample weight (higher for better outcomes) */
    weight?: number;
}

/**
 * DecisionNetwork - Neural network that outputs trading decision parameters.
 *
 * This is a simplified implementation using manual gradient descent.
 * For production use, consider integrating TensorFlow.js or ONNX.
 *
 * The network takes market features as input and outputs parameter values
 * for trading decisions (targetBuyPrice, targetSellPrice, etc.).
 */
export class DecisionNetwork {
    private config: DecisionNetworkConfig;
    private weights: number[][][] = [];
    private biases: number[][] = [];
    private featureStats?: { means: number[]; stds: number[] };

    constructor(config: DecisionNetworkConfig) {
        this.config = {
            ...config,
            activation: config.activation ?? 'relu',
            dropoutRate: config.dropoutRate ?? 0.1,
        };
        this.initializeWeights();
    }

    /**
     * Initializes network weights using Xavier initialization.
     */
    private initializeWeights(): void {
        const layerSizes = [
            this.config.inputFeatures.length,
            ...this.config.hiddenLayers,
            this.config.outputs.length,
        ];

        this.weights = [];
        this.biases = [];

        for (let i = 0; i < layerSizes.length - 1; i++) {
            const fanIn = layerSizes[i];
            const fanOut = layerSizes[i + 1];
            const scale = Math.sqrt(2.0 / (fanIn + fanOut));

            // Initialize weights with Xavier initialization
            const layerWeights: number[][] = [];
            for (let j = 0; j < fanOut; j++) {
                const neuronWeights: number[] = [];
                for (let k = 0; k < fanIn; k++) {
                    neuronWeights.push((Math.random() * 2 - 1) * scale);
                }
                layerWeights.push(neuronWeights);
            }
            this.weights.push(layerWeights);

            // Initialize biases to zero
            this.biases.push(new Array(fanOut).fill(0));
        }
    }

    /**
     * Activation function.
     */
    private activate(x: number): number {
        switch (this.config.activation) {
            case 'relu':
                return Math.max(0, x);
            case 'tanh':
                return Math.tanh(x);
            case 'sigmoid':
                return 1 / (1 + Math.exp(-x));
            default:
                return Math.max(0, x);
        }
    }

    /**
     * Derivative of activation function.
     */
    private activateDerivative(x: number): number {
        switch (this.config.activation) {
            case 'relu':
                return x > 0 ? 1 : 0;
            case 'tanh':
                const t = Math.tanh(x);
                return 1 - t * t;
            case 'sigmoid':
                const s = 1 / (1 + Math.exp(-x));
                return s * (1 - s);
            default:
                return x > 0 ? 1 : 0;
        }
    }

    /**
     * Forward pass through the network.
     */
    private forward(input: number[]): { activations: number[][]; preActivations: number[][] } {
        const activations: number[][] = [input];
        const preActivations: number[][] = [];

        let current = input;

        for (let layer = 0; layer < this.weights.length; layer++) {
            const layerWeights = this.weights[layer];
            const layerBiases = this.biases[layer];
            const isOutputLayer = layer === this.weights.length - 1;

            const next: number[] = [];
            const preAct: number[] = [];

            for (let j = 0; j < layerWeights.length; j++) {
                let sum = layerBiases[j];
                for (let k = 0; k < current.length; k++) {
                    sum += current[k] * layerWeights[j][k];
                }
                preAct.push(sum);

                // Apply activation (except for output layer, use sigmoid for bounded outputs)
                if (isOutputLayer) {
                    // Sigmoid for output layer to bound outputs
                    next.push(1 / (1 + Math.exp(-sum)));
                } else {
                    next.push(this.activate(sum));
                }
            }

            preActivations.push(preAct);
            activations.push(next);
            current = next;
        }

        return { activations, preActivations };
    }

    /**
     * Normalizes input features.
     */
    private normalizeInput(features: FeatureVector): number[] {
        const input: number[] = [];
        for (let i = 0; i < this.config.inputFeatures.length; i++) {
            const name = this.config.inputFeatures[i];
            let value = features[name] ?? 0;

            // Apply z-score normalization if stats are available
            if (this.featureStats) {
                value = (value - this.featureStats.means[i]) / (this.featureStats.stds[i] + 1e-8);
            }

            input.push(value);
        }
        return input;
    }

    /**
     * Converts network output to decision values.
     */
    private outputToDecisions(rawOutput: number[]): DecisionOutputs {
        const decisions: DecisionOutputs = {};

        for (let i = 0; i < this.config.outputs.length; i++) {
            const outputConfig = this.config.outputs[i];
            let value = rawOutput[i];

            if (outputConfig.type === 'continuous' && outputConfig.bounds) {
                // Scale sigmoid output to bounds
                value = outputConfig.bounds.min + value * (outputConfig.bounds.max - outputConfig.bounds.min);
            } else if (outputConfig.type === 'discrete' && outputConfig.options) {
                // Select option based on probability
                const optionIndex = Math.floor(value * outputConfig.options.length);
                value = outputConfig.options[Math.min(optionIndex, outputConfig.options.length - 1)];
            }

            decisions[outputConfig.name] = value;
        }

        return decisions;
    }

    /**
     * Predicts decision outputs for given features.
     */
    predict(features: FeatureVector): DecisionOutputs {
        const input = this.normalizeInput(features);
        const { activations } = this.forward(input);
        const output = activations[activations.length - 1];
        return this.outputToDecisions(output);
    }

    /**
     * Trains the network on labeled samples.
     */
    train(samples: LabeledSample[], config: DecisionTrainingConfig): void {
        // Compute feature normalization stats
        this.computeNormalizationStats(samples);

        // Weight samples by outcome
        const weightedSamples = samples.map((s) => ({
            ...s,
            weight: s.weight ?? (s.outcome.pnl > 0 ? 1 + s.outcome.pnl / 10 : 0.3),
        }));

        // Split into train/validation
        const splitIndex = Math.floor(samples.length * (1 - config.validationSplit));
        const trainSamples = weightedSamples.slice(0, splitIndex);
        const valSamples = weightedSamples.slice(splitIndex);

        let bestValLoss = Infinity;
        let patienceCounter = 0;

        for (let epoch = 0; epoch < config.epochs; epoch++) {
            // Shuffle training samples
            const shuffled = [...trainSamples].sort(() => Math.random() - 0.5);

            // Mini-batch training
            const batchSize = config.batchSize || shuffled.length;
            let epochLoss = 0;

            for (let i = 0; i < shuffled.length; i += batchSize) {
                const batch = shuffled.slice(i, i + batchSize);
                const batchLoss = this.trainBatch(batch, config.learningRate, config.l2Lambda);
                epochLoss += batchLoss * batch.length;
            }

            epochLoss /= shuffled.length;

            // Validation
            if (valSamples.length > 0) {
                const valLoss = this.computeLoss(valSamples);

                if (config.verbose && epoch % 10 === 0) {
                    console.log(
                        `Epoch ${epoch}: train_loss=${epochLoss.toFixed(4)}, val_loss=${valLoss.toFixed(4)}`
                    );
                }

                // Early stopping
                if (valLoss < bestValLoss) {
                    bestValLoss = valLoss;
                    patienceCounter = 0;
                } else {
                    patienceCounter++;
                    if (patienceCounter >= config.earlyStopPatience) {
                        if (config.verbose) {
                            console.log(`Early stopping at epoch ${epoch}`);
                        }
                        break;
                    }
                }
            }
        }
    }

    /**
     * Trains on a single batch and returns the loss.
     */
    private trainBatch(batch: LabeledSample[], lr: number, l2Lambda: number): number {
        // Accumulate gradients
        const weightGrads: number[][][] = this.weights.map((layer) =>
            layer.map((neuron) => neuron.map(() => 0))
        );
        const biasGrads: number[][] = this.biases.map((layer) => layer.map(() => 0));

        let totalLoss = 0;

        for (const sample of batch) {
            const input = this.normalizeInput(sample.features);
            const { activations, preActivations } = this.forward(input);
            const output = activations[activations.length - 1];

            // Compute target from decisions
            const target = this.decisionsToTarget(sample.decisions);

            // Compute loss (weighted MSE)
            const weight = sample.weight ?? 1;
            for (let i = 0; i < output.length; i++) {
                const error = output[i] - target[i];
                totalLoss += weight * error * error;
            }

            // Backpropagation
            let delta = output.map((o, i) => {
                const error = o - target[i];
                // Sigmoid derivative for output layer
                return weight * error * o * (1 - o);
            });

            for (let layer = this.weights.length - 1; layer >= 0; layer--) {
                const prevActivation = activations[layer];

                // Compute gradients
                for (let j = 0; j < this.weights[layer].length; j++) {
                    for (let k = 0; k < this.weights[layer][j].length; k++) {
                        weightGrads[layer][j][k] += delta[j] * prevActivation[k];
                    }
                    biasGrads[layer][j] += delta[j];
                }

                // Propagate delta to previous layer
                if (layer > 0) {
                    const newDelta: number[] = [];
                    for (let k = 0; k < this.weights[layer][0].length; k++) {
                        let sum = 0;
                        for (let j = 0; j < this.weights[layer].length; j++) {
                            sum += delta[j] * this.weights[layer][j][k];
                        }
                        newDelta.push(sum * this.activateDerivative(preActivations[layer - 1][k]));
                    }
                    delta = newDelta;
                }
            }
        }

        // Apply gradients with L2 regularization
        const batchScale = 1 / batch.length;
        for (let layer = 0; layer < this.weights.length; layer++) {
            for (let j = 0; j < this.weights[layer].length; j++) {
                for (let k = 0; k < this.weights[layer][j].length; k++) {
                    const grad = weightGrads[layer][j][k] * batchScale;
                    const l2Reg = l2Lambda * this.weights[layer][j][k];
                    this.weights[layer][j][k] -= lr * (grad + l2Reg);
                }
                this.biases[layer][j] -= lr * biasGrads[layer][j] * batchScale;
            }
        }

        return totalLoss / batch.length / this.config.outputs.length;
    }

    /**
     * Converts decisions to network target values.
     */
    private decisionsToTarget(decisions: DecisionOutputs): number[] {
        return this.config.outputs.map((outputConfig) => {
            const value = decisions[outputConfig.name] ?? 0;

            if (outputConfig.type === 'continuous' && outputConfig.bounds) {
                // Normalize to 0-1 range for sigmoid output
                return (value - outputConfig.bounds.min) / (outputConfig.bounds.max - outputConfig.bounds.min);
            } else if (outputConfig.type === 'discrete' && outputConfig.options) {
                // Find option index
                const index = outputConfig.options.indexOf(value);
                return index >= 0 ? index / (outputConfig.options.length - 1) : 0.5;
            }

            return value;
        });
    }

    /**
     * Computes loss on a set of samples.
     */
    private computeLoss(samples: LabeledSample[]): number {
        let totalLoss = 0;

        for (const sample of samples) {
            const input = this.normalizeInput(sample.features);
            const { activations } = this.forward(input);
            const output = activations[activations.length - 1];
            const target = this.decisionsToTarget(sample.decisions);
            const weight = sample.weight ?? 1;

            for (let i = 0; i < output.length; i++) {
                const error = output[i] - target[i];
                totalLoss += weight * error * error;
            }
        }

        return totalLoss / samples.length / this.config.outputs.length;
    }

    /**
     * Computes normalization stats from training samples.
     */
    private computeNormalizationStats(samples: LabeledSample[]): void {
        const n = samples.length;
        const numFeatures = this.config.inputFeatures.length;

        const means: number[] = new Array(numFeatures).fill(0);
        const stds: number[] = new Array(numFeatures).fill(0);

        // Compute means
        for (const sample of samples) {
            for (let i = 0; i < numFeatures; i++) {
                const name = this.config.inputFeatures[i];
                means[i] += (sample.features[name] ?? 0) / n;
            }
        }

        // Compute standard deviations
        for (const sample of samples) {
            for (let i = 0; i < numFeatures; i++) {
                const name = this.config.inputFeatures[i];
                const diff = (sample.features[name] ?? 0) - means[i];
                stds[i] += (diff * diff) / n;
            }
        }

        for (let i = 0; i < numFeatures; i++) {
            stds[i] = Math.sqrt(stds[i]);
        }

        this.featureStats = { means, stds };
    }

    /**
     * Saves the model to a JSON-serializable object.
     */
    save(): SerializedDecisionNetwork {
        return {
            version: '1.0',
            config: this.config,
            weights: this.weights,
            biases: this.biases,
            featureStats: this.featureStats,
        };
    }

    /**
     * Loads a model from serialized data.
     */
    static load(data: SerializedDecisionNetwork): DecisionNetwork {
        const network = new DecisionNetwork(data.config);
        network.weights = data.weights;
        network.biases = data.biases;
        network.featureStats = data.featureStats;
        return network;
    }
}

/**
 * Serializable model state.
 */
export interface SerializedDecisionNetwork {
    version: string;
    config: DecisionNetworkConfig;
    weights: number[][][];
    biases: number[][];
    featureStats?: { means: number[]; stds: number[] };
}
