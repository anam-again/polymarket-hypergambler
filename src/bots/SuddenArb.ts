import { Side } from "@polymarket/clob-client";
import { QuantBot, QuantBotProps, QuantBotRun, TradeOrder, TradeStatus } from "./QuantBot.js";
import { FairValueModel, PredictionWithUncertainty } from "../ml/FairValueModel.js";
import { ExitModel, SimulatedExitLevel, EnhancedExitPrediction } from "../ml/ExitModel.js";
import { ExperienceReplayBuffer } from "../ml/ExperienceReplayBuffer.js";
import { MarketRegimeDetector, MarketRegime, RegimeFeatures } from "../ml/MarketRegimeDetector.js";
import { MLPFairValueModel } from "../ml/MLPFairValueModel.js";
import { FeatureAnalyzer, FeatureImportanceResult } from "../ml/FeatureAnalyzer.js";
import { RealTimePriceBuffer, BinanceSymbol } from "../signals/RealTimePriceBuffer.js";
import { PolymarketWebSocket, PolymarketPriceUpdate, PolymarketBook } from "../signals/PolymarketWebSocket.js";
import { SharedPriceBufferManager, SharedPolymarketManager } from "../signals/SharedWebSocketManager.js";
import { OrderBookDepthAnalyzer, OrderBookDepthFeatures } from "../signals/OrderBookDepthAnalyzer.js";
import { DataLogger } from "../signals/DataLogger.js";
import { existsSync, mkdirSync } from "fs";
import { OrderBookSummary } from "../types/interfaces.js";

// Import types from SuddenArbTypes (extracted to reduce file size)
import {
    SuddenArbMLConfig,
    PendingTrainingSample,
    CancelledOrderTracker,
    MissedOpportunityTracker,
    OriginalPriceTracker,
    TheoreticalTradeTracker,
    TheoreticalExitTracker,
    ActiveTrade,
    FillOutcome,
} from "./SuddenArbTypes.js";

// Re-export SuddenArbMLConfig for backward compatibility
export { SuddenArbMLConfig } from "./SuddenArbTypes.js";

interface SuddenArbProps extends QuantBotProps {
    mispricingThreshold: number;    // Min divergence to trade (e.g., 0.02 = 2%)
    targetProfitMargin: number;     // Target sell price margin (e.g., 0.03 = 3%) - DEPRECATED: used as fallback
    minProfitMargin?: number;       // Minimum acceptable profit margin (floor for ExitModel)
    maxPositionDollars: number;     // Max position size
    maxConcurrentTrades?: number;   // Max simultaneous open positions (default: 5)
    learningRate: number;           // Online learning rate
    modelId: string;                // Unique ID for model persistence
    binanceSymbol: BinanceSymbol;   // Which symbol to track (e.g., 'BTCUSDT')
    convergenceWindowMs?: number;   // How long to wait before training (default: 30s)
    mlConfig?: Partial<SuddenArbMLConfig>;  // ML enhancement flags
}

// Note: PendingTrainingSample, CancelledOrderTracker, MissedOpportunityTracker,
// OriginalPriceTracker, TheoreticalTradeTracker, TheoreticalExitTracker, and
// ActiveTrade interfaces have been moved to SuddenArbTypes.ts to reduce file size.

export class SuddenArb extends QuantBot implements QuantBotRun {
    private fairValueModel: FairValueModel;
    private exitModel: ExitModel;
    // TimeoutModel removed - timeout prediction now integrated into ExitModel
    private binancePriceBuffer!: RealTimePriceBuffer;  // Set in run() via shared manager
    private polymarketManager: SharedPolymarketManager;
    private polymarketSubscriberId: string = '';
    private modelPath: string;
    private modelSaveInterval: NodeJS.Timeout | null = null;

    // ML Enhancement components
    private experienceReplayBuffer: ExperienceReplayBuffer;
    private regimeDetector: MarketRegimeDetector;
    private mlConfig: SuddenArbMLConfig;

    // MLP ensemble model
    private mlpModel: MLPFairValueModel | null = null;
    private mlpTrainInterval: NodeJS.Timeout | null = null;
    private lastMLPTrainingTime: number = 0;

    // REST price fallback for when WebSocket doesn't deliver prices (e.g., less active quarterly markets)
    private restPricePollInterval: NodeJS.Timeout | null = null;
    private static readonly REST_PRICE_POLL_MS = 2000; // Poll every 2 seconds when WebSocket prices missing

    // Real-time Polymarket prices and depth from WebSocket
    private lastUpPrice: PolymarketPriceUpdate | null = null;
    private lastDownPrice: PolymarketPriceUpdate | null = null;
    private lastUpBook: PolymarketBook | null = null;
    private lastDownBook: PolymarketBook | null = null;
    private lastUpDepth: OrderBookDepthFeatures | null = null;
    private lastDownDepth: OrderBookDepthFeatures | null = null;

    // Period start price tracking (for priceVsPeriodStart feature)
    private periodStartUpPrice: number | null = null;
    private periodStartDownPrice: number | null = null;
    private periodStartBinancePrice: number | null = null;
    private lastPeriodIndex: number = -1;  // Track which period we're in

    // Token IDs for current period
    private upTokenId: string = '';
    private downTokenId: string = '';

    // Track multiple concurrent trades
    private activeTrades: ActiveTrade[] = [];
    private tradeCounter: number = 0;
    private tradesThisPeriod: number = 0;

    // Win rate tracking for confidence calibration
    // Tracks actual directional outcomes vs predictions over a rolling window
    private winRateWindow: Array<{ predicted: 'UP' | 'DOWN'; wasCorrect: boolean }> = [];
    private static readonly WIN_RATE_WINDOW_SIZE = 30;  // Rolling 30 periods
    private static readonly WIN_RATE_PAUSE_THRESHOLD = 0.40;  // Pause if win rate < 40%
    private winRatePauseActive: boolean = false;

    // Training samples waiting for convergence
    private pendingTrainingSamples: PendingTrainingSample[] = [];
    private convergenceWindowMs: number;

    // Trackers for counterfactual training (with hard limits)
    private cancelledOrderTrackers: CancelledOrderTracker[] = [];
    private static readonly COUNTERFACTUAL_TRACKING_MULTIPLIER = 3;
    private static readonly MAX_CANCELLED_ORDER_TRACKERS = 50;
    private missedOpportunityTrackers: MissedOpportunityTracker[] = [];
    private missedOpportunityCounter: number = 0;
    private static readonly MISSED_OPP_TRACKING_MS = 60 * 1000;
    private static readonly MISSED_OPP_DIVERGENCE_THRESHOLD = 0.5;
    private static readonly MAX_MISSED_OPP_TRACKERS = 20;
    private originalPriceTrackers: OriginalPriceTracker[] = [];
    private static readonly ORIGINAL_PRICE_TRACKING_MS = 90 * 1000;
    private static readonly MAX_ORIGINAL_PRICE_TRACKERS = 30;

    // Theoretical trade tracking (trades we would have made but didn't due to low confidence)
    private theoreticalTradeTrackers: TheoreticalTradeTracker[] = [];
    private theoreticalTradeCounter: number = 0;
    private static readonly THEORETICAL_TRADE_TRACKING_MS = 60 * 1000;  // Track for 60s
    private static readonly MAX_THEORETICAL_TRADE_TRACKERS = 30;

    // Theoretical exit tracking (for enhanced ExitModel training)
    private theoreticalExitTrackers: TheoreticalExitTracker[] = [];
    private theoreticalExitCounter: number = 0;
    private static readonly MAX_THEORETICAL_EXIT_TRACKERS = 50;
    private static readonly DEFAULT_EXIT_SIMULATION_LEVELS = [0.005, 0.01, 0.015, 0.02, 0.025, 0.03];
    private static readonly DEFAULT_EXIT_SIMULATION_DURATION_MS = 60 * 1000;

    // NaN feature tracking for debugging
    private static readonly MAX_NAN_WARNINGS = 100;
    private nanFeatureCount: number = 0;

    // Fill rate tracking for historical features
    private recentFillOutcomes: Array<{ timestamp: number; filled: boolean; timeToFillMs: number }> = [];
    private static readonly FILL_HISTORY_SIZE = 100;
    private static readonly FILL_HISTORY_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

    // Cross-token feature tracking
    private imbalanceHistory: number[] = [];
    private static readonly IMBALANCE_HISTORY_SIZE = 30;

    // Configuration
    private mispricingThreshold: number;
    private targetProfitMargin: number;  // DEPRECATED: Used as fallback when ExitModel not ready
    private minProfitMargin: number;     // Minimum acceptable profit (floor for ExitModel)
    private maxPositionDollars: number;
    private maxConcurrentTrades: number;
    private binanceSymbol: BinanceSymbol;

    // Model sanity: if divergence exceeds this, the model is likely miscalibrated — skip trade
    private static readonly MAX_SANE_DIVERGENCE = 0.35;  // 35% max believable mispricing

    // Replay training interval
    private replayTrainInterval: NodeJS.Timeout | null = null;
    private static readonly REPLAY_TRAIN_INTERVAL_MS = 60 * 1000;  // Every minute

    constructor(props: SuddenArbProps) {
        super(props);

        this.mispricingThreshold = props.mispricingThreshold;
        this.targetProfitMargin = props.targetProfitMargin;  // Fallback when ExitModel not ready
        this.minProfitMargin = props.minProfitMargin ?? 0.01;  // Default 1% minimum profit
        this.maxPositionDollars = props.maxPositionDollars;
        this.maxConcurrentTrades = props.maxConcurrentTrades ?? 5;  // Default max 5 concurrent positions
        this.binanceSymbol = props.binanceSymbol;
        // 90s convergence: train on price ~90s after prediction rather than 30s.
        // At 30s, market prices barely move; 90s captures a more meaningful signal
        // about whether the prediction direction was correct.
        this.convergenceWindowMs = props.convergenceWindowMs ?? 90 * 1000;

        // ML config with defaults (all enabled)
        this.mlConfig = {
            useAdaptiveLearningRate: props.mlConfig?.useAdaptiveLearningRate ?? true,
            useMomentum: props.mlConfig?.useMomentum ?? true,
            useExperienceReplay: props.mlConfig?.useExperienceReplay ?? true,
            useRegimeAwareness: props.mlConfig?.useRegimeAwareness ?? true,
            useUncertaintyEstimation: props.mlConfig?.useUncertaintyEstimation ?? true,
            useConfidencePositionSizing: props.mlConfig?.useConfidencePositionSizing ?? true,
            useTimeFeatures: props.mlConfig?.useTimeFeatures ?? true,
            useOrderFlowFeatures: props.mlConfig?.useOrderFlowFeatures ?? true,
            useCrossTokenFeatures: props.mlConfig?.useCrossTokenFeatures ?? true,
            // MLP ensemble defaults
            useMLPEnsemble: props.mlConfig?.useMLPEnsemble ?? true,
            mlpEnsembleWeight: props.mlConfig?.mlpEnsembleWeight ?? 0.3,  // 30% MLP, 70% linear
            mlpTrainingIntervalMs: props.mlConfig?.mlpTrainingIntervalMs ?? 5 * 60 * 1000,  // Every 5 min
            mlpMinSamplesForTraining: props.mlConfig?.mlpMinSamplesForTraining ?? 100,
            // Theoretical trade defaults
            useTheoreticalTrades: props.mlConfig?.useTheoreticalTrades ?? true,
            minConfidenceToTrade: props.mlConfig?.minConfidenceToTrade ?? 0.20,  // Don't trade below 20% confidence
            // Enhanced Exit Model defaults
            useEnhancedExitModel: props.mlConfig?.useEnhancedExitModel ?? true,
            exitSimulationLevels: props.mlConfig?.exitSimulationLevels ?? SuddenArb.DEFAULT_EXIT_SIMULATION_LEVELS,
            exitSimulationDurationMs: props.mlConfig?.exitSimulationDurationMs ?? SuddenArb.DEFAULT_EXIT_SIMULATION_DURATION_MS,
            minFillProbability: props.mlConfig?.minFillProbability ?? 0.7,
            exitSimulationWeight: props.mlConfig?.exitSimulationWeight ?? 0.8,
            // PnL-weighted training
            usePnLWeightedTraining: props.mlConfig?.usePnLWeightedTraining ?? true,
            pnlWeightScalingFactor: props.mlConfig?.pnlWeightScalingFactor ?? 10,
            // Return-based signals
            useReturnBasedSignals: props.mlConfig?.useReturnBasedSignals ?? true,
            returnLossWeight: props.mlConfig?.returnLossWeight ?? 0.3,
            // Balanced theoretical training
            useBalancedTheoreticalTraining: props.mlConfig?.useBalancedTheoreticalTraining ?? true,
            negativeExampleWeight: props.mlConfig?.negativeExampleWeight ?? 0.5,
        };

        // Model persistence path
        this.modelPath = `./models/suddenarb_${props.modelId}`;
        if (!existsSync(this.modelPath)) {
            mkdirSync(this.modelPath, { recursive: true });
        }

        // Initialize models with persistence
        // Note: TimeoutModel removed - timeout prediction now integrated into ExitModel
        this.fairValueModel = new FairValueModel(props.learningRate, `${this.modelPath}/fairvalue.json`);
        this.exitModel = new ExitModel(props.learningRate, `${this.modelPath}/exit.json`);

        // Initialize ML enhancement components
        this.experienceReplayBuffer = new ExperienceReplayBuffer(
            1000,  // maxSize
            32,    // miniBatchSize
            `${this.modelPath}/replay_buffer.json`
        );
        this.regimeDetector = new MarketRegimeDetector();

        // Initialize MLP ensemble model if enabled
        if (this.mlConfig.useMLPEnsemble) {
            this.mlpModel = new MLPFairValueModel(
                {
                    inputSize: 56,  // Must match FairValueModel.NUM_FEATURES (17+8+8+10+6+4+3)
                    hiddenSizes: [24],  // Single hidden layer with 24 neurons
                    learningRate: 0.001,
                    dropoutRate: 0.1,
                    l2Lambda: 0.0001,
                },
                `${this.modelPath}/mlp_fairvalue.json`
            );
        }

        // Load existing models and buffers
        this.fairValueModel.loadIfExists();
        this.exitModel.loadIfExists();
        this.experienceReplayBuffer.loadIfExists();
        this.mlpModel?.loadIfExists();

        // Check for and auto-reset corrupted MLP model
        if (this.mlpModel?.resetIfCorrupted()) {
            console.warn('[SuddenArb] MLP model was corrupted and has been reset');
        }

        // Configure return-based training if enabled
        if (this.mlConfig.useReturnBasedSignals) {
            this.fairValueModel.setReturnTraining(true, this.mlConfig.returnLossWeight);
        }

        // Get shared Polymarket manager instance
        this.polymarketManager = SharedPolymarketManager.getInstance();
    }

