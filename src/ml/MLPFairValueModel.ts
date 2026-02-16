import { writeFileSync, readFileSync, existsSync } from 'fs';
import { MarketRegime } from './MarketRegimeDetector.js';

/**
 * MLP configuration options.
 */
export interface MLPConfig {
    inputSize: number;
    hiddenSizes: number[];      // e.g., [24] for single hidden layer, [32, 16] for two
    learningRate: number;
    beta1: number;              // Adam momentum (default 0.9)
    beta2: number;              // Adam RMSprop (default 0.999)
    epsilon: number;            // Adam numerical stability (default 1e-8)
    dropoutRate: number;        // Dropout probability during training (0 = disabled)
    l2Lambda: number;           // L2 regularization strength (0 = disabled)
    clipGradient: number;       // Max gradient norm (0 = disabled)
}

/**
 * MLP prediction result.
 */
export interface MLPPrediction {
    upPrice: number;
    downPrice: number;
    hiddenActivations: number[][];  // For debugging/analysis
}

/**
 * Multi-Layer Perceptron for Fair Value Prediction
 *
 * Architecture: Input → Hidden(s) → Output
 * - ReLU activation for hidden layers
 * - Sigmoid activation for output (prices in [0,1])
 * - Adam optimizer for stable training
 * - Trained from replay buffer (batch), not online
 *
 * Designed to capture non-linear feature interactions that
 * the linear FairValueModel cannot learn.
 */
export class MLPFairValueModel {
    private config: MLPConfig;
    private savePath: string;

    // Network weights: weights[layer][outputNeuron][inputNeuron]
    private weights: number[][][];
    // Biases: biases[layer][neuron]
    private biases: number[][];

    // Adam optimizer state
    private mWeights: number[][][];  // First moment (momentum)
    private vWeights: number[][][];  // Second moment (RMSprop)
    private mBiases: number[][];
    private vBiases: number[][];
    private timestep: number = 0;

    // Training stats
    private trainingSamples: number = 0;
    private trainingEpochs: number = 0;
    private lastTrainingLoss: number = 0;

    // Layer sizes including input and output
    private layerSizes: number[];

    constructor(
        config?: Partial<MLPConfig>,
        savePath: string = './models/mlp_fairvalue.json'
    ) {
        // Default config (56 features = 17 price + 8 UP depth + 8 DOWN depth + 10 time + 6 order flow + 4 cross-token + 3 period start)
        this.config = {
            inputSize: config?.inputSize ?? 56,
            hiddenSizes: config?.hiddenSizes ?? [24],
            learningRate: config?.learningRate ?? 0.001,
            beta1: config?.beta1 ?? 0.9,
            beta2: config?.beta2 ?? 0.999,
            epsilon: config?.epsilon ?? 1e-8,
            dropoutRate: config?.dropoutRate ?? 0.1,
            l2Lambda: config?.l2Lambda ?? 0.0001,
            clipGradient: config?.clipGradient ?? 5.0,
        };

        this.savePath = savePath;

        // Build layer sizes: input → hidden(s) → output(2)
        this.layerSizes = [
            this.config.inputSize,
            ...this.config.hiddenSizes,
            2  // Output: upPrice, downPrice
        ];

        // Initialize weights and biases
        this.weights = [];
        this.biases = [];
        this.mWeights = [];
        this.vWeights = [];
        this.mBiases = [];
        this.vBiases = [];

        this.initializeWeights();
    }

    /**
     * Initialize weights using He initialization (good for ReLU).
     */
    private initializeWeights(): void {
        this.weights = [];
        this.biases = [];
        this.mWeights = [];
        this.vWeights = [];
        this.mBiases = [];
        this.vBiases = [];

        for (let l = 0; l < this.layerSizes.length - 1; l++) {
            const inputSize = this.layerSizes[l];
            const outputSize = this.layerSizes[l + 1];

            // He initialization: sqrt(2 / fan_in)
            const scale = Math.sqrt(2.0 / inputSize);

            // Initialize weights
            const layerWeights: number[][] = [];
            const layerM: number[][] = [];
            const layerV: number[][] = [];

            for (let o = 0; o < outputSize; o++) {
                const neuronWeights: number[] = [];
                const neuronM: number[] = [];
                const neuronV: number[] = [];

                for (let i = 0; i < inputSize; i++) {
                    // Gaussian initialization
                    neuronWeights.push(this.randomGaussian() * scale);
                    neuronM.push(0);
                    neuronV.push(0);
                }

                layerWeights.push(neuronWeights);
                layerM.push(neuronM);
                layerV.push(neuronV);
            }

            this.weights.push(layerWeights);
            this.mWeights.push(layerM);
            this.vWeights.push(layerV);

            // Initialize biases to small positive values (helps ReLU)
            const layerBiases = Array(outputSize).fill(0).map(() => 0.01);
            this.biases.push(layerBiases);
            this.mBiases.push(Array(outputSize).fill(0));
            this.vBiases.push(Array(outputSize).fill(0));
        }

        this.timestep = 0;
    }

