import { Side } from "@polymarket/clob-client";

import { QuantBot, QuantBotProps, QuantBotRun, TradeOrder, TradeStatus } from "./QuantBot.js";
import { MarketSchedule } from "../types/interfaces.js";
import {
    PredictionStyle,
    getPredictionStyleConfig,
    PredictionStyleConfig,
    evaluatePnL,
    PnLResult,
    Prediction,
} from "../ml/types.js";
import { ModelManager } from "../ml/ModelManager.js";
import { MarketPredictor } from "../ml/MarketPredictor.js";
import { DataPreparation, splitByTime } from "../ml/DataPreparation.js";
import { FeatureEngineering } from "../ml/FeatureEngineering.js";
import { PredictionService } from "../ml/PredictionService.js";
import { CoinType } from "../simulation/GeneticOptimizer.js";

// ============================================================================
// Types & Interfaces
// ============================================================================

export interface YOLOMLBotProps extends QuantBotProps {
    predictionStyle: PredictionStyle;
    tradeDollars?: number;            // Dollar amount to trade per position (default $10)
    pnlThresholdPercent?: number;
    modelMaxAgeHours?: number;
    modelDir?: string;
    minConfidenceThreshold?: number;  // Skip trades below this confidence (default 0.15)
    minProfitMargin?: number;         // Min expected profit % above buy price (default 0.01 = 1%)
}

type TradingState =
    | 'WAITING_CUTOFF'      // Waiting for cutoff minute to make prediction
    | 'MAKING_PREDICTION'   // Loading model and making prediction
    | 'PLACING_BUY'         // Placing buy order
    | 'WAITING_BUY_FILL'    // Waiting for buy order to fill
    | 'PLACING_SELL'        // Placing sell order (INTERVAL only)
    | 'POSITION_HELD'       // Holding position until settlement (EOP only)
    | 'PERIOD_COMPLETE'     // Period complete, waiting for reset
    | 'NO_TRADE';           // Skipped trading this period (no edge)

type BetDirection = 'WITH' | 'AGAINST';

// ============================================================================
// YOLOMLBot Class
// ============================================================================

/**
 * YOLOMLBot - Machine Learning powered trading bot.
 *
 * Uses ML predictions to make directional bets. The bot:
 * 1. Waits until the feature cutoff minute
 * 2. Trains/loads an ML model and makes a prediction
 * 3. Evaluates historical test PnL to determine if the model has edge
 * 4. Bets WITH the model if avgPnL > threshold, AGAINST if avgPnL < -threshold
 * 5. For INTERVAL styles: places sell order at target minute
 * 6. For EOP styles: holds position until settlement
 */
export class YOLOMLBot extends QuantBot implements QuantBotRun {

    // --- Configuration ---
    private predictionStyle: PredictionStyle;
    private styleConfig: PredictionStyleConfig;
    private tradeDollars: number;
    private pnlThresholdPercent: number;
    private modelMaxAgeHours: number;
    private minConfidenceThreshold: number;
    private minProfitMargin: number;

    // --- Dependencies ---
    private modelManager: ModelManager;
    private coinType: CoinType;

    // --- State ---
    private state: TradingState = 'WAITING_CUTOFF';
    private prediction: Prediction | null = null;
    private testPnL: PnLResult | null = null;
    private betDirection: BetDirection | null = null;
    private targetToken: 'UP' | 'DOWN' | null = null;
    private targetTokenId: string | null = null;

    // --- Orders ---
    private buyOrder?: TradeOrder;
    private sellOrder?: TradeOrder;
    private expectedSellPrice: number | null = null;

    // --- Constructor ---

