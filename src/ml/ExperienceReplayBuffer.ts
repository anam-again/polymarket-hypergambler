import { writeFileSync, readFileSync, existsSync } from 'fs';

/**
 * Training sample stored in the replay buffer.
 */
export interface TrainingSample {
    id: string;
    timestamp: number;
    features: Record<string, number>;
    target: number;
    outcome: 'positive' | 'negative' | 'neutral';
    modelType: 'fairValue' | 'exit' | 'timeout';
    weight: number;  // Importance weight (recent samples weighted higher)
    error?: number;  // Prediction error (for prioritized sampling)
    pnl?: number;           // PnL as decimal (0.05 = 5% profit, -0.02 = 2% loss)
    pnlWeight?: number;     // Computed weight: 1 + |pnl| * scalingFactor
}

/**
 * Interface for models that can be trained via the replay buffer.
 */
export interface IReplayTrainable {
    trainFromReplay(features: Record<string, number>, target: number): void;
}

/**
 * Experience Replay Buffer for stable online learning.
 *
 * Key features:
 * - Stores recent training samples to prevent catastrophic forgetting
 * - Prioritized sampling: recent + high-error samples more likely
 * - Periodic batch training from the buffer
 * - Persistence support for save/load across sessions
 */
export class ExperienceReplayBuffer {
    private buffer: TrainingSample[] = [];
    private maxSize: number;
    private miniBatchSize: number;
    private sampleCounter: number = 0;
    private savePath: string;

    // Prioritization parameters
    private readonly recencyWeight: number = 0.6;  // Weight for recency vs error priority
    private readonly errorWeight: number = 0.4;
    private readonly minWeight: number = 0.1;      // Minimum sampling probability

    constructor(
        maxSize: number = 1000,
        miniBatchSize: number = 32,
        savePath: string = './models/replay_buffer.json'
    ) {
        this.maxSize = maxSize;
        this.miniBatchSize = miniBatchSize;
        this.savePath = savePath;
    }

    // NaN tracking for debugging
    private static readonly MAX_NAN_WARNINGS = 50;
    private nanSampleCount: number = 0;

    /**
     * Adds a training sample to the buffer.
     * Oldest samples are evicted when buffer is full.
     * Rejects samples with NaN values to prevent model corruption.
     */
    add(sample: Omit<TrainingSample, 'id'>): void {
        // Validate sample doesn't contain NaN values
        const nanFeatures: string[] = [];
        for (const [key, value] of Object.entries(sample.features)) {
            if (!isFinite(value)) {
                nanFeatures.push(key);
            }
        }

        if (nanFeatures.length > 0 || !isFinite(sample.target)) {
            this.nanSampleCount++;
            if (this.nanSampleCount <= ExperienceReplayBuffer.MAX_NAN_WARNINGS) {
                console.warn(`[ExperienceReplayBuffer] Rejecting sample with NaN - features: [${nanFeatures.join(', ')}], target: ${sample.target}`);
                if (this.nanSampleCount === ExperienceReplayBuffer.MAX_NAN_WARNINGS) {
                    console.warn(`[ExperienceReplayBuffer] Suppressing further NaN warnings (${this.nanSampleCount} total)`);
                }
            }
            return;  // Don't add corrupted samples
        }

        this.sampleCounter++;
        const fullSample: TrainingSample = {
            ...sample,
            id: `sample-${this.sampleCounter}`,
        };

        this.buffer.push(fullSample);

        // Evict oldest samples if over capacity
        while (this.buffer.length > this.maxSize) {
            this.buffer.shift();
        }
    }