    /**
     * Box-Muller transform for Gaussian random numbers.
     */
    private randomGaussian(): number {
        let u1 = Math.random();
        let u2 = Math.random();
        // Avoid log(0)
        while (u1 === 0) u1 = Math.random();
        return Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
    }

    /**
     * Forward pass through the network.
     * @param input Feature vector
     * @param training If true, apply dropout
     * @returns Prediction and intermediate activations
     */
    forward(input: number[], training: boolean = false): MLPPrediction {
        let activations = [...input];
        const hiddenActivations: number[][] = [];

        for (let l = 0; l < this.weights.length; l++) {
            const isOutputLayer = l === this.weights.length - 1;
            const layerWeights = this.weights[l];
            const layerBiases = this.biases[l];

            const newActivations: number[] = [];

            for (let o = 0; o < layerWeights.length; o++) {
                let sum = layerBiases[o];
                for (let i = 0; i < activations.length; i++) {
                    sum += layerWeights[o][i] * activations[i];
                }

                // Apply activation function
                if (isOutputLayer) {
                    // Sigmoid for output (prices in [0, 1])
                    newActivations.push(this.sigmoid(sum));
                } else {
                    // ReLU for hidden layers
                    newActivations.push(this.relu(sum));
                }
            }

            // Apply dropout to hidden layers during training
            if (training && !isOutputLayer && this.config.dropoutRate > 0) {
                for (let i = 0; i < newActivations.length; i++) {
                    if (Math.random() < this.config.dropoutRate) {
                        newActivations[i] = 0;
                    } else {
                        // Scale up to maintain expected value
                        newActivations[i] /= (1 - this.config.dropoutRate);
                    }
                }
            }

            if (!isOutputLayer) {
                hiddenActivations.push([...newActivations]);
            }

            activations = newActivations;
        }

        return {
            upPrice: activations[0],
            downPrice: activations[1],
            hiddenActivations,
        };
    }

    // Track prediction NaN warnings (separate from training)
    private predictionNaNCount: number = 0;
    private static readonly MAX_PREDICTION_NAN_WARNINGS = 5;
    private hasRunDiagnostics: boolean = false;

    /**
     * Predict fair prices from features.
     */
    predict(features: Record<string, number>): { upPrice: number; downPrice: number } {
        const input = this.toVector(features);
        const result = this.forward(input, false);

        // Safeguard against NaN - return neutral prices if model is corrupted
        let upPrice = result.upPrice;
        let downPrice = result.downPrice;

        if (!isFinite(upPrice) || !isFinite(downPrice)) {
            this.predictionNaNCount++;
            if (this.predictionNaNCount <= MLPFairValueModel.MAX_PREDICTION_NAN_WARNINGS) {
                console.warn(`[MLPFairValueModel] NaN detected in prediction #${this.predictionNaNCount} - returning neutral prices`);

                // Run diagnostics once to find the source
                if (!this.hasRunDiagnostics) {
                    this.hasRunDiagnostics = true;
                    this.diagnoseNaN();
                }
            }
            upPrice = 0.5;
            downPrice = 0.5;
        }

        return { upPrice, downPrice };
    }

    /**
     * Diagnose and report all NaN/Infinity values in weights and biases.
     * Call this to find where corruption exists in the model.
     */
    diagnoseNaN(): { corrupted: boolean; details: string[] } {
        const details: string[] = [];
        let corrupted = false;

        // Check weights
        for (let l = 0; l < this.weights.length; l++) {
            for (let o = 0; o < this.weights[l].length; o++) {
                for (let i = 0; i < this.weights[l][o].length; i++) {
                    const w = this.weights[l][o][i];
                    if (!isFinite(w)) {
                        corrupted = true;
                        details.push(`weights[${l}][${o}][${i}] = ${w}`);
                    }
                }
            }
        }

        // Check biases
        for (let l = 0; l < this.biases.length; l++) {
            for (let o = 0; o < this.biases[l].length; o++) {
                const b = this.biases[l][o];
                if (!isFinite(b)) {
                    corrupted = true;
                    details.push(`biases[${l}][${o}] = ${b}`);
                }
            }
        }

        // Check Adam state (mWeights, vWeights)
        for (let l = 0; l < this.mWeights.length; l++) {
            for (let o = 0; o < this.mWeights[l].length; o++) {
                for (let i = 0; i < this.mWeights[l][o].length; i++) {
                    if (!isFinite(this.mWeights[l][o][i])) {
                        corrupted = true;
                        details.push(`mWeights[${l}][${o}][${i}] = ${this.mWeights[l][o][i]}`);
                    }
                    if (!isFinite(this.vWeights[l][o][i])) {
                        corrupted = true;
                        details.push(`vWeights[${l}][${o}][${i}] = ${this.vWeights[l][o][i]}`);
                    }
                }
            }
        }

        // Log findings
        if (corrupted) {
            console.error(`[MLPFairValueModel] DIAGNOSTIC: Found ${details.length} corrupted values:`);
            // Log first 20 corrupted values
            for (let i = 0; i < Math.min(20, details.length); i++) {
                console.error(`  - ${details[i]}`);
            }
            if (details.length > 20) {
                console.error(`  ... and ${details.length - 20} more`);
            }
            console.error(`[MLPFairValueModel] RECOMMENDATION: Delete the model file at ${this.savePath} and restart to reinitialize weights`);
        } else {
            // Weights look OK, check if issue is in forward pass
            console.warn(`[MLPFairValueModel] DIAGNOSTIC: No NaN found in weights/biases. Issue may be in input features or forward computation.`);
        }

        return { corrupted, details };
    }