    constructor(props: YOLOMLBotProps) {
        super(props);

        this.predictionStyle = props.predictionStyle;
        this.styleConfig = getPredictionStyleConfig(props.predictionStyle);
        this.tradeDollars = props.tradeDollars ?? 10;
        this.pnlThresholdPercent = props.pnlThresholdPercent ?? 10;
        this.modelMaxAgeHours = props.modelMaxAgeHours ?? 3;
        this.minConfidenceThreshold = props.minConfidenceThreshold ?? 0.15;
        this.minProfitMargin = props.minProfitMargin ?? 0.01;

        // Validate style/schedule compatibility
        const isQuarterlyStyleFlag = this.predictionStyle.startsWith('Quarterly');
        const isQuarterlySchedule = this.marketSchedule === MarketSchedule.QUARTERLY;

        if (isQuarterlyStyleFlag !== isQuarterlySchedule) {
            throw new Error(
                `Prediction style ${this.predictionStyle} doesn't match schedule ${this.marketSchedule}. ` +
                `Quarterly styles require QUARTERLY schedule, Hourly styles require HOURLY schedule.`
            );
        }

        // Parse targeted market to get coin type
        const { coinType } = PredictionService.parseTargetedMarket(this.targetedMarket);
        this.coinType = coinType;

        // Initialize model manager
        const modelDir = props.modelDir ?? './models';
        this.modelManager = new ModelManager(modelDir);

        this.writeLog(`Initialized with style=${this.predictionStyle}, tradeDollars=${this.tradeDollars}, pnlThreshold=${this.pnlThresholdPercent}%`);
    }

    // -------------------------------------------------------------------------
    // Main Run Loop
    // -------------------------------------------------------------------------

    public async run(): Promise<void> {
        this.setupPeriodReset();
        this.startTradingLoop();
    }

    public stop(): void {
        super.stop();
    }

    // -------------------------------------------------------------------------
    // Setup
    // -------------------------------------------------------------------------

    private setupPeriodReset(): void {
        this.registerResetHandler(async () => {
            await this.updateOrders();
            await this.auditAndReset();
            this.resetTradeState();
        });
    }

    protected override resetTradeState(): void {
        this.state = 'WAITING_CUTOFF';
        this.prediction = null;
        this.testPnL = null;
        this.betDirection = null;
        this.targetToken = null;
        this.targetTokenId = null;
        this.buyOrder = undefined;
        this.sellOrder = undefined;
        this.expectedSellPrice = null;
        this.writeLog('State reset for new period');
    }

    // -------------------------------------------------------------------------
    // Trading Loop
    // -------------------------------------------------------------------------

    private startTradingLoop(): void {
        this.tickWrapper(3000, 2000, async () => {
            await this.tick();
        });
    }

    private async tick(): Promise<void> {
        await this.updateOrders();

        switch (this.state) {
            case 'WAITING_CUTOFF':
                await this.handleWaitingCutoff();
                break;

            case 'MAKING_PREDICTION':
                await this.handleMakingPrediction();
                break;

            case 'PLACING_BUY':
                await this.handlePlacingBuy();
                break;

            case 'WAITING_BUY_FILL':
                await this.handleWaitingBuyFill();
                break;

            case 'PLACING_SELL':
                await this.handlePlacingSell();
                break;

            case 'POSITION_HELD':
                // For EOP: just wait for period end
                break;

            case 'PERIOD_COMPLETE':
            case 'NO_TRADE':
                // Nothing to do
                break;
        }
    }

    public override async onSimulationTick(): Promise<void> {
        await this.tick();
    }

    // -------------------------------------------------------------------------
    // State Handlers
    // -------------------------------------------------------------------------

    private async handleWaitingCutoff(): Promise<void> {
        if (this.isAtCutoff()) {
            this.writeLog(`At cutoff minute (${this.styleConfig.featureCutoffMinutes}m), making prediction...`);
            this.state = 'MAKING_PREDICTION';
        }
    }

