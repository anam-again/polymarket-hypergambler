/**
 * Market Regime Detector
 *
 * Classifies the current market into one of four regimes based on:
 * - Volatility (HIGH vs LOW)
 * - Trend direction (TRENDING vs RANGING)
 *
 * Used to adapt model behavior and parameters to current market conditions.
 */

export enum MarketRegime {
    HIGH_VOL_TRENDING = 'HIGH_VOL_TRENDING',
    HIGH_VOL_RANGING = 'HIGH_VOL_RANGING',
    LOW_VOL_TRENDING = 'LOW_VOL_TRENDING',
    LOW_VOL_RANGING = 'LOW_VOL_RANGING',
}

/**
 * Features used for regime detection.
 */
export interface RegimeFeatures {
    volatility30s: number;     // Short-term volatility
    volatility60s: number;     // Medium-term volatility
    momentum: number;          // Price momentum (candle10s - candle30s)
    trendStrength: number;     // ADX-like measure (0-1)
    priceVsMa: number;         // Price vs moving average deviation
}

/**
 * Regime history entry.
 */
interface RegimeHistoryEntry {
    timestamp: number;
    regime: MarketRegime;
    features: RegimeFeatures;
    confidence: number;
}

/**
 * Regime statistics for analysis.
 */
export interface RegimeStats {
    currentRegime: MarketRegime;
    regimeDurationMs: number;
    regimeCounts: Record<MarketRegime, number>;
    avgVolatility: number;
    avgTrendStrength: number;
    transitionCount: number;
    confidence: number;
}

export class MarketRegimeDetector {
    private currentRegime: MarketRegime = MarketRegime.LOW_VOL_RANGING;
    private regimeHistory: RegimeHistoryEntry[] = [];
    private regimeStartTime: number = Date.now();

    // Thresholds (auto-calibrated based on historical data)
    private volThreshold: number = 0.002;      // 0.2% per 30s = high volatility
    private trendThreshold: number = 0.3;      // Trend strength > 0.3 = trending

    // Minimum duration before switching regimes (prevents noise)
    private minRegimeDurationMs: number = 30000;  // 30 seconds

    // History limits
    private maxHistorySize: number = 1000;

    // Running statistics for calibration
    private volatilityHistory: number[] = [];
    private trendHistory: number[] = [];
    private readonly calibrationWindow: number = 500;

    constructor(config?: {
        volThreshold?: number;
        trendThreshold?: number;
        minRegimeDurationMs?: number;
    }) {
        if (config?.volThreshold) this.volThreshold = config.volThreshold;
        if (config?.trendThreshold) this.trendThreshold = config.trendThreshold;
        if (config?.minRegimeDurationMs) this.minRegimeDurationMs = config.minRegimeDurationMs;
    }