    /**
     * Force reset if model is corrupted. Returns true if reset was needed.
     */
    resetIfCorrupted(): boolean {
        const { corrupted } = this.diagnoseNaN();
        if (corrupted) {
            console.warn(`[MLPFairValueModel] Resetting corrupted model to random weights`);
            this.initializeWeights();
            this.trainingSamples = 0;
            this.trainingEpochs = 0;
            this.lastTrainingLoss = 0;
            this.predictionNaNCount = 0;
            this.hasRunDiagnostics = false;
            return true;
        }
        return false;
    }

    /**
     * Train on a batch of samples using backpropagation with Adam.
     * @param samples Array of { features, actualUpPrice, actualDownPrice }
     * @returns Average loss for the batch
     */
    trainBatch(
        samples: Array<{
            features: Record<string, number>;
            actualUpPrice: number;
            actualDownPrice: number;
        }>
    ): number {
        if (samples.length === 0) return 0;

        // Accumulate gradients over batch
        const gradWeights: number[][][] = this.weights.map(layer =>
            layer.map(neuron => neuron.map(() => 0))
        );
        const gradBiases: number[][] = this.biases.map(layer =>
            layer.map(() => 0)
        );

        let totalLoss = 0;

        for (const sample of samples) {
            const input = this.toVector(sample.features);
            const targets = [sample.actualUpPrice, sample.actualDownPrice];

            // Forward pass (with dropout during training)
            const { activations, preActivations } = this.forwardDetailed(input, true);

            // Calculate loss (MSE)
            const output = activations[activations.length - 1];
            for (let i = 0; i < 2; i++) {
                totalLoss += (output[i] - targets[i]) ** 2;
            }

            // Backward pass
            const { weightGrads, biasGrads } = this.backward(
                activations,
                preActivations,
                targets
            );

            // Accumulate gradients
            for (let l = 0; l < gradWeights.length; l++) {
                for (let o = 0; o < gradWeights[l].length; o++) {
                    gradBiases[l][o] += biasGrads[l][o];
                    for (let i = 0; i < gradWeights[l][o].length; i++) {
                        gradWeights[l][o][i] += weightGrads[l][o][i];
                    }
                }
            }
        }

        // Average gradients
        const batchSize = samples.length;
        for (let l = 0; l < gradWeights.length; l++) {
            for (let o = 0; o < gradWeights[l].length; o++) {
                gradBiases[l][o] /= batchSize;
                for (let i = 0; i < gradWeights[l][o].length; i++) {
                    gradWeights[l][o][i] /= batchSize;
                }
            }
        }

        // Add L2 regularization gradients
        if (this.config.l2Lambda > 0) {
            for (let l = 0; l < this.weights.length; l++) {
                for (let o = 0; o < this.weights[l].length; o++) {
                    for (let i = 0; i < this.weights[l][o].length; i++) {
                        gradWeights[l][o][i] += this.config.l2Lambda * this.weights[l][o][i];
                    }
                }
            }
        }

        // Clip gradients
        if (this.config.clipGradient > 0) {
            this.clipGradients(gradWeights, gradBiases);
        }

        // Update weights using Adam
        this.adamUpdate(gradWeights, gradBiases);

        this.trainingSamples += samples.length;
        this.lastTrainingLoss = totalLoss / (batchSize * 2);  // 2 outputs

        return this.lastTrainingLoss;
    }

    // Track forward pass NaN warnings
    private forwardNaNCount: number = 0;
    private static readonly MAX_FORWARD_NAN_WARNINGS = 20;