    public async run(): Promise<void> {
        const orderBooks = await this.marketInfo.getLiveData(this.targetedMarket);
        this.upTokenId = orderBooks.BtcUpTokenId;
        this.downTokenId = orderBooks.BtcDownTokenId;
        this.writeLog(`Token IDs: UP=${this.upTokenId.substring(0, 16)}..., DOWN=${this.downTokenId.substring(0, 16)}...`);

        // Use shared Binance price buffer (reuses existing connection for same symbol)
        this.binancePriceBuffer = SharedPriceBufferManager.getBuffer(this.binanceSymbol, 5 * 60 * 1000);
        this.writeLog(`Binance WebSocket price feed started (shared for ${this.binanceSymbol})`);

        // Extract market name for logging (e.g., 'BTCUSDT' -> 'btc')
        const marketName = this.binanceSymbol.replace('USDT', '').toLowerCase();

        // Subscribe to shared Polymarket WebSocket
        let firstUpPriceReceived = false;
        let firstDownPriceReceived = false;
        this.polymarketSubscriberId = await this.polymarketManager.subscribe({
            id: `suddenarb-${this.binanceSymbol}-${Date.now()}`,
            assetIds: [this.upTokenId, this.downTokenId],
            onPrice: (update: PolymarketPriceUpdate) => {
                if (update.assetId === this.upTokenId) {
                    if (!firstUpPriceReceived) {
                        this.writeLog(`First UP price received: mid=${update.midPrice.toFixed(3)}`);
                        firstUpPriceReceived = true;
                    }
                    this.lastUpPrice = update;
                } else if (update.assetId === this.downTokenId) {
                    if (!firstDownPriceReceived) {
                        this.writeLog(`First DOWN price received: mid=${update.midPrice.toFixed(3)}`);
                        firstDownPriceReceived = true;
                    }
                    this.lastDownPrice = update;
                }
            },
            onBook: (book: PolymarketBook) => {
                if (book.assetId === this.upTokenId) {
                    this.lastUpBook = book;
                    this.lastUpDepth = OrderBookDepthAnalyzer.analyze(book);
                    // Log for historical ML training (throttled internally)
                    DataLogger.logOrderBookDepth(marketName, 'up', this.lastUpDepth);
                } else if (book.assetId === this.downTokenId) {
                    this.lastDownBook = book;
                    this.lastDownDepth = OrderBookDepthAnalyzer.analyze(book);
                    // Log for historical ML training (throttled internally)
                    DataLogger.logOrderBookDepth(marketName, 'down', this.lastDownDepth);
                }
            },
            onError: (error: Error) => {
                this.writeError(`Polymarket WebSocket error: ${error.message}`);
            },
        });
        this.writeLog('Polymarket WebSocket subscription added (shared connection)');

        this.setupPeriodReset();

        // Auto-save models every 5 minutes
        this.modelSaveInterval = setInterval(() => {
            this.saveAllModels();
        }, 5 * 60 * 1000);

        // Periodic replay training
        if (this.mlConfig.useExperienceReplay) {
            this.replayTrainInterval = setInterval(() => {
                this.performReplayTraining();
            }, SuddenArb.REPLAY_TRAIN_INTERVAL_MS);
        }

        // Periodic MLP training from replay buffer
        if (this.mlConfig.useMLPEnsemble && this.mlpModel) {
            this.mlpTrainInterval = setInterval(() => {
                this.performMLPTraining();
            }, this.mlConfig.mlpTrainingIntervalMs);
        }

        this.writeLog('Waiting 30s for price buffers to warm up...');
        await new Promise(resolve => setTimeout(resolve, 30 * 1000));
        this.writeLog('Price buffers warmed up, starting trading');

        // Startup health check: detect and reset degenerate ExitModel from previous session.
        // The ExitModel can load from disk in a degenerate state (stuck predicting ~0 fill prob)
        // if prior training was dominated by non-fill signals. Check immediately so the bot
        // doesn't trade with a broken ExitModel for the first 5 minutes.
        // Lower minSamples to 20 on startup so even lightly-trained models are checked
        if (this.exitModel.checkAndResetIfDegenerate(0.08, 0.92, 20)) {
            this.writeLog(`[STARTUP] ExitModel was degenerate on load — reset to initial weights. Will retrain from live data.`);
        } else {
            const avgFill = this.exitModel.getAverageFillProbability();
            this.writeLog(`[STARTUP] ExitModel health OK — avg P(fill)=${(avgFill * 100).toFixed(1)}%`);
        }

        // Log connection status for debugging
        this.writeLog(`Binance buffer live: ${this.binancePriceBuffer.isLive()}, buffer size: ${this.binancePriceBuffer.getBufferSize()}`);
        this.writeLog(`Polymarket manager active: ${this.polymarketManager.isActive()}`);
        const pmStats = this.polymarketManager.getStats();
        this.writeLog(`Polymarket stats: subscribers=${pmStats.subscriberCount}, assets=${pmStats.assetCount}, connected=${pmStats.isConnected}`);

        // Start REST price fallback polling for less active markets (e.g., quarterly)
        // This ensures prices are available even when WebSocket doesn't deliver updates
        this.restPricePollInterval = setInterval(async () => {
            const now = Date.now();
            const upStale = !this.lastUpPrice || (now - this.lastUpPrice.timestamp > 3000);
            const downStale = !this.lastDownPrice || (now - this.lastDownPrice.timestamp > 3000);

            if (upStale || downStale) {
                await this.fetchPolymarketPricesViaRest();
            }
        }, SuddenArb.REST_PRICE_POLL_MS);

        this.tickWrapper(1000, 500, async () => {
            if (!this.binancePriceBuffer.isLive()) {
                // Log occasionally to help debug
                if (Math.random() < 0.01) this.writeLog('Skipping tick: Binance buffer not live');
                return;
            }
            if (!this.polymarketManager.isActive()) {
                // Log occasionally to help debug
                if (Math.random() < 0.01) this.writeLog('Skipping tick: Polymarket not active');
                return;
            }
            await this.executeTradingLogic();
        });
    }

    private saveAllModels(): void {
        this.fairValueModel.save();
        this.exitModel.save();
        this.experienceReplayBuffer.save();
        this.mlpModel?.save();

        const stats = this.experienceReplayBuffer.getStats();
        const mlpStats = this.mlpModel?.getStats();
        const mlpInfo = mlpStats ? `, MLP: ${mlpStats.trainingEpochs} epochs` : '';

        // Periodic ExitModel health check: detect and recover from degenerate state
        // (weights pushed negative by too many non-fill training signals)
        const wasReset = this.exitModel.checkAndResetIfDegenerate();
        if (wasReset) {
            this.writeLog(`[HEALTH] ExitModel was degenerate (stuck at ~0) and has been reset to initial state`);
        } else {
            const avgFill = this.exitModel.getAverageFillProbability();
            this.writeLog(`Models saved (FV: ${this.fairValueModel.getTrainingSamples()}, Exit: ${this.exitModel.getTrainingSamples()}, Exit avg P(fill): ${(avgFill * 100).toFixed(1)}%, Replay: ${stats.size}${mlpInfo})`);
        }

        // Win rate summary
        if (this.winRateWindow.length >= 10) {
            const wins = this.winRateWindow.filter(w => w.wasCorrect).length;
            const winRate = wins / this.winRateWindow.length;
            this.writeLog(`[WIN_RATE] ${wins}/${this.winRateWindow.length} correct (${(winRate * 100).toFixed(1)}%) over last ${this.winRateWindow.length} periods${this.winRatePauseActive ? ' — PAUSED (too low)' : ''}`);
        }
    }

    private performReplayTraining(): void {
        const batch = this.experienceReplayBuffer.sampleBalanced(16);
        if (batch.length === 0) return;

        for (const sample of batch) {
            if (sample.modelType === 'fairValue') {
                this.fairValueModel.trainFromReplay(sample.features, sample.target);
            } else if (sample.modelType === 'exit') {
                this.exitModel.trainFromReplay(sample.features, sample.target);
            }
            // Note: 'timeout' samples are ignored - timeout now derived from ExitModel fill probability
        }
    }

    /**
     * Trains the MLP model from the replay buffer.
     * Called periodically (every 5 minutes by default).
     */
    private performMLPTraining(): void {
        if (!this.mlpModel) return;

        const stats = this.experienceReplayBuffer.getStats();
        if (stats.byType.fairValue < this.mlConfig.mlpMinSamplesForTraining) {
            return;  // Not enough samples yet
        }

        // Get all fair value samples from replay buffer
        const allSamples = this.experienceReplayBuffer.getAll();
        const fairValueSamples = allSamples
            .filter(s => s.modelType === 'fairValue')
            .map(s => {
                // Reconstruct UP/DOWN samples
                const isUp = s.features._direction === 1;
                return {
                    features: s.features,
                    actualUpPrice: isUp ? s.target : 0.5,
                    actualDownPrice: isUp ? 0.5 : s.target,
                };
            });

        // Pair UP and DOWN samples to get complete training examples
        // Group by timestamp (samples added at same time are pairs)
        const paired: Array<{
            features: Record<string, number>;
            actualUpPrice: number;
            actualDownPrice: number;
        }> = [];

        // Simple approach: use samples directly, handling missing pairs
        for (let i = 0; i < fairValueSamples.length - 1; i += 2) {
            const s1 = fairValueSamples[i];
            const s2 = fairValueSamples[i + 1];

            // Merge UP and DOWN samples
            const isS1Up = s1.features._direction === 1;
            paired.push({
                features: s1.features,
                actualUpPrice: isS1Up ? s1.actualUpPrice : s2.actualUpPrice,
                actualDownPrice: isS1Up ? s2.actualDownPrice : s1.actualDownPrice,
            });
        }

        if (paired.length < 10) return;  // Need at least 10 paired samples

        // Train for a few epochs
        const result = this.mlpModel.trainEpochs(paired, 5, 32, true);

        this.lastMLPTrainingTime = Date.now();
        const mlpStats = this.mlpModel.getStats();

        this.writeLog(
            `MLP trained: ${paired.length} samples, ` +
            `${mlpStats.trainingEpochs} total epochs, ` +
            `loss=${result.finalLoss.toFixed(6)}`
        );
    }