    /**
     * Creates a training sample for fairValue model.
     */
    addFairValueSample(
        features: Record<string, number>,
        actualUpPrice: number,
        actualDownPrice: number,
        predictedUpPrice: number,
        predictedDownPrice: number,
        outcome: 'positive' | 'negative' | 'neutral'
    ): void {
        // Store as two separate samples (one for UP, one for DOWN)
        const upError = Math.abs(predictedUpPrice - actualUpPrice);
        this.add({
            timestamp: Date.now(),
            features: { ...features, _direction: 1 }, // 1 = UP
            target: actualUpPrice,
            outcome,
            modelType: 'fairValue',
            weight: 1.0,
            error: upError,
        });

        const downError = Math.abs(predictedDownPrice - actualDownPrice);
        this.add({
            timestamp: Date.now(),
            features: { ...features, _direction: 0 }, // 0 = DOWN
            target: actualDownPrice,
            outcome,
            modelType: 'fairValue',
            weight: 1.0,
            error: downError,
        });
    }

    /**
     * Creates a training sample for fairValue model with PnL weighting.
     * High-PnL trades contribute more to model learning.
     *
     * @param pnl - PnL as decimal (0.05 = 5% profit)
     * @param pnlScalingFactor - How much to scale PnL weight (default 10: 1% PnL = 10% more weight)
     */
    addFairValueSampleWithPnL(
        features: Record<string, number>,
        actualUpPrice: number,
        actualDownPrice: number,
        predictedUpPrice: number,
        predictedDownPrice: number,
        outcome: 'positive' | 'negative' | 'neutral',
        pnl: number,
        pnlScalingFactor: number = 10
    ): void {
        const pnlWeight = 1 + Math.abs(pnl) * pnlScalingFactor;

        // Store as two separate samples (one for UP, one for DOWN)
        const upError = Math.abs(predictedUpPrice - actualUpPrice);
        this.add({
            timestamp: Date.now(),
            features: { ...features, _direction: 1 }, // 1 = UP
            target: actualUpPrice,
            outcome,
            modelType: 'fairValue',
            weight: pnlWeight,
            error: upError,
            pnl,
            pnlWeight,
        });

        const downError = Math.abs(predictedDownPrice - actualDownPrice);
        this.add({
            timestamp: Date.now(),
            features: { ...features, _direction: 0 }, // 0 = DOWN
            target: actualDownPrice,
            outcome,
            modelType: 'fairValue',
            weight: pnlWeight,
            error: downError,
            pnl,
            pnlWeight,
        });
    }

    /**
     * Creates a training sample for exit model.
     */
    addExitSample(
        features: Record<string, number>,
        actualFillPrice: number,
        filled: boolean,
        suggestedPrice: number
    ): void {
        const error = filled ? Math.abs(suggestedPrice - actualFillPrice) : 0.1;
        this.add({
            timestamp: Date.now(),
            features,
            target: actualFillPrice,
            outcome: filled ? 'positive' : 'negative',
            modelType: 'exit',
            weight: 1.0,
            error,
        });
    }

    /**
     * Creates a training sample for timeout model.
     */
    addTimeoutSample(
        features: Record<string, number>,
        isBuy: boolean,
        filled: boolean,
        actualWaitTimeMs: number,
        predictedTimeoutMs: number
    ): void {
        const normalizedTarget = actualWaitTimeMs / 120000; // Normalize to [0, 1] assuming max 2min
        const normalizedPredicted = predictedTimeoutMs / 120000;
        const error = Math.abs(normalizedTarget - normalizedPredicted);

        this.add({
            timestamp: Date.now(),
            features: { ...features, _isBuy: isBuy ? 1 : 0 },
            target: normalizedTarget,
            outcome: filled ? 'positive' : 'negative',
            modelType: 'timeout',
            weight: 1.0,
            error,
        });
    }