    /**
     * Detects the current market regime based on features.
     * Returns the detected regime (may be different from current if stable enough).
     */
    detectRegime(features: RegimeFeatures): MarketRegime {
        // Update history for calibration
        this.volatilityHistory.push(features.volatility30s);
        this.trendHistory.push(Math.abs(features.trendStrength));
        if (this.volatilityHistory.length > this.calibrationWindow) {
            this.volatilityHistory.shift();
            this.trendHistory.shift();
        }

        // Determine volatility level
        const isHighVol = features.volatility30s > this.volThreshold ||
                          features.volatility60s > this.volThreshold * 0.8;

        // Determine trend direction
        // Combine momentum and trend strength with adaptive scaling
        // Use trendThreshold as a reference for momentum scaling
        const momentumScale = this.trendThreshold > 0 ? 1 / this.trendThreshold : 10;
        const scaledMomentum = Math.min(1, Math.abs(features.momentum) * momentumScale);
        const effectiveTrend = Math.abs(features.trendStrength) * 0.6 + scaledMomentum * 0.4;
        const isTrending = effectiveTrend > this.trendThreshold;

        // Determine new regime
        let detectedRegime: MarketRegime;
        if (isHighVol && isTrending) {
            detectedRegime = MarketRegime.HIGH_VOL_TRENDING;
        } else if (isHighVol && !isTrending) {
            detectedRegime = MarketRegime.HIGH_VOL_RANGING;
        } else if (!isHighVol && isTrending) {
            detectedRegime = MarketRegime.LOW_VOL_TRENDING;
        } else {
            detectedRegime = MarketRegime.LOW_VOL_RANGING;
        }

        // Calculate confidence based on how clearly features fall into regime
        const volMargin = Math.abs(features.volatility30s - this.volThreshold) / this.volThreshold;
        const trendMargin = Math.abs(effectiveTrend - this.trendThreshold) / this.trendThreshold;
        const confidence = Math.min(1, (volMargin + trendMargin) / 2);

        // Only switch if enough time has passed (prevents noise-driven switches)
        const timeSinceLastChange = Date.now() - this.regimeStartTime;
        if (detectedRegime !== this.currentRegime && timeSinceLastChange >= this.minRegimeDurationMs) {
            this.currentRegime = detectedRegime;
            this.regimeStartTime = Date.now();
        }

        // Record history
        this.regimeHistory.push({
            timestamp: Date.now(),
            regime: this.currentRegime,
            features: { ...features },
            confidence,
        });

        // Maintain history size
        while (this.regimeHistory.length > this.maxHistorySize) {
            this.regimeHistory.shift();
        }

        return this.currentRegime;
    }

    /**
     * Updates regime without requiring all features.
     * Uses only volatility and momentum which are most commonly available.
     */
    updateFromBasicFeatures(volatility: number, momentum: number): MarketRegime {
        // Estimate trend strength from momentum
        const trendStrength = Math.min(1, Math.abs(momentum) * 10);

        return this.detectRegime({
            volatility30s: volatility,
            volatility60s: volatility * 0.9,  // Estimate
            momentum,
            trendStrength,
            priceVsMa: momentum * 5,  // Estimate
        });
    }

    /**
     * Returns the current regime.
     */
    getCurrentRegime(): MarketRegime {
        return this.currentRegime;
    }

    /**
     * Returns time spent in current regime (milliseconds).
     */
    getRegimeDuration(): number {
        return Date.now() - this.regimeStartTime;
    }

    /**
     * Auto-calibrates thresholds based on historical data.
     * Call this periodically (e.g., every hour) to adapt to changing markets.
     */
    calibrate(history?: RegimeFeatures[]): void {
        // Use provided history or internal history
        const volData = history
            ? history.map(h => h.volatility30s)
            : this.volatilityHistory;
        const trendData = history
            ? history.map(h => Math.abs(h.trendStrength))
            : this.trendHistory;

        if (volData.length < 50) return;  // Not enough data

        // Set thresholds at percentiles
        // Volatility: 60th percentile = high vol threshold
        const sortedVol = [...volData].sort((a, b) => a - b);
        this.volThreshold = sortedVol[Math.floor(sortedVol.length * 0.6)];

        // Trend: 50th percentile = trending threshold
        const sortedTrend = [...trendData].sort((a, b) => a - b);
        this.trendThreshold = sortedTrend[Math.floor(sortedTrend.length * 0.5)];

        // Ensure minimum thresholds
        this.volThreshold = Math.max(0.0005, this.volThreshold);
        this.trendThreshold = Math.max(0.1, this.trendThreshold);

        console.log(`[MarketRegimeDetector] Calibrated: volThreshold=${this.volThreshold.toFixed(5)}, trendThreshold=${this.trendThreshold.toFixed(3)}`);
    }