    private setupPeriodReset(): void {
        this.registerResetHandler(async () => {
            const currentRegime = this.mlConfig.useRegimeAwareness
                ? this.regimeDetector.getCurrentRegime()
                : undefined;

            if (this.tradesThisPeriod === 0) {
                const features = this.computeAllFeatures();
                const pmarketPrices = this.getCurrentPolymarketPrices();
                if (features && pmarketPrices) {
                    this.writeLog(`No trades this period - applying no-trade penalty to model`);
                    this.fairValueModel.applyNoTradePenalty(
                        features,
                        pmarketPrices.upMid,
                        pmarketPrices.downMid,
                        3.0,
                        currentRegime
                    );
                }
            } else {
                this.writeLog(`Made ${this.tradesThisPeriod} trades this period`);

                // Record win rate: use final market price as resolution proxy.
                // At period end, upMid > 0.70 strongly indicates UP resolved YES.
                // This lets us calibrate model accuracy over time.
                const endPrices = this.getCurrentPolymarketPrices();
                if (endPrices && this.tradesThisPeriod > 0) {
                    const upResolvedYes = endPrices.upMid > 0.70;

                    // For each distinct direction traded this period, record outcome
                    const directionsTraded = new Set(this.activeTrades.map(t => t.direction));
                    for (const direction of directionsTraded) {
                        const wasCorrect = direction === 'UP' ? upResolvedYes : !upResolvedYes;
                        this.winRateWindow.push({ predicted: direction as 'UP' | 'DOWN', wasCorrect });
                    }

                    // Keep window at fixed size
                    while (this.winRateWindow.length > SuddenArb.WIN_RATE_WINDOW_SIZE) {
                        this.winRateWindow.shift();
                    }

                    // Update pause state
                    if (this.winRateWindow.length >= 10) {
                        const wins = this.winRateWindow.filter(w => w.wasCorrect).length;
                        const winRate = wins / this.winRateWindow.length;
                        const wasAlreadyPaused = this.winRatePauseActive;
                        this.winRatePauseActive = winRate < SuddenArb.WIN_RATE_PAUSE_THRESHOLD;

                        if (this.winRatePauseActive && !wasAlreadyPaused) {
                            this.writeLog(`[WIN_RATE] ⚠️  Win rate dropped to ${(winRate * 100).toFixed(1)}% (threshold: ${(SuddenArb.WIN_RATE_PAUSE_THRESHOLD * 100).toFixed(0)}%). Trading PAUSED until model improves.`);
                        } else if (!this.winRatePauseActive && wasAlreadyPaused) {
                            this.writeLog(`[WIN_RATE] ✅ Win rate recovered to ${(winRate * 100).toFixed(1)}%. Trading RESUMED.`);
                        }
                    }
                }
            }

            await this.updateOrders();
            await this.auditAndReset();
            this.resetTradeState();

            const oldUpTokenId = this.upTokenId;
            const oldDownTokenId = this.downTokenId;

            const orderBooks = await this.marketInfo.getLiveData(this.targetedMarket);
            this.upTokenId = orderBooks.BtcUpTokenId;
            this.downTokenId = orderBooks.BtcDownTokenId;

            // Update subscription with new token IDs via shared manager
            if (oldUpTokenId && oldDownTokenId && this.polymarketSubscriberId) {
                // Unsubscribe old and resubscribe with new tokens
                await this.polymarketManager.unsubscribe(this.polymarketSubscriberId);

                const marketName = this.binanceSymbol.replace('USDT', '').toLowerCase();
                this.polymarketSubscriberId = await this.polymarketManager.subscribe({
                    id: `suddenarb-${this.binanceSymbol}-${Date.now()}`,
                    assetIds: [this.upTokenId, this.downTokenId],
                    onPrice: (update: PolymarketPriceUpdate) => {
                        if (update.assetId === this.upTokenId) {
                            this.lastUpPrice = update;
                        } else if (update.assetId === this.downTokenId) {
                            this.lastDownPrice = update;
                        }
                    },
                    onBook: (book: PolymarketBook) => {
                        if (book.assetId === this.upTokenId) {
                            this.lastUpBook = book;
                            this.lastUpDepth = OrderBookDepthAnalyzer.analyze(book);
                            DataLogger.logOrderBookDepth(marketName, 'up', this.lastUpDepth);
                        } else if (book.assetId === this.downTokenId) {
                            this.lastDownBook = book;
                            this.lastDownDepth = OrderBookDepthAnalyzer.analyze(book);
                            DataLogger.logOrderBookDepth(marketName, 'down', this.lastDownDepth);
                        }
                    },
                    onError: (error: Error) => {
                        this.writeError(`Polymarket WebSocket error: ${error.message}`);
                    },
                });

                // Note: We intentionally do NOT clear lastUpPrice/lastDownPrice here.
                // The new subscription's onPrice callbacks will overwrite them when new prices arrive.
                // This avoids "No PM prices" spam during the brief window between reset and first price.
                // Old prices (from old token IDs) may be used briefly, which is better than no prices.

                // Wait briefly for new price updates to arrive after resubscribing
                await new Promise(resolve => setTimeout(resolve, 3000));
                this.writeLog(`Period reset complete, new tokens: UP=${this.upTokenId.substring(0, 16)}..., DOWN=${this.downTokenId.substring(0, 16)}...`);
            }
        });
    }

    protected override resetTradeState(): void {
        // Note: TimeoutModel training removed - timeout now derived from ExitModel fill probability
        // Cancelled order trackers are still tracked but no longer used for timeout training

        // Complete any outstanding theoretical exit trackers before reset
        this.completeAllTheoreticalExitTrackers();

        this.activeTrades = [];
        this.tradesThisPeriod = 0;
        // Note: lastUpPrice, lastDownPrice, lastUpBook, lastDownBook, lastUpDepth, lastDownDepth
        // are NOT cleared anywhere - the new subscription's onPrice/onBook callbacks will overwrite
        // them when new data arrives. This prevents "No PM prices" spam at period boundaries,
        // especially on quarterly markets where resets happen every 15 minutes.
        this.pendingTrainingSamples = [];
        this.cancelledOrderTrackers = [];
        this.missedOpportunityTrackers = [];
        this.originalPriceTrackers = [];
        this.theoreticalTradeTrackers = [];
        this.theoreticalExitTrackers = [];
        this.imbalanceHistory = [];
        // Note: recentFillOutcomes preserved across periods for historical features
    }

    public override stop(): void {
        super.stop();

        // Release shared Binance buffer (will stop if no more subscribers)
        SharedPriceBufferManager.releaseBuffer(this.binanceSymbol);

        // Unsubscribe from shared Polymarket WebSocket
        if (this.polymarketSubscriberId) {
            this.polymarketManager.unsubscribe(this.polymarketSubscriberId).catch(err => {
                this.writeError(`Failed to unsubscribe from Polymarket: ${err}`);
            });
            this.polymarketSubscriberId = '';
        }

        if (this.modelSaveInterval) {
            clearInterval(this.modelSaveInterval);
        }
        if (this.replayTrainInterval) {
            clearInterval(this.replayTrainInterval);
        }
        if (this.mlpTrainInterval) {
            clearInterval(this.mlpTrainInterval);
        }
        if (this.restPricePollInterval) {
            clearInterval(this.restPricePollInterval);
        }
        this.saveAllModels();
    }

    private getCurrentPolymarketPrices(): { upMid: number; downMid: number } | null {
        // Try callback-populated prices first
        let upPrice = this.lastUpPrice;
        let downPrice = this.lastDownPrice;

        // Fallback: try getting from SharedPolymarketManager's cache
        // This helps when WebSocket callbacks haven't fired yet (e.g., less active quarterly markets)
        if (!upPrice && this.upTokenId) {
            upPrice = this.polymarketManager.getLastPrice(this.upTokenId) ?? null;
            if (upPrice) {
                this.lastUpPrice = upPrice;
            }
        }
        if (!downPrice && this.downTokenId) {
            downPrice = this.polymarketManager.getLastPrice(this.downTokenId) ?? null;
            if (downPrice) {
                this.lastDownPrice = downPrice;
            }
        }

        if (!upPrice || !downPrice) {
            if (Math.random() < 0.005) {
                this.writeLog(`No PM prices: lastUp=${!!upPrice}, lastDown=${!!downPrice}`);
            }
            return null;
        }

        const now = Date.now();
        if (now - upPrice.timestamp > 5000 ||
            now - downPrice.timestamp > 5000) {
            if (Math.random() < 0.005) {
                const upAge = now - upPrice.timestamp;
                const downAge = now - downPrice.timestamp;
                this.writeLog(`Stale PM prices: upAge=${upAge}ms, downAge=${downAge}ms`);
            }
            return null;
        }

        return {
            upMid: upPrice.midPrice,
            downMid: downPrice.midPrice,
        };
    }

    /**
     * Fetches prices via REST API as fallback when WebSocket prices aren't available.
     * This is slower but more reliable for less active markets like quarterly.
     */
    private async fetchPolymarketPricesViaRest(): Promise<{ upMid: number; downMid: number } | null> {
        try {
            const orderBooks = await this.marketInfo.getLiveData(this.targetedMarket);

            // Compute mid prices from order books
            const upBids = orderBooks.BtcUp.bids;
            const upAsks = orderBooks.BtcUp.asks;
            const downBids = orderBooks.BtcDown.bids;
            const downAsks = orderBooks.BtcDown.asks;

            const upBestBid = upBids.length > 0 ? parseFloat(upBids[upBids.length - 1].price) : 0;
            const upBestAsk = upAsks.length > 0 ? parseFloat(upAsks[0].price) : 1;
            const downBestBid = downBids.length > 0 ? parseFloat(downBids[downBids.length - 1].price) : 0;
            const downBestAsk = downAsks.length > 0 ? parseFloat(downAsks[0].price) : 1;

            const upMid = (upBestBid + upBestAsk) / 2;
            const downMid = (downBestBid + downBestAsk) / 2;

            // Update cached prices so subsequent calls use these
            const now = Date.now();
            this.lastUpPrice = {
                assetId: this.upTokenId,
                midPrice: upMid,
                bestBid: upBestBid,
                bestAsk: upBestAsk,
                spread: upBestAsk - upBestBid,
                timestamp: now,
            };
            this.lastDownPrice = {
                assetId: this.downTokenId,
                midPrice: downMid,
                bestBid: downBestBid,
                bestAsk: downBestAsk,
                spread: downBestAsk - downBestBid,
                timestamp: now,
            };

            return { upMid, downMid };
        } catch (e) {
            if (Math.random() < 0.01) {
                this.writeLog(`REST price fetch failed: ${e}`);
            }
            return null;
        }
    }

    /**
     * Computes all features for the ML model including new features.
     */
    private computeAllFeatures(): Record<string, number> | null {
        if (!this.binancePriceBuffer.isLive()) return null;

        const pmarketPrices = this.getCurrentPolymarketPrices();
        if (!pmarketPrices) return null;

        const currentPrice = this.binancePriceBuffer.getCurrentPrice();
        if (!currentPrice) return null;

        const ma30s = this.binancePriceBuffer.getMA(30);
        const ma60s = this.binancePriceBuffer.getMA(60);
        const ma5m = this.binancePriceBuffer.getMA(300);
        const vol30s = this.binancePriceBuffer.getVolatility(30);
        const vol60s = this.binancePriceBuffer.getVolatility(60);

        // Base features
        const features: Record<string, number> = {
            candle10s: this.binancePriceBuffer.getCandle(10),
            candle20s: this.binancePriceBuffer.getCandle(20),
            candle30s: this.binancePriceBuffer.getCandle(30),
            candle60s: this.binancePriceBuffer.getCandle(60),
            candle5m: this.binancePriceBuffer.getCandle(300),
            ma30s: ma30s > 0 ? (currentPrice - ma30s) / ma30s : 0,
            ma60s: ma60s > 0 ? (currentPrice - ma60s) / ma60s : 0,
            ma5m: ma5m > 0 ? (currentPrice - ma5m) / ma5m : 0,
            volatility30s: currentPrice > 0 ? vol30s / currentPrice : 0,
            volatility60s: currentPrice > 0 ? vol60s / currentPrice : 0,
            momentum: this.binancePriceBuffer.getCandle(10) - this.binancePriceBuffer.getCandle(30),
            priceVsMa: ma5m > 0 ? (currentPrice - ma5m) / ma5m : 0,
            upMid: pmarketPrices.upMid,
            downMid: pmarketPrices.downMid,
            upSpread: this.lastUpPrice?.spread ?? 0,
            downSpread: this.lastDownPrice?.spread ?? 0,
            imbalance: pmarketPrices.upMid - pmarketPrices.downMid,
        };

        // UP token depth features (always compute for consistent feature count)
        if (this.lastUpDepth) {
            features.upBidDepth1pct = this.lastUpDepth.bidDepth1pct;
            features.upAskDepth1pct = this.lastUpDepth.askDepth1pct;
            features.upBidDepth5pct = this.lastUpDepth.bidDepth5pct;
            features.upAskDepth5pct = this.lastUpDepth.askDepth5pct;
            features.upVolumeImbalance = this.lastUpDepth.volumeImbalance;
            features.upBidVWAP = this.lastUpDepth.bidVWAP;
            features.upAskVWAP = this.lastUpDepth.askVWAP;
            features.upBookPressure = this.lastUpDepth.bookPressure;

            // Order flow features (always computed for consistent feature count)
            features.upBidAskRatio = this.lastUpDepth.bidAskRatio;
            features.upTopBidConcentration = this.lastUpDepth.topBidConcentration;
            features.upTopAskConcentration = this.lastUpDepth.topAskConcentration;
        } else {
            // Default values when depth data unavailable
            features.upBidDepth1pct = 0;
            features.upAskDepth1pct = 0;
            features.upBidDepth5pct = 0;
            features.upAskDepth5pct = 0;
            features.upVolumeImbalance = 0;
            features.upBidVWAP = 0.5;
            features.upAskVWAP = 0.5;
            features.upBookPressure = 1;
            features.upBidAskRatio = 1;
            features.upTopBidConcentration = 0;
            features.upTopAskConcentration = 0;
        }

        // DOWN token depth features (always compute for consistent feature count)
        if (this.lastDownDepth) {
            features.downBidDepth1pct = this.lastDownDepth.bidDepth1pct;
            features.downAskDepth1pct = this.lastDownDepth.askDepth1pct;
            features.downBidDepth5pct = this.lastDownDepth.bidDepth5pct;
            features.downAskDepth5pct = this.lastDownDepth.askDepth5pct;
            features.downVolumeImbalance = this.lastDownDepth.volumeImbalance;
            features.downBidVWAP = this.lastDownDepth.bidVWAP;
            features.downAskVWAP = this.lastDownDepth.askVWAP;
            features.downBookPressure = this.lastDownDepth.bookPressure;

            features.downBidAskRatio = this.lastDownDepth.bidAskRatio;
            features.downTopBidConcentration = this.lastDownDepth.topBidConcentration;
            features.downTopAskConcentration = this.lastDownDepth.topAskConcentration;
        } else {
            // Default values when depth data unavailable
            features.downBidDepth1pct = 0;
            features.downAskDepth1pct = 0;
            features.downBidDepth5pct = 0;
            features.downAskDepth5pct = 0;
            features.downVolumeImbalance = 0;
            features.downBidVWAP = 0.5;
            features.downAskVWAP = 0.5;
            features.downBookPressure = 1;
            features.downBidAskRatio = 1;
            features.downTopBidConcentration = 0;
            features.downTopAskConcentration = 0;
        }

        // Time-based features (always computed for consistent feature count)
        const estTime = new Date(this.clock.getCurrentEstTimestamp());
        features.minuteInHour = estTime.getMinutes() / 60;
        features.secondInMinute = estTime.getSeconds() / 60;
        features.timeToHourEnd = (60 - estTime.getMinutes()) / 60;
        features.isFirstQuarter = estTime.getMinutes() < 15 ? 1 : 0;
        features.isLastQuarter = estTime.getMinutes() >= 45 ? 1 : 0;
        features.minuteSin = Math.sin(2 * Math.PI * estTime.getMinutes() / 60);
        features.minuteCos = Math.cos(2 * Math.PI * estTime.getMinutes() / 60);
        features.hourSin = Math.sin(2 * Math.PI * estTime.getHours() / 24);
        features.hourCos = Math.cos(2 * Math.PI * estTime.getHours() / 24);

        // Period progress - normalized time within the current trading period (0-1)
        const isQuarterly = this.targetedMarket.includes('Quarterly');
        const periodMinutes = isQuarterly ? 15 : 60;
        const minuteInPeriod = estTime.getMinutes() % periodMinutes;
        const secondInPeriod = estTime.getSeconds();
        features.periodProgress = (minuteInPeriod + secondInPeriod / 60) / periodMinutes;

        // Period start price tracking - detect new period and capture opening prices
        // Period index changes when we enter a new period (e.g., new hour or new 15-min block)
        const currentPeriodIndex = isQuarterly
            ? Math.floor(estTime.getMinutes() / 15) + estTime.getHours() * 4
            : estTime.getHours();

        if (currentPeriodIndex !== this.lastPeriodIndex) {
            // New period started - capture opening prices
            this.periodStartUpPrice = this.lastUpPrice?.midPrice ?? null;
            this.periodStartDownPrice = this.lastDownPrice?.midPrice ?? null;
            this.periodStartBinancePrice = currentPrice;
            this.lastPeriodIndex = currentPeriodIndex;

            if (this.periodStartUpPrice !== null || this.periodStartDownPrice !== null) {
                this.writeLog(`New period started - captured opening prices: UP=${this.periodStartUpPrice?.toFixed(4)}, DOWN=${this.periodStartDownPrice?.toFixed(4)}, Binance=${this.periodStartBinancePrice?.toFixed(2)}`);
            }
        }

        // Compute price vs period start features
        // These measure how far price has moved since the period opened
        features.upPriceVsPeriodStart = (this.periodStartUpPrice !== null && this.lastUpPrice)
            ? (this.lastUpPrice.midPrice - this.periodStartUpPrice) / Math.max(0.01, this.periodStartUpPrice)
            : 0;
        features.downPriceVsPeriodStart = (this.periodStartDownPrice !== null && this.lastDownPrice)
            ? (this.lastDownPrice.midPrice - this.periodStartDownPrice) / Math.max(0.01, this.periodStartDownPrice)
            : 0;
        features.binancePriceVsPeriodStart = (this.periodStartBinancePrice !== null && currentPrice)
            ? (currentPrice - this.periodStartBinancePrice) / this.periodStartBinancePrice
            : 0;

        // Cross-token features (always computed for consistent feature count)
        // Use safe division to prevent extreme ratios
        features.upDownSpreadRatio = features.downSpread > 0.01
            ? Math.max(0.1, Math.min(10, features.upSpread / features.downSpread))
            : 1;
        features.combinedLiquidity = (features.upBidDepth1pct ?? 0) + (features.downBidDepth1pct ?? 0);

        // Track imbalance history for velocity
        this.imbalanceHistory.push(features.imbalance);
        if (this.imbalanceHistory.length > SuddenArb.IMBALANCE_HISTORY_SIZE) {
            this.imbalanceHistory.shift();
        }
        features.imbalanceVelocity = this.computeImbalanceVelocity();

        // Correlation with stale data check
        features.upDownCorrelation = this.computeUpDownCorrelation();

        // Sanitize features - replace any NaN/Infinity with 0 to prevent model corruption
        // Log warnings to identify the source of corruption
        for (const key of Object.keys(features)) {
            if (!isFinite(features[key])) {
                this.nanFeatureCount++;
                if (this.nanFeatureCount <= SuddenArb.MAX_NAN_WARNINGS) {
                    this.writeLog(`WARNING: NaN/Infinity detected in feature "${key}": ${features[key]}`);
                    if (this.nanFeatureCount === SuddenArb.MAX_NAN_WARNINGS) {
                        this.writeLog(`Suppressing further NaN warnings (${this.nanFeatureCount} total)`);
                    }
                }
                features[key] = 0;
            }
        }

        return features;
    }