    /**
     * Forward pass with detailed activations for backprop.
     */
    private forwardDetailed(
        input: number[],
        training: boolean
    ): { activations: number[][]; preActivations: number[][] } {
        const activations: number[][] = [[...input]];
        const preActivations: number[][] = [[]];  // No pre-activation for input

        let current = [...input];

        // Check for NaN in input (which would come from corrupted features)
        for (let i = 0; i < input.length; i++) {
            if (!isFinite(input[i])) {
                this.forwardNaNCount++;
                if (this.forwardNaNCount <= MLPFairValueModel.MAX_FORWARD_NAN_WARNINGS) {
                    console.warn(`[MLPFairValueModel] NaN in input feature idx=${i}: ${input[i]}`);
                }
                // Replace with 0 to continue
                current[i] = 0;
            }
        }

        for (let l = 0; l < this.weights.length; l++) {
            const isOutputLayer = l === this.weights.length - 1;
            const layerWeights = this.weights[l];
            const layerBiases = this.biases[l];

            const preAct: number[] = [];
            const postAct: number[] = [];

            for (let o = 0; o < layerWeights.length; o++) {
                let sum = layerBiases[o];
                for (let i = 0; i < current.length; i++) {
                    sum += layerWeights[o][i] * current[i];
                }

                // Check for overflow/NaN in pre-activation
                if (!isFinite(sum)) {
                    this.forwardNaNCount++;
                    if (this.forwardNaNCount <= MLPFairValueModel.MAX_FORWARD_NAN_WARNINGS) {
                        console.warn(`[MLPFairValueModel] NaN in pre-activation layer=${l}, neuron=${o}: ${sum}, bias=${layerBiases[o]}`);
                    }
                    sum = 0;  // Clamp to prevent propagation
                }

                preAct.push(sum);

                if (isOutputLayer) {
                    postAct.push(this.sigmoid(sum));
                } else {
                    postAct.push(this.relu(sum));
                }
            }

            // Apply dropout during training (to hidden layers only)
            if (training && !isOutputLayer && this.config.dropoutRate > 0) {
                for (let i = 0; i < postAct.length; i++) {
                    if (Math.random() < this.config.dropoutRate) {
                        postAct[i] = 0;
                    } else {
                        postAct[i] /= (1 - this.config.dropoutRate);
                    }
                }
            }

            preActivations.push(preAct);
            activations.push(postAct);
            current = postAct;
        }

        return { activations, preActivations };
    }

    // Track backward pass NaN warnings
    private backwardNaNCount: number = 0;
    private static readonly MAX_BACKWARD_NAN_WARNINGS = 20;

    /**
     * Backward pass to compute gradients.
     */
    private backward(
        activations: number[][],
        preActivations: number[][],
        targets: number[]
    ): { weightGrads: number[][][]; biasGrads: number[][] } {
        const numLayers = this.weights.length;

        const weightGrads: number[][][] = this.weights.map(layer =>
            layer.map(neuron => neuron.map(() => 0))
        );
        const biasGrads: number[][] = this.biases.map(layer =>
            layer.map(() => 0)
        );

        // Output layer error (MSE derivative * sigmoid derivative)
        const outputAct = activations[numLayers];
        let delta: number[] = [];

        for (let o = 0; o < 2; o++) {
            const error = outputAct[o] - targets[o];
            const sigmoidDeriv = outputAct[o] * (1 - outputAct[o]);
            let d = error * sigmoidDeriv;

            // Check for NaN in output delta
            if (!isFinite(d)) {
                this.backwardNaNCount++;
                if (this.backwardNaNCount <= MLPFairValueModel.MAX_BACKWARD_NAN_WARNINGS) {
                    console.warn(`[MLPFairValueModel] NaN in output delta o=${o}: error=${error}, output=${outputAct[o]}, target=${targets[o]}`);
                }
                d = 0;  // Clamp to prevent propagation
            }
            delta.push(d);
        }

        // Backpropagate through layers
        for (let l = numLayers - 1; l >= 0; l--) {
            const prevActivations = activations[l];

            // Compute gradients for this layer
            for (let o = 0; o < this.weights[l].length; o++) {
                biasGrads[l][o] = delta[o];
                for (let i = 0; i < this.weights[l][o].length; i++) {
                    const grad = delta[o] * prevActivations[i];
                    // Check for NaN in weight gradient
                    if (!isFinite(grad)) {
                        this.backwardNaNCount++;
                        if (this.backwardNaNCount <= MLPFairValueModel.MAX_BACKWARD_NAN_WARNINGS) {
                            console.warn(`[MLPFairValueModel] NaN weight grad layer=${l}, o=${o}, i=${i}: delta=${delta[o]}, activation=${prevActivations[i]}`);
                        }
                        weightGrads[l][o][i] = 0;
                    } else {
                        weightGrads[l][o][i] = grad;
                    }
                }
            }

            // Compute delta for previous layer (if not input layer)
            if (l > 0) {
                const newDelta: number[] = [];
                for (let i = 0; i < this.weights[l][0].length; i++) {
                    let sum = 0;
                    for (let o = 0; o < this.weights[l].length; o++) {
                        sum += this.weights[l][o][i] * delta[o];
                    }
                    // ReLU derivative
                    const reluDeriv = preActivations[l][i] > 0 ? 1 : 0;
                    let d = sum * reluDeriv;

                    // Check for NaN in hidden delta
                    if (!isFinite(d)) {
                        this.backwardNaNCount++;
                        if (this.backwardNaNCount <= MLPFairValueModel.MAX_BACKWARD_NAN_WARNINGS) {
                            console.warn(`[MLPFairValueModel] NaN hidden delta layer=${l}, i=${i}: sum=${sum}, reluDeriv=${reluDeriv}`);
                        }
                        d = 0;
                    }
                    newDelta.push(d);
                }
                delta = newDelta;
            }
        }

        return { weightGrads, biasGrads };
    }

