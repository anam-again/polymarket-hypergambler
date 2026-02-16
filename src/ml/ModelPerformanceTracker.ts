import { writeFileSync, existsSync, readFileSync } from 'fs';

/**
 * Record of a single prediction for performance tracking.
 */
export interface PredictionRecord {
    timestamp: number;
    predicted: number;
    actual: number;
    error: number;
    absoluteError: number;
    squaredError: number;
    direction: 'correct' | 'incorrect' | 'neutral';
    features?: Record<string, number>;
}

/**
 * Performance metrics for the model.
 */
export interface PerformanceMetrics {
    mae: number;                       // Mean Absolute Error
    mse: number;                       // Mean Squared Error
    rmse: number;                      // Root Mean Squared Error
    directionalAccuracy: number;       // % correct direction predictions
    sharpeRatio: number;               // Risk-adjusted performance
    recentTrend: 'improving' | 'stable' | 'degrading';
    sampleCount: number;
    avgError: number;
    maxError: number;
    minError: number;
    errorStdDev: number;
}

/**
 * Alert configuration for performance degradation.
 */
export interface AlertThresholds {
    maxMae: number;                    // Alert if MAE exceeds this
    degradationRate: number;           // Alert if recent error > historical by this ratio
    minSamplesForAlert: number;        // Minimum samples before alerts enabled
}

/**
 * Model Performance Tracker
 *
 * Tracks predictions and outcomes to:
 * - Calculate real-time performance metrics (MAE, MSE, RMSE)
 * - Detect performance trends (improving/stable/degrading)
 * - Trigger alerts when performance degrades
 * - Analyze feature correlations with errors
 * - Support adaptive learning rate adjustments
 */
export class ModelPerformanceTracker {
    private predictions: PredictionRecord[] = [];
    private windowSize: number;
    private alertThresholds: AlertThresholds;
    private modelName: string;
    private savePath: string;

    // Trend detection parameters
    private readonly trendWindow: number = 20;  // Last N samples for trend
    private readonly trendThreshold: number = 0.1;  // 10% change = significant

    constructor(
        modelName: string = 'model',
        windowSize: number = 100,
        alertThresholds?: Partial<AlertThresholds>,
        savePath?: string
    ) {
        this.modelName = modelName;
        this.windowSize = windowSize;
        this.savePath = savePath ?? `./models/${modelName}_performance.json`;
        this.alertThresholds = {
            maxMae: alertThresholds?.maxMae ?? 0.1,
            degradationRate: alertThresholds?.degradationRate ?? 1.5,
            minSamplesForAlert: alertThresholds?.minSamplesForAlert ?? 50,
        };
    }

    /**
     * Records a prediction outcome.
     * @param predicted The predicted value
     * @param actual The actual observed value
     * @param features Optional features for correlation analysis
     */
    record(predicted: number, actual: number, features?: Record<string, number>): void {
        const error = predicted - actual;
        const absoluteError = Math.abs(error);
        const squaredError = error * error;

        // Determine direction correctness
        // For price predictions: if both moved in same direction relative to 0.5 midpoint
        let direction: 'correct' | 'incorrect' | 'neutral';
        const predictedDirection = predicted > 0.5 ? 1 : predicted < 0.5 ? -1 : 0;
        const actualDirection = actual > 0.5 ? 1 : actual < 0.5 ? -1 : 0;

        if (predictedDirection === 0 || actualDirection === 0) {
            direction = 'neutral';
        } else if (predictedDirection === actualDirection) {
            direction = 'correct';
        } else {
            direction = 'incorrect';
        }

        const record: PredictionRecord = {
            timestamp: Date.now(),
            predicted,
            actual,
            error,
            absoluteError,
            squaredError,
            direction,
            features: features ? { ...features } : undefined,
        };

        this.predictions.push(record);

        // Maintain window size
        while (this.predictions.length > this.windowSize) {
            this.predictions.shift();
        }
    }

    /**
     * Records a prediction with signed error (for models where direction matters).
     */
    recordWithDirection(
        predicted: number,
        actual: number,
        predictedDirection: number,
        actualDirection: number,
        features?: Record<string, number>
    ): void {
        const error = predicted - actual;
        const absoluteError = Math.abs(error);
        const squaredError = error * error;

        let direction: 'correct' | 'incorrect' | 'neutral';
        if (predictedDirection === 0 || actualDirection === 0) {
            direction = 'neutral';
        } else if (Math.sign(predictedDirection) === Math.sign(actualDirection)) {
            direction = 'correct';
        } else {
            direction = 'incorrect';
        }

        const record: PredictionRecord = {
            timestamp: Date.now(),
            predicted,
            actual,
            error,
            absoluteError,
            squaredError,
            direction,
            features: features ? { ...features } : undefined,
        };

        this.predictions.push(record);

        while (this.predictions.length > this.windowSize) {
            this.predictions.shift();
        }
    }