    private computeImbalanceVelocity(): number {
        if (this.imbalanceHistory.length < 5) return 0;

        const recent = this.imbalanceHistory.slice(-5);
        const older = this.imbalanceHistory.slice(-10, -5);

        if (older.length === 0) return 0;

        const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
        const olderAvg = older.reduce((a, b) => a + b, 0) / older.length;

        return recentAvg - olderAvg;
    }

    private computeUpDownCorrelation(): number {
        // Simple correlation estimate based on whether UP and DOWN moved together
        if (!this.lastUpPrice || !this.lastDownPrice) return 0;

        // Check for stale data (more than 5 seconds old)
        const now = Date.now();
        const maxAge = 5000;
        if (now - this.lastUpPrice.timestamp > maxAge ||
            now - this.lastDownPrice.timestamp > maxAge) {
            return 0;  // Return neutral if data is stale
        }

        // Check if timestamps are reasonably close to each other (within 2 seconds)
        if (Math.abs(this.lastUpPrice.timestamp - this.lastDownPrice.timestamp) > 2000) {
            return 0;  // Data from different time windows, can't compare
        }

        const upMove = this.lastUpPrice.midPrice - 0.5;
        const downMove = this.lastDownPrice.midPrice - 0.5;

        // If both moved same direction from 0.5, positive correlation
        // If opposite, negative correlation
        if (Math.abs(upMove) < 0.01 || Math.abs(downMove) < 0.01) return 0;

        return Math.sign(upMove) === Math.sign(downMove) ? 0.5 : -0.5;
    }

    private getRegimeFeatures(features: Record<string, number>): RegimeFeatures {
        return {
            volatility30s: features.volatility30s ?? 0,
            volatility60s: features.volatility60s ?? 0,
            momentum: features.momentum ?? 0,
            trendStrength: Math.abs(features.momentum ?? 0) * 10,  // Scale momentum to trend
            priceVsMa: features.priceVsMa ?? 0,
        };
    }

    private async executeTradingLogic(): Promise<void> {
        await this.updateOrders();
        this.processTrainingSamples();

        const features = this.computeAllFeatures();
        if (!features) {
            if (Math.random() < 0.01) this.writeLog('executeTradingLogic: no features computed');
            return;
        }

        // Update regime detector
        let currentRegime: MarketRegime | undefined;
        if (this.mlConfig.useRegimeAwareness) {
            const regimeFeatures = this.getRegimeFeatures(features);
            currentRegime = this.regimeDetector.detectRegime(regimeFeatures);
        }

        await this.processActiveTrades(features, currentRegime);
        this.processCounterfactualTrackers();
        this.processTheoreticalTrades();
        this.processTheoreticalExitTrackers();

        const pmarketPrices = this.getCurrentPolymarketPrices();
        if (!pmarketPrices) {
            if (Math.random() < 0.01) this.writeLog('executeTradingLogic: no Polymarket prices available');
            return;
        }

        // Get prediction (with or without uncertainty)
        let prediction: PredictionWithUncertainty;
        if (this.mlConfig.useUncertaintyEstimation) {
            prediction = this.fairValueModel.predictWithUncertainty(features, currentRegime);
        } else {
            const simplePred = this.fairValueModel.predict(features);
            prediction = {
                ...simplePred,
                upConfidence: 0.7,
                downConfidence: 0.7,
                upUncertainty: 0.3,
                downUncertainty: 0.3,
            };
        }

        // Ensemble with MLP if enabled and trained
        let fairUpPrice = prediction.upPrice;
        let fairDownPrice = prediction.downPrice;

        if (this.mlConfig.useMLPEnsemble && this.mlpModel) {
            const mlpStats = this.mlpModel.getStats();
            // Only use MLP if it has been trained
            if (mlpStats.trainingEpochs > 0) {
                const mlpPred = this.mlpModel.predict(features);

                // Weighted ensemble: (1 - weight) * linear + weight * MLP
                const w = this.mlConfig.mlpEnsembleWeight;
                fairUpPrice = (1 - w) * prediction.upPrice + w * mlpPred.upPrice;
                fairDownPrice = (1 - w) * prediction.downPrice + w * mlpPred.downPrice;
            }
        }

        const rawUpDivergence = fairUpPrice - pmarketPrices.upMid;
        const rawDownDivergence = fairDownPrice - pmarketPrices.downMid;

        // Win rate calibration: scale effective divergence by model accuracy.
        // A model at 50% win rate has zero edge; at 70%+ it has meaningful edge.
        // calibrationFactor = clamp(0.3, 1.0) based on rolling win rate:
        //   winRate < 50% → factor = 0.3  (strong headwind — allow only very large signals)
        //   winRate = 60% → factor = 0.7
        //   winRate >= 70% → factor = 1.0 (full signal)
        const calibrationFactor = this.getWinRateCalibrationFactor();
        const upDivergence = rawUpDivergence * calibrationFactor;
        const downDivergence = rawDownDivergence * calibrationFactor;

        // Periodic logging to show model vs market (every ~30 seconds)
        if (Math.random() < 0.033) {
            const winRate = this.getCurrentWinRate();
            const winRateStr = winRate !== null ? ` | WinRate=${(winRate * 100).toFixed(0)}% cal=${calibrationFactor.toFixed(2)}` : '';
            this.writeLog(`Model: fairUp=${fairUpPrice.toFixed(3)}, fairDown=${fairDownPrice.toFixed(3)} | Market: up=${pmarketPrices.upMid.toFixed(3)}, down=${pmarketPrices.downMid.toFixed(3)} | Div: up=${(upDivergence * 100).toFixed(2)}%, down=${(downDivergence * 100).toFixed(2)}% | Threshold=${(this.mispricingThreshold * 100).toFixed(2)}%${winRateStr}`);
        }

        if (upDivergence > this.mispricingThreshold && upDivergence > downDivergence) {
            // Sanity check: divergence above MAX_SANE_DIVERGENCE suggests a miscalibrated model
            if (upDivergence > SuddenArb.MAX_SANE_DIVERGENCE) {
                this.writeLog(`[SANITY] Skipping UP trade: divergence ${(upDivergence * 100).toFixed(1)}% exceeds sane limit (${(SuddenArb.MAX_SANE_DIVERGENCE * 100).toFixed(0)}%). Model may be miscalibrated. fair=${fairUpPrice.toFixed(3)}, market=${pmarketPrices.upMid.toFixed(3)}`);
            } else if (this.winRatePauseActive) {
                this.writeLog(`[WIN_RATE] Skipping UP trade: model win rate below ${(SuddenArb.WIN_RATE_PAUSE_THRESHOLD * 100).toFixed(0)}% threshold`);
            } else if (this.activeTrades.length >= this.maxConcurrentTrades) {
                this.writeLog(`[LIMIT] Skipping UP trade: already at max concurrent trades (${this.activeTrades.length}/${this.maxConcurrentTrades})`);
            } else {
                // Log confidence for debugging
                this.writeLog(`Signal UP: div=${(upDivergence * 100).toFixed(2)}%, conf=${prediction.upConfidence.toFixed(3)}, threshold=${this.mlConfig.minConfidenceToTrade}`);
                await this.executeArbitrage('UP', pmarketPrices.upMid, fairUpPrice, this.upTokenId, prediction, currentRegime);
            }
        } else if (downDivergence > this.mispricingThreshold) {
            // Sanity check: divergence above MAX_SANE_DIVERGENCE suggests a miscalibrated model
            if (downDivergence > SuddenArb.MAX_SANE_DIVERGENCE) {
                this.writeLog(`[SANITY] Skipping DOWN trade: divergence ${(downDivergence * 100).toFixed(1)}% exceeds sane limit (${(SuddenArb.MAX_SANE_DIVERGENCE * 100).toFixed(0)}%). Model may be miscalibrated. fair=${fairDownPrice.toFixed(3)}, market=${pmarketPrices.downMid.toFixed(3)}`);
            } else if (this.winRatePauseActive) {
                this.writeLog(`[WIN_RATE] Skipping DOWN trade: model win rate below ${(SuddenArb.WIN_RATE_PAUSE_THRESHOLD * 100).toFixed(0)}% threshold`);
            } else if (this.activeTrades.length >= this.maxConcurrentTrades) {
                this.writeLog(`[LIMIT] Skipping DOWN trade: already at max concurrent trades (${this.activeTrades.length}/${this.maxConcurrentTrades})`);
            } else {
                // Log confidence for debugging
                this.writeLog(`Signal DOWN: div=${(downDivergence * 100).toFixed(2)}%, conf=${prediction.downConfidence.toFixed(3)}, threshold=${this.mlConfig.minConfidenceToTrade}`);
                await this.executeArbitrage('DOWN', pmarketPrices.downMid, fairDownPrice, this.downTokenId, prediction, currentRegime);
            }
        } else {
            const minTrackDivergence = this.mispricingThreshold * SuddenArb.MISSED_OPP_DIVERGENCE_THRESHOLD;

            if (upDivergence > minTrackDivergence && upDivergence > downDivergence) {
                this.trackMissedOpportunity('UP', features, fairUpPrice, pmarketPrices.upMid, upDivergence);
            } else if (downDivergence > minTrackDivergence) {
                this.trackMissedOpportunity('DOWN', features, fairDownPrice, pmarketPrices.downMid, downDivergence);
            }
        }
    }

