import { Side } from "@polymarket/clob-client";

import { QuantBot, QuantBotProps, QuantBotRun, TradeOrder, TradeStatus } from "./QuantBot.js";
import { CDMarketData, RecentPriceEntry } from "../nonBots/CDMarketData.js";

// ============================================================================
// Types & Interfaces
// ============================================================================

interface TrendFollowingProps extends QuantBotProps {
    shortMaPeriod: number;          // Short moving average period (e.g., 5)
    longMaPeriod: number;           // Long moving average period (e.g., 20)
    adxPeriod: number;              // ADX calculation period (e.g., 14)
    adxThreshold: number;           // Minimum ADX for trend confirmation (e.g., 25)
    atrPeriod: number;              // ATR calculation period (e.g., 14)
    atrStopMultiple: number;        // ATR multiple for stop-loss consideration
    targetBuyPrice: number;
    targetSellPrice: number;
    targetSize: number;
    cutoffMinute: number;
}

interface TrendIndicators {
    shortMa: number;
    longMa: number;
    macdLine: number;
    signalLine: number;
    macdHistogram: number;
    adx: number;
    atr: number;
    currentPrice: number;
    priceChangePercent: number;
    donchianHigh: number;
    donchianLow: number;
}

type TrendSignal = 'GOLDEN_CROSS' | 'DEATH_CROSS' | 'NONE';
type TradeDirection = 'UP' | 'DOWN';

type TradingState =
    | 'WAITING_DATA'        // Waiting for enough price data
    | 'MONITORING'          // Monitoring for trend signal
    | 'POSITION_OPEN'       // Trade entered
    | 'PAST_CUTOFF';        // Past cutoff, no more trading

// ============================================================================
// TrendFollowing Class
// ============================================================================

export class TrendFollowing extends QuantBot implements QuantBotRun {

    // --- Properties ---

    private shortMaPeriod: number;
    private longMaPeriod: number;
    private adxPeriod: number;
    private adxThreshold: number;
    private atrPeriod: number;
    private atrStopMultiple: number;
    private targetBuyPrice: number;
    private targetSellPrice: number;
    private targetSize: number;
    private cutoffMinute: number;

    private buyOrder?: TradeOrder;
    private sellOrder?: TradeOrder;

    private state: TradingState = 'WAITING_DATA';
    private tradeDirection?: TradeDirection;
    private previousShortMa?: number;
    private previousLongMa?: number;
    private entryPrice?: number;

    // --- Constructor ---

    constructor(props: TrendFollowingProps) {
        super(props);

        this.shortMaPeriod = props.shortMaPeriod;
        this.longMaPeriod = props.longMaPeriod;
        this.adxPeriod = props.adxPeriod;
        this.adxThreshold = props.adxThreshold;
        this.atrPeriod = props.atrPeriod;
        this.atrStopMultiple = props.atrStopMultiple;
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
        this.previousShortMa = undefined;
        this.previousLongMa = undefined;
        this.entryPrice = undefined;
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
        const indicators = this.calculateIndicators();

        if (!indicators) {
            if (this.state !== 'WAITING_DATA') {
                this.state = 'WAITING_DATA';
                this.writeLog(`Insufficient data for ${this.longMaPeriod} periods`);
            }
            return;
        }

        switch (this.state) {
            case 'WAITING_DATA':
                this.state = 'MONITORING';
                this.logIndicators(indicators, 'Data available, now monitoring');
                // Initialize previous MAs for crossover detection
                this.previousShortMa = indicators.shortMa;
                this.previousLongMa = indicators.longMa;
                break;

            case 'MONITORING':
                await this.handleMonitoring(indicators);
                break;

            case 'POSITION_OPEN':
                this.handlePositionOpen(indicators);
                break;
        }
    }