    /**
     * Creates training samples for exit model from simulation data.
     * Generates multiple samples from multi-level simulation outcomes.
     *
     * Simulation type encoding:
     * - 1 = exitLevel (individual level outcome)
     * - 2 = exitBest (best achieved offset summary)
     */
    addExitSimulationSample(
        features: Record<string, number>,
        simulatedLevels: Array<{
            offsetFromMid: number;
            wasHit: boolean;
            firstHitTimeMs: number | null;
        }>,
        direction: 'UP' | 'DOWN',
        weight: number = 0.8
    ): void {
        // Add a sample for each simulated level
        for (const level of simulatedLevels) {
            const levelFeatures: Record<string, number> = {
                ...features,
                _simulationType: 1, // exitLevel
                _direction: direction === 'UP' ? 1 : 0,
                _targetOffset: level.offsetFromMid,
            };

            // Target is 1 for hit, 0 for not hit (classification target)
            // Weight faster hits more heavily
            const hitWeight = level.wasHit && level.firstHitTimeMs !== null
                ? weight * Math.exp(-level.firstHitTimeMs / 60000)
                : weight;

            this.add({
                timestamp: Date.now(),
                features: levelFeatures,
                target: level.wasHit ? 1 : 0,
                outcome: level.wasHit ? 'positive' : 'negative',
                modelType: 'exit',
                weight: hitWeight,
                error: 0, // Will be updated during training
            });
        }

        // Also add a summary sample with the best achieved offset
        const hitLevels = simulatedLevels.filter(l => l.wasHit);
        if (hitLevels.length > 0) {
            const bestOffset = Math.max(...hitLevels.map(l => l.offsetFromMid));
            this.add({
                timestamp: Date.now(),
                features: {
                    ...features,
                    _simulationType: 2, // exitBest
                    _direction: direction === 'UP' ? 1 : 0,
                    _bestOffset: bestOffset,
                },
                target: bestOffset,
                outcome: 'positive',
                modelType: 'exit',
                weight: weight,
                error: 0,
            });
        }
    }

    /**
     * Samples a mini-batch using prioritized replay.
     * Samples are weighted by recency and error magnitude.
     * Uses reservoir sampling with weights for unbiased selection.
     */
    sampleBatch(batchSize?: number): TrainingSample[] {
        const size = batchSize ?? this.miniBatchSize;
        if (this.buffer.length === 0) return [];
        if (this.buffer.length <= size) return [...this.buffer];

        // Calculate sampling weights
        const now = Date.now();
        const weights = this.buffer.map((sample, index) => {
            // Recency score: exponential decay, recent samples have higher weight
            const ageMs = now - sample.timestamp;
            const recencyScore = Math.exp(-ageMs / (60 * 60 * 1000)); // 1-hour half-life

            // Error score: higher error = more likely to resample
            const errorScore = Math.min(1, (sample.error ?? 0) * 10);

            // Position score: later in buffer = more recent addition
            const positionScore = index / this.buffer.length;

            // Combined weight
            const weight = this.recencyWeight * (recencyScore + positionScore) / 2 +
                          this.errorWeight * errorScore;

            return Math.max(this.minWeight, weight);
        });

        // Use weighted reservoir sampling (A-Res algorithm)
        // This ensures unbiased weighted sampling without replacement
        const indexed = this.buffer.map((sample, i) => ({
            sample,
            weight: weights[i],
            // Key for A-Res: random^(1/weight) - higher weight = higher key on average
            key: Math.pow(Math.random(), 1 / weights[i]),
        }));

        // Sort by key descending and take top 'size' elements
        indexed.sort((a, b) => b.key - a.key);

        return indexed.slice(0, size).map(item => item.sample);
    }

    /**
     * Samples by model type.
     */
    sampleByType(modelType: 'fairValue' | 'exit' | 'timeout', batchSize?: number): TrainingSample[] {
        const filtered = this.buffer.filter(s => s.modelType === modelType);
        if (filtered.length === 0) return [];

        const size = Math.min(batchSize ?? this.miniBatchSize, filtered.length);

        // Simple random sampling from filtered set
        const shuffled = [...filtered].sort(() => Math.random() - 0.5);
        return shuffled.slice(0, size);
    }

    /**
     * Samples only positive outcomes (successful trades).
     */
    samplePositive(batchSize?: number): TrainingSample[] {
        const positive = this.buffer.filter(s => s.outcome === 'positive');
        if (positive.length === 0) return [];

        const size = Math.min(batchSize ?? this.miniBatchSize, positive.length);
        const shuffled = [...positive].sort(() => Math.random() - 0.5);
        return shuffled.slice(0, size);
    }