    private async handleMakingPrediction(): Promise<void> {
        try {
            // Get or train model
            const model = await this.modelManager.getOrTrainModel(
                this.coinType,
                this.marketSchedule,
                this.predictionStyle,
                this.modelMaxAgeHours
            );

            // Make prediction using current market data
            this.prediction = await this.makePrediction(model);

            if (!this.prediction) {
                this.writeLog('Failed to make prediction, skipping trade');
                this.state = 'NO_TRADE';
                return;
            }

            this.writeLog(
                `Prediction: ${this.prediction.prediction} ` +
                `(prob=${(this.prediction.probability * 100).toFixed(1)}%, ` +
                `conf=${(this.prediction.confidence * 100).toFixed(1)}%)`
            );

            // Check 1: Minimum confidence threshold
            if (this.prediction.confidence < this.minConfidenceThreshold) {
                this.writeLog(
                    `Low confidence (${(this.prediction.confidence * 100).toFixed(1)}% < ` +
                    `${(this.minConfidenceThreshold * 100).toFixed(0)}%), market stagnant, skipping`
                );
                this.state = 'NO_TRADE';
                return;
            }

            // Evaluate test PnL to determine if we have edge
            this.testPnL = await this.evaluateTestPnL(model);

            if (!this.testPnL) {
                this.writeLog('Failed to evaluate test PnL, skipping trade');
                this.state = 'NO_TRADE';
                return;
            }

            this.writeLog(
                `Test PnL: avg=${this.testPnL.averagePnL.toFixed(2)}%, ` +
                `total=${this.testPnL.totalPnL.toFixed(2)}%, ` +
                `winRate=${(this.testPnL.winRate * 100).toFixed(1)}%`
            );

            // Determine bet direction
            this.betDirection = this.determineBetDirection();

            if (!this.betDirection) {
                this.writeLog(
                    `No edge detected (avgPnL=${this.testPnL.averagePnL.toFixed(2)}%, ` +
                    `threshold=+/-${this.pnlThresholdPercent}%), skipping trade`
                );
                this.state = 'NO_TRADE';
                return;
            }

            // Determine target token
            this.targetToken = this.getTargetToken();
            this.writeLog(`Betting ${this.betDirection} prediction -> ${this.targetToken}`);

            this.state = 'PLACING_BUY';
        } catch (error) {
            this.writeError(`Error making prediction: ${error}`);
            this.state = 'NO_TRADE';
        }
    }

    private async handlePlacingBuy(): Promise<void> {
        if (this.buyOrder) {
            // Already placed
            this.state = 'WAITING_BUY_FILL';
            return;
        }

        if (!this.targetToken) {
            this.state = 'NO_TRADE';
            return;
        }

        try {
            const orderBooks = await this.marketInfo.getLiveData(this.targetedMarket);
            this.targetTokenId = this.targetToken === 'UP'
                ? orderBooks.BtcUpTokenId
                : orderBooks.BtcDownTokenId;

            // Get current mid price
            const midPrice = await this.getCurrentMidPrice(this.targetToken);

            if (!midPrice || midPrice <= 0 || midPrice >= 1) {
                this.writeLog(`Invalid mid price: ${midPrice}, skipping trade`);
                this.state = 'NO_TRADE';
                return;
            }

            // Round to 2 decimal places
            const buyPrice = Math.round(midPrice * 100) / 100;

            // Convert dollar amount to token quantity
            const tradeSize = this.dollarToTokens(this.tradeDollars, buyPrice);
            if (tradeSize === null) {
                this.writeLog(`Invalid trade size: $${this.tradeDollars} at price ${buyPrice}`);
                this.state = 'NO_TRADE';
                return;
            }

            const totalCost = buyPrice * tradeSize;

            // Check 2: Verify expected sell price > buy price
            const expectedSellPrice = this.estimateExpectedSellPrice(midPrice);
            if (expectedSellPrice <= buyPrice * (1 + this.minProfitMargin)) {
                this.writeLog(
                    `Insufficient expected profit: buy=${buyPrice.toFixed(3)}, ` +
                    `expectedSell=${expectedSellPrice.toFixed(3)}, margin required=${(this.minProfitMargin * 100).toFixed(1)}%`
                );
                this.state = 'NO_TRADE';
                return;
            }

            // Store expected sell price for INTERVAL trades (determined at buy time)
            this.expectedSellPrice = Math.round(expectedSellPrice * 100) / 100;

            if (!this.checkIfOrderIsValid(buyPrice, tradeSize)) {
                this.writeLog(`Invalid order: price=${buyPrice}, size=${tradeSize}`);
                this.state = 'NO_TRADE';
                return;
            }

            if (!this.canSpend(totalCost)) {
                this.writeLog(`Insufficient budget: need $${totalCost.toFixed(2)}`);
                this.state = 'NO_TRADE';
                return;
            }

            this.writeLog(`Placing buy order: ${tradeSize} ${this.targetToken} @ ${buyPrice} ($${this.tradeDollars})`);

            this.buyOrder = await this.makeOrder(
                'yoloml-buy',
                this.targetTokenId,
                buyPrice,
                tradeSize,
                Side.BUY
            );

            if (this.buyOrder) {
                this.state = 'WAITING_BUY_FILL';
            } else {
                this.writeLog('Failed to place buy order');
                this.state = 'NO_TRADE';
            }
        } catch (error) {
            this.writeError(`Error placing buy order: ${error}`);
            this.state = 'NO_TRADE';
        }
    }