    private async handleMonitoring(indicators: TrendIndicators): Promise<void> {
        const signal = this.detectCrossover(indicators);
        const trendStrong = indicators.adx >= this.adxThreshold;

        // // Log current state
        // this.logIndicators(indicators, `Signal: ${signal}, ADX Strong: ${trendStrong}`);

        // Check for entry conditions
        if (signal === 'GOLDEN_CROSS' && trendStrong) {
            // Golden Cross with strong trend - bet UP
            this.tradeDirection = 'UP';
            this.entryPrice = indicators.currentPrice;
            this.logIndicators(indicators, '');
            this.writeLog(`ENTRY: Golden Cross with ADX ${indicators.adx.toFixed(1)} >= ${this.adxThreshold}`);
            await this.createBuyOrder();
        } else if (signal === 'DEATH_CROSS' && trendStrong) {
            // Death Cross with strong trend - bet DOWN
            this.tradeDirection = 'DOWN';
            this.entryPrice = indicators.currentPrice;
            this.logIndicators(indicators, '');
            this.writeLog(`ENTRY: Death Cross with ADX ${indicators.adx.toFixed(1)} >= ${this.adxThreshold}`);
            await this.createBuyOrder();
        }

        // Additional entry: Donchian Channel breakout with trend confirmation
        if (!this.tradeDirection && trendStrong) {
            if (indicators.currentPrice >= indicators.donchianHigh && indicators.shortMa > indicators.longMa) {
                this.tradeDirection = 'UP';
                this.entryPrice = indicators.currentPrice;
                this.logIndicators(indicators, '');
                this.writeLog(`ENTRY: Donchian breakout HIGH with uptrend`);
                await this.createBuyOrder();
            } else if (indicators.currentPrice <= indicators.donchianLow && indicators.shortMa < indicators.longMa) {
                this.tradeDirection = 'DOWN';
                this.entryPrice = indicators.currentPrice;
                this.logIndicators(indicators, '');
                this.writeLog(`ENTRY: Donchian breakout LOW with downtrend`);
                await this.createBuyOrder();
            }
        }

        // Update previous MAs for next crossover detection
        this.previousShortMa = indicators.shortMa;
        this.previousLongMa = indicators.longMa;
    }

    private handlePositionOpen(indicators: TrendIndicators): void {
        // Monitor trend continuation
        const trendContinues = this.tradeDirection === 'UP'
            ? indicators.shortMa > indicators.longMa
            : indicators.shortMa < indicators.longMa;

        // Calculate ATR-based stop distance
        // const stopDistance = indicators.atr * this.atrStopMultiple;

        // this.logIndicators(
        //     indicators,
        //     `Position: ${this.tradeDirection}, Trend continues: ${trendContinues}, ATR Stop: ${stopDistance.toFixed(2)}`
        // );

        // Check for trend reversal warning
        if (!trendContinues) {
            this.logIndicators(indicators, '');
            // this.writeLog(`WARNING: Trend reversal detected - MAs crossed against position`);
        }
    }

    private detectCrossover(indicators: TrendIndicators): TrendSignal {
        if (!this.previousShortMa || !this.previousLongMa) {
            return 'NONE';
        }

        const prevShortAboveLong = this.previousShortMa > this.previousLongMa;
        const currShortAboveLong = indicators.shortMa > indicators.longMa;

        // Golden Cross: Short MA crosses above Long MA
        if (!prevShortAboveLong && currShortAboveLong) {
            return 'GOLDEN_CROSS';
        }

        // Death Cross: Short MA crosses below Long MA
        if (prevShortAboveLong && !currShortAboveLong) {
            return 'DEATH_CROSS';
        }

        return 'NONE';
    }

    // -------------------------------------------------------------------------
    // Technical Indicators
    // -------------------------------------------------------------------------

    private calculateIndicators(): TrendIndicators | null {
        const cdMarketData = CDMarketData.getInstance();
        const requiredPeriods = Math.max(this.longMaPeriod, this.adxPeriod, this.atrPeriod) + 10;
        const recentPrices = cdMarketData.getRecentPrices(this.targetedMarket, requiredPeriods);

        if (recentPrices.length < requiredPeriods) {
            return null;
        }

        const prices = recentPrices.map(p => p.price);
        const currentPrice = prices[prices.length - 1];

        // Moving Averages
        const shortMa = this.calculateSMA(prices, this.shortMaPeriod);
        const longMa = this.calculateSMA(prices, this.longMaPeriod);

        // MACD (12, 26, 9 standard)
        const { macdLine, signalLine, histogram } = this.calculateMACD(prices);

        // ADX
        const adx = this.calculateADX(prices, this.adxPeriod);

        // ATR
        const atr = this.calculateATR(prices, this.atrPeriod);

        // Donchian Channels
        const { high: donchianHigh, low: donchianLow } = this.calculateDonchian(prices, this.longMaPeriod);

        // Price change
        const previousPrice = prices[prices.length - 2] || currentPrice;
        const priceChangePercent = ((currentPrice - previousPrice) / previousPrice) * 100;

        return {
            shortMa,
            longMa,
            macdLine,
            signalLine,
            macdHistogram: histogram,
            adx,
            atr,
            currentPrice,
            priceChangePercent,
            donchianHigh,
            donchianLow,
        };
    }

    private calculateSMA(prices: number[], period: number): number {
        const slice = prices.slice(-period);
        return slice.reduce((sum, p) => sum + p, 0) / slice.length;
    }

    private calculateEMA(prices: number[], period: number): number {
        const multiplier = 2 / (period + 1);
        let ema = prices[0];

        for (let i = 1; i < prices.length; i++) {
            ema = (prices[i] - ema) * multiplier + ema;
        }

        return ema;
    }

