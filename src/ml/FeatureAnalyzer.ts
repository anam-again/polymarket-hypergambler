import { FairValueModel } from './FairValueModel.js';
import { MLPFairValueModel } from './MLPFairValueModel.js';
import { ModelPerformanceTracker } from './ModelPerformanceTracker.js';
import { ExperienceReplayBuffer } from './ExperienceReplayBuffer.js';
import { writeFileSync } from 'fs';

/**
 * Feature importance from different analysis methods.
 */
export interface FeatureImportanceResult {
    featureName: string;
    // Linear model weights (direct interpretability)
    linearWeightUp: number;
    linearWeightDown: number;
    linearWeightAvg: number;
    // MLP importance (gradient-based)
    mlpImportance: number | null;
    // Error correlation (negative = feature helps reduce error)
    errorCorrelation: number | null;
    // Combined score (normalized)
    combinedScore: number;
    // Rank
    rank: number;
}

/**
 * Feature statistics from training data.
 */
export interface FeatureStatistics {
    featureName: string;
    mean: number;
    std: number;
    min: number;
    max: number;
    percentile25: number;
    percentile75: number;
    nonZeroRatio: number;  // % of samples where feature is non-zero
}

/**
 * Feature Analyzer
 *
 * Provides comprehensive analysis of feature importance across all models.
 * Useful for:
 * - Understanding which features drive predictions
 * - Identifying useless or harmful features
 * - Feature selection and engineering decisions
 */
export class FeatureAnalyzer {
    private static readonly FEATURE_NAMES = [
        // Binance price features (17)
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
    ];

    /**
     * Analyzes feature importance across all available models.
     */
    static analyzeImportance(
        linearModel: FairValueModel,
        mlpModel?: MLPFairValueModel | null,
        performanceTracker?: ModelPerformanceTracker | null,
        replayBuffer?: ExperienceReplayBuffer | null
    ): FeatureImportanceResult[] {
        const results: FeatureImportanceResult[] = [];

        // Get linear weights
        const linearUp = linearModel.getFeatureWeights('up');
        const linearDown = linearModel.getFeatureWeights('down');

        // Get MLP importance if available
        let mlpImportance: Map<string, number> | null = null;
        if (mlpModel && replayBuffer) {
            const samples = replayBuffer.getAll()
                .filter(s => s.modelType === 'fairValue')
                .slice(0, 100)
                .map(s => ({ features: s.features }));
            if (samples.length >= 10) {
                mlpImportance = mlpModel.getFeatureImportance(samples);
            }
        }

        // Get error correlations if available
        let errorCorrelations: Map<string, number> | null = null;
        if (performanceTracker) {
            errorCorrelations = performanceTracker.getFeatureCorrelations();
        }

        // Collect raw scores for normalization
        const rawScores: number[] = [];

        for (const featureName of this.FEATURE_NAMES) {
            const linearWeightUp = linearUp[featureName] ?? 0;
            const linearWeightDown = linearDown[featureName] ?? 0;
            const linearWeightAvg = (Math.abs(linearWeightUp) + Math.abs(linearWeightDown)) / 2;

            const mlpImp = mlpImportance?.get(featureName) ?? null;
            const errorCorr = errorCorrelations?.get(featureName) ?? null;

            // Combined score: weighted average of available metrics
            let combinedScore = 0;
            let weightSum = 0;

            // Linear weight contribution (always available)
            combinedScore += linearWeightAvg * 1.0;
            weightSum += 1.0;

            // MLP importance contribution
            if (mlpImp !== null) {
                combinedScore += mlpImp * 0.8;
                weightSum += 0.8;
            }

            // Error correlation (negative correlation = good)
            // We want features that REDUCE error, so negate
            if (errorCorr !== null) {
                combinedScore += Math.abs(errorCorr) * 0.5;
                weightSum += 0.5;
            }

            combinedScore = weightSum > 0 ? combinedScore / weightSum : 0;
            rawScores.push(combinedScore);

            results.push({
                featureName,
                linearWeightUp,
                linearWeightDown,
                linearWeightAvg,
                mlpImportance: mlpImp,
                errorCorrelation: errorCorr,
                combinedScore,
                rank: 0,  // Will be set after sorting
            });
        }

        // Normalize combined scores to [0, 1]
        const maxScore = Math.max(...rawScores, 0.001);
        for (const result of results) {
            result.combinedScore = result.combinedScore / maxScore;
        }

        // Sort by combined score and assign ranks
        results.sort((a, b) => b.combinedScore - a.combinedScore);
        results.forEach((r, i) => r.rank = i + 1);

        return results;
    }