    private async handleWaitingBuyFill(): Promise<void> {
        if (!this.buyOrder) {
            this.state = 'NO_TRADE';
            return;
        }

        if (this.buyOrder.status === TradeStatus.MATCHED) {
            this.writeLog('Buy order matched');

            if (this.styleConfig.targetType === 'INTERVAL') {
                // For INTERVAL: place sell immediately
                this.state = 'PLACING_SELL';
            } else {
                // For EOP: hold until settlement
                this.writeLog('Holding position until EOP settlement');
                this.state = 'POSITION_HELD';
            }
            return;
        }

        if (this.buyOrder.status === TradeStatus.CANCELED ||
            this.buyOrder.status === TradeStatus.EXPIRED) {
            this.writeLog(`Buy order ${this.buyOrder.status.toLowerCase()}`);
            this.state = 'NO_TRADE';
            return;
        }

        // For INTERVAL styles, cancel buy if we've passed target minute without fill
        if (this.styleConfig.targetType === 'INTERVAL' && this.isPastTargetMinute()) {
            this.writeLog('Past target minute without buy fill, canceling order');
            await this.cancelTrade(this.buyOrder);
            this.state = 'PERIOD_COMPLETE';
        }
    }

    private async handlePlacingSell(): Promise<void> {
        // Only for INTERVAL styles
        if (this.styleConfig.targetType !== 'INTERVAL') {
            this.state = 'POSITION_HELD';
            return;
        }

        if (this.sellOrder) {
            // Already placed
            this.state = 'PERIOD_COMPLETE';
            return;
        }

        if (!this.buyOrder || !this.targetTokenId || !this.targetToken || !this.expectedSellPrice) {
            this.state = 'PERIOD_COMPLETE';
            return;
        }

        try {
            // Use the expected sell price calculated at buy time (not current market price)
            const sellPrice = this.expectedSellPrice;

            if (sellPrice <= 0 || sellPrice >= 1) {
                this.writeLog(`Invalid expected sell price: ${sellPrice}`);
                this.state = 'PERIOD_COMPLETE';
                return;
            }

            this.writeLog(`Placing sell order: ${this.buyOrder.amount} ${this.targetToken} @ ${sellPrice} (predicted at buy time)`);

            this.sellOrder = await this.makeOrder(
                'yoloml-sell',
                this.targetTokenId,
                sellPrice,
                this.buyOrder.amount,
                Side.SELL
            );

            this.state = 'PERIOD_COMPLETE';
        } catch (error) {
            this.writeError(`Error placing sell order: ${error}`);
            this.state = 'PERIOD_COMPLETE';
        }
    }

    // -------------------------------------------------------------------------
    // Timing Logic
    // -------------------------------------------------------------------------

    private getMinutesIntoPeriod(): number {
        const minute = this.clock.getMinutes();
        return this.marketSchedule === MarketSchedule.QUARTERLY
            ? minute % 15
            : minute;
    }

    private isAtCutoff(): boolean {
        return this.getMinutesIntoPeriod() === this.styleConfig.featureCutoffMinutes;
    }

    private isAtTargetMinute(): boolean {
        return this.getMinutesIntoPeriod() === this.styleConfig.targetMinutes;
    }

    private isPastTargetMinute(): boolean {
        const minutesInPeriod = this.getMinutesIntoPeriod();
        return minutesInPeriod > this.styleConfig.targetMinutes;
    }

    // -------------------------------------------------------------------------
    // Prediction & PnL Evaluation
    // -------------------------------------------------------------------------

    private async makePrediction(model: MarketPredictor): Promise<Prediction | null> {
        try {
            // Prepare current period data for feature extraction
            const dataPrep = new DataPreparation(this.coinType, this.marketSchedule);
            const dataset = dataPrep.prepare();

            if (dataset.periods.length === 0) {
                this.writeLog('No periods available for prediction');
                return null;
            }

            // Get the most recent period
            const latestPeriod = dataset.periods[dataset.periods.length - 1];

            // Create feature engineer with the prediction style
            // Use forPrediction=true since we don't have future data for INTERVAL styles
            const featureEngineer = new FeatureEngineering(this.predictionStyle, dataPrep);
            const samples = featureEngineer.prepareSamples([latestPeriod], true, true);

            if (samples.length === 0) {
                this.writeLog('Failed to prepare features for prediction');
                return null;
            }

            // Make prediction
            const prediction = model.predict(samples[0].features);
            return prediction;
        } catch (error) {
            this.writeError(`Error in makePrediction: ${error}`);
            return null;
        }
    }