    private calculateMACD(prices: number[]): { macdLine: number; signalLine: number; histogram: number } {
        const ema12 = this.calculateEMA(prices, 12);
        const ema26 = this.calculateEMA(prices, 26);
        const macdLine = ema12 - ema26;

        // Calculate signal line (9-period EMA of MACD)
        // Simplified: use recent MACD values
        const macdValues: number[] = [];
        for (let i = 26; i < prices.length; i++) {
            const slice = prices.slice(0, i + 1);
            const e12 = this.calculateEMA(slice, 12);
            const e26 = this.calculateEMA(slice, 26);
            macdValues.push(e12 - e26);
        }

        const signalLine = macdValues.length >= 9
            ? this.calculateEMA(macdValues, 9)
            : macdLine;

        return {
            macdLine,
            signalLine,
            histogram: macdLine - signalLine,
        };
    }

    private calculateADX(prices: number[], period: number): number {
        if (prices.length < period + 1) return 0;

        const trueRanges: number[] = [];
        const plusDMs: number[] = [];
        const minusDMs: number[] = [];

        // Calculate TR, +DM, -DM
        for (let i = 1; i < prices.length; i++) {
            const high = prices[i];
            const low = prices[i];
            const prevHigh = prices[i - 1];
            const prevLow = prices[i - 1];
            const prevClose = prices[i - 1];

            // True Range (simplified with single price series)
            const tr = Math.max(
                Math.abs(high - low),
                Math.abs(high - prevClose),
                Math.abs(low - prevClose)
            );
            trueRanges.push(tr);

            // Directional Movement
            const upMove = high - prevHigh;
            const downMove = prevLow - low;

            plusDMs.push(upMove > downMove && upMove > 0 ? upMove : 0);
            minusDMs.push(downMove > upMove && downMove > 0 ? downMove : 0);
        }

        // Smooth with Wilder's method
        const smoothTR = this.wilderSmooth(trueRanges, period);
        const smoothPlusDM = this.wilderSmooth(plusDMs, period);
        const smoothMinusDM = this.wilderSmooth(minusDMs, period);

        if (smoothTR === 0) return 0;

        // Calculate DI+ and DI-
        const plusDI = (smoothPlusDM / smoothTR) * 100;
        const minusDI = (smoothMinusDM / smoothTR) * 100;

        // Calculate DX
        const diSum = plusDI + minusDI;
        if (diSum === 0) return 0;

        const dx = (Math.abs(plusDI - minusDI) / diSum) * 100;

        // ADX is smoothed DX (simplified)
        return dx;
    }

    private wilderSmooth(values: number[], period: number): number {
        if (values.length < period) return 0;

        let smooth = values.slice(0, period).reduce((a, b) => a + b, 0);

        for (let i = period; i < values.length; i++) {
            smooth = smooth - (smooth / period) + values[i];
        }

        return smooth / period;
    }

    private calculateATR(prices: number[], period: number): number {
        if (prices.length < period + 1) return 0;

        const trueRanges: number[] = [];

        for (let i = 1; i < prices.length; i++) {
            const current = prices[i];
            const previous = prices[i - 1];
            // Simplified TR for single-price series
            const tr = Math.abs(current - previous);
            trueRanges.push(tr);
        }

        // Simple average of recent TRs
        const recentTRs = trueRanges.slice(-period);
        return recentTRs.reduce((a, b) => a + b, 0) / recentTRs.length;
    }

    private calculateDonchian(prices: number[], period: number): { high: number; low: number } {
        const slice = prices.slice(-period);
        return {
            high: Math.max(...slice),
            low: Math.min(...slice),
        };
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
            'trend-buy',
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
            'trend-sell',
            tokenId,
            this.targetSellPrice,
            this.targetSize,
            Side.SELL
        );
    }

    // -------------------------------------------------------------------------
    // Logging
    // -------------------------------------------------------------------------

    private logIndicators(indicators: TrendIndicators, message: string): void {
        this.writeLog(
            `${message} | ` +
            `Price=${indicators.currentPrice.toFixed(2)}, ` +
            `SMA[${this.shortMaPeriod}]=${indicators.shortMa.toFixed(2)}, ` +
            `SMA[${this.longMaPeriod}]=${indicators.longMa.toFixed(2)}, ` +
            `ADX=${indicators.adx.toFixed(1)}, ` +
            `ATR=${indicators.atr.toFixed(2)}, ` +
            `MACD=${indicators.macdHistogram.toFixed(2)}, ` +
            `Donchian[${indicators.donchianLow.toFixed(0)}-${indicators.donchianHigh.toFixed(0)}]`
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