    /**
     * Clip gradients by global norm.
     */
    private clipGradients(
        weightGrads: number[][][],
        biasGrads: number[][]
    ): void {
        // Compute global norm
        let normSq = 0;
        for (let l = 0; l < weightGrads.length; l++) {
            for (let o = 0; o < weightGrads[l].length; o++) {
                normSq += biasGrads[l][o] ** 2;
                for (let i = 0; i < weightGrads[l][o].length; i++) {
                    normSq += weightGrads[l][o][i] ** 2;
                }
            }
        }
        const norm = Math.sqrt(normSq);

        // Clip if necessary
        if (norm > this.config.clipGradient) {
            const scale = this.config.clipGradient / norm;
            for (let l = 0; l < weightGrads.length; l++) {
                for (let o = 0; o < weightGrads[l].length; o++) {
                    biasGrads[l][o] *= scale;
                    for (let i = 0; i < weightGrads[l][o].length; i++) {
                        weightGrads[l][o][i] *= scale;
                    }
                }
            }
        }
    }

    // Track weight corruption warnings
    private weightCorruptionCount: number = 0;
    private static readonly MAX_WEIGHT_CORRUPTION_WARNINGS = 20;

    /**
     * Adam optimizer update.
     */
    private adamUpdate(
        weightGrads: number[][][],
        biasGrads: number[][]
    ): void {
        // Check for NaN in gradients before updating - log details about which gradient
        for (let l = 0; l < weightGrads.length; l++) {
            for (let o = 0; o < weightGrads[l].length; o++) {
                if (!isFinite(biasGrads[l][o])) {
                    this.logWeightCorruption(`gradient`, l, o, -1, biasGrads[l][o], 'biasGrad');
                    return;  // Skip entire update
                }
                for (let i = 0; i < weightGrads[l][o].length; i++) {
                    if (!isFinite(weightGrads[l][o][i])) {
                        this.logWeightCorruption(`gradient`, l, o, i, weightGrads[l][o][i], 'weightGrad');
                        return;  // Skip entire update
                    }
                }
            }
        }

        this.timestep++;

        const { beta1, beta2, epsilon, learningRate } = this.config;

        // Bias correction
        const biasCorrection1 = 1 - Math.pow(beta1, this.timestep);
        const biasCorrection2 = 1 - Math.pow(beta2, this.timestep);

        for (let l = 0; l < this.weights.length; l++) {
            for (let o = 0; o < this.weights[l].length; o++) {
                // Update biases
                const oldBias = this.biases[l][o];
                this.mBiases[l][o] = beta1 * this.mBiases[l][o] + (1 - beta1) * biasGrads[l][o];
                this.vBiases[l][o] = beta2 * this.vBiases[l][o] + (1 - beta2) * biasGrads[l][o] ** 2;

                const mHatB = this.mBiases[l][o] / biasCorrection1;
                const vHatB = this.vBiases[l][o] / biasCorrection2;

                const biasUpdate = learningRate * mHatB / (Math.sqrt(vHatB) + epsilon);
                if (isFinite(biasUpdate)) {
                    this.biases[l][o] -= biasUpdate;
                    // Check if weight became NaN after update
                    if (!isFinite(this.biases[l][o])) {
                        this.logWeightCorruption('bias', l, o, -1, this.biases[l][o], 'afterUpdate',
                            { oldValue: oldBias, update: biasUpdate, mHat: mHatB, vHat: vHatB, grad: biasGrads[l][o] });
                        this.biases[l][o] = oldBias;  // Restore
                    }
                }

                // Update weights
                for (let i = 0; i < this.weights[l][o].length; i++) {
                    const oldWeight = this.weights[l][o][i];
                    this.mWeights[l][o][i] = beta1 * this.mWeights[l][o][i] + (1 - beta1) * weightGrads[l][o][i];
                    this.vWeights[l][o][i] = beta2 * this.vWeights[l][o][i] + (1 - beta2) * weightGrads[l][o][i] ** 2;

                    const mHat = this.mWeights[l][o][i] / biasCorrection1;
                    const vHat = this.vWeights[l][o][i] / biasCorrection2;

                    const weightUpdate = learningRate * mHat / (Math.sqrt(vHat) + epsilon);
                    if (isFinite(weightUpdate)) {
                        this.weights[l][o][i] -= weightUpdate;
                        // Check if weight became NaN after update
                        if (!isFinite(this.weights[l][o][i])) {
                            this.logWeightCorruption('weight', l, o, i, this.weights[l][o][i], 'afterUpdate',
                                { oldValue: oldWeight, update: weightUpdate, mHat, vHat, grad: weightGrads[l][o][i] });
                            this.weights[l][o][i] = oldWeight;  // Restore
                        }
                    }
                }
            }
        }
    }