    private async evaluateTestPnL(model: MarketPredictor): Promise<PnLResult | null> {
        try {
            // Load historical data
            const dataPrep = new DataPreparation(this.coinType, this.marketSchedule);
            const dataset = dataPrep.prepare();

            if (dataset.periods.length < 50) {
                this.writeLog(`Insufficient historical data: ${dataset.periods.length} periods`);
                return null;
            }

            // Create feature engineer and prepare samples
            const featureEngineer = new FeatureEngineering(this.predictionStyle, dataPrep);
            const allSamples = featureEngineer.prepareSamples(dataset.periods, true);

            // Use only test samples (last 20%)
            const { test: testSamples } = splitByTime(allSamples, 0.8);

            if (testSamples.length < 10) {
                this.writeLog(`Insufficient test samples: ${testSamples.length}`);
                return null;
            }

            // Get predictions for test samples
            const predictions = model.predictBatch(testSamples);

            // Evaluate PnL
            const pnlResult = evaluatePnL(
                testSamples,
                predictions.map(p => ({ prediction: p.prediction, confidence: p.confidence })),
                this.predictionStyle,
                100  // $100 notional for percentage calculation
            );

            return pnlResult;
        } catch (error) {
            this.writeError(`Error evaluating test PnL: ${error}`);
            return null;
        }
    }

    // -------------------------------------------------------------------------
    // Bet Direction Logic
    // -------------------------------------------------------------------------

    private determineBetDirection(): BetDirection | null {
        if (!this.testPnL) return null;

        const avgPnL = this.testPnL.averagePnL;

        if (avgPnL > this.pnlThresholdPercent) {
            // Model is profitable, bet with prediction
            return 'WITH';
        }

        if (avgPnL < -this.pnlThresholdPercent) {
            // Model is unprofitable, bet opposite
            return 'AGAINST';
        }

        // No clear edge, skip trading
        return null;
    }

    private getTargetToken(): 'UP' | 'DOWN' {
        if (!this.prediction) {
            throw new Error('No prediction available');
        }

        if (this.betDirection === 'WITH') {
            return this.prediction.prediction;
        } else {
            // Bet against: opposite of prediction
            return this.prediction.prediction === 'UP' ? 'DOWN' : 'UP';
        }
    }

    // -------------------------------------------------------------------------
    // Market Data
    // -------------------------------------------------------------------------

    private async getCurrentMidPrice(token: 'UP' | 'DOWN'): Promise<number | null> {
        try {
            const orderBooks = await this.marketInfo.getLiveData(this.targetedMarket);
            const tokenId = token === 'UP'
                ? orderBooks.BtcUpTokenId
                : orderBooks.BtcDownTokenId;

            // Get bid and ask prices
            const bidPrice = await this.marketInfo.getPrice(tokenId, Side.SELL, this.targetedMarket);
            const askPrice = await this.marketInfo.getPrice(tokenId, Side.BUY, this.targetedMarket);

            if (isNaN(bidPrice) || isNaN(askPrice) || bidPrice <= 0 || askPrice <= 0) {
                return null;
            }

            // Calculate mid price
            const midPrice = (bidPrice + askPrice) / 2;
            return midPrice;
        } catch (error) {
            this.writeError(`Error getting mid price: ${error}`);
            return null;
        }
    }

    private estimateExpectedSellPrice(currentMidPrice: number): number {
        if (!this.prediction) return currentMidPrice;

        const expectedMovePercent = this.prediction.confidence;

        if (this.styleConfig.targetType === 'INTERVAL') {
            // For INTERVAL: we're betting on price moving in our direction
            // If we're betting correctly, price moves up by expectedMovePercent
            return currentMidPrice * (1 + expectedMovePercent);
        } else {
            // For EOP: token settles at 1.00 if correct, 0.00 if wrong
            // Expected value = probability * 1.00 + (1 - probability) * 0.00
            return this.prediction.probability;
        }
    }
}