    /**
     * Returns the current rolling win rate, or null if insufficient data.
     */
    private getCurrentWinRate(): number | null {
        if (this.winRateWindow.length < 5) return null;
        const wins = this.winRateWindow.filter(w => w.wasCorrect).length;
        return wins / this.winRateWindow.length;
    }

    /**
     * Returns a calibration multiplier [0.3, 1.0] that scales divergence signals
     * based on the model's recent directional accuracy.
     *
     * - No data yet (< 5 periods): return 1.0 (no penalty until we have evidence)
     * - win rate >= 70%: factor = 1.0  (full signal — model has real edge)
     * - win rate = 50%: factor = 0.3  (severe reduction — model barely beats random)
     * - win rate <= 40%: factor = 0.0  (see winRatePauseActive for hard stop)
     */
    private getWinRateCalibrationFactor(): number {
        const winRate = this.getCurrentWinRate();
        if (winRate === null) return 1.0;  // Insufficient data — assume normal operation
        if (winRate >= 0.70) return 1.0;
        // Linear interpolation: 0.40→0.0, 0.70→1.0
        return Math.max(0.0, Math.min(1.0, (winRate - 0.40) / 0.30));
    }

    /**
     * Calculates position size based on confidence and divergence.
     * Uses additive multipliers to prevent exponential scaling.
     */
    private calculatePositionSize(
        prediction: PredictionWithUncertainty,
        direction: 'UP' | 'DOWN',
        divergence: number
    ): number {
        if (!this.mlConfig.useConfidencePositionSizing) {
            return this.maxPositionDollars;
        }

        const confidence = direction === 'UP' ? prediction.upConfidence : prediction.downConfidence;

        // Base position from config
        let positionDollars = this.maxPositionDollars;

        // Use additive approach to prevent compounding
        // Start at 0.6x base, add up to 0.4x from confidence, 0.3x from divergence
        let totalMultiplier = 0.6;

        // Confidence contribution: 0 to 0.4x (confidence ranges 0.1 to 0.95)
        const confidenceContribution = (confidence - 0.1) / 0.85 * 0.4;
        totalMultiplier += Math.max(0, confidenceContribution);

        // Divergence contribution: 0 to 0.3x
        const normalizedDivergence = Math.min(1, Math.abs(divergence) / (this.mispricingThreshold * 2));
        totalMultiplier += normalizedDivergence * 0.3;

        positionDollars *= totalMultiplier;

        // Apply regime adjustments (multiplicative but bounded)
        if (this.mlConfig.useRegimeAwareness) {
            const multipliers = this.regimeDetector.getRegimeMultipliers();
            // Bound regime multiplier to prevent extreme swings
            const boundedRegimeMultiplier = Math.max(0.5, Math.min(1.2, multipliers.positionSizeMultiplier));
            positionDollars *= boundedRegimeMultiplier;
        }

        // Hard cap at 1.2x max (was 1.5x) - more conservative
        return Math.min(positionDollars, this.maxPositionDollars * 1.2);
    }

    private trackMissedOpportunity(
        direction: 'UP' | 'DOWN',
        features: Record<string, number>,
        predictedFairPrice: number,
        marketPrice: number,
        divergence: number
    ): void {
        // Use MAX_MISSED_OPP_TRACKERS constant instead of magic number
        if (this.missedOpportunityTrackers.length >= SuddenArb.MAX_MISSED_OPP_TRACKERS) {
            // Remove oldest tracker to make room
            this.missedOpportunityTrackers.shift();
        }

        const recentTracker = this.missedOpportunityTrackers.find(
            t => t.direction === direction && Date.now() - t.timestamp < 10000
        );
        if (recentTracker) return;

        this.missedOpportunityCounter++;
        const tracker: MissedOpportunityTracker = {
            id: `missed-${direction}-${this.missedOpportunityCounter}`,
            direction,
            timestamp: Date.now(),
            features: { ...features },
            predictedFairPrice,
            marketPriceAtDecision: marketPrice,
            divergence,
            maxTrackingMs: SuddenArb.MISSED_OPP_TRACKING_MS,
        };
        this.missedOpportunityTrackers.push(tracker);
    }

    private async processActiveTrades(features: Record<string, number>, regime?: MarketRegime): Promise<void> {
        const completedTradeIds: string[] = [];

        for (const trade of this.activeTrades) {
            if (trade.buyOrder.status === TradeStatus.LIVE) {
                const orderAgeMs = Date.now() - trade.buyOrder.createdAt;
                if (orderAgeMs >= trade.buyTimeoutMs) {
                    await this.handleUnfilledTrade(trade, features, regime);
                }
            } else if (trade.buyOrder.status === TradeStatus.MATCHED && !trade.sellOrder) {
                const buyWaitTimeMs = Date.now() - trade.buyOrder.createdAt;
                // Record buy fill outcome for historical tracking
                this.recordFillOutcome(true, buyWaitTimeMs);
                // Note: TimeoutModel training removed - timeout derived from ExitModel fill probability
                await this.placeSellOrder(trade, features, regime);
            } else if (trade.buyOrder.status === TradeStatus.MATCHED && trade.sellOrder) {
                if (trade.sellOrder.status === TradeStatus.MATCHED) {
                    const sellWaitTimeMs = Date.now() - trade.sellOrder.createdAt;
                    // Record sell fill outcome for historical tracking
                    this.recordFillOutcome(true, sellWaitTimeMs);
                    // Note: TimeoutModel training removed - timeout derived from ExitModel fill probability

                    if (trade.repriceCount > 0 && trade.lastExitFeatures && trade.lastSuggestedPrice) {
                        const actualFillPrice = trade.sellOrder.targetSellPrice ?? trade.lastSuggestedPrice;
                        this.exitModel.train(trade.lastExitFeatures, actualFillPrice, true);

                        // Add to replay buffer
                        if (this.mlConfig.useExperienceReplay) {
                            this.experienceReplayBuffer.addExitSample(
                                trade.lastExitFeatures,
                                actualFillPrice,
                                true,
                                trade.lastSuggestedPrice
                            );
                        }
                    }

                    // Train FairValueModel on successful round-trip trade
                    // This is the strongest signal - our fair value prediction led to a profitable trade
                    const currentPrices = this.getCurrentPolymarketPrices();
                    if (currentPrices) {
                        // Calculate PnL for weighted training
                        const buyPrice = trade.buyOrder.targetBuyPrice ?? 0.5;
                        const sellPrice = trade.sellOrder.targetSellPrice ?? buyPrice;
                        const pnl = (sellPrice - buyPrice) / Math.max(buyPrice, 0.01);

                        // Compute sample weight based on PnL
                        const pnlWeight = this.mlConfig.usePnLWeightedTraining
                            ? 1 + Math.abs(pnl) * this.mlConfig.pnlWeightScalingFactor
                            : 1.0;

                        this.fairValueModel.train(
                            trade.placementFeatures,
                            currentPrices.upMid,
                            currentPrices.downMid,
                            regime,
                            pnlWeight
                        );

                        // Add to replay buffer for FairValueModel with PnL weight
                        if (this.mlConfig.useExperienceReplay) {
                            const predictedUp = trade.placementFeatures.upMid ?? currentPrices.upMid;
                            const predictedDown = trade.placementFeatures.downMid ?? currentPrices.downMid;
                            if (this.mlConfig.usePnLWeightedTraining) {
                                this.experienceReplayBuffer.addFairValueSampleWithPnL(
                                    trade.placementFeatures,
                                    currentPrices.upMid,
                                    currentPrices.downMid,
                                    predictedUp,
                                    predictedDown,
                                    'positive',  // Successful trade = positive outcome
                                    pnl,
                                    this.mlConfig.pnlWeightScalingFactor
                                );
                            } else {
                                this.experienceReplayBuffer.addFairValueSample(
                                    trade.placementFeatures,
                                    currentPrices.upMid,
                                    currentPrices.downMid,
                                    predictedUp,
                                    predictedDown,
                                    'positive'  // Successful trade = positive outcome
                                );
                            }
                        }

                        // Log PnL weight for monitoring
                        if (this.mlConfig.usePnLWeightedTraining && Math.abs(pnl) > 0.01) {
                            this.writeLog(`PnL-weighted training: pnl=${(pnl * 100).toFixed(2)}%, weight=${pnlWeight.toFixed(2)}`);
                        }
                    }

                    this.recordTrainingSample(trade.placementFeatures, regime);
                    this.writeLog(`Trade ${trade.id} complete: ${trade.direction} arbitrage successful`);
                    completedTradeIds.push(trade.id);
                } else if (trade.sellOrder.status === TradeStatus.LIVE) {
                    const sellOrderAgeMs = Date.now() - trade.sellOrder.createdAt;
                    const sellTimeoutMs = trade.sellTimeoutMs ?? ExitModel.getDefaultTimeoutMs();

                    if (sellOrderAgeMs >= sellTimeoutMs) {
                        await this.handleUnfilledSellOrder(trade, features, regime);
                    }
                } else if (trade.sellOrder.status === TradeStatus.EXPIRED ||
                           trade.sellOrder.status === TradeStatus.CANCELED) {
                    this.trainOnExpiredSell(trade, features, regime);
                    completedTradeIds.push(trade.id);
                }
            } else if (trade.buyOrder.status === TradeStatus.EXPIRED ||
                       trade.buyOrder.status === TradeStatus.CANCELED) {
                this.trainOnExpiredBuy(trade, features, regime);
                completedTradeIds.push(trade.id);
            }
        }

        this.activeTrades = this.activeTrades.filter(t => !completedTradeIds.includes(t.id));
    }

    private processCounterfactualTrackers(): void {
        const pmarketPrices = this.getCurrentPolymarketPrices();
        if (!pmarketPrices) return;

        const now = Date.now();
        const completedTrackerIds: string[] = [];

        for (const tracker of this.cancelledOrderTrackers) {
            const timeSinceCancel = now - tracker.cancelledAt;
            const currentMidPrice = tracker.direction === 'UP' ? pmarketPrices.upMid : pmarketPrices.downMid;

            let wouldHaveFilled = false;
            if (tracker.isBuy) {
                wouldHaveFilled = currentMidPrice <= tracker.targetPrice;
            } else {
                wouldHaveFilled = currentMidPrice >= tracker.targetPrice;
            }

            if (wouldHaveFilled) {
                // Note: TimeoutModel training removed - timeout derived from ExitModel fill probability
                // Counterfactual tracking still useful for analytics/logging
                completedTrackerIds.push(tracker.id);
            } else if (timeSinceCancel >= tracker.maxTrackingMs) {
                // Tracking expired without fill
                completedTrackerIds.push(tracker.id);
            }
        }

        this.cancelledOrderTrackers = this.cancelledOrderTrackers.filter(
            t => !completedTrackerIds.includes(t.id)
        );

        this.processMissedOpportunityTrackers();
        this.processOriginalPriceTrackers();
    }

    private processMissedOpportunityTrackers(): void {
        const pmarketPrices = this.getCurrentPolymarketPrices();
        if (!pmarketPrices) return;

        const now = Date.now();
        const completedTrackerIds: string[] = [];

        for (const tracker of this.missedOpportunityTrackers) {
            const timeSinceDecision = now - tracker.timestamp;
            const currentMidPrice = tracker.direction === 'UP' ? pmarketPrices.upMid : pmarketPrices.downMid;
            const hypotheticalProfit = currentMidPrice - tracker.marketPriceAtDecision;
            const significantProfit = hypotheticalProfit > this.targetProfitMargin;

            if (significantProfit) {
                const currentRegime = this.mlConfig.useRegimeAwareness
                    ? this.regimeDetector.getCurrentRegime()
                    : undefined;

                this.fairValueModel.train(
                    tracker.features,
                    pmarketPrices.upMid,
                    pmarketPrices.downMid,
                    currentRegime
                );
                completedTrackerIds.push(tracker.id);
            } else if (timeSinceDecision >= tracker.maxTrackingMs) {
                completedTrackerIds.push(tracker.id);
            }
        }

        this.missedOpportunityTrackers = this.missedOpportunityTrackers.filter(
            t => !completedTrackerIds.includes(t.id)
        );
    }

    private processOriginalPriceTrackers(): void {
        const pmarketPrices = this.getCurrentPolymarketPrices();
        if (!pmarketPrices) return;

        const now = Date.now();
        const completedTrackerIds: string[] = [];

        for (const tracker of this.originalPriceTrackers) {
            const timeSinceReprice = now - tracker.repricedAt;
            const currentMidPrice = tracker.direction === 'UP' ? pmarketPrices.upMid : pmarketPrices.downMid;
            const wouldHaveFilledAtOriginal = currentMidPrice >= tracker.originalSellPrice;

            if (wouldHaveFilledAtOriginal) {
                // Original price would have filled - train as positive
                this.exitModel.train(tracker.exitFeatures, tracker.originalSellPrice, true);

                // Add to replay buffer
                if (this.mlConfig.useExperienceReplay) {
                    this.experienceReplayBuffer.addExitSample(
                        tracker.exitFeatures,
                        tracker.originalSellPrice,
                        true,
                        tracker.originalSellPrice
                    );
                }
                completedTrackerIds.push(tracker.id);
            } else if (timeSinceReprice >= tracker.maxTrackingMs) {
                // Original price never reached - train as negative (repricing was correct)
                this.exitModel.train(tracker.exitFeatures, 0, false);

                // Add to replay buffer
                if (this.mlConfig.useExperienceReplay) {
                    this.experienceReplayBuffer.addExitSample(
                        tracker.exitFeatures,
                        0,
                        false,
                        tracker.originalSellPrice
                    );
                }
                completedTrackerIds.push(tracker.id);
            }
        }

        this.originalPriceTrackers = this.originalPriceTrackers.filter(
            t => !completedTrackerIds.includes(t.id)
        );
    }