    /**
     * Computes statistics for each feature from the replay buffer.
     */
    static computeStatistics(replayBuffer: ExperienceReplayBuffer): FeatureStatistics[] {
        const samples = replayBuffer.getAll();
        if (samples.length === 0) return [];

        const stats: FeatureStatistics[] = [];

        for (const featureName of this.FEATURE_NAMES) {
            const values: number[] = [];

            for (const sample of samples) {
                const value = sample.features[featureName];
                if (value !== undefined && !isNaN(value)) {
                    values.push(value);
                }
            }

            if (values.length === 0) {
                stats.push({
                    featureName,
                    mean: 0,
                    std: 0,
                    min: 0,
                    max: 0,
                    percentile25: 0,
                    percentile75: 0,
                    nonZeroRatio: 0,
                });
                continue;
            }

            // Sort for percentiles
            values.sort((a, b) => a - b);

            const n = values.length;
            const mean = values.reduce((a, b) => a + b, 0) / n;
            const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / n;
            const std = Math.sqrt(variance);
            const min = values[0];
            const max = values[n - 1];
            const percentile25 = values[Math.floor(n * 0.25)];
            const percentile75 = values[Math.floor(n * 0.75)];
            const nonZeroCount = values.filter(v => Math.abs(v) > 0.0001).length;

            stats.push({
                featureName,
                mean,
                std,
                min,
                max,
                percentile25,
                percentile75,
                nonZeroRatio: nonZeroCount / n,
            });
        }

        return stats;
    }

    /**
     * Identifies potentially problematic features.
     */
    static identifyProblems(
        importance: FeatureImportanceResult[],
        statistics: FeatureStatistics[]
    ): Array<{ featureName: string; problem: string; severity: 'low' | 'medium' | 'high' }> {
        const problems: Array<{ featureName: string; problem: string; severity: 'low' | 'medium' | 'high' }> = [];

        const statsMap = new Map(statistics.map(s => [s.featureName, s]));

        for (const imp of importance) {
            const stat = statsMap.get(imp.featureName);

            // Check for high error correlation (feature may be causing bad predictions)
            if (imp.errorCorrelation !== null && imp.errorCorrelation > 0.3) {
                problems.push({
                    featureName: imp.featureName,
                    problem: `High positive error correlation (${imp.errorCorrelation.toFixed(3)}) - feature may be misleading`,
                    severity: 'high',
                });
            }

            // Check for near-zero weights (feature not being used)
            if (imp.linearWeightAvg < 0.01 && (imp.mlpImportance === null || imp.mlpImportance < 0.01)) {
                problems.push({
                    featureName: imp.featureName,
                    problem: 'Very low weight in both models - feature may be useless',
                    severity: 'low',
                });
            }

            // Check for constant features
            if (stat && stat.std < 0.0001) {
                problems.push({
                    featureName: imp.featureName,
                    problem: 'Near-constant value (std ≈ 0) - no information content',
                    severity: 'medium',
                });
            }

            // Check for mostly-zero features
            if (stat && stat.nonZeroRatio < 0.1) {
                problems.push({
                    featureName: imp.featureName,
                    problem: `Mostly zero (${(stat.nonZeroRatio * 100).toFixed(1)}% non-zero) - sparse signal`,
                    severity: 'low',
                });
            }

            // Check for extreme values
            if (stat && (stat.max > 100 || stat.min < -100)) {
                problems.push({
                    featureName: imp.featureName,
                    problem: `Extreme values (min=${stat.min.toFixed(2)}, max=${stat.max.toFixed(2)}) - may need better normalization`,
                    severity: 'medium',
                });
            }
        }

        // Sort by severity
        const severityOrder = { high: 0, medium: 1, low: 2 };
        problems.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

        return problems;
    }

