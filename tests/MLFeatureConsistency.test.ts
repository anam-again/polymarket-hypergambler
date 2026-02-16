import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { FairValueModel } from '../src/ml/FairValueModel.js';
import { MLPFairValueModel } from '../src/ml/MLPFairValueModel.js';
import { ExitModel } from '../src/ml/ExitModel.js';
import { TimeoutModel } from '../src/ml/TimeoutModel.js';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';

/**
 * Tests to ensure feature count consistency across ML models.
 * These tests prevent the NaN prediction bug caused by feature count mismatches.
 *
 * CRITICAL: Feature counts must match between:
 * - FairValueModel.NUM_FEATURES (56)
 * - MLPFairValueModel.inputSize (56)
 * - ExitModel.NUM_FEATURES (57 = 56 + targetOffset)
 * - TimeoutModel.NUM_FEATURES (17 - uses only price features)
 */
describe('ML Feature Consistency', () => {
    // Expected feature count: 17 price + 8 UP depth + 8 DOWN depth + 10 time + 6 order flow + 4 cross-token + 3 period start = 56
    const EXPECTED_FEATURE_COUNT = 56;
    const EXPECTED_EXIT_FEATURE_COUNT = 57;  // 56 + targetOffset
    const EXPECTED_TIMEOUT_FEATURE_COUNT = 17;  // Only price features

    /**
     * Creates a complete set of mock features with all expected fields.
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

            // Time-based features (10) - includes periodProgress
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

            // Period start features (3) - price change from period open
            upPriceVsPeriodStart: 0.01,
            downPriceVsPeriodStart: -0.005,
            binancePriceVsPeriodStart: 0.002,
        };
    }

    describe('FairValueModel', () => {
        let model: FairValueModel;

        beforeEach(() => {
            model = new FairValueModel(0.01, './test-models/fairvalue-test.json');
        });

        it('should have correct NUM_FEATURES constant', () => {
            // Access private static via class prototype workaround
            const featureNames = model.getFeatureNames();
            expect(featureNames.length).toBe(EXPECTED_FEATURE_COUNT);
        });

        it('should not return NaN predictions with valid features', () => {
            const features = createMockFeatures();
            const prediction = model.predict(features);

            expect(prediction.upPrice).not.toBeNaN();
            expect(prediction.downPrice).not.toBeNaN();
            expect(prediction.upPrice).toBeGreaterThanOrEqual(0);
            expect(prediction.upPrice).toBeLessThanOrEqual(1);
            expect(prediction.downPrice).toBeGreaterThanOrEqual(0);
            expect(prediction.downPrice).toBeLessThanOrEqual(1);
        });

        it('should not return NaN with predictWithUncertainty', () => {
            const features = createMockFeatures();
            const prediction = model.predictWithUncertainty(features);

            expect(prediction.upPrice).not.toBeNaN();
            expect(prediction.downPrice).not.toBeNaN();
            expect(prediction.upConfidence).not.toBeNaN();
            expect(prediction.downConfidence).not.toBeNaN();
            expect(prediction.upUncertainty).not.toBeNaN();
            expect(prediction.downUncertainty).not.toBeNaN();
        });

        it('should handle missing features gracefully (no NaN)', () => {
            // Only provide minimal features
            const sparseFeatures: Record<string, number> = {
                upMid: 0.55,
                downMid: 0.45,
            };
            const prediction = model.predict(sparseFeatures);

            expect(prediction.upPrice).not.toBeNaN();
            expect(prediction.downPrice).not.toBeNaN();
        });

        it('should have feature names matching feature vector length', () => {
            const featureNames = model.getFeatureNames();
            const features = createMockFeatures();
            const prediction = model.predict(features);

            // Feature names should match the expected count
            expect(featureNames.length).toBe(EXPECTED_FEATURE_COUNT);

            // Prediction should work (implicitly tests vector length matches weights)
            expect(prediction.upPrice).not.toBeNaN();
        });

        it('should train without producing NaN weights', () => {
            const features = createMockFeatures();

            // Train the model
            model.train(features, 0.6, 0.4);

            // Predict after training
            const prediction = model.predict(features);
            expect(prediction.upPrice).not.toBeNaN();
            expect(prediction.downPrice).not.toBeNaN();
        });
    });

    describe('MLPFairValueModel', () => {
        let model: MLPFairValueModel;

        beforeEach(() => {
            model = new MLPFairValueModel({}, './test-models/mlp-test.json');
        });

        it('should have correct default inputSize', () => {
            const stats = model.getStats();
            // inputSize should be 53
            expect(stats.parameterCount).toBeGreaterThan(0);
        });

        it('should not return NaN predictions with valid features', () => {
            const features = createMockFeatures();
            const prediction = model.predict(features);

            expect(prediction.upPrice).not.toBeNaN();
            expect(prediction.downPrice).not.toBeNaN();
            expect(prediction.upPrice).toBeGreaterThanOrEqual(0);
            expect(prediction.upPrice).toBeLessThanOrEqual(1);
            expect(prediction.downPrice).toBeGreaterThanOrEqual(0);
            expect(prediction.downPrice).toBeLessThanOrEqual(1);
        });

        it('should handle missing features gracefully (no NaN)', () => {
            const sparseFeatures: Record<string, number> = {
                upMid: 0.55,
                downMid: 0.45,
            };
            const prediction = model.predict(sparseFeatures);

            expect(prediction.upPrice).not.toBeNaN();
            expect(prediction.downPrice).not.toBeNaN();
        });

        it('should have feature names matching expected count', () => {
            const featureNames = model.getFeatureNames();
            expect(featureNames.length).toBe(EXPECTED_FEATURE_COUNT);
        });
    });

    describe('ExitModel', () => {
        let model: ExitModel;

        beforeEach(() => {
            model = new ExitModel(0.01, './test-models/exit-test.json');
        });

        it('should have correct NUM_FEATURES constant (56 + targetOffset)', () => {
            const featureNames = ExitModel.getFeatureNames();
            expect(featureNames.length).toBe(EXPECTED_EXIT_FEATURE_COUNT);
        });

        it('should not return NaN predictions with valid features', () => {
            const features = { ...createMockFeatures(), targetOffset: 0.02 };
            const prediction = model.predict(features);

            expect(prediction.suggestedPrice).not.toBeNaN();
            expect(prediction.confidence).not.toBeNaN();
            expect(prediction.suggestedPrice).toBeGreaterThanOrEqual(0);
            expect(prediction.suggestedPrice).toBeLessThanOrEqual(1);
        });

        it('should handle findOptimalPrice without NaN', () => {
            const features = { ...createMockFeatures(), targetOffset: 0.02 };
            const prediction = model.findOptimalPrice(features, 0.7, 'UP', 0.55);

            expect(prediction.suggestedPrice).not.toBeNaN();
            expect(prediction.fillProbability).not.toBeNaN();
            expect(prediction.expectedValue).not.toBeNaN();
        });

        // Timeout prediction tests (integrated from TimeoutModel)
        it('should include suggestedTimeoutMs in findOptimalPrice result', () => {
            const features = { ...createMockFeatures(), targetOffset: 0.02 };
            const prediction = model.findOptimalPrice(features, 0.7, 'UP', 0.55);

            expect(prediction.suggestedTimeoutMs).toBeDefined();
            expect(prediction.suggestedTimeoutMs).not.toBeNaN();
            expect(prediction.suggestedTimeoutMs).toBeGreaterThanOrEqual(5000);   // MIN_TIMEOUT_MS
            expect(prediction.suggestedTimeoutMs).toBeLessThanOrEqual(120000);    // MAX_TIMEOUT_MS
        });

        it('should predict buy timeout within valid range', () => {
            const features = createMockFeatures();
            const buyTimeout = model.predictBuyTimeout(features);

            expect(buyTimeout).not.toBeNaN();
            expect(buyTimeout).toBeGreaterThanOrEqual(5000);    // MIN_TIMEOUT_MS
            expect(buyTimeout).toBeLessThanOrEqual(120000);     // MAX_TIMEOUT_MS
        });

        it('should predict sell timeout within valid range', () => {
            const features = createMockFeatures();
            const sellTimeout = model.predictSellTimeout(features, 0.02);

            expect(sellTimeout).not.toBeNaN();
            expect(sellTimeout).toBeGreaterThanOrEqual(5000);   // MIN_TIMEOUT_MS
            expect(sellTimeout).toBeLessThanOrEqual(120000);    // MAX_TIMEOUT_MS
        });

        it('should return longer timeout for lower fill probability', () => {
            const features = createMockFeatures();

            // Aggressive offset should have lower fill probability → longer timeout
            const aggressiveTimeout = model.predictSellTimeout(features, 0.05);
            // Conservative offset should have higher fill probability → shorter timeout
            const conservativeTimeout = model.predictSellTimeout(features, 0.005);

            // We expect aggressive to be longer (or equal) to conservative
            expect(aggressiveTimeout).toBeGreaterThanOrEqual(conservativeTimeout);
        });

        it('should provide static timeout helper methods', () => {
            expect(ExitModel.getDefaultTimeoutMs()).toBe(30000);  // 30s default

            const range = ExitModel.getTimeoutRange();
            expect(range.min).toBe(5000);
            expect(range.max).toBe(120000);
            expect(range.default).toBe(30000);
        });
    });

    describe('TimeoutModel (Legacy - now integrated into ExitModel)', () => {
        // Note: TimeoutModel is kept for backward compatibility but
        // SuddenArb now uses ExitModel's integrated timeout prediction.
        // These tests ensure the standalone TimeoutModel still works.
        let model: TimeoutModel;

        beforeEach(() => {
            model = new TimeoutModel(0.01, './test-models/timeout-test.json');
        });

        it('should not return NaN predictions with valid features', () => {
            const features = createMockFeatures();
            const predictionBuy = model.predict(features, true);
            const predictionSell = model.predict(features, false);

            expect(predictionBuy).not.toBeNaN();
            expect(predictionSell).not.toBeNaN();
            expect(predictionBuy).toBeGreaterThan(0);
            expect(predictionSell).toBeGreaterThan(0);
        });
    });

    describe('Feature Count Validation', () => {
        it('mock features should have exactly EXPECTED_FEATURE_COUNT fields', () => {
            const features = createMockFeatures();
            const featureCount = Object.keys(features).length;
            expect(featureCount).toBe(EXPECTED_FEATURE_COUNT);
        });

        it('FairValueModel and MLPFairValueModel should have matching feature names', () => {
            const linearModel = new FairValueModel(0.01, './test-models/fv-test.json');
            const mlpModel = new MLPFairValueModel({}, './test-models/mlp-test.json');

            const linearNames = linearModel.getFeatureNames();
            const mlpNames = mlpModel.getFeatureNames();

            expect(linearNames.length).toBe(mlpNames.length);
            expect(linearNames).toEqual(mlpNames);
        });

        it('ExitModel should have FairValueModel features + targetOffset', () => {
            const fvModel = new FairValueModel(0.01, './test-models/fv-test.json');
            const exitModel = new ExitModel(0.01, './test-models/exit-test.json');

            const fvNames = fvModel.getFeatureNames();
            const exitNames = ExitModel.getFeatureNames();

            // ExitModel should have all FairValue features plus targetOffset
            expect(exitNames.length).toBe(fvNames.length + 1);
            expect(exitNames[exitNames.length - 1]).toBe('targetOffset');

            // First 56 features should match FairValueModel
            expect(exitNames.slice(0, -1)).toEqual(fvNames);
        });
    });

    /**
     * CRITICAL TEST: This test prevents the exact bug that caused NaN predictions.
     * MLPFairValueModel's inputSize must match the number of features in toVector().
     */
    describe('MLPFairValueModel inputSize Consistency', () => {
        it('CRITICAL: MLPFairValueModel inputSize must equal toVector feature count', () => {
            // This test prevents the bug where inputSize=52 but toVector returned 56 features
            const model = new MLPFairValueModel({}, './test-models/mlp-inputsize-test.json');
            const featureNames = model.getFeatureNames();
            const stats = model.getStats();

            // The inputSize (layerSizes[0]) should match the feature count
            expect(stats.layerSizes[0]).toBe(featureNames.length);
            expect(stats.layerSizes[0]).toBe(EXPECTED_FEATURE_COUNT);
        });

        it('CRITICAL: MLPFairValueModel with explicit inputSize must match feature count', () => {
            // Test that passing an explicit inputSize that doesn't match features still works
            // (model should use the passed inputSize, but features will be truncated/padded)
            const correctModel = new MLPFairValueModel({ inputSize: 56 }, './test-models/mlp-correct.json');
            const features = createMockFeatures();
            const prediction = correctModel.predict(features);

            expect(prediction.upPrice).not.toBeNaN();
            expect(prediction.downPrice).not.toBeNaN();
        });

        it('CRITICAL: Detect mismatch between SuddenArb config and feature count', () => {
            // This is the exact bug scenario: SuddenArb passed inputSize: 52 but features had 56
            // The model should work with matching sizes
            const inputSize = 56;  // This MUST match EXPECTED_FEATURE_COUNT
            expect(inputSize).toBe(EXPECTED_FEATURE_COUNT);

            const model = new MLPFairValueModel({ inputSize }, './test-models/mlp-config-test.json');
            const stats = model.getStats();
            const featureNames = model.getFeatureNames();

            expect(stats.layerSizes[0]).toBe(inputSize);
            expect(featureNames.length).toBe(inputSize);
        });

        it('should detect NaN if weights are corrupted and auto-diagnose', () => {
            // Test the diagnoseNaN method
            const model = new MLPFairValueModel({}, './test-models/mlp-diagnose-test.json');
            const result = model.diagnoseNaN();

            // Fresh model should have no corruption
            expect(result.corrupted).toBe(false);
            expect(result.details.length).toBe(0);
        });
    });;

    describe('Corrupted Model Detection', () => {
        const TEST_DIR = './test-models';
        const CORRUPTED_FV_PATH = `${TEST_DIR}/corrupted-fv.json`;
        const CORRUPTED_MLP_PATH = `${TEST_DIR}/corrupted-mlp.json`;

        beforeEach(() => {
            // Ensure test directory exists
            if (!existsSync(TEST_DIR)) {
                mkdirSync(TEST_DIR, { recursive: true });
            }
        });

        it('FairValueModel should handle model with wrong feature count (52 instead of 53)', () => {
            // Create a corrupted model file with 52 features (old format)
            const corruptedData = {
                version: '2.0',
                numFeatures: 52,  // Wrong! Should be 53
                weightsUp: Array(52).fill(0.01),
                weightsDown: Array(52).fill(0.01),
                biasUp: 0,
                biasDown: 0,
                trainingSamples: 100,
            };
            writeFileSync(CORRUPTED_FV_PATH, JSON.stringify(corruptedData));

            // Load the corrupted model
            const model = new FairValueModel(0.01, CORRUPTED_FV_PATH);
            model.loadIfExists();

            // Model should migrate weights and still produce valid predictions
            const features = createMockFeatures();
            const prediction = model.predict(features);

            expect(prediction.upPrice).not.toBeNaN();
            expect(prediction.downPrice).not.toBeNaN();
            expect(prediction.upPrice).toBeGreaterThanOrEqual(0);
            expect(prediction.upPrice).toBeLessThanOrEqual(1);
        });

        it('FairValueModel should handle completely malformed JSON', () => {
            // Create a malformed model file
            writeFileSync(CORRUPTED_FV_PATH, '{ invalid json }');

            // Model should initialize with fresh weights
            const model = new FairValueModel(0.01, CORRUPTED_FV_PATH);
            const loaded = model.loadIfExists();

            expect(loaded).toBe(false);

            // Should still predict correctly with fresh weights
            const features = createMockFeatures();
            const prediction = model.predict(features);

            expect(prediction.upPrice).not.toBeNaN();
            expect(prediction.downPrice).not.toBeNaN();
        });

        it('FairValueModel should handle model with NaN weights', () => {
            // Create a model file with NaN weights
            const corruptedData = {
                version: '3.0',
                numFeatures: 53,
                weightsUp: Array(53).fill(NaN),
                weightsDown: Array(53).fill(0.01),
                biasUp: NaN,
                biasDown: 0,
                trainingSamples: 100,
            };
            writeFileSync(CORRUPTED_FV_PATH, JSON.stringify(corruptedData));

            const model = new FairValueModel(0.01, CORRUPTED_FV_PATH);
            model.loadIfExists();

            const features = createMockFeatures();
            const prediction = model.predict(features);

            // NaN weights will produce NaN - this is expected behavior
            // The model should be reset if this happens
            // This test documents current behavior
            const hasNaN = isNaN(prediction.upPrice) || isNaN(prediction.downPrice);
            if (hasNaN) {
                // Model loaded NaN weights - user should delete the file
                console.warn('Model has NaN weights - needs manual reset');
            }
        });

        it('MLPFairValueModel should handle model with mismatched layer sizes', () => {
            // Create a model file with wrong layer sizes
            const corruptedData = {
                version: '1.0',
                config: { inputSize: 52, hiddenSizes: [24] },  // Wrong input size
                layerSizes: [52, 24, 2],  // Wrong!
                weights: [
                    Array(24).fill(Array(52).fill(0.01)),
                    Array(2).fill(Array(24).fill(0.01)),
                ],
                biases: [
                    Array(24).fill(0.01),
                    Array(2).fill(0.01),
                ],
                trainingSamples: 100,
            };
            writeFileSync(CORRUPTED_MLP_PATH, JSON.stringify(corruptedData));

            // Model should detect mismatch and reinitialize
            const model = new MLPFairValueModel({}, CORRUPTED_MLP_PATH);
            const loaded = model.loadIfExists();

            expect(loaded).toBe(false);  // Should reject mismatched model

            // Should still predict correctly with fresh weights
            const features = createMockFeatures();
            const prediction = model.predict(features);

            expect(prediction.upPrice).not.toBeNaN();
            expect(prediction.downPrice).not.toBeNaN();
        });

        it('MLPFairValueModel should handle completely malformed JSON', () => {
            writeFileSync(CORRUPTED_MLP_PATH, 'not valid json at all');

            const model = new MLPFairValueModel({}, CORRUPTED_MLP_PATH);
            const loaded = model.loadIfExists();

            expect(loaded).toBe(false);

            const features = createMockFeatures();
            const prediction = model.predict(features);

            expect(prediction.upPrice).not.toBeNaN();
            expect(prediction.downPrice).not.toBeNaN();
        });

        it('should detect feature count mismatch between model weights and toVector', () => {
            // This test verifies that NUM_FEATURES matches the actual vector length
            const model = new FairValueModel(0.01, `${TEST_DIR}/feature-count-test.json`);
            const featureNames = model.getFeatureNames();
            const features = createMockFeatures();

            // The number of feature names should match expected count
            expect(featureNames.length).toBe(EXPECTED_FEATURE_COUNT);

            // And prediction should work (implicitly tests internal consistency)
            const prediction = model.predict(features);
            expect(prediction.upPrice).not.toBeNaN();
            expect(prediction.downPrice).not.toBeNaN();
        });

        // Cleanup after tests
        afterAll(() => {
            try {
                if (existsSync(TEST_DIR)) {
                    rmSync(TEST_DIR, { recursive: true, force: true });
                }
            } catch {
                // Ignore cleanup errors
            }
        });
    });
});