    /**
     * Processes theoretical trades - tracks price movement and trains models.
     * Theoretical trades help us learn from situations where we had a signal
     * but lacked confidence to actually trade.
     */
    private processTheoreticalTrades(): void {
        if (!this.mlConfig.useTheoreticalTrades) return;

        const pmarketPrices = this.getCurrentPolymarketPrices();
        if (!pmarketPrices) return;

        const now = Date.now();
        const completedTrackerIds: string[] = [];
        const currentRegime = this.mlConfig.useRegimeAwareness
            ? this.regimeDetector.getCurrentRegime()
            : undefined;

        for (const tracker of this.theoreticalTradeTrackers) {
            const timeSinceEntry = now - tracker.timestamp;
            const currentPrice = tracker.direction === 'UP' ? pmarketPrices.upMid : pmarketPrices.downMid;

            // Update best/worst prices seen
            tracker.bestPriceSeen = Math.max(tracker.bestPriceSeen, currentPrice);
            tracker.worstPriceSeen = Math.min(tracker.worstPriceSeen, currentPrice);

            // Calculate hypothetical P&L
            const hypotheticalProfit = currentPrice - tracker.entryPrice;
            const reachedTarget = currentPrice >= tracker.targetExitPrice;
            const significantProfit = hypotheticalProfit > this.targetProfitMargin * 0.5;

            // Check if we should complete this tracker
            if (timeSinceEntry >= tracker.maxTrackingMs) {
                // Tracking period complete - train based on outcome
                const bestProfit = tracker.bestPriceSeen - tracker.entryPrice;
                const worstDrawdown = tracker.entryPrice - tracker.worstPriceSeen;

                // Determine if this would have been a good trade
                const wouldHaveBeenProfitable = bestProfit > this.targetProfitMargin * 0.5;

                if (wouldHaveBeenProfitable) {
                    // This was a missed opportunity - train model toward fair value
                    this.fairValueModel.train(
                        tracker.features,
                        pmarketPrices.upMid,
                        pmarketPrices.downMid,
                        currentRegime
                    );

                    // Add to experience replay for additional learning
                    if (this.mlConfig.useExperienceReplay) {
                        this.experienceReplayBuffer.add({
                            timestamp: tracker.timestamp,
                            features: tracker.features,
                            target: tracker.direction === 'UP' ? pmarketPrices.upMid : pmarketPrices.downMid,
                            outcome: 'positive',
                            modelType: 'fairValue',
                            weight: 0.8,  // Slightly lower weight than real trades
                        });
                    }

                    this.writeLog(`Theoretical ${tracker.id} result: PROFITABLE [TRAINED] - best=${(bestProfit * 100).toFixed(1)}%, conf was ${tracker.confidence.toFixed(2)}`);
                } else if (this.mlConfig.useBalancedTheoreticalTraining) {
                    // NEW: Also train on would-have-lost trades to eliminate survivorship bias
                    // Use lower weight since confidence was correctly low
                    const weight = this.mlConfig.negativeExampleWeight;

                    this.fairValueModel.train(
                        tracker.features,
                        pmarketPrices.upMid,
                        pmarketPrices.downMid,
                        currentRegime,
                        weight
                    );

                    // Add negative example to experience replay
                    if (this.mlConfig.useExperienceReplay) {
                        this.experienceReplayBuffer.add({
                            timestamp: tracker.timestamp,
                            features: tracker.features,
                            target: tracker.direction === 'UP' ? pmarketPrices.upMid : pmarketPrices.downMid,
                            outcome: 'negative',
                            modelType: 'fairValue',
                            weight: weight,
                            pnl: -worstDrawdown,  // Negative PnL for losing trade
                        });
                    }

                    this.writeLog(`Theoretical ${tracker.id} result: AVOIDED LOSS [TRAINED] - worst=${(worstDrawdown * 100).toFixed(1)}%, weight=${weight.toFixed(2)}, conf was ${tracker.confidence.toFixed(2)}`);
                } else {
                    // Confidence was correctly low - this would have been a bad trade (no training)
                    this.writeLog(`Theoretical ${tracker.id} result: AVOIDED LOSS - worst=${(worstDrawdown * 100).toFixed(1)}%, conf was ${tracker.confidence.toFixed(2)}`);
                }

                completedTrackerIds.push(tracker.id);
            } else if (reachedTarget) {
                // Hit target early - definitely a missed opportunity
                this.fairValueModel.train(
                    tracker.features,
                    pmarketPrices.upMid,
                    pmarketPrices.downMid,
                    currentRegime
                );

                if (this.mlConfig.useExperienceReplay) {
                    this.experienceReplayBuffer.add({
                        timestamp: tracker.timestamp,
                        features: tracker.features,
                        target: tracker.direction === 'UP' ? pmarketPrices.upMid : pmarketPrices.downMid,
                        outcome: 'positive',
                        modelType: 'fairValue',
                        weight: 1.0,  // Full weight - clear signal
                    });
                }

                this.writeLog(`Theoretical ${tracker.id} HIT TARGET in ${(timeSinceEntry / 1000).toFixed(1)}s! conf was ${tracker.confidence.toFixed(2)}`);
                completedTrackerIds.push(tracker.id);
            }
        }

        this.theoreticalTradeTrackers = this.theoreticalTradeTrackers.filter(
            t => !completedTrackerIds.includes(t.id)
        );
    }

    /**
     * Creates a theoretical exit tracker at a trade signal.
     * Used to simulate what fill prices could have been achieved at different offsets.
     */
    private createTheoreticalExitTracker(
        direction: 'UP' | 'DOWN',
        entryMidPrice: number,
        entrySpread: number
    ): void {
        if (!this.mlConfig.useEnhancedExitModel) return;

        // Enforce max trackers limit
        if (this.theoreticalExitTrackers.length >= SuddenArb.MAX_THEORETICAL_EXIT_TRACKERS) {
            // Complete oldest tracker before removing
            const oldest = this.theoreticalExitTrackers.shift();
            if (oldest) {
                this.completeTheoreticalExitTracker(oldest);
            }
        }

        const features = this.computeEnhancedExitFeatures(direction, entryMidPrice, entrySpread);
        if (!features) return;

        // Initialize simulated levels
        // Always add offset since we're SELLING tokens - we want price to go UP to get a better sell price
        // Whether UP or DOWN token, we bought at entryMidPrice and want to sell higher
        const simulatedLevels: SimulatedExitLevel[] = this.mlConfig.exitSimulationLevels.map(offset => ({
            targetPrice: entryMidPrice + offset,
            offsetFromMid: offset,
            wasHit: false,
            firstHitTimeMs: null,
            hitCount: 0,
            timeAboveLevel: 0,
        }));

        this.theoreticalExitCounter++;
        const tracker: TheoreticalExitTracker = {
            id: `exit-sim-${direction}-${this.theoreticalExitCounter}`,
            direction,
            timestamp: Date.now(),
            entryFeatures: features,
            entryMidPrice,
            entrySpread,
            simulatedLevels,
            maxTrackingMs: this.mlConfig.exitSimulationDurationMs,
            bestPriceSeen: entryMidPrice,
            worstPriceSeen: entryMidPrice,
            lastUpdateMs: Date.now(),
        };

        this.theoreticalExitTrackers.push(tracker);
    }

    /**
     * Processes all theoretical exit trackers.
     * Updates simulated levels based on current price and completes expired trackers.
     */
    private processTheoreticalExitTrackers(): void {
        if (!this.mlConfig.useEnhancedExitModel) return;

        const pmarketPrices = this.getCurrentPolymarketPrices();
        if (!pmarketPrices) return;

        const now = Date.now();
        const completedTrackerIds: string[] = [];

        for (const tracker of this.theoreticalExitTrackers) {
            const timeSinceEntry = now - tracker.timestamp;
            const timeSinceLastUpdate = now - tracker.lastUpdateMs;
            const currentPrice = tracker.direction === 'UP' ? pmarketPrices.upMid : pmarketPrices.downMid;

            // Update best/worst prices
            tracker.bestPriceSeen = Math.max(tracker.bestPriceSeen, currentPrice);
            tracker.worstPriceSeen = Math.min(tracker.worstPriceSeen, currentPrice);

            // Update each simulated level
            // Always check >= since targets are always above entry (we want to SELL higher)
            for (const level of tracker.simulatedLevels) {
                const priceReachedLevel = currentPrice >= level.targetPrice;

                if (priceReachedLevel) {
                    if (!level.wasHit) {
                        // First time hitting this level
                        level.wasHit = true;
                        level.firstHitTimeMs = timeSinceEntry;
                    }
                    level.hitCount++;
                    level.timeAboveLevel += timeSinceLastUpdate;
                }
            }

            tracker.lastUpdateMs = now;

            // Check if tracking period complete
            if (timeSinceEntry >= tracker.maxTrackingMs) {
                this.completeTheoreticalExitTracker(tracker);
                completedTrackerIds.push(tracker.id);
            }
        }

        this.theoreticalExitTrackers = this.theoreticalExitTrackers.filter(
            t => !completedTrackerIds.includes(t.id)
        );
    }

    /**
     * Completes a theoretical exit tracker and trains the ExitModel.
     */
    private completeTheoreticalExitTracker(tracker: TheoreticalExitTracker): void {
        // Train ExitModel from simulation data
        this.exitModel.trainFromSimulation(
            tracker.entryFeatures,
            tracker.simulatedLevels,
            tracker.direction
        );

        // Add to experience replay buffer for additional training
        if (this.mlConfig.useExperienceReplay) {
            // Find best achieved offset
            const hitLevels = tracker.simulatedLevels.filter(l => l.wasHit);
            const bestOffset = hitLevels.length > 0
                ? Math.max(...hitLevels.map(l => l.offsetFromMid))
                : 0;

            // Add simulation sample with weight based on config
            // _simulationType: 2 = exitBest (summary sample)
            this.experienceReplayBuffer.add({
                timestamp: tracker.timestamp,
                features: {
                    ...tracker.entryFeatures,
                    _simulationType: 2, // exitBest
                    _direction: tracker.direction === 'UP' ? 1 : 0,
                    _bestOffset: bestOffset,
                },
                target: tracker.entryMidPrice + (tracker.direction === 'UP' ? bestOffset : -bestOffset),
                outcome: hitLevels.length > 0 ? 'positive' : 'negative',
                modelType: 'exit',
                weight: this.mlConfig.exitSimulationWeight,
            });
        }

        // Log summary
        const hitCount = tracker.simulatedLevels.filter(l => l.wasHit).length;
        const totalLevels = tracker.simulatedLevels.length;
        if (hitCount > 0) {
            const bestLevel = tracker.simulatedLevels
                .filter(l => l.wasHit)
                .reduce((best, curr) => curr.offsetFromMid > best.offsetFromMid ? curr : best);
            this.writeLog(`ExitSim ${tracker.id}: ${hitCount}/${totalLevels} levels hit, best=${(bestLevel.offsetFromMid * 100).toFixed(1)}%`);
        }
    }

    /**
     * Completes all theoretical exit trackers (called on period reset).
     */
    private completeAllTheoreticalExitTrackers(): void {
        for (const tracker of this.theoreticalExitTrackers) {
            this.completeTheoreticalExitTracker(tracker);
        }
        this.theoreticalExitTrackers = [];
    }

    /**
     * Computes enhanced exit features (25 features) for the ExitModel.
     */
    private computeEnhancedExitFeatures(
        direction: 'UP' | 'DOWN',
        currentMidPrice: number,
        currentSpread: number
    ): Record<string, number> | null {
        // Use the same 53 features as FairValueModel for consistency
        // ExitModel will add targetOffset when needed for level-specific predictions
        const allFeatures = this.computeAllFeatures();
        if (!allFeatures) return null;

        // Return all features directly - ExitModel now uses the same 53 features as FairValueModel
        // plus targetOffset which is added during training/prediction
        return allFeatures;
    }

    /**
     * Computes historical fill statistics from recent outcomes.
     */
    private computeHistoricalFillStats(): { recentFillRate: number; avgTimeToFill: number } {
        const now = Date.now();
        const windowStart = now - SuddenArb.FILL_HISTORY_WINDOW_MS;

        // Filter to recent outcomes
        const recentOutcomes = this.recentFillOutcomes.filter(o => o.timestamp > windowStart);

        if (recentOutcomes.length === 0) {
            return { recentFillRate: 0.5, avgTimeToFill: 30 };
        }

        const filledCount = recentOutcomes.filter(o => o.filled).length;
        const recentFillRate = filledCount / recentOutcomes.length;

        const filledOutcomes = recentOutcomes.filter(o => o.filled);
        const avgTimeToFill = filledOutcomes.length > 0
            ? filledOutcomes.reduce((sum, o) => sum + o.timeToFillMs, 0) / filledOutcomes.length / 1000
            : 30;

        return { recentFillRate, avgTimeToFill };
    }

    /**
     * Records a fill outcome for historical tracking.
     */
    private recordFillOutcome(filled: boolean, timeToFillMs: number): void {
        this.recentFillOutcomes.push({
            timestamp: Date.now(),
            filled,
            timeToFillMs,
        });

        // Enforce size limit
        while (this.recentFillOutcomes.length > SuddenArb.FILL_HISTORY_SIZE) {
            this.recentFillOutcomes.shift();
        }
    }

