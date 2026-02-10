// ============================================================================
// DecisionDataCollector - Training Data Collection for Decision Networks
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import { FeatureVector, DecisionOutputs, LabeledSample } from './DecisionNetwork.js';

/**
 * Trade outcome recorded after a trade completes.
 */
export interface TradeOutcome {
    /** Profit/loss from the trade */
    pnl: number;
    /** Whether the trade completed successfully (matched) */
    tradeCompleted: boolean;
    /** Time held in milliseconds */
    holdTimeMs: number;
    /** Buy price */
    buyPrice?: number;
    /** Sell price */
    sellPrice?: number;
    /** Trade direction */
    direction?: 'UP' | 'DOWN';
}

/**
 * Pending decision waiting for outcome.
 */
interface PendingDecision {
    features: FeatureVector;
    decisions: DecisionOutputs;
    timestamp: number;
    tradeId: string;
}

/**
 * DecisionDataCollector - Collects training data from bot decisions and outcomes.
 *
 * Attach this to a bot or simulator to collect:
 * 1. Features at decision time
 * 2. Parameters used for the decision
 * 3. Outcome of the trade (PnL, completion, hold time)
 *
 * This data can then be used to train a DecisionNetwork.
 */
export class DecisionDataCollector {
    private samples: LabeledSample[] = [];
    private pendingDecisions: Map<string, PendingDecision> = new Map();
    private saveDirectory: string;

    constructor(saveDirectory: string = './data/decision-samples') {
        this.saveDirectory = saveDirectory;
    }

    /**
     * Records a decision at the time it's made.
     * Call this when a bot makes a trading decision.
     *
     * @param tradeId - Unique identifier for the trade
     * @param features - Market features at decision time
     * @param decisions - Parameter values used for the decision
     */
    onDecision(tradeId: string, features: FeatureVector, decisions: DecisionOutputs): void {
        this.pendingDecisions.set(tradeId, {
            features,
            decisions,
            timestamp: Date.now(),
            tradeId,
        });
    }

    /**
     * Records the outcome of a trade.
     * Call this when a trade completes (matched, expired, or cancelled).
     *
     * @param tradeId - Unique identifier for the trade
     * @param outcome - Trade outcome data
     */
    onTradeComplete(tradeId: string, outcome: TradeOutcome): void {
        const pending = this.pendingDecisions.get(tradeId);
        if (!pending) {
            console.warn(`[DecisionDataCollector] No pending decision for trade ${tradeId}`);
            return;
        }

        // Create labeled sample
        const sample: LabeledSample = {
            features: pending.features,
            decisions: pending.decisions,
            outcome: {
                pnl: outcome.pnl,
                tradeCompleted: outcome.tradeCompleted,
                holdTimeMs: outcome.holdTimeMs,
            },
        };

        this.samples.push(sample);
        this.pendingDecisions.delete(tradeId);
    }

    /**
     * Gets all collected samples.
     */
    getSamples(): LabeledSample[] {
        return [...this.samples];
    }

    /**
     * Gets the number of collected samples.
     */
    getSampleCount(): number {
        return this.samples.length;
    }

    /**
     * Gets the number of pending decisions.
     */
    getPendingCount(): number {
        return this.pendingDecisions.size;
    }

    /**
     * Clears pending decisions older than maxAge milliseconds.
     */
    cleanupStaleDecisions(maxAgeMs: number = 3600000): number {
        const now = Date.now();
        let removed = 0;

        for (const [id, decision] of this.pendingDecisions.entries()) {
            if (now - decision.timestamp > maxAgeMs) {
                this.pendingDecisions.delete(id);
                removed++;
            }
        }

        return removed;
    }

    /**
     * Clears all collected samples.
     */
    clearSamples(): void {
        this.samples = [];
    }

    /**
     * Saves samples to a file.
     */
    saveToFile(filename?: string): string {
        // Ensure directory exists
        if (!fs.existsSync(this.saveDirectory)) {
            fs.mkdirSync(this.saveDirectory, { recursive: true });
        }

        const name = filename ?? `samples-${Date.now()}.json`;
        const filepath = path.join(this.saveDirectory, name);

        const data = {
            version: '1.0',
            collectedAt: new Date().toISOString(),
            sampleCount: this.samples.length,
            samples: this.samples,
        };

        fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
        console.log(`[DecisionDataCollector] Saved ${this.samples.length} samples to ${filepath}`);

        return filepath;
    }