    /**
     * Calculates current performance metrics.
     */
    getMetrics(): PerformanceMetrics {
        if (this.predictions.length === 0) {
            return {
                mae: 0,
                mse: 0,
                rmse: 0,
                directionalAccuracy: 0.5,
                sharpeRatio: 0,
                recentTrend: 'stable',
                sampleCount: 0,
                avgError: 0,
                maxError: 0,
                minError: 0,
                errorStdDev: 0,
            };
        }

        const n = this.predictions.length;
        let sumAbsError = 0;
        let sumSqError = 0;
        let directionalCorrect = 0;
        let directionalTotal = 0;
        let minError = Infinity;
        let maxError = -Infinity;
        const errors: number[] = [];

        for (const p of this.predictions) {
            sumAbsError += p.absoluteError;
            sumSqError += p.squaredError;
            errors.push(p.absoluteError);

            minError = Math.min(minError, p.absoluteError);
            maxError = Math.max(maxError, p.absoluteError);

            if (p.direction !== 'neutral') {
                directionalTotal++;
                if (p.direction === 'correct') {
                    directionalCorrect++;
                }
            }
        }

        const mae = sumAbsError / n;
        const mse = sumSqError / n;
        const rmse = Math.sqrt(mse);
        const directionalAccuracy = directionalTotal > 0 ? directionalCorrect / directionalTotal : 0.5;
        const avgError = errors.reduce((a, b) => a + b, 0) / n;

        // Standard deviation of errors
        const errorVariance = errors.reduce((sum, e) => sum + (e - avgError) ** 2, 0) / n;
        const errorStdDev = Math.sqrt(errorVariance);

        // Sharpe ratio: average error improvement / error volatility
        // Higher = more consistent performance
        const sharpeRatio = errorStdDev > 0 ? -mae / errorStdDev : 0;

        // Determine trend
        const recentTrend = this.detectTrend();

        return {
            mae,
            mse,
            rmse,
            directionalAccuracy,
            sharpeRatio,
            recentTrend,
            sampleCount: n,
            avgError,
            maxError: maxError === -Infinity ? 0 : maxError,
            minError: minError === Infinity ? 0 : minError,
            errorStdDev,
        };
    }

    /**
     * Detects whether performance is improving, stable, or degrading.
     */
    private detectTrend(): 'improving' | 'stable' | 'degrading' {
        if (this.predictions.length < this.trendWindow * 2) {
            return 'stable';
        }

        // Compare recent errors to older errors
        const recent = this.predictions.slice(-this.trendWindow);
        const older = this.predictions.slice(-this.trendWindow * 2, -this.trendWindow);

        const recentMae = recent.reduce((sum, p) => sum + p.absoluteError, 0) / recent.length;
        const olderMae = older.reduce((sum, p) => sum + p.absoluteError, 0) / older.length;

        const changeRatio = olderMae > 0 ? (recentMae - olderMae) / olderMae : 0;

        if (changeRatio < -this.trendThreshold) {
            return 'improving';
        } else if (changeRatio > this.trendThreshold) {
            return 'degrading';
        } else {
            return 'stable';
        }
    }

    /**
     * Returns true if an alert should be raised.
     */
    shouldAlert(): boolean {
        if (this.predictions.length < this.alertThresholds.minSamplesForAlert) {
            return false;
        }

        const metrics = this.getMetrics();

        // Alert if MAE exceeds threshold
        if (metrics.mae > this.alertThresholds.maxMae) {
            return true;
        }

        // Alert if performance is degrading significantly
        if (metrics.recentTrend === 'degrading') {
            const recent = this.predictions.slice(-this.trendWindow);
            const historical = this.predictions.slice(0, -this.trendWindow);

            if (historical.length > 0) {
                const recentMae = recent.reduce((sum, p) => sum + p.absoluteError, 0) / recent.length;
                const historicalMae = historical.reduce((sum, p) => sum + p.absoluteError, 0) / historical.length;

                if (recentMae > historicalMae * this.alertThresholds.degradationRate) {
                    return true;
                }
            }
        }

        return false;
    }

    /**
     * Returns alert details if an alert is active.
     */
    getAlertDetails(): { reason: string; metrics: PerformanceMetrics } | null {
        if (!this.shouldAlert()) return null;

        const metrics = this.getMetrics();
        let reason = '';

        if (metrics.mae > this.alertThresholds.maxMae) {
            reason = `MAE ${metrics.mae.toFixed(4)} exceeds threshold ${this.alertThresholds.maxMae}`;
        } else if (metrics.recentTrend === 'degrading') {
            reason = `Performance degrading: recent trend shows increasing errors`;
        }

        return { reason, metrics };
    }