    /**
     * Log detailed info about weight corruption for debugging.
     */
    private logWeightCorruption(
        type: string,
        layer: number,
        outputNeuron: number,
        inputIdx: number,
        value: number,
        context: string,
        details?: Record<string, number>
    ): void {
        this.weightCorruptionCount++;
        if (this.weightCorruptionCount > MLPFairValueModel.MAX_WEIGHT_CORRUPTION_WARNINGS) {
            return;
        }

        const location = inputIdx >= 0
            ? `layer=${layer}, output=${outputNeuron}, input=${inputIdx}`
            : `layer=${layer}, neuron=${outputNeuron}`;

        let msg = `[MLPFairValueModel] NaN ${type} detected at ${location} (${context}): ${value}`;

        if (details) {
            const detailStr = Object.entries(details)
                .map(([k, v]) => `${k}=${v}`)
                .join(', ');
            msg += ` | ${detailStr}`;
        }

        console.warn(msg);

        if (this.weightCorruptionCount === MLPFairValueModel.MAX_WEIGHT_CORRUPTION_WARNINGS) {
            console.warn(`[MLPFairValueModel] Suppressing further corruption warnings (${this.weightCorruptionCount} total)`);
        }
    }

    /**
     * Train for multiple epochs on the given samples.
     */
    trainEpochs(
        samples: Array<{
            features: Record<string, number>;
            actualUpPrice: number;
            actualDownPrice: number;
        }>,
        epochs: number = 10,
        batchSize: number = 32,
        shuffle: boolean = true
    ): { losses: number[]; finalLoss: number } {
        const losses: number[] = [];

        for (let epoch = 0; epoch < epochs; epoch++) {
            // Shuffle samples
            const shuffled = shuffle
                ? [...samples].sort(() => Math.random() - 0.5)
                : samples;

            let epochLoss = 0;
            let batchCount = 0;

            // Train in batches
            for (let i = 0; i < shuffled.length; i += batchSize) {
                const batch = shuffled.slice(i, i + batchSize);
                const loss = this.trainBatch(batch);
                epochLoss += loss;
                batchCount++;
            }

            const avgLoss = epochLoss / batchCount;
            losses.push(avgLoss);
            this.trainingEpochs++;
        }

        return {
            losses,
            finalLoss: losses[losses.length - 1] ?? 0,
        };
    }

    /**
     * Convert feature dict to vector.
     * Uses sanitize() instead of ?? to also catch NaN values.
     * Logs warnings with feature names to help identify corruption sources.
     */
    private toVector(features: Record<string, number>): number[] {
        const s = (value: number | undefined | null, defaultValue: number, name: string) =>
            this.sanitize(value, defaultValue, name);
        return [
            // Binance price features (17)
            s(features.candle10s, 0, 'candle10s'),
            s(features.candle20s, 0, 'candle20s'),
            s(features.candle30s, 0, 'candle30s'),
            s(features.candle60s, 0, 'candle60s'),
            s(features.candle5m, 0, 'candle5m'),
            s(features.ma30s, 0, 'ma30s'),
            s(features.ma60s, 0, 'ma60s'),
            s(features.ma5m, 0, 'ma5m'),
            s(features.volatility30s, 0, 'volatility30s'),
            s(features.volatility60s, 0, 'volatility60s'),
            s(features.momentum, 0, 'momentum'),
            s(features.priceVsMa, 0, 'priceVsMa'),
            s(features.upMid, 0.5, 'upMid'),
            s(features.downMid, 0.5, 'downMid'),
            s(features.upSpread, 0, 'upSpread'),
            s(features.downSpread, 0, 'downSpread'),
            s(features.imbalance, 0, 'imbalance'),

            // UP token order book depth features (8)
            s(features.upBidDepth1pct, 0, 'upBidDepth1pct'),
            s(features.upAskDepth1pct, 0, 'upAskDepth1pct'),
            s(features.upBidDepth5pct, 0, 'upBidDepth5pct'),
            s(features.upAskDepth5pct, 0, 'upAskDepth5pct'),
            s(features.upVolumeImbalance, 0, 'upVolumeImbalance'),
            s(features.upBidVWAP, 0.5, 'upBidVWAP'),
            s(features.upAskVWAP, 0.5, 'upAskVWAP'),
            s(features.upBookPressure, 1, 'upBookPressure'),

            // DOWN token order book depth features (8)
            s(features.downBidDepth1pct, 0, 'downBidDepth1pct'),
            s(features.downAskDepth1pct, 0, 'downAskDepth1pct'),
            s(features.downBidDepth5pct, 0, 'downBidDepth5pct'),
            s(features.downAskDepth5pct, 0, 'downAskDepth5pct'),
            s(features.downVolumeImbalance, 0, 'downVolumeImbalance'),
            s(features.downBidVWAP, 0.5, 'downBidVWAP'),
            s(features.downAskVWAP, 0.5, 'downAskVWAP'),
            s(features.downBookPressure, 1, 'downBookPressure'),

            // Time-based features (10)
            s(features.minuteInHour, 0, 'minuteInHour'),
            s(features.secondInMinute, 0, 'secondInMinute'),
            s(features.timeToHourEnd, 0, 'timeToHourEnd'),
            s(features.isFirstQuarter, 0, 'isFirstQuarter'),
            s(features.isLastQuarter, 0, 'isLastQuarter'),
            s(features.minuteSin, 0, 'minuteSin'),
            s(features.minuteCos, 1, 'minuteCos'),
            s(features.hourSin, 0, 'hourSin'),
            s(features.hourCos, 1, 'hourCos'),
            s(features.periodProgress, 0, 'periodProgress'),

            // Order flow features (6)
            s(features.upBidAskRatio, 1, 'upBidAskRatio'),
            s(features.downBidAskRatio, 1, 'downBidAskRatio'),
            s(features.upTopBidConcentration, 0, 'upTopBidConcentration'),
            s(features.upTopAskConcentration, 0, 'upTopAskConcentration'),
            s(features.downTopBidConcentration, 0, 'downTopBidConcentration'),
            s(features.downTopAskConcentration, 0, 'downTopAskConcentration'),

            // Cross-token features (4)
            s(features.upDownCorrelation, 0, 'upDownCorrelation'),
            s(features.upDownSpreadRatio, 1, 'upDownSpreadRatio'),
            s(features.combinedLiquidity, 0, 'combinedLiquidity'),
            s(features.imbalanceVelocity, 0, 'imbalanceVelocity'),

            // Period start features (3) - price change from period open
            s(features.upPriceVsPeriodStart, 0, 'upPriceVsPeriodStart'),
            s(features.downPriceVsPeriodStart, 0, 'downPriceVsPeriodStart'),
            s(features.binancePriceVsPeriodStart, 0, 'binancePriceVsPeriodStart'),
        ];
    }