    /**
     * Loads samples from a file.
     */
    loadFromFile(filepath: string): number {
        if (!fs.existsSync(filepath)) {
            console.warn(`[DecisionDataCollector] File not found: ${filepath}`);
            return 0;
        }

        const content = fs.readFileSync(filepath, 'utf-8');
        const data = JSON.parse(content) as {
            version: string;
            samples: LabeledSample[];
        };

        const loadedCount = data.samples.length;
        this.samples.push(...data.samples);

        console.log(`[DecisionDataCollector] Loaded ${loadedCount} samples from ${filepath}`);
        return loadedCount;
    }

    /**
     * Loads all sample files from the save directory.
     */
    loadAllFromDirectory(): number {
        if (!fs.existsSync(this.saveDirectory)) {
            return 0;
        }

        const files = fs.readdirSync(this.saveDirectory).filter((f) => f.endsWith('.json'));

        let totalLoaded = 0;
        for (const file of files) {
            const filepath = path.join(this.saveDirectory, file);
            totalLoaded += this.loadFromFile(filepath);
        }

        return totalLoaded;
    }

    /**
     * Gets summary statistics about collected samples.
     */
    getStats(): DecisionDataStats {
        const samples = this.samples;
        const n = samples.length;

        if (n === 0) {
            return {
                sampleCount: 0,
                completedTrades: 0,
                incompleteTrades: 0,
                totalPnL: 0,
                averagePnL: 0,
                winRate: 0,
                avgHoldTime: 0,
                pnlDistribution: { min: 0, max: 0, median: 0, stdDev: 0 },
            };
        }

        let completedTrades = 0;
        let totalPnL = 0;
        let winningTrades = 0;
        let totalHoldTime = 0;
        const pnls: number[] = [];

        for (const sample of samples) {
            if (sample.outcome.tradeCompleted) {
                completedTrades++;
            }
            totalPnL += sample.outcome.pnl;
            pnls.push(sample.outcome.pnl);
            if (sample.outcome.pnl > 0) {
                winningTrades++;
            }
            totalHoldTime += sample.outcome.holdTimeMs;
        }

        // Calculate PnL distribution
        pnls.sort((a, b) => a - b);
        const mean = totalPnL / n;
        const variance = pnls.reduce((sum, p) => sum + Math.pow(p - mean, 2), 0) / n;

        return {
            sampleCount: n,
            completedTrades,
            incompleteTrades: n - completedTrades,
            totalPnL,
            averagePnL: totalPnL / n,
            winRate: n > 0 ? winningTrades / n : 0,
            avgHoldTime: totalHoldTime / n,
            pnlDistribution: {
                min: pnls[0] ?? 0,
                max: pnls[n - 1] ?? 0,
                median: pnls[Math.floor(n / 2)] ?? 0,
                stdDev: Math.sqrt(variance),
            },
        };
    }

    /**
     * Filters samples based on criteria.
     */
    filterSamples(criteria: {
        minPnL?: number;
        maxPnL?: number;
        completedOnly?: boolean;
        minHoldTime?: number;
        maxHoldTime?: number;
    }): LabeledSample[] {
        return this.samples.filter((sample) => {
            if (criteria.minPnL !== undefined && sample.outcome.pnl < criteria.minPnL) {
                return false;
            }
            if (criteria.maxPnL !== undefined && sample.outcome.pnl > criteria.maxPnL) {
                return false;
            }
            if (criteria.completedOnly && !sample.outcome.tradeCompleted) {
                return false;
            }
            if (criteria.minHoldTime !== undefined && sample.outcome.holdTimeMs < criteria.minHoldTime) {
                return false;
            }
            if (criteria.maxHoldTime !== undefined && sample.outcome.holdTimeMs > criteria.maxHoldTime) {
                return false;
            }
            return true;
        });
    }

    /**
     * Applies outcome-based weighting to samples.
     * Higher PnL trades get higher weights.
     */
    applyOutcomeWeighting(config: {
        positiveMultiplier?: number;
        negativeWeight?: number;
        pnlScale?: number;
    } = {}): void {
        const positiveMultiplier = config.positiveMultiplier ?? 1;
        const negativeWeight = config.negativeWeight ?? 0.3;
        const pnlScale = config.pnlScale ?? 10;

        for (const sample of this.samples) {
            if (sample.outcome.pnl > 0) {
                sample.weight = positiveMultiplier + sample.outcome.pnl / pnlScale;
            } else {
                sample.weight = negativeWeight;
            }
        }
    }
}

/**
 * Statistics about collected decision data.
 */
export interface DecisionDataStats {
    sampleCount: number;
    completedTrades: number;
    incompleteTrades: number;
    totalPnL: number;
    averagePnL: number;
    winRate: number;
    avgHoldTime: number;
    pnlDistribution: {
        min: number;
        max: number;
        median: number;
        stdDev: number;
    };
}