    private async handleUnfilledTrade(trade: ActiveTrade, features: Record<string, number>, regime?: MarketRegime): Promise<void> {
        // Note: We do NOT train ExitModel here - this is a BUY order that didn't fill.
        // ExitModel is only for exit (SELL) decisions.

        const canceled = await this.cancelTrade(trade.buyOrder);
        if (!canceled) return;

        const waitTimeMs = Date.now() - trade.buyOrder.createdAt;
        const tracker: CancelledOrderTracker = {
            id: `${trade.id}-buy`,
            direction: trade.direction,
            isBuy: true,
            targetPrice: trade.buyOrder.targetBuyPrice ?? 0.5,
            cancelledAt: Date.now(),
            originalTimeoutMs: trade.buyTimeoutMs,
            actualWaitMs: waitTimeMs,
            placementFeatures: { ...trade.placementFeatures },
            maxTrackingMs: trade.buyTimeoutMs * SuddenArb.COUNTERFACTUAL_TRACKING_MULTIPLIER,
        };
        this.cancelledOrderTrackers.push(tracker);
        // Enforce hard limit - remove oldest if over limit
        while (this.cancelledOrderTrackers.length > SuddenArb.MAX_CANCELLED_ORDER_TRACKERS) {
            this.cancelledOrderTrackers.shift();
        }

        const currentPrices = this.getCurrentPolymarketPrices();
        if (currentPrices) {
            this.fairValueModel.train(
                trade.placementFeatures,
                currentPrices.upMid,
                currentPrices.downMid,
                regime
            );
        }

        this.activeTrades = this.activeTrades.filter(t => t.id !== trade.id);
    }

    private async handleUnfilledSellOrder(trade: ActiveTrade, features: Record<string, number>, regime?: MarketRegime): Promise<void> {
        if (!trade.sellOrder) return;

        const exitFeatures = this.computeExitFeatures(features, trade.sellOrder, trade.placementBookPressure, trade.direction);

        const canceled = await this.cancelTrade(trade.sellOrder);
        if (!canceled) return;

        // Record unfilled outcome for historical tracking
        const waitTimeMs = Date.now() - trade.sellOrder.createdAt;
        this.recordFillOutcome(false, waitTimeMs);

        const sellPrice = trade.sellOrder.targetSellPrice ?? 0.5;
        this.exitModel.train(exitFeatures, 0, false);

        // Add negative outcome to replay buffer for balanced training
        if (this.mlConfig.useExperienceReplay) {
            this.experienceReplayBuffer.addExitSample(
                exitFeatures,
                0,      // actualFillPrice = 0 (didn't fill)
                false,  // filled = false
                sellPrice
            );
        }

        const originalSellTimeoutMs = trade.sellTimeoutMs ?? ExitModel.getDefaultTimeoutMs();

        const tracker: CancelledOrderTracker = {
            id: `${trade.id}-sell-${trade.repriceCount}`,
            direction: trade.direction,
            isBuy: false,
            targetPrice: sellPrice,
            cancelledAt: Date.now(),
            originalTimeoutMs: originalSellTimeoutMs,
            actualWaitMs: waitTimeMs,
            placementFeatures: { ...trade.placementFeatures },
            maxTrackingMs: originalSellTimeoutMs * SuddenArb.COUNTERFACTUAL_TRACKING_MULTIPLIER,
        };
        this.cancelledOrderTrackers.push(tracker);
        // Enforce hard limit
        while (this.cancelledOrderTrackers.length > SuddenArb.MAX_CANCELLED_ORDER_TRACKERS) {
            this.cancelledOrderTrackers.shift();
        }

        const originalPriceTracker: OriginalPriceTracker = {
            id: `${trade.id}-origprice-${trade.repriceCount}`,
            direction: trade.direction,
            originalSellPrice: trade.sellOrder.targetSellPrice ?? 0.5,
            repricedAt: Date.now(),
            exitFeatures: { ...exitFeatures },
            maxTrackingMs: SuddenArb.ORIGINAL_PRICE_TRACKING_MS,
        };
        this.originalPriceTrackers.push(originalPriceTracker);
        // Enforce hard limit
        while (this.originalPriceTrackers.length > SuddenArb.MAX_ORIGINAL_PRICE_TRACKERS) {
            this.originalPriceTrackers.shift();
        }

        const buyPrice = trade.buyOrder.targetBuyPrice ?? 0.5;
        const originalSellPrice = trade.sellOrder.targetSellPrice ?? (buyPrice + this.targetProfitMargin);

        // Stop-loss floor: allow selling below minProfitMargin on reprices
        // First reprice: floor at breakeven (buyPrice)
        // Subsequent reprices: floor at buyPrice - 5% (accept small loss to exit)
        const stopLossFloor = trade.repriceCount === 0
            ? buyPrice  // First reprice: try to break even
            : Math.max(0.01, buyPrice - 0.05);  // Subsequent: accept up to 5% loss

        // Use enhanced ExitModel if enabled, otherwise fall back to legacy 50/50 blend
        let newSellPrice: number;
        const pmarketPrices = this.getCurrentPolymarketPrices();
        const currentMid = pmarketPrices
            ? (trade.direction === 'UP' ? pmarketPrices.upMid : pmarketPrices.downMid)
            : 0.5;
        const periodProgress = features.periodProgress ?? 0;

        // Emergency stop-loss: if market has dropped >12% below buy price, cut the loss
        // immediately rather than waiting for further reprices. Better to take a 12% loss
        // now than a 100% loss at expiry.
        const drawdownPct = (buyPrice - currentMid) / buyPrice;
        if (drawdownPct > 0.12 && trade.repriceCount > 0) {
            const emergencyPrice = Math.max(0.01, currentMid - 0.01);  // Just below bid to fill fast
            this.writeLog(`[STOP_LOSS] Market dropped ${(drawdownPct * 100).toFixed(1)}% below buy price (${buyPrice.toFixed(3)} → ${currentMid.toFixed(3)}). Emergency exit at ${emergencyPrice.toFixed(3)}`);
            trade.sellOrder = await this.makeOrder(
                `arb-${trade.id}-sell-stoploss`,
                trade.buyOrder.clobTokenId,
                emergencyPrice,
                trade.buyOrder.amount,
                Side.SELL,
            );
            trade.repriceCount++;
            return;
        }

        if (this.mlConfig.useEnhancedExitModel) {
            const enhancedPrediction = this.exitModel.findOptimalPrice(
                exitFeatures,
                this.mlConfig.minFillProbability,
                trade.direction,
                currentMid
            );

            // Use expected value optimization with stop-loss floor
            newSellPrice = Math.max(stopLossFloor, Math.min(0.99, enhancedPrediction.suggestedPrice));

            const profitPct = ((newSellPrice - buyPrice) / buyPrice * 100).toFixed(1);
            this.writeLog(`ExitModel reprice #${trade.repriceCount + 1}: price=${newSellPrice.toFixed(3)} (${profitPct}%), EV=${(enhancedPrediction.expectedValue * 100).toFixed(2)}, P(fill)=${(enhancedPrediction.fillProbability * 100).toFixed(0)}%, floor=${stopLossFloor.toFixed(3)}`);
        } else {
            // Legacy 50/50 blend with stop-loss floor
            const exitPrediction = this.exitModel.predict(exitFeatures);
            const suggestedPrice = exitPrediction.suggestedPrice;
            newSellPrice = Math.max(stopLossFloor, Math.min(0.99, (originalSellPrice + suggestedPrice) / 2));
        }

        // Apply time-aware cap: lower price aggressively if period is near expiry
        const timeAwareCap = this.getTimeAwareSellPriceCap(periodProgress, currentMid, buyPrice);
        if (timeAwareCap !== null) {
            // In reprice context, override the stop-loss floor too — expiry is worse than a small loss
            const cappedPrice = Math.max(0.01, Math.min(newSellPrice, timeAwareCap));
            if (cappedPrice < newSellPrice) {
                this.writeLog(`[TIME_AWARE] Reprice capped from ${newSellPrice.toFixed(3)} to ${cappedPrice.toFixed(3)} (progress: ${(periodProgress * 100).toFixed(0)}%)`);
                newSellPrice = cappedPrice;
            }
        }

        // Sell timeout derived from ExitModel using fill probability
        const targetOffset = newSellPrice - (features.upMid ?? features.downMid ?? 0.5);
        const newSellTimeoutMs = this.exitModel.predictSellTimeout(features, Math.abs(targetOffset));
        trade.sellTimeoutMs = newSellTimeoutMs;

        trade.lastExitFeatures = { ...exitFeatures };
        trade.lastSuggestedPrice = newSellPrice;
        trade.repriceCount++;

        trade.sellOrder = await this.makeOrder(
            `arb-${trade.id}-sell-retry-${trade.repriceCount}`,
            trade.buyOrder.clobTokenId,
            newSellPrice,
            trade.buyOrder.amount,
            Side.SELL,
        );
    }

    private trainOnExpiredBuy(trade: ActiveTrade, features: Record<string, number>, regime?: MarketRegime): void {
        // Note: TimeoutModel training removed - timeout derived from ExitModel fill probability

        const currentPrices = this.getCurrentPolymarketPrices();
        if (currentPrices) {
            this.fairValueModel.train(
                trade.placementFeatures,
                currentPrices.upMid,
                currentPrices.downMid,
                regime
            );
        }
    }

    private trainOnExpiredSell(trade: ActiveTrade, features: Record<string, number>, regime?: MarketRegime): void {
        if (!trade.sellOrder) return;

        // Note: TimeoutModel training removed - timeout derived from ExitModel fill probability

        if (trade.repriceCount > 0 && trade.lastExitFeatures) {
            this.exitModel.train(trade.lastExitFeatures, 0, false);

            // Add negative outcome to replay buffer for balanced training
            if (this.mlConfig.useExperienceReplay && trade.lastSuggestedPrice) {
                this.experienceReplayBuffer.addExitSample(
                    trade.lastExitFeatures,
                    0,      // actualFillPrice = 0 (didn't fill)
                    false,  // filled = false
                    trade.lastSuggestedPrice
                );
            }
        }

        const currentPrices = this.getCurrentPolymarketPrices();
        if (currentPrices) {
            this.fairValueModel.train(
                trade.placementFeatures,
                currentPrices.upMid,
                currentPrices.downMid,
                regime
            );
        }
    }

    /**
     * Returns the time-aware sell price cap based on period progress.
     *
     * As the period approaches expiry, we lower the sell target to ensure the
     * position exits before the period resets. Holding through period end means
     * tokens resolve at 0 or 1 — acceptable for a winning bet, catastrophic for
     * a losing one.
     *
     * - periodProgress < 0.70: full profit target (use normal pricing)
     * - periodProgress 0.70-0.85: moderate urgency, cap at mid + 1.5%
     * - periodProgress 0.85-0.95: high urgency, cap at mid + 0.3%
     * - periodProgress > 0.95: critical, accept break-even or small loss
     */
    private getTimeAwareSellPriceCap(
        periodProgress: number,
        currentMid: number,
        buyPrice: number
    ): number | null {
        if (periodProgress >= 0.95) {
            // Final 5%: accept break-even or up to 2% loss to ensure exit
            return Math.max(0.01, buyPrice - 0.02);
        } else if (periodProgress >= 0.85) {
            // Final 15%: cap at mid + 0.3% (tight, likely to fill)
            return Math.min(0.99, currentMid + 0.003);
        } else if (periodProgress >= 0.70) {
            // Final 30%: cap at mid + 1.5%
            return Math.min(0.99, currentMid + 0.015);
        }
        return null;  // No cap — use normal pricing
    }

    private async placeSellOrder(trade: ActiveTrade, features: Record<string, number>, regime?: MarketRegime): Promise<void> {
        const buyPrice = trade.buyOrder.targetBuyPrice ?? 0.5;
        const minSellPrice = Math.min(0.99, buyPrice + this.minProfitMargin);  // Floor based on minProfitMargin
        const periodProgress = features.periodProgress ?? 0;

        let sellPrice: number;

        // Use ExitModel to determine optimal sell price when enabled and model has training data
        if (this.mlConfig.useEnhancedExitModel && this.exitModel.getTrainingSamples() > 10) {
            const pmarketPrices = this.getCurrentPolymarketPrices();
            const currentMid = pmarketPrices
                ? (trade.direction === 'UP' ? pmarketPrices.upMid : pmarketPrices.downMid)
                : buyPrice;

            // Compute exit features for prediction
            const exitFeatures = this.computeExitFeatures(features, trade.buyOrder, trade.placementBookPressure, trade.direction);

            // Get optimal price from ExitModel
            const enhancedPrediction = this.exitModel.findOptimalPrice(
                exitFeatures,
                this.mlConfig.minFillProbability,
                trade.direction,
                currentMid
            );

            // Use ExitModel suggested price (max expected value), but enforce minProfitMargin floor
            sellPrice = Math.max(minSellPrice, Math.min(0.99, enhancedPrediction.suggestedPrice));

            // Apply time-aware cap: lower sell target if period is near expiry
            const timeAwareCap = this.getTimeAwareSellPriceCap(periodProgress, currentMid, buyPrice);
            if (timeAwareCap !== null && sellPrice > timeAwareCap) {
                this.writeLog(`[TIME_AWARE] Capping sell from ${sellPrice.toFixed(3)} to ${timeAwareCap.toFixed(3)} (progress: ${(periodProgress * 100).toFixed(0)}%)`);
                sellPrice = timeAwareCap;
            }

            this.writeLog(`ExitModel initial sell: offset=${(enhancedPrediction.suggestedOffset * 100).toFixed(1)}%, EV=${(enhancedPrediction.expectedValue * 100).toFixed(2)}, P(fill)=${(enhancedPrediction.fillProbability * 100).toFixed(0)}%, price=${sellPrice.toFixed(3)} (min=${minSellPrice.toFixed(3)})`);
        } else {
            // Fallback to targetProfitMargin when ExitModel not ready
            const pmarketPrices = this.getCurrentPolymarketPrices();
            const currentMid = pmarketPrices
                ? (trade.direction === 'UP' ? pmarketPrices.upMid : pmarketPrices.downMid)
                : buyPrice;
            sellPrice = Math.min(0.99, buyPrice + this.targetProfitMargin);

            // Still apply time-aware cap in fallback mode
            const timeAwareCap = this.getTimeAwareSellPriceCap(periodProgress, currentMid, buyPrice);
            if (timeAwareCap !== null && sellPrice > timeAwareCap) {
                this.writeLog(`[TIME_AWARE] Capping fallback sell from ${sellPrice.toFixed(3)} to ${timeAwareCap.toFixed(3)} (progress: ${(periodProgress * 100).toFixed(0)}%)`);
                sellPrice = timeAwareCap;
            }
        }

        // Sell timeout derived from ExitModel using fill probability
        const sellOffset = sellPrice - buyPrice;  // Approximate offset from mid
        const sellTimeoutMs = this.exitModel.predictSellTimeout(features, Math.abs(sellOffset));
        trade.sellTimeoutMs = sellTimeoutMs;

        trade.sellOrder = await this.makeOrder(
            `arb-${trade.id}-sell`,
            trade.buyOrder.clobTokenId,
            sellPrice,
            trade.buyOrder.amount,
            Side.SELL,
        );
    }

