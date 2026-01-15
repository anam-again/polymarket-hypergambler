import { Side } from "@polymarket/clob-client";

import { QuantBot, QuantBotProps, QuantBotRun, TradeOrder, TradeStatus } from "./QuantBot.js";
import { CDMarketData } from "../nonBots/CDMarketData.js";

// ============================================================================
// Types & Interfaces
// ============================================================================

interface MeanReversionProps extends QuantBotProps {
    lookbackPeriods: number;        // Number of price points for rolling calculations
    entryThreshold: number;         // Z-score threshold for entry (e.g., 2.0)
    exitThreshold: number;          // Z-score level to track exit condition (e.g., 0.5)
    targetBuyPrice: number;
    targetSellPrice: number;
    targetSize: number;
    cutoffMinute: number;
}

interface RollingStats {
    mean: number;
    stdDev: number;
    zScore: number;
    currentPrice: number;
    bollingerUpper: number;
    bollingerLower: number;
    bollingerWidth: number;
}

type TradeDirection = 'UP' | 'DOWN';

type TradingState =
    | 'WAITING_DATA'        // Waiting for enough price data
    | 'MONITORING'          // Monitoring for entry signal
    | 'POSITION_OPEN'       // Trade entered, monitoring for exit
    | 'PAST_CUTOFF';        // Past cutoff, no more trading

// ============================================================================
// MeanReversion Class
// ============================================================================

export class MeanReversion extends QuantBot implements QuantBotRun {

    // --- Properties ---

    private lookbackPeriods: number;
    private entryThreshold: number;
    private exitThreshold: number;
    private targetBuyPrice: number;
    private targetSellPrice: number;
    private targetSize: number;
    private cutoffMinute: number;

    private buyOrder?: TradeOrder;
    private sellOrder?: TradeOrder;

    private state: TradingState = 'WAITING_DATA';
    private tradeDirection?: TradeDirection;
    private entryZScore?: number;

    // --- Constructor ---

    constructor(props: MeanReversionProps) {
        super(props);

        this.lookbackPeriods = props.lookbackPeriods;
        this.entryThreshold = props.entryThreshold;
        this.exitThreshold = props.exitThreshold;
        this.targetBuyPrice = props.targetBuyPrice;
        this.targetSellPrice = props.targetSellPrice;
        this.targetSize = props.targetSize;
        this.cutoffMinute = props.cutoffMinute;
    }

    // --- Main Run Loop ---

    public async run(): Promise<void> {
        this.setupHourlyReset();
        this.startTradingLoop();
    }

    // -------------------------------------------------------------------------
    // Setup
    // -------------------------------------------------------------------------

    private setupHourlyReset(): void {
        this.on('hourly', async () => {
            await this.updateOrders();
            await this.auditAndReset();
            this.resetState();
        });
    }

    private resetState(): void {
        this.buyOrder = undefined;
        this.sellOrder = undefined;
        this.state = 'WAITING_DATA';
        this.tradeDirection = undefined;
        this.entryZScore = undefined;
    }

    // -------------------------------------------------------------------------
    // Trading Loop
    // -------------------------------------------------------------------------

    private startTradingLoop(): void {
        this.tickWrapper(1000 * 5, 1000 * 2, async () => {
            await this.updateOrders();

            // Handle sell order creation if buy matched
            if (this.shouldCreateSellOrder()) {
                await this.createSellOrder();
            }

            // Check cutoff
            if (this.isAfterCutoff() && this.state !== 'POSITION_OPEN') {
                await this.handleCutoff();
                return;
            }

            if (this.state === 'PAST_CUTOFF') {
                return;
            }

            // Execute state machine
            await this.executeStateMachine();
        });
    }

    // -------------------------------------------------------------------------
    // State Machine
    // -------------------------------------------------------------------------

    private async executeStateMachine(): Promise<void> {
        const stats = this.calculateRollingStats();

        if (!stats) {
            if (this.state !== 'WAITING_DATA') {
                this.state = 'WAITING_DATA';
                this.writeLog(`Insufficient data for ${this.lookbackPeriods} periods`);
            }
            return;
        }

        switch (this.state) {
            case 'WAITING_DATA':
                this.state = 'MONITORING';
                this.logStats(stats, 'Data available, now monitoring');
                break;

            case 'MONITORING':
                await this.handleMonitoring(stats);
                break;

            case 'POSITION_OPEN':
                this.handlePositionOpen(stats);
                break;
        }
    }

    private async handleMonitoring(stats: RollingStats): Promise<void> {
        const { zScore } = stats;

        // Entry conditions based on Z-score
        if (zScore <= -this.entryThreshold) {
            // Price is significantly below mean - expect reversion UP
            this.tradeDirection = 'UP';
            this.entryZScore = zScore;
            this.logStats(stats, `Entry signal: Z-score ${zScore.toFixed(2)} <= -${this.entryThreshold}, betting UP`);
            await this.createBuyOrder();
        } else if (zScore >= this.entryThreshold) {
            // Price is significantly above mean - expect reversion DOWN
            this.tradeDirection = 'DOWN';
            this.entryZScore = zScore;
            this.logStats(stats, `Entry signal: Z-score ${zScore.toFixed(2)} >= ${this.entryThreshold}, betting DOWN`);
            await this.createBuyOrder();
        } else {
            // Log periodic stats without entry
            // this.logStats(stats, 'No entry signal');
        }
    }