    private relu(x: number): number {
        return Math.max(0, x);
    }

    private sigmoid(x: number): number {
        const clipped = Math.max(-500, Math.min(500, x));
        return 1 / (1 + Math.exp(-clipped));
    }

    // Track NaN occurrences for debugging
    private nanWarningCount: number = 0;
    private static readonly MAX_NAN_WARNINGS = 100;  // Limit log spam

    /**
     * Sanitize a feature value - handles NaN, undefined, null, and Infinity.
     * The ?? operator only catches undefined/null, not NaN!
     * Logs warnings to help identify the source of corruption.
     */
    private sanitize(value: number | undefined | null, defaultValue: number, featureName?: string): number {
        if (value === undefined || value === null) {
            return defaultValue;
        }
        if (!isFinite(value)) {
            this.nanWarningCount++;
            if (this.nanWarningCount <= MLPFairValueModel.MAX_NAN_WARNINGS) {
                console.warn(`[MLPFairValueModel] NaN/Infinity detected in feature "${featureName ?? 'unknown'}": ${value}`);
                if (this.nanWarningCount === MLPFairValueModel.MAX_NAN_WARNINGS) {
                    console.warn(`[MLPFairValueModel] Suppressing further NaN warnings (${this.nanWarningCount} total)`);
                }
            }
            return defaultValue;
        }
        return value;
    }

    /**
     * Save model to disk.
     */
    save(): void {
        try {
            const data = {
                version: '1.0',
                config: this.config,
                layerSizes: this.layerSizes,
                weights: this.weights,
                biases: this.biases,
                mWeights: this.mWeights,
                vWeights: this.vWeights,
                mBiases: this.mBiases,
                vBiases: this.vBiases,
                timestep: this.timestep,
                trainingSamples: this.trainingSamples,
                trainingEpochs: this.trainingEpochs,
                lastTrainingLoss: this.lastTrainingLoss,
                savedAt: new Date().toISOString(),
            };
            writeFileSync(this.savePath, JSON.stringify(data, null, 2));
        } catch (e) {
            console.error(`[MLPFairValueModel] Failed to save: ${e}`);
        }
    }