    /**
     * Generates a comprehensive report.
     */
    static generateReport(
        linearModel: FairValueModel,
        mlpModel?: MLPFairValueModel | null,
        performanceTracker?: ModelPerformanceTracker | null,
        replayBuffer?: ExperienceReplayBuffer | null
    ): string {
        const lines: string[] = [];

        lines.push('=' .repeat(80));
        lines.push('FEATURE IMPORTANCE ANALYSIS REPORT');
        lines.push('=' .repeat(80));
        lines.push(`Generated: ${new Date().toISOString()}`);
        lines.push('');

        // Model info
        lines.push('MODEL INFORMATION');
        lines.push('-'.repeat(40));
        lines.push(`Linear Model Training Samples: ${linearModel.getTrainingSamples()}`);
        if (mlpModel) {
            const stats = mlpModel.getStats();
            lines.push(`MLP Model Training Epochs: ${stats.trainingEpochs}`);
            lines.push(`MLP Model Parameters: ${stats.parameterCount}`);
            lines.push(`MLP Last Training Loss: ${stats.lastTrainingLoss.toFixed(6)}`);
        }
        if (replayBuffer) {
            const stats = replayBuffer.getStats();
            lines.push(`Replay Buffer Size: ${stats.size}`);
        }
        lines.push('');

        // Feature importance
        const importance = this.analyzeImportance(linearModel, mlpModel, performanceTracker, replayBuffer);

        lines.push('FEATURE IMPORTANCE RANKING');
        lines.push('-'.repeat(80));
        lines.push(
            'Rank'.padEnd(6) +
            'Feature'.padEnd(25) +
            'Linear(Avg)'.padEnd(12) +
            'MLP'.padEnd(10) +
            'ErrCorr'.padEnd(10) +
            'Combined'
        );
        lines.push('-'.repeat(80));

        for (const imp of importance) {
            const mlpStr = imp.mlpImportance !== null ? imp.mlpImportance.toFixed(4) : 'N/A';
            const errStr = imp.errorCorrelation !== null ? imp.errorCorrelation.toFixed(4) : 'N/A';

            lines.push(
                `#${imp.rank}`.padEnd(6) +
                imp.featureName.padEnd(25) +
                imp.linearWeightAvg.toFixed(4).padEnd(12) +
                mlpStr.padEnd(10) +
                errStr.padEnd(10) +
                imp.combinedScore.toFixed(4)
            );
        }
        lines.push('');

        // Top 10 most important
        lines.push('TOP 10 MOST IMPORTANT FEATURES');
        lines.push('-'.repeat(40));
        for (let i = 0; i < 10 && i < importance.length; i++) {
            const imp = importance[i];
            lines.push(`${i + 1}. ${imp.featureName} (score: ${imp.combinedScore.toFixed(4)})`);
        }
        lines.push('');

        // Bottom 10 least important
        lines.push('BOTTOM 10 LEAST IMPORTANT FEATURES');
        lines.push('-'.repeat(40));
        const bottom = importance.slice(-10).reverse();
        for (let i = 0; i < bottom.length; i++) {
            const imp = bottom[i];
            lines.push(`${i + 1}. ${imp.featureName} (score: ${imp.combinedScore.toFixed(4)})`);
        }
        lines.push('');

        // Feature statistics
        if (replayBuffer) {
            const statistics = this.computeStatistics(replayBuffer);

            lines.push('FEATURE STATISTICS');
            lines.push('-'.repeat(90));
            lines.push(
                'Feature'.padEnd(25) +
                'Mean'.padEnd(12) +
                'Std'.padEnd(12) +
                'Min'.padEnd(12) +
                'Max'.padEnd(12) +
                'NonZero%'
            );
            lines.push('-'.repeat(90));

            for (const stat of statistics) {
                lines.push(
                    stat.featureName.padEnd(25) +
                    stat.mean.toFixed(4).padEnd(12) +
                    stat.std.toFixed(4).padEnd(12) +
                    stat.min.toFixed(4).padEnd(12) +
                    stat.max.toFixed(4).padEnd(12) +
                    `${(stat.nonZeroRatio * 100).toFixed(1)}%`
                );
            }
            lines.push('');

            // Problems
            const problems = this.identifyProblems(importance, statistics);

            if (problems.length > 0) {
                lines.push('POTENTIAL ISSUES');
                lines.push('-'.repeat(40));
                for (const p of problems) {
                    const severityIcon = p.severity === 'high' ? '!!!' : p.severity === 'medium' ? '!!' : '!';
                    lines.push(`[${severityIcon}] ${p.featureName}: ${p.problem}`);
                }
                lines.push('');
            }
        }

        // Linear model detailed weights
        lines.push('LINEAR MODEL DETAILED WEIGHTS');
        lines.push('-'.repeat(60));
        lines.push('Feature'.padEnd(25) + 'UP Weight'.padEnd(15) + 'DOWN Weight');
        lines.push('-'.repeat(60));

        const upWeights = linearModel.getFeatureWeights('up');
        const downWeights = linearModel.getFeatureWeights('down');

        for (const name of this.FEATURE_NAMES) {
            lines.push(
                name.padEnd(25) +
                (upWeights[name] ?? 0).toFixed(6).padEnd(15) +
                (downWeights[name] ?? 0).toFixed(6)
            );
        }
        lines.push('');
        lines.push('=' .repeat(80));
        lines.push('END OF REPORT');
        lines.push('=' .repeat(80));

        return lines.join('\n');
    }