    public override async onSimulationTick(): Promise<void> {
        await this.executeTradingLogic();
    }

    private async executeArbitrage(
        direction: 'UP' | 'DOWN',
        currentPrice: number,
        fairPrice: number,
        tokenId: string,
        prediction: PredictionWithUncertainty,
        regime?: MarketRegime
    ): Promise<void> {
        if (fairPrice > currentPrice) {
            const priceData = direction === 'UP' ? this.lastUpPrice : this.lastDownPrice;
            const halfSpread = (priceData?.spread ?? 0.02) / 2;
            const bestAsk = currentPrice + halfSpread;

            const buyPrice = Math.min(bestAsk + 0.01, fairPrice - 0.01);

            if (buyPrice >= fairPrice - 0.01) {
                return;
            }

            // Calculate position size based on confidence
            const divergence = fairPrice - currentPrice;
            const confidence = direction === 'UP' ? prediction.upConfidence : prediction.downConfidence;

            // Check if confidence is below minimum threshold
            if (this.mlConfig.useTheoreticalTrades && confidence < this.mlConfig.minConfidenceToTrade) {
                // Create theoretical trade instead of real trade
                this.trackTheoreticalTrade(direction, buyPrice, fairPrice, divergence, confidence);
                return;
            }

            const positionDollars = this.calculatePositionSize(prediction, direction, divergence);
            const size = this.dollarToTokens(positionDollars, buyPrice);

            if (size && this.canSpend(buyPrice * size)) {
                const placementFeatures = this.computeAllFeatures();
                if (!placementFeatures) return;

                const bookPressure = direction === 'UP'
                    ? (this.lastUpDepth?.bookPressure ?? 1)
                    : (this.lastDownDepth?.bookPressure ?? 1);

                this.tradeCounter++;
                const tradeId = `${direction}-${this.tradeCounter}`;

                // Buy timeout derived from ExitModel using market features
                const buyTimeoutMs = this.exitModel.predictBuyTimeout(placementFeatures);

                this.writeLog(`Trade ${tradeId}: mid=${currentPrice.toFixed(3)}, buyAt=${buyPrice.toFixed(3)}, fair=${fairPrice.toFixed(3)}, timeout=${(buyTimeoutMs / 1000).toFixed(1)}s, conf=${confidence.toFixed(2)}, size=$${positionDollars.toFixed(0)}`);

                const buyOrder = await this.makeOrder(
                    `arb-${tradeId}-buy`,
                    tokenId,
                    buyPrice,
                    size,
                    Side.BUY,
                );

                if (buyOrder) {
                    const trade: ActiveTrade = {
                        id: tradeId,
                        direction,
                        buyOrder,
                        placementFeatures,
                        placementBookPressure: bookPressure,
                        createdAt: Date.now(),
                        buyTimeoutMs,
                        repriceCount: 0,
                        positionSize: positionDollars,
                        predictionConfidence: confidence,
                    };
                    this.activeTrades.push(trade);
                    this.tradesThisPeriod++;

                    // Create theoretical exit tracker for training enhanced ExitModel
                    const priceData = direction === 'UP' ? this.lastUpPrice : this.lastDownPrice;
                    this.createTheoreticalExitTracker(direction, currentPrice, priceData?.spread ?? 0.02);
                }
            }
        }
    }

    /**
     * Tracks a theoretical trade that wasn't placed due to low confidence.
     * These are used to generate training data and calibrate confidence thresholds.
     */
    private trackTheoreticalTrade(
        direction: 'UP' | 'DOWN',
        entryPrice: number,
        predictedFairPrice: number,
        divergence: number,
        confidence: number
    ): void {
        // Enforce max trackers limit
        if (this.theoreticalTradeTrackers.length >= SuddenArb.MAX_THEORETICAL_TRADE_TRACKERS) {
            this.theoreticalTradeTrackers.shift();
        }

        // Don't create duplicate trackers for same direction within 10 seconds
        const recentTracker = this.theoreticalTradeTrackers.find(
            t => t.direction === direction && Date.now() - t.timestamp < 10000
        );
        if (recentTracker) return;

        const features = this.computeAllFeatures();
        if (!features) return;

        const targetExitPrice = entryPrice + this.targetProfitMargin;

        this.theoreticalTradeCounter++;
        const tracker: TheoreticalTradeTracker = {
            id: `theo-${direction}-${this.theoreticalTradeCounter}`,
            direction,
            timestamp: Date.now(),
            features,
            entryPrice,
            predictedFairPrice,
            targetExitPrice,
            divergence,
            confidence,
            maxTrackingMs: SuddenArb.THEORETICAL_TRADE_TRACKING_MS,
            bestPriceSeen: entryPrice,
            worstPriceSeen: entryPrice,
        };

        this.theoreticalTradeTrackers.push(tracker);
        this.writeLog(`Theoretical ${direction}: entry=${entryPrice.toFixed(3)}, fair=${predictedFairPrice.toFixed(3)}, conf=${confidence.toFixed(2)} (below ${this.mlConfig.minConfidenceToTrade})`);
    }

    /**
     * Computes exit features for the ExitModel (57 features).
     * Uses computeAllFeatures() as base (56 features aligned with FairValueModel)
     * then adds targetOffset for level-specific predictions.
     *
     * This ensures ExitModel features are aligned with FairValueModel for consistency.
     */
    private computeExitFeatures(
        features: Record<string, number>,
        order: TradeOrder,
        placementBookPressure: number,
        direction?: 'UP' | 'DOWN'
    ): Record<string, number> {
        // Use ALL 56 FairValueModel features as base (passed in as 'features')
        const exitFeatures = { ...features };

        // Determine direction from order if not provided
        const effectiveDirection = direction ?? (order.side === Side.BUY ? 'UP' : 'DOWN');

        // Add targetOffset for ExitModel (required at index 56)
        // This is the offset from current mid to the order's target price
        const orderPrice = order.targetBuyPrice ?? order.targetSellPrice ?? 0.5;
        const currentMid = effectiveDirection === 'UP'
            ? (features.upMid ?? 0.5)
            : (features.downMid ?? 0.5);
        exitFeatures.targetOffset = orderPrice - currentMid;

        return exitFeatures;
    }

    private recordTrainingSample(features: Record<string, number>, regime?: MarketRegime): void {
        const prediction = this.fairValueModel.predict(features);

        this.pendingTrainingSamples.push({
            features: { ...features },
            timestamp: Date.now(),
            predictedUpPrice: prediction.upPrice,
            predictedDownPrice: prediction.downPrice,
            regime,
        });
    }

    private processTrainingSamples(): void {
        const now = Date.now();
        const readySamples: PendingTrainingSample[] = [];
        const pendingSamples: PendingTrainingSample[] = [];

        for (const sample of this.pendingTrainingSamples) {
            if (now - sample.timestamp >= this.convergenceWindowMs) {
                readySamples.push(sample);
            } else {
                pendingSamples.push(sample);
            }
        }

        this.pendingTrainingSamples = pendingSamples;

        for (const sample of readySamples) {
            const pmarketPrices = this.getCurrentPolymarketPrices();
            if (pmarketPrices) {
                // Note on training signal: we're training on the market price
                // convergenceWindowMs after the prediction was made. This gives
                // the model a "predict short-term price movement" objective.
                // However, period-end training (applyNoTradePenalty, trainOnExpiredSell)
                // trains on resolution prices (0 or 1), creating a conflicting objective.
                // TODO: Separate these into two model heads or use a unified training objective.
                this.fairValueModel.train(
                    sample.features,
                    pmarketPrices.upMid,
                    pmarketPrices.downMid,
                    sample.regime
                );

                // Add to replay buffer
                if (this.mlConfig.useExperienceReplay) {
                    this.experienceReplayBuffer.addFairValueSample(
                        sample.features,
                        pmarketPrices.upMid,
                        pmarketPrices.downMid,
                        sample.predictedUpPrice,
                        sample.predictedDownPrice,
                        'positive'
                    );
                }
            }
        }
    }

    protected getMidPrice(orderBook: OrderBookSummary): number {
        const bestBid = orderBook.bids.length > 0
            ? Math.max(...orderBook.bids.map(b => parseFloat(b.price)))
            : 0;
        const bestAsk = orderBook.asks.length > 0
            ? Math.min(...orderBook.asks.map(a => parseFloat(a.price)))
            : 1;
        return (bestBid + bestAsk) / 2;
    }

    /**
     * Returns current ML config for inspection.
     */
    getMLConfig(): SuddenArbMLConfig {
        return { ...this.mlConfig };
    }

    /**
     * Returns current regime information.
     */
    getRegimeInfo(): { regime: MarketRegime; duration: number } | null {
        if (!this.mlConfig.useRegimeAwareness) return null;

        return {
            regime: this.regimeDetector.getCurrentRegime(),
            duration: this.regimeDetector.getRegimeDuration(),
        };
    }

    /**
     * Returns model performance metrics.
     * Note: TimeoutModel removed - timeout prediction now integrated into ExitModel
     */
    getModelMetrics(): {
        fairValue: ReturnType<FairValueModel['getPerformanceMetrics']>;
        exit: ReturnType<ExitModel['getPerformanceMetrics']>;
    } {
        return {
            fairValue: this.fairValueModel.getPerformanceMetrics(),
            exit: this.exitModel.getPerformanceMetrics(),
        };
    }

    /**
     * Returns MLP model statistics.
     */
    getMLPStats(): ReturnType<MLPFairValueModel['getStats']> | null {
        return this.mlpModel?.getStats() ?? null;
    }

    /**
     * Returns MLP feature importance (requires samples for gradient calculation).
     */
    getMLPFeatureImportance(): Map<string, number> | null {
        if (!this.mlpModel) return null;

        const samples = this.experienceReplayBuffer.getAll()
            .filter(s => s.modelType === 'fairValue')
            .slice(0, 100)
            .map(s => ({ features: s.features }));

        if (samples.length < 10) return null;

        return this.mlpModel.getFeatureImportance(samples);
    }

    /**
     * Analyzes feature importance across all models.
     * Returns ranked list of features by importance.
     */
    analyzeFeatureImportance(): FeatureImportanceResult[] {
        return FeatureAnalyzer.analyzeImportance(
            this.fairValueModel,
            this.mlpModel,
            this.fairValueModel.getPerformanceTracker(),
            this.experienceReplayBuffer
        );
    }

    /**
     * Generates a comprehensive feature analysis report.
     * @param savePath Optional path to save the report (default: model path)
     * @returns The report as a string
     */
    generateFeatureReport(savePath?: string): string {
        const report = FeatureAnalyzer.generateReport(
            this.fairValueModel,
            this.mlpModel,
            this.fairValueModel.getPerformanceTracker(),
            this.experienceReplayBuffer
        );

        if (savePath) {
            FeatureAnalyzer.saveReport(
                savePath,
                this.fairValueModel,
                this.mlpModel,
                this.fairValueModel.getPerformanceTracker(),
                this.experienceReplayBuffer
            );
        }

        return report;
    }

    /**
     * Gets feature importance grouped by category.
     */
    getFeatureImportanceByGroup(): Map<string, number> {
        const importance = this.analyzeFeatureImportance();
        return FeatureAnalyzer.analyzeByGroup(importance);
    }

    /**
     * Gets the top N most important features.
     */
    getTopFeatures(n: number = 10): Array<{ name: string; score: number }> {
        const importance = this.analyzeFeatureImportance();
        return importance
            .slice(0, n)
            .map(i => ({ name: i.featureName, score: i.combinedScore }));
    }

    /**
     * Gets the bottom N least important features.
     */
    getBottomFeatures(n: number = 10): Array<{ name: string; score: number }> {
        const importance = this.analyzeFeatureImportance();
        return importance
            .slice(-n)
            .reverse()
            .map(i => ({ name: i.featureName, score: i.combinedScore }));
    }
}