    /**
     * Load model from disk.
     */
    loadIfExists(): boolean {
        if (!existsSync(this.savePath)) return false;

        try {
            const content = readFileSync(this.savePath, 'utf-8');
            const data = JSON.parse(content);

            // Validate layer sizes match
            const expectedLayers = [
                this.config.inputSize,
                ...this.config.hiddenSizes,
                2
            ];

            if (JSON.stringify(data.layerSizes) !== JSON.stringify(expectedLayers)) {
                console.warn(`[MLPFairValueModel] Layer sizes mismatch, reinitializing`);
                return false;
            }

            this.weights = data.weights;
            this.biases = data.biases;
            this.mWeights = data.mWeights ?? this.mWeights;
            this.vWeights = data.vWeights ?? this.vWeights;
            this.mBiases = data.mBiases ?? this.mBiases;
            this.vBiases = data.vBiases ?? this.vBiases;
            this.timestep = data.timestep ?? 0;
            this.trainingSamples = data.trainingSamples ?? 0;
            this.trainingEpochs = data.trainingEpochs ?? 0;
            this.lastTrainingLoss = data.lastTrainingLoss ?? 0;

            // Check for NaN corruption in weights, biases, and Adam state
            const hasNaNWeights = this.weights.some(layer =>
                layer.some(neuron =>
                    neuron.some(w => !isFinite(w))
                )
            );
            const hasNaNBiases = this.biases.some(layer =>
                layer.some(b => !isFinite(b))
            );
            const hasNaNAdam = this.mWeights.some(layer =>
                layer.some(neuron =>
                    neuron.some(w => !isFinite(w))
                )
            ) || this.vWeights.some(layer =>
                layer.some(neuron =>
                    neuron.some(w => !isFinite(w))
                )
            );

            if (hasNaNWeights || hasNaNBiases || hasNaNAdam) {
                const sources = [];
                if (hasNaNWeights) sources.push('weights');
                if (hasNaNBiases) sources.push('biases');
                if (hasNaNAdam) sources.push('Adam optimizer state');
                console.warn(`[MLPFairValueModel] Detected NaN/Infinity in loaded model (${sources.join(', ')}) - resetting to random`);
                this.initializeWeights();
                return false;
            }

            console.log(`[MLPFairValueModel] Loaded from ${this.savePath} (${this.trainingSamples} samples, ${this.trainingEpochs} epochs)`);
            return true;
        } catch (e) {
            console.warn(`[MLPFairValueModel] Failed to load: ${e}`);
            return false;
        }
    }

    /**
     * Reset model to random weights.
     */
    reset(): void {
        this.initializeWeights();
        this.trainingSamples = 0;
        this.trainingEpochs = 0;
        this.lastTrainingLoss = 0;
    }

    /**
     * Get training statistics.
     */
    getStats(): {
        trainingSamples: number;
        trainingEpochs: number;
        lastTrainingLoss: number;
        parameterCount: number;
        layerSizes: number[];
    } {
        let paramCount = 0;
        for (let l = 0; l < this.weights.length; l++) {
            for (let o = 0; o < this.weights[l].length; o++) {
                paramCount += this.weights[l][o].length + 1;  // weights + bias
            }
        }

        return {
            trainingSamples: this.trainingSamples,
            trainingEpochs: this.trainingEpochs,
            lastTrainingLoss: this.lastTrainingLoss,
            parameterCount: paramCount,
            layerSizes: [...this.layerSizes],
        };
    }

    /**
     * Returns feature names for consistency with FairValueModel.
     */
    getFeatureNames(): string[] {
        return MLPFairValueModel.getFeatureNames();
    }

    /**
     * Returns feature names (static method).
     */
    static getFeatureNames(): string[] {
        return [
            // Price features (17)
            'candle10s', 'candle20s', 'candle30s', 'candle60s', 'candle5m',
            'ma30s', 'ma60s', 'ma5m', 'volatility30s', 'volatility60s',
            'momentum', 'priceVsMa', 'upMid', 'downMid', 'upSpread', 'downSpread', 'imbalance',
            // UP depth features (8)
            'upBidDepth1pct', 'upAskDepth1pct', 'upBidDepth5pct', 'upAskDepth5pct',
            'upVolumeImbalance', 'upBidVWAP', 'upAskVWAP', 'upBookPressure',
            // DOWN depth features (8)
            'downBidDepth1pct', 'downAskDepth1pct', 'downBidDepth5pct', 'downAskDepth5pct',
            'downVolumeImbalance', 'downBidVWAP', 'downAskVWAP', 'downBookPressure',
            // Time features (10)
            'minuteInHour', 'secondInMinute', 'timeToHourEnd', 'isFirstQuarter', 'isLastQuarter',
            'minuteSin', 'minuteCos', 'hourSin', 'hourCos', 'periodProgress',
            // Order flow features (6)
            'upBidAskRatio', 'downBidAskRatio', 'upTopBidConcentration', 'upTopAskConcentration',
            'downTopBidConcentration', 'downTopAskConcentration',
            // Cross-token features (4)
            'upDownCorrelation', 'upDownSpreadRatio', 'combinedLiquidity', 'imbalanceVelocity',
            // Period start features (3)
            'upPriceVsPeriodStart', 'downPriceVsPeriodStart', 'binancePriceVsPeriodStart',
        ];
    }

    /**
     * Get feature importance via gradient-based attribution.
     * Computes average absolute gradient w.r.t. each input feature.
     */
    getFeatureImportance(
        samples: Array<{ features: Record<string, number> }>
    ): Map<string, number> {
        const featureNames = MLPFairValueModel.getFeatureNames();

        // Simple importance: sum of absolute weights from input to first hidden layer
        const importance = new Map<string, number>();
        const firstLayerWeights = this.weights[0];

        for (let i = 0; i < featureNames.length && i < this.config.inputSize; i++) {
            let totalAbsWeight = 0;
            for (let o = 0; o < firstLayerWeights.length; o++) {
                totalAbsWeight += Math.abs(firstLayerWeights[o][i]);
            }
            importance.set(featureNames[i], totalAbsWeight / firstLayerWeights.length);
        }

        return importance;
    }
}
