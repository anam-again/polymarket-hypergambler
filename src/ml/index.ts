/**
 * ML Market Prediction System
 *
 * Barrel exports for the ML module. Import from here instead of individual files.
 *
 * Key components:
 * - FairValueModel: Linear model for UP/DOWN token fair value (56 features)
 * - MLPFairValueModel: Neural network ensemble for fair value prediction
 * - ExitModel: Optimal exit price prediction with integrated timeout (57 features)
 * - MarketRegimeDetector: Market condition classification
 * - ExperienceReplayBuffer: Training sample storage for stable online learning
 */

// Types
export * from './types.js';

// Core Models
export { FairValueModel, type PredictionWithUncertainty } from './FairValueModel.js';
export { MLPFairValueModel, type MLPConfig, type MLPPrediction } from './MLPFairValueModel.js';
export { ExitModel, type SimulatedExitLevel, type EnhancedExitPrediction } from './ExitModel.js';
export { TimeoutModel } from './TimeoutModel.js';
export { MarketRegimeDetector, type MarketRegime, type RegimeFeatures } from './MarketRegimeDetector.js';

// Training & Replay
export {
    ExperienceReplayBuffer,
    type TrainingSample,
    type IReplayTrainable,
} from './ExperienceReplayBuffer.js';

// ML Prediction Service (unified wrapper for strategies)
export {
    MLPredictionService,
    type MLServiceConfig,
    type MLPrediction,
    type TradeOutcome,
} from './MLPredictionService.js';

// Performance Tracking
export { ModelPerformanceTracker } from './ModelPerformanceTracker.js';
export { FeatureAnalyzer, type FeatureImportanceResult } from './FeatureAnalyzer.js';
export { HyperparameterTuner } from './HyperparameterTuner.js';

// Multi-horizon Prediction
export { MultiHorizonPredictor } from './MultiHorizonPredictor.js';

// Data Preparation
export {
    DataPreparation,
    splitByTime,
    filterByDateRange,
    type UpDownPriceEntry,
    type HourlyDataEntry,
    type MinuteDataEntry,
    type AlignedPeriodData,
    type PreparedDataset,
} from './DataPreparation.js';

// Feature Engineering
export {
    FeatureEngineering,
    FEATURE_NAMES,
} from './FeatureEngineering.js';

// Legacy Prediction System
export {
    MarketPredictor,
    printModelSummary,
} from './MarketPredictor.js';

export {
    PredictionService,
    getPredictionService,
    resetPredictionService,
    type PredictionRequest,
    type PredictionResult,
    type PredictionServiceConfig,
} from './PredictionService.js';

export {
    ModelManager,
} from './ModelManager.js';