    /**
     * Analyzes correlation between features and prediction errors.
     * Returns features ranked by their correlation with errors.
     */
    getFeatureCorrelations(): Map<string, number> {
        const correlations = new Map<string, number>();

        // Collect feature values and errors
        const featuresWithErrors: { features: Record<string, number>; error: number }[] = [];
        for (const p of this.predictions) {
            if (p.features) {
                featuresWithErrors.push({ features: p.features, error: p.absoluteError });
            }
        }

        if (featuresWithErrors.length < 10) {
            return correlations;
        }

        // Get all feature names
        const featureNames = new Set<string>();
        for (const { features } of featuresWithErrors) {
            for (const key of Object.keys(features)) {
                if (!key.startsWith('_')) {  // Skip internal features
                    featureNames.add(key);
                }
            }
        }

        // Calculate correlation for each feature
        for (const featureName of featureNames) {
            const pairs: { x: number; y: number }[] = [];
            for (const { features, error } of featuresWithErrors) {
                if (features[featureName] !== undefined) {
                    pairs.push({ x: features[featureName], y: error });
                }
            }

            if (pairs.length >= 10) {
                const correlation = this.pearsonCorrelation(pairs);
                correlations.set(featureName, correlation);
            }
        }

        return correlations;
    }

    /**
     * Calculates Pearson correlation coefficient.
     */
    private pearsonCorrelation(pairs: { x: number; y: number }[]): number {
        const n = pairs.length;
        if (n < 2) return 0;

        const sumX = pairs.reduce((s, p) => s + p.x, 0);
        const sumY = pairs.reduce((s, p) => s + p.y, 0);
        const sumXY = pairs.reduce((s, p) => s + p.x * p.y, 0);
        const sumX2 = pairs.reduce((s, p) => s + p.x * p.x, 0);
        const sumY2 = pairs.reduce((s, p) => s + p.y * p.y, 0);

        const numerator = n * sumXY - sumX * sumY;
        const denominator = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));

        if (denominator === 0) return 0;
        return numerator / denominator;
    }

    /**
     * Returns features most correlated with high errors (for debugging).
     */
    getProblematicFeatures(topN: number = 5): Array<{ feature: string; correlation: number }> {
        const correlations = this.getFeatureCorrelations();
        const sorted = Array.from(correlations.entries())
            .map(([feature, correlation]) => ({ feature, correlation }))
            .sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation))
            .slice(0, topN);

        return sorted;
    }

    /**
     * Returns the rolling MAE over time for visualization.
     */
    getRollingMae(windowSize: number = 10): number[] {
        if (this.predictions.length < windowSize) return [];

        const result: number[] = [];
        for (let i = windowSize - 1; i < this.predictions.length; i++) {
            const window = this.predictions.slice(i - windowSize + 1, i + 1);
            const mae = window.reduce((sum, p) => sum + p.absoluteError, 0) / windowSize;
            result.push(mae);
        }

        return result;
    }

    /**
     * Exports all predictions to JSON for analysis.
     */
    exportToJson(path?: string): void {
        try {
            const exportPath = path ?? this.savePath.replace('.json', '_export.json');
            const data = {
                modelName: this.modelName,
                exportedAt: new Date().toISOString(),
                metrics: this.getMetrics(),
                predictions: this.predictions,
                featureCorrelations: Object.fromEntries(this.getFeatureCorrelations()),
            };
            writeFileSync(exportPath, JSON.stringify(data, null, 2));
        } catch (e) {
            console.error(`[ModelPerformanceTracker:${this.modelName}] Failed to export: ${e}`);
        }
    }

    /**
     * Saves tracker state to disk.
     */
    save(): void {
        try {
            const data = {
                version: '1.0',
                modelName: this.modelName,
                windowSize: this.windowSize,
                alertThresholds: this.alertThresholds,
                predictions: this.predictions,
                savedAt: new Date().toISOString(),
            };
            writeFileSync(this.savePath, JSON.stringify(data, null, 2));
        } catch (e) {
            console.error(`[ModelPerformanceTracker:${this.modelName}] Failed to save: ${e}`);
        }
    }

    /**
     * Loads tracker state from disk if file exists.
     */
    loadIfExists(): boolean {
        if (!existsSync(this.savePath)) return false;

        try {
            const content = readFileSync(this.savePath, 'utf-8');
            const data = JSON.parse(content);

            this.predictions = data.predictions ?? [];

            // Enforce window size
            while (this.predictions.length > this.windowSize) {
                this.predictions.shift();
            }

            console.log(`[ModelPerformanceTracker:${this.modelName}] Loaded ${this.predictions.length} records`);
            return true;
        } catch (e) {
            console.warn(`[ModelPerformanceTracker:${this.modelName}] Failed to load: ${e}`);
            return false;
        }
    }

    /**
     * Clears all prediction history.
     */
    clear(): void {
        this.predictions = [];
    }

    /**
     * Returns the number of tracked predictions.
     */
    size(): number {
        return this.predictions.length;
    }
}