    private handlePositionOpen(stats: RollingStats): void {
        const { zScore } = stats;

        // Track if mean reversion is occurring
        if (this.tradeDirection === 'UP' && zScore >= -this.exitThreshold) {
            // this.logStats(stats, `Mean reversion progressing: Z-score ${zScore.toFixed(2)} approaching mean`);
        } else if (this.tradeDirection === 'DOWN' && zScore <= this.exitThreshold) {
            // this.logStats(stats, `Mean reversion progressing: Z-score ${zScore.toFixed(2)} approaching mean`);
        }
    }

    // -------------------------------------------------------------------------
    // Rolling Statistics
    // -------------------------------------------------------------------------

    private calculateRollingStats(): RollingStats | null {
        const cdMarketData = CDMarketData.getInstance();
        const recentPrices = cdMarketData.getRecentPrices(this.targetedMarket, this.lookbackPeriods);

        if (recentPrices.length < this.lookbackPeriods) {
            return null;
        }

        const prices = recentPrices.map(p => p.price);
        const currentPrice = prices[prices.length - 1];

        // Calculate rolling mean
        const mean = this.calculateMean(prices);

        // Calculate rolling standard deviation
        const stdDev = this.calculateStdDev(prices, mean);

        // Avoid division by zero
        if (stdDev === 0) {
            return null;
        }

        // Calculate Z-score: (Price - Mean) / StdDev
        const zScore = (currentPrice - mean) / stdDev;

        // Calculate Bollinger Bands (2 standard deviations)
        const bollingerUpper = mean + (2 * stdDev);
        const bollingerLower = mean - (2 * stdDev);
        const bollingerWidth = (bollingerUpper - bollingerLower) / mean;

        return {
            mean,
            stdDev,
            zScore,
            currentPrice,
            bollingerUpper,
            bollingerLower,
            bollingerWidth,
        };
    }

    private calculateMean(values: number[]): number {
        if (values.length === 0) return 0;
        return values.reduce((sum, val) => sum + val, 0) / values.length;
    }

    private calculateStdDev(values: number[], mean: number): number {
        if (values.length < 2) return 0;

        const squaredDiffs = values.map(val => Math.pow(val - mean, 2));
        const variance = squaredDiffs.reduce((sum, val) => sum + val, 0) / (values.length - 1);
        return Math.sqrt(variance);
    }

    // -------------------------------------------------------------------------
    // Order Logic
    // -------------------------------------------------------------------------

    private shouldCreateSellOrder(): boolean {
        if (this.sellOrder) return false;
        if (!this.buyOrder) return false;
        return this.buyOrder.status === TradeStatus.MATCHED;
    }

    private async createBuyOrder(): Promise<void> {
        if (this.buyOrder || !this.tradeDirection) return;

        const orderBooks = await this.marketInfo.getLiveData(this.targetedMarket);
        const tokenId = this.tradeDirection === 'UP'
            ? orderBooks.BtcUpTokenId
            : orderBooks.BtcDownTokenId;

        const totalCost = this.targetBuyPrice * this.targetSize;

        if (!this.checkIfOrderIsValid(this.targetBuyPrice, this.targetSize)) return;
        if (!this.canSpend(totalCost)) return;

        this.buyOrder = await this.makeOrder(
            'meanrev-buy',
            tokenId,
            this.targetBuyPrice,
            this.targetSize,
            Side.BUY
        );

        this.state = 'POSITION_OPEN';

        this.buyOrder?.once('tradeMatched', () => {
            this.createSellOrder();
        });
    }

    private async createSellOrder(): Promise<void> {
        if (this.sellOrder || !this.buyOrder || !this.tradeDirection) return;

        const orderBooks = await this.marketInfo.getLiveData(this.targetedMarket);
        const tokenId = this.tradeDirection === 'UP'
            ? orderBooks.BtcUpTokenId
            : orderBooks.BtcDownTokenId;

        this.sellOrder = await this.makeOrder(
            'meanrev-sell',
            tokenId,
            this.targetSellPrice,
            this.targetSize,
            Side.SELL
        );
    }

    // -------------------------------------------------------------------------
    // Logging
    // -------------------------------------------------------------------------

    private logStats(stats: RollingStats, message: string): void {
        this.writeLog(
            `${message} | ` +
            `Price=${stats.currentPrice.toFixed(2)}, ` +
            `Mean=${stats.mean.toFixed(2)}, ` +
            `StdDev=${stats.stdDev.toFixed(2)}, ` +
            `Z=${stats.zScore.toFixed(3)}, ` +
            `BB[${stats.bollingerLower.toFixed(0)}-${stats.bollingerUpper.toFixed(0)}], ` +
            `Width=${(stats.bollingerWidth * 100).toFixed(2)}%`
        );
    }

    // -------------------------------------------------------------------------
    // Cutoff Handling
    // -------------------------------------------------------------------------

    private isAfterCutoff(): boolean {
        const currentMinute = this.clock.getMinutes();
        return currentMinute >= this.cutoffMinute;
    }

    private async handleCutoff(): Promise<void> {
        this.state = 'PAST_CUTOFF';
        await this.cancelLiveBuyOrders();
    }

    private async cancelLiveBuyOrders(): Promise<void> {
        for (const trade of this.trades) {
            if (trade.status === TradeStatus.LIVE && trade.side === Side.BUY) {
                await this.cancelTrade(trade);
            }
        }
    }
}