    /**
     * Samples balanced mix of positive and negative outcomes.
     */
    sampleBalanced(batchSize?: number): TrainingSample[] {
        const size = batchSize ?? this.miniBatchSize;
        const positive = this.buffer.filter(s => s.outcome === 'positive');
        const negative = this.buffer.filter(s => s.outcome === 'negative');

        const halfSize = Math.floor(size / 2);
        const posCount = Math.min(halfSize, positive.length);
        const negCount = Math.min(size - posCount, negative.length);

        const shuffledPos = [...positive].sort(() => Math.random() - 0.5);
        const shuffledNeg = [...negative].sort(() => Math.random() - 0.5);

        return [
            ...shuffledPos.slice(0, posCount),
            ...shuffledNeg.slice(0, negCount),
        ];
    }

    /**
     * Returns buffer statistics.
     */
    getStats(): {
        size: number;
        maxSize: number;
        byType: Record<string, number>;
        byOutcome: Record<string, number>;
        oldestTimestamp: number;
        newestTimestamp: number;
    } {
        const byType: Record<string, number> = { fairValue: 0, exit: 0, timeout: 0 };
        const byOutcome: Record<string, number> = { positive: 0, negative: 0, neutral: 0 };
        let oldest = Infinity;
        let newest = 0;

        for (const sample of this.buffer) {
            byType[sample.modelType] = (byType[sample.modelType] ?? 0) + 1;
            byOutcome[sample.outcome] = (byOutcome[sample.outcome] ?? 0) + 1;
            oldest = Math.min(oldest, sample.timestamp);
            newest = Math.max(newest, sample.timestamp);
        }

        return {
            size: this.buffer.length,
            maxSize: this.maxSize,
            byType,
            byOutcome,
            oldestTimestamp: oldest === Infinity ? 0 : oldest,
            newestTimestamp: newest,
        };
    }

    /**
     * Clears all samples from the buffer.
     */
    clear(): void {
        this.buffer = [];
    }

    /**
     * Updates the error for a sample (for prioritized replay adjustments).
     */
    updateError(sampleId: string, newError: number): void {
        const sample = this.buffer.find(s => s.id === sampleId);
        if (sample) {
            sample.error = newError;
        }
    }

    /**
     * Saves buffer to disk for persistence.
     */
    save(): void {
        try {
            const data = {
                version: '1.0',
                sampleCounter: this.sampleCounter,
                maxSize: this.maxSize,
                miniBatchSize: this.miniBatchSize,
                buffer: this.buffer,
                savedAt: new Date().toISOString(),
            };
            writeFileSync(this.savePath, JSON.stringify(data, null, 2));
        } catch (e) {
            console.error(`[ExperienceReplayBuffer] Failed to save: ${e}`);
        }
    }

    /**
     * Loads buffer from disk if file exists.
     */
    loadIfExists(): boolean {
        if (!existsSync(this.savePath)) return false;

        try {
            const content = readFileSync(this.savePath, 'utf-8');
            const data = JSON.parse(content);

            this.sampleCounter = data.sampleCounter ?? 0;
            this.buffer = data.buffer ?? [];

            // Enforce max size on load
            while (this.buffer.length > this.maxSize) {
                this.buffer.shift();
            }

            console.log(`[ExperienceReplayBuffer] Loaded ${this.buffer.length} samples from ${this.savePath}`);
            return true;
        } catch (e) {
            console.warn(`[ExperienceReplayBuffer] Failed to load: ${e}`);
            return false;
        }
    }

    /**
     * Returns the current buffer size.
     */
    size(): number {
        return this.buffer.length;
    }

    /**
     * Returns all samples (for debugging/analysis).
     */
    getAll(): TrainingSample[] {
        return [...this.buffer];
    }
}