    /**
     * Returns statistics about regime distribution.
     */
    getStats(): RegimeStats {
        const counts: Record<MarketRegime, number> = {
            [MarketRegime.HIGH_VOL_TRENDING]: 0,
            [MarketRegime.HIGH_VOL_RANGING]: 0,
            [MarketRegime.LOW_VOL_TRENDING]: 0,
            [MarketRegime.LOW_VOL_RANGING]: 0,
        };

        let transitions = 0;
        let prevRegime: MarketRegime | null = null;
        let totalVol = 0;
        let totalTrend = 0;

        for (const entry of this.regimeHistory) {
            counts[entry.regime]++;
            totalVol += entry.features.volatility30s;
            totalTrend += Math.abs(entry.features.trendStrength);

            if (prevRegime && prevRegime !== entry.regime) {
                transitions++;
            }
            prevRegime = entry.regime;
        }

        const n = this.regimeHistory.length || 1;
        const lastEntry = this.regimeHistory[this.regimeHistory.length - 1];

        return {
            currentRegime: this.currentRegime,
            regimeDurationMs: this.getRegimeDuration(),
            regimeCounts: counts,
            avgVolatility: totalVol / n,
            avgTrendStrength: totalTrend / n,
            transitionCount: transitions,
            confidence: lastEntry?.confidence ?? 0.5,
        };
    }

    /**
     * Returns regime multipliers for model adaptation.
     * Higher volatility regimes should use smaller learning rates.
     */
    getRegimeMultipliers(): {
        learningRateMultiplier: number;
        positionSizeMultiplier: number;
        timeoutMultiplier: number;
    } {
        switch (this.currentRegime) {
            case MarketRegime.HIGH_VOL_TRENDING:
                // High vol + trend: be cautious, follow trend
                return {
                    learningRateMultiplier: 0.5,  // Slower learning
                    positionSizeMultiplier: 0.7,  // Smaller positions
                    timeoutMultiplier: 0.8,       // Shorter timeouts (fast moves)
                };
            case MarketRegime.HIGH_VOL_RANGING:
                // High vol + ranging: very cautious, lots of noise
                return {
                    learningRateMultiplier: 0.3,  // Much slower learning
                    positionSizeMultiplier: 0.5,  // Smaller positions
                    timeoutMultiplier: 1.2,       // Longer timeouts (wait for clarity)
                };
            case MarketRegime.LOW_VOL_TRENDING:
                // Low vol + trend: ideal for learning and trading
                return {
                    learningRateMultiplier: 1.2,  // Faster learning
                    positionSizeMultiplier: 1.2,  // Larger positions
                    timeoutMultiplier: 1.0,       // Normal timeouts
                };
            case MarketRegime.LOW_VOL_RANGING:
            default:
                // Low vol + ranging: stable, normal operation
                return {
                    learningRateMultiplier: 1.0,
                    positionSizeMultiplier: 1.0,
                    timeoutMultiplier: 1.0,
                };
        }
    }

    /**
     * Returns recent regime transitions for analysis.
     */
    getRecentTransitions(n: number = 10): Array<{
        from: MarketRegime;
        to: MarketRegime;
        timestamp: number;
    }> {
        const transitions: Array<{
            from: MarketRegime;
            to: MarketRegime;
            timestamp: number;
        }> = [];

        let prevRegime: MarketRegime | null = null;
        for (const entry of this.regimeHistory) {
            if (prevRegime && prevRegime !== entry.regime) {
                transitions.push({
                    from: prevRegime,
                    to: entry.regime,
                    timestamp: entry.timestamp,
                });
            }
            prevRegime = entry.regime;
        }

        return transitions.slice(-n);
    }

    /**
     * Resets regime to default and clears history.
     */
    reset(): void {
        this.currentRegime = MarketRegime.LOW_VOL_RANGING;
        this.regimeStartTime = Date.now();
        this.regimeHistory = [];
        this.volatilityHistory = [];
        this.trendHistory = [];
    }

    /**
     * Returns the current thresholds (for debugging).
     */
    getThresholds(): { volThreshold: number; trendThreshold: number } {
        return {
            volThreshold: this.volThreshold,
            trendThreshold: this.trendThreshold,
        };
    }

    /**
     * Sets thresholds manually (overrides calibration).
     */
    setThresholds(volThreshold: number, trendThreshold: number): void {
        this.volThreshold = volThreshold;
        this.trendThreshold = trendThreshold;
    }
}