    /**
     * Saves the report to a file.
     */
    static saveReport(
        path: string,
        linearModel: FairValueModel,
        mlpModel?: MLPFairValueModel | null,
        performanceTracker?: ModelPerformanceTracker | null,
        replayBuffer?: ExperienceReplayBuffer | null
    ): void {
        try {
            const report = this.generateReport(linearModel, mlpModel, performanceTracker, replayBuffer);
            writeFileSync(path, report);
            console.log(`[FeatureAnalyzer] Report saved to ${path}`);
        } catch (e) {
            console.error(`[FeatureAnalyzer] Failed to save report: ${e}`);
        }
    }

    /**
     * Returns feature names grouped by category.
     */
    static getFeatureGroups(): Record<string, string[]> {
        return {
            'Price Movement': ['candle10s', 'candle20s', 'candle30s', 'candle60s', 'candle5m'],
            'Moving Averages': ['ma30s', 'ma60s', 'ma5m', 'priceVsMa'],
            'Volatility': ['volatility30s', 'volatility60s'],
            'Momentum': ['momentum'],
            'Polymarket Prices': ['upMid', 'downMid', 'upSpread', 'downSpread', 'imbalance'],
            'UP Order Book': ['upBidDepth1pct', 'upAskDepth1pct', 'upBidDepth5pct', 'upAskDepth5pct',
                             'upVolumeImbalance', 'upBidVWAP', 'upAskVWAP', 'upBookPressure'],
            'DOWN Order Book': ['downBidDepth1pct', 'downAskDepth1pct', 'downBidDepth5pct', 'downAskDepth5pct',
                               'downVolumeImbalance', 'downBidVWAP', 'downAskVWAP', 'downBookPressure'],
            'Time': ['minuteInHour', 'secondInMinute', 'timeToHourEnd', 'isFirstQuarter', 'isLastQuarter',
                    'minuteSin', 'minuteCos', 'hourSin', 'hourCos', 'periodProgress'],
            'Order Flow': ['upBidAskRatio', 'downBidAskRatio', 'upTopBidConcentration', 'upTopAskConcentration',
                          'downTopBidConcentration', 'downTopAskConcentration'],
            'Cross-Token': ['upDownCorrelation', 'upDownSpreadRatio', 'combinedLiquidity', 'imbalanceVelocity'],
        };
    }

    /**
     * Analyzes importance by feature group.
     */
    static analyzeByGroup(importance: FeatureImportanceResult[]): Map<string, number> {
        const groups = this.getFeatureGroups();
        const groupScores = new Map<string, number>();

        for (const [groupName, features] of Object.entries(groups)) {
            const groupImportance = importance.filter(i => features.includes(i.featureName));
            const avgScore = groupImportance.length > 0
                ? groupImportance.reduce((sum, i) => sum + i.combinedScore, 0) / groupImportance.length
                : 0;
            groupScores.set(groupName, avgScore);
        }

        return groupScores;
    }
}
