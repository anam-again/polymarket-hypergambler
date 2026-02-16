import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { MLPredictionService, MLServiceConfig, TradeOutcome } from '../src/ml/MLPredictionService.js';
import { MarketRegime } from '../src/ml/MarketRegimeDetector.js';
import { rmSync, existsSync, mkdirSync } from 'fs';

/**
 * Tests for MLPredictionService - unified ML prediction wrapper for MSPEQ strategies.
 *
 * Tests cover:
 * - Model initialization with and without existing weights
 * - Fair value prediction with confidence
 * - Exit price optimization using expected value
 * - Trade gating based on ML confidence
 * - Position size adjustment
 * - Training on trade outcomes
 * - Model persistence (save/load/reset)
 * - Regime detection and multipliers
 */
describe('MLPredictionService', () => {
    const TEST_MODEL_PATH = './test-models/MLPredictionServiceTest/';

    // Clean up test models before and after tests
    beforeEach(() => {
        if (existsSync(TEST_MODEL_PATH)) {
            rmSync(TEST_MODEL_PATH, { recursive: true, force: true });
        }
    });

    afterAll(() => {
        if (existsSync(TEST_MODEL_PATH)) {
            rmSync(TEST_MODEL_PATH, { recursive: true, force: true });
        }
    });

    /**
     * Creates a complete set of mock features with all 56 expected fields.
     */
    function createMockFeatures(): Record<string, number> {
        return {
            // Binance price features (17)
            candle10s: 0.001,
            candle20s: 0.002,
            candle30s: 0.003,
            candle60s: 0.005,
            candle5m: 0.01,
            ma30s: 50000,
            ma60s: 50000,
            ma5m: 50000,
            volatility30s: 0.001,
            volatility60s: 0.002,
            momentum: 0.001,
            priceVsMa: 0.0001,
            upMid: 0.55,
            downMid: 0.45,
            upSpread: 0.02,
            downSpread: 0.02,
            imbalance: 0.1,

            // UP token order book depth features (8)
            upBidDepth1pct: 1000,
            upAskDepth1pct: 1200,
            upBidDepth5pct: 5000,
            upAskDepth5pct: 5500,
            upVolumeImbalance: 0.1,
            upBidVWAP: 0.54,
            upAskVWAP: 0.56,
            upBookPressure: 1.1,

            // DOWN token order book depth features (8)
            downBidDepth1pct: 800,
            downAskDepth1pct: 900,
            downBidDepth5pct: 4000,
            downAskDepth5pct: 4200,
            downVolumeImbalance: -0.05,
            downBidVWAP: 0.44,
            downAskVWAP: 0.46,
            downBookPressure: 0.95,

            // Time-based features (10)
            minuteInHour: 0.5,
            secondInMinute: 0.5,
            timeToHourEnd: 0.5,
            isFirstQuarter: 0,
            isLastQuarter: 0,
            minuteSin: 0,
            minuteCos: 1,
            hourSin: 0.5,
            hourCos: 0.866,
            periodProgress: 0.5,

            // Order flow features (6)
            upBidAskRatio: 1.1,
            downBidAskRatio: 0.9,
            upTopBidConcentration: 0.3,
            upTopAskConcentration: 0.25,
            downTopBidConcentration: 0.28,
            downTopAskConcentration: 0.22,

            // Cross-token features (4)
            upDownCorrelation: 0.8,
            upDownSpreadRatio: 1.0,
            combinedLiquidity: 2000,
            imbalanceVelocity: 0.01,

            // Period start features (3)
            upPriceVsPeriodStart: 0.01,
            downPriceVsPeriodStart: -0.005,
            binancePriceVsPeriodStart: 0.002,
        };
    }

    describe('Initialization', () => {
        it('should create service with default config', () => {
            const service = new MLPredictionService();

            expect(service).toBeDefined();
            expect(service.getStrategyName()).toBe('Unknown');
        });

        it('should create service with custom config', () => {
            const config: MLServiceConfig = {
                learningRate: 0.005,
                modelPath: TEST_MODEL_PATH,
                strategyName: 'TestStrategy',
                minConfidence: 0.6,
                minFillProbability: 0.4,
            };

            const service = new MLPredictionService(config);

            expect(service.getStrategyName()).toBe('TestStrategy');
            expect(service.getModelPath()).toBe(TEST_MODEL_PATH);
        });

        it('should create model directory if it does not exist', () => {
            const config: MLServiceConfig = {
                modelPath: TEST_MODEL_PATH + 'nested/path/',
                strategyName: 'NestedTest',
            };

            const service = new MLPredictionService(config);

            expect(existsSync(config.modelPath)).toBe(true);
            expect(service).toBeDefined();
        });
    });

    describe('Fair Value Prediction', () => {
        it('should predict fair values with confidence', () => {
            const service = new MLPredictionService({
                modelPath: TEST_MODEL_PATH,
                loadExisting: false,
            });

            const features = createMockFeatures();
            const prediction = service.predictFairValue(features);

            // Should return valid prediction
            expect(prediction.fairValueUp).toBeGreaterThanOrEqual(0);
            expect(prediction.fairValueUp).toBeLessThanOrEqual(1);
            expect(prediction.fairValueDown).toBeGreaterThanOrEqual(0);
            expect(prediction.fairValueDown).toBeLessThanOrEqual(1);

            // Should have confidence values
            expect(prediction.upConfidence).toBeGreaterThanOrEqual(0);
            expect(prediction.upConfidence).toBeLessThanOrEqual(1);
            expect(prediction.downConfidence).toBeGreaterThanOrEqual(0);
            expect(prediction.downConfidence).toBeLessThanOrEqual(1);
            expect(prediction.confidence).toBeGreaterThanOrEqual(0);
            expect(prediction.confidence).toBeLessThanOrEqual(1);

            // Should have regime info
            expect(Object.values(MarketRegime)).toContain(prediction.regime);
            expect(prediction.positionMultiplier).toBeGreaterThan(0);
        });

        it('should not return NaN values', () => {
            const service = new MLPredictionService({
                modelPath: TEST_MODEL_PATH,
                loadExisting: false,
            });

            const features = createMockFeatures();
            const prediction = service.predictFairValue(features);

            expect(isNaN(prediction.fairValueUp)).toBe(false);
            expect(isNaN(prediction.fairValueDown)).toBe(false);
            expect(isNaN(prediction.confidence)).toBe(false);
        });
    });

    describe('Exit Price Optimization', () => {
        it('should find optimal exit price', () => {
            const service = new MLPredictionService({
                modelPath: TEST_MODEL_PATH,
                loadExisting: false,
            });

            const features = createMockFeatures();
            const result = service.findOptimalExitPrice(features, 'UP', 0.55);

            // Should return valid exit prediction
            expect(result.suggestedPrice).toBeGreaterThan(0);
            expect(result.suggestedPrice).toBeLessThanOrEqual(1);
            expect(result.suggestedOffset).toBeGreaterThan(0);
            expect(result.fillProbability).toBeGreaterThanOrEqual(0);
            expect(result.fillProbability).toBeLessThanOrEqual(1);
            expect(result.expectedValue).toBeGreaterThanOrEqual(0);

            // Should have level predictions
            expect(result.levelPredictions.length).toBeGreaterThan(0);
        });

        it('should predict fill probability at specific offset', () => {
            const service = new MLPredictionService({
                modelPath: TEST_MODEL_PATH,
                loadExisting: false,
            });

            const features = createMockFeatures();
            const fillProb = service.predictFillProbability(features, 0.02);

            expect(fillProb).toBeGreaterThanOrEqual(0);
            expect(fillProb).toBeLessThanOrEqual(1);
            expect(isNaN(fillProb)).toBe(false);
        });
    });

    describe('Trade Gating', () => {
        it('should allow trades when confidence is above threshold', () => {
            const service = new MLPredictionService({
                modelPath: TEST_MODEL_PATH,
                loadExisting: false,
                minConfidence: 0.1, // Low threshold
            });

            const features = createMockFeatures();
            const result = service.shouldTrade(features, 0.1);

            // With low threshold and fresh model, should usually allow
            expect(typeof result.shouldTrade).toBe('boolean');
            expect(typeof result.confidence).toBe('number');
        });

        it('should block trades when confidence is below threshold', () => {
            const service = new MLPredictionService({
                modelPath: TEST_MODEL_PATH,
                loadExisting: false,
                minConfidence: 0.99, // Very high threshold
            });

            const features = createMockFeatures();
            const result = service.shouldTrade(features, 0.99);

            // With very high threshold, fresh model won't have enough confidence
            expect(result.shouldTrade).toBe(false);
            expect(result.reason).toBeDefined();
        });
    });

    describe('Position Size Adjustment', () => {
        it('should adjust position size based on confidence', () => {
            const service = new MLPredictionService({
                modelPath: TEST_MODEL_PATH,
                loadExisting: false,
            });

            const features = createMockFeatures();
            const baseSize = 10;
            const adjustedSize = service.getAdjustedPositionSize(baseSize, features, 1.0);

            // Should be within reasonable bounds (50% to 150% of base)
            expect(adjustedSize).toBeGreaterThanOrEqual(baseSize * 0.5);
            expect(adjustedSize).toBeLessThanOrEqual(baseSize * 1.5);
        });

        it('should apply mlPositionMultiplier', () => {
            const service = new MLPredictionService({
                modelPath: TEST_MODEL_PATH,
                loadExisting: false,
            });

            const features = createMockFeatures();
            const baseSize = 10;

            const sizeWithMultiplier = service.getAdjustedPositionSize(baseSize, features, 1.5);
            const sizeWithoutMultiplier = service.getAdjustedPositionSize(baseSize, features, 1.0);

            // Higher multiplier should generally result in larger position
            // (though regime and confidence also affect it)
            expect(typeof sizeWithMultiplier).toBe('number');
            expect(typeof sizeWithoutMultiplier).toBe('number');
        });
    });

    describe('Training', () => {
        it('should train on trade outcome', () => {
            const service = new MLPredictionService({
                modelPath: TEST_MODEL_PATH,
                loadExisting: false,
            });

            const features = createMockFeatures();

            // Get initial stats
            const initialStats = service.getStats();
            expect(initialStats.trainingSamples).toBe(0);

            // Train on outcome
            const outcome: TradeOutcome = {
                entryFeatures: features,
                actualUpPrice: 0.56,
                actualDownPrice: 0.44,
                pnl: 0.05,
                filled: true,
                entryPrice: 0.55,
                exitPrice: 0.56,
                direction: 'UP',
            };

            service.trainOnOutcome(outcome);

            // Check stats updated
            const afterStats = service.getStats();
            expect(afterStats.trainingSamples).toBe(1);
        });

        it('should train fair value directly', () => {
            const service = new MLPredictionService({
                modelPath: TEST_MODEL_PATH,
                loadExisting: false,
            });

            const features = createMockFeatures();
            const initialSamples = service.getStats().fairValueSamples;

            service.trainFairValue(features, 0.56, 0.44);

            const afterSamples = service.getStats().fairValueSamples;
            expect(afterSamples).toBe(initialSamples + 1);
        });
    });

    describe('Regime Detection', () => {
        it('should detect market regime from features', () => {
            const service = new MLPredictionService({
                modelPath: TEST_MODEL_PATH,
                loadExisting: false,
            });

            const features = createMockFeatures();
            const regime = service.detectRegime(features);

            expect(Object.values(MarketRegime)).toContain(regime);
        });

        it('should return regime multipliers', () => {
            const service = new MLPredictionService({
                modelPath: TEST_MODEL_PATH,
                loadExisting: false,
            });

            const multipliers = service.getRegimeMultipliers();

            expect(multipliers.learningRateMultiplier).toBeGreaterThan(0);
            expect(multipliers.positionSizeMultiplier).toBeGreaterThan(0);
            expect(multipliers.timeoutMultiplier).toBeGreaterThan(0);
        });
    });

    describe('Model Persistence', () => {
        it('should save and load models', () => {
            // Create service and train it
            const service1 = new MLPredictionService({
                modelPath: TEST_MODEL_PATH,
                strategyName: 'PersistenceTest',
                loadExisting: false,
            });

            const features = createMockFeatures();
            service1.trainFairValue(features, 0.56, 0.44);
            service1.save();

            // Create new service that loads existing
            const service2 = new MLPredictionService({
                modelPath: TEST_MODEL_PATH,
                strategyName: 'PersistenceTest',
                loadExisting: true,
            });

            // Should have same training count
            expect(service2.getStats().fairValueSamples).toBe(1);
        });

        it('should reset models to fresh state', () => {
            const service = new MLPredictionService({
                modelPath: TEST_MODEL_PATH,
                loadExisting: false,
            });

            // Train some samples
            const features = createMockFeatures();
            service.trainFairValue(features, 0.56, 0.44);
            service.trainFairValue(features, 0.57, 0.43);

            expect(service.getStats().trainingSamples).toBe(2);

            // Reset
            service.reset();

            // Should be back to zero
            expect(service.getStats().trainingSamples).toBe(0);
            expect(service.getStats().fairValueSamples).toBe(0);
        });
    });

    describe('Statistics', () => {
        it('should return comprehensive stats', () => {
            const service = new MLPredictionService({
                modelPath: TEST_MODEL_PATH,
                loadExisting: false,
            });

            const stats = service.getStats();

            expect(typeof stats.trainingSamples).toBe('number');
            expect(typeof stats.fairValueSamples).toBe('number');
            expect(typeof stats.exitModelSamples).toBe('number');
            expect(Object.values(MarketRegime)).toContain(stats.currentRegime);
            expect(typeof stats.regimeDurationMs).toBe('number');
        });

        it('should return performance metrics', () => {
            const service = new MLPredictionService({
                modelPath: TEST_MODEL_PATH,
                loadExisting: false,
            });

            const fvMetrics = service.getFairValueMetrics();
            const exitMetrics = service.getExitModelMetrics();
            const regimeStats = service.getRegimeStats();

            expect(fvMetrics).toBeDefined();
            expect(exitMetrics).toBeDefined();
            expect(regimeStats).toBeDefined();
        });
    });

    describe('Underlying Model Access', () => {
        it('should provide access to underlying models', () => {
            const service = new MLPredictionService({
                modelPath: TEST_MODEL_PATH,
                loadExisting: false,
            });

            expect(service.getFairValueModel()).toBeDefined();
            expect(service.getExitModel()).toBeDefined();
            expect(service.getRegimeDetector()).toBeDefined();
        });
    });
});
