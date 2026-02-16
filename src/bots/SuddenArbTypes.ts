/**
 * Type definitions for SuddenArb bot.
 *
 * Extracted to reduce main file size and improve reusability.
 */

import { MarketRegime } from "../ml/MarketRegimeDetector.js";
import { SimulatedExitLevel } from "../ml/ExitModel.js";
import { TradeOrder } from "./QuantBot.js";

// ============================================================================
// ML Configuration
// ============================================================================

/**
 * Configuration flags for ML enhancements in SuddenArb.
 */
export interface SuddenArbMLConfig {
    useAdaptiveLearningRate: boolean;
    useMomentum: boolean;
    useExperienceReplay: boolean;
    useRegimeAwareness: boolean;
    useUncertaintyEstimation: boolean;
    useConfidencePositionSizing: boolean;
    useTimeFeatures: boolean;
    useOrderFlowFeatures: boolean;
    useCrossTokenFeatures: boolean;
    // MLP ensemble options
    useMLPEnsemble: boolean;           // Enable MLP model for ensemble predictions
    mlpEnsembleWeight: number;         // Weight for MLP predictions (0-1), linear gets 1-weight
    mlpTrainingIntervalMs: number;     // How often to train MLP from replay buffer
    mlpMinSamplesForTraining: number;  // Minimum samples before training MLP
    // Theoretical trade tracking
    useTheoreticalTrades: boolean;     // Track trades we would have made but didn't due to low confidence
    minConfidenceToTrade: number;      // Minimum confidence to actually place a trade (e.g., 0.3)
    // Enhanced Exit Model (theoretical exit simulation)
    useEnhancedExitModel: boolean;     // Use 25-feature exit model with simulation
    exitSimulationLevels: number[];    // Price offsets to simulate [0.005, 0.01, 0.015, 0.02, 0.025, 0.03]
    exitSimulationDurationMs: number;  // How long to track each simulation (60000)
    minFillProbability: number;        // Min probability for optimal price selection (0.7)
    exitSimulationWeight: number;      // Weight for simulated vs real training (0.8)
    // PnL-weighted training
    usePnLWeightedTraining: boolean;   // Weight training samples by actual PnL (default: true)
    pnlWeightScalingFactor: number;    // How much PnL affects weight (default: 10, so 1% PnL = 10% more weight)
    // Return-based signals
    useReturnBasedSignals: boolean;    // Train on price returns, not just absolute prices (default: true)
    returnLossWeight: number;          // Weight for return prediction loss (default: 0.3 = 30% return, 70% absolute)
    // Balanced theoretical trade training
    useBalancedTheoreticalTraining: boolean;  // Also train on losing theoretical trades (default: true)
    negativeExampleWeight: number;     // Weight for losing trade samples (default: 0.5)
}

// ============================================================================
// Training Samples
// ============================================================================

/**
 * Pending training sample waiting for price convergence.
 */
export interface PendingTrainingSample {
    features: Record<string, number>;
    timestamp: number;
    predictedUpPrice: number;
    predictedDownPrice: number;
    regime?: MarketRegime;
}

// ============================================================================
// Counterfactual Trackers
// ============================================================================

/**
 * Tracks cancelled orders to learn from counterfactual outcomes.
 * If we cancelled too early and it would have filled, we learn from that.
 */
export interface CancelledOrderTracker {
    id: string;
    direction: 'UP' | 'DOWN';
    isBuy: boolean;
    targetPrice: number;
    cancelledAt: number;
    originalTimeoutMs: number;
    actualWaitMs: number;
    placementFeatures: Record<string, number>;
    maxTrackingMs: number;
}

/**
 * Tracks missed opportunities where we could have traded profitably.
 * Used to adjust confidence thresholds.
 */
export interface MissedOpportunityTracker {
    id: string;
    direction: 'UP' | 'DOWN';
    timestamp: number;
    features: Record<string, number>;
    predictedFairPrice: number;
    marketPriceAtDecision: number;
    divergence: number;
    maxTrackingMs: number;
}

/**
 * Tracks original sell prices after repricing.
 * Used to evaluate if repricing decisions were correct.
 */
export interface OriginalPriceTracker {
    id: string;
    direction: 'UP' | 'DOWN';
    originalSellPrice: number;
    repricedAt: number;
    exitFeatures: Record<string, number>;
    maxTrackingMs: number;
}

/**
 * Tracks theoretical trades that weren't placed due to low confidence.
 * Used to generate additional training data and calibrate confidence thresholds.
 */
export interface TheoreticalTradeTracker {
    id: string;
    direction: 'UP' | 'DOWN';
    timestamp: number;
    features: Record<string, number>;
    entryPrice: number;           // Price we would have bought at
    predictedFairPrice: number;   // Our predicted fair value
    targetExitPrice: number;      // Price we would have tried to sell at
    divergence: number;           // Divergence at entry
    confidence: number;           // Confidence at entry (reason we didn't trade)
    maxTrackingMs: number;        // How long to track
    bestPriceSeen: number;        // Best price seen since entry (for profit calc)
    worstPriceSeen: number;       // Worst price seen (for drawdown calc)
}

/**
 * Tracks theoretical exit simulations for training the enhanced ExitModel.
 * Created at trade signals to simulate what fill prices could have been achieved.
 */
export interface TheoreticalExitTracker {
    id: string;
    direction: 'UP' | 'DOWN';
    timestamp: number;

    // Entry context (enhanced features)
    entryFeatures: Record<string, number>;
    entryMidPrice: number;
    entrySpread: number;

    // Simulated price levels
    simulatedLevels: SimulatedExitLevel[];

    // Tracking state
    maxTrackingMs: number;              // 60 seconds default
    bestPriceSeen: number;
    worstPriceSeen: number;
    lastUpdateMs: number;               // For tracking time above levels
}

// ============================================================================
// Active Trade State
// ============================================================================

/**
 * Represents an active trade with buy and optional sell orders.
 */
export interface ActiveTrade {
    id: string;
    direction: 'UP' | 'DOWN';
    buyOrder: TradeOrder;
    sellOrder?: TradeOrder;
    placementFeatures: Record<string, number>;
    placementBookPressure: number;
    createdAt: number;
    buyTimeoutMs: number;
    sellTimeoutMs?: number;
    lastExitFeatures?: Record<string, number>;
    lastSuggestedPrice?: number;
    repriceCount: number;
    positionSize: number;  // Actual position size (may be adjusted by confidence)
    predictionConfidence: number;  // Confidence at time of trade
}

// ============================================================================
// Fill Outcome Tracking
// ============================================================================

/**
 * Records the outcome of an order fill for historical analysis.
 */
export interface FillOutcome {
    filled: boolean;
    timeToFillMs: number;
    timestamp: number;
}
