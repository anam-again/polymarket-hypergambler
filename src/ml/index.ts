/**
 * ML Market Outcome Prediction System
 *
 * This module provides machine learning capabilities for predicting
 * whether Polymarket UP/DOWN markets will close UP or DOWN.
 *
 * Key components:
 * - DataPreparation: Loads and aligns data from multiple sources
 * - FeatureEngineering: Extracts and normalizes features
 * - MarketPredictor: Logistic regression model for predictions
 * - PredictionService: Real-time prediction API
 * - MLBacktester: Walk-forward backtesting framework
 */

// Types
export * from './types.js';

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

// Model
export {
    MarketPredictor,
    printModelSummary,
} from './MarketPredictor.js';

// Prediction Service
export {
    PredictionService,
    getPredictionService,
    resetPredictionService,
    type PredictionRequest,
    type PredictionResult,
    type PredictionServiceConfig,
} from './PredictionService.js';

// Model Manager
export {
    ModelManager,
} from './ModelManager.js';

