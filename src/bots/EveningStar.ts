import { Side } from "@polymarket/clob-client";

import { QuantBot, QuantBotProps, QuantBotRun, TradeOrder, TradeStatus } from "./QuantBot.js";
import { CDMarketData } from "../nonBots/CDMarketData.js";

// ============================================================================
// Types & Interfaces
// ============================================================================

interface EveningStarProps extends QuantBotProps {
    candleMinutes: number;          // Duration of each candle (e.g., 10 minutes)
    minBullishMove: number;         // Min price rise for first candle to be "bullish" (e.g., 50 = $50)
    maxIndecisionRange: number;     // Max range for second candle to be "indecision" (e.g., 30 = $30)
    minBearishMove: number;         // Min price drop for third candle to be "bearish" (e.g., 50 = $50)
    targetBuyPrice: number;
    targetSellPrice: number;
    targetSize: number;
    cutoffMinute: number;
}

interface Candle {
    open: number;
    close: number;
    high: number;
    low: number;
    startTime: number;
}

type TradingState =
    | 'FORMING_CANDLE_1'    // First candle is forming (looking for bullish)
    | 'FORMING_CANDLE_2'    // Second candle is forming (looking for indecision)
    | 'FORMING_CANDLE_3'    // Third candle is forming (looking for bearish)
    | 'PATTERN_DETECTED'    // Evening Star pattern detected, ready to trade
    | 'TRADE_ENTERED'       // Trade has been placed
    | 'PAST_CUTOFF';        // Past cutoff, no more trading

// ============================================================================
// EveningStar Class
// ============================================================================

export class EveningStar extends QuantBot implements QuantBotRun {

    // --- Properties ---

    private candleMinutes: number;
    private minBullishMove: number;
    private maxIndecisionRange: number;
    private minBearishMove: number;
    private targetBuyPrice: number;
    private targetSellPrice: number;
    private targetSize: number;
    private cutoffMinute: number;

    private buyOrder?: TradeOrder;
    private sellOrder?: TradeOrder;

    // State tracking
    private state: TradingState = 'FORMING_CANDLE_1';
    private candle1?: Candle;
    private candle2?: Candle;
    private candle3?: Candle;
    private currentCandle?: Candle;

    // --- Constructor ---

    constructor(props: EveningStarProps) {
        super(props);

        this.candleMinutes = props.candleMinutes;
        this.minBullishMove = props.minBullishMove;
        this.maxIndecisionRange = props.maxIndecisionRange;
        this.minBearishMove = props.minBearishMove;
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
        this.state = 'FORMING_CANDLE_1';
        this.candle1 = undefined;
        this.candle2 = undefined;
        this.candle3 = undefined;
        this.currentCandle = undefined;
    }

    // -------------------------------------------------------------------------
    // Trading Loop
    // -------------------------------------------------------------------------

    private startTradingLoop(): void {
        this.tickWrapper(1000 * 3, 1000 * 3, async () => {
            await this.updateOrders();

            // Handle sell order creation if buy matched
            if (this.shouldCreateSellOrder()) {
                await this.createSellOrder();
            }

            // Check cutoff
            if (this.isAfterCutoff() && this.state !== 'TRADE_ENTERED') {
                await this.handleCutoff();
                return;
            }

            if (this.state === 'PAST_CUTOFF' || this.state === 'TRADE_ENTERED') {
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
        const currentPrice = await this.getCurrentBtcPrice();
        if (!currentPrice) return;

        const currentMinute = new Date().getMinutes();
        const candleIndex = Math.floor(currentMinute / this.candleMinutes);

        // Initialize current candle if needed
        if (!this.currentCandle || this.getCandleIndex(this.currentCandle.startTime) !== candleIndex) {
            await this.finalizeCurrentCandle();
            this.currentCandle = {
                open: currentPrice,
                close: currentPrice,
                high: currentPrice,
                low: currentPrice,
                startTime: Date.now(),
            };
        }

        // Update current candle
        this.currentCandle.close = currentPrice;
        this.currentCandle.high = Math.max(this.currentCandle.high, currentPrice);
        this.currentCandle.low = Math.min(this.currentCandle.low, currentPrice);

        // Check if pattern is complete and we can trade
        if (this.state === 'PATTERN_DETECTED') {
            await this.createBuyOrder();
        }
    }

    private getCandleIndex(timestamp: number): number {
        const date = new Date(timestamp);
        return Math.floor(date.getMinutes() / this.candleMinutes);
    }

    private async finalizeCurrentCandle(): Promise<void> {
        if (!this.currentCandle) return;

        switch (this.state) {
            case 'FORMING_CANDLE_1':
                this.evaluateFirstCandle();
                break;

            case 'FORMING_CANDLE_2':
                this.evaluateSecondCandle();
                break;

            case 'FORMING_CANDLE_3':
                this.evaluateThirdCandle();
                break;
        }
    }

    // -------------------------------------------------------------------------
    // Candle Evaluation - Evening Star Pattern (Inverse of Morning Star)
    // -------------------------------------------------------------------------

    /**
     * First Candle (Bullish): A long, solid bullish candle indicating strong
     * buying pressure and continuation of the uptrend.
     */
    private evaluateFirstCandle(): void {
        if (!this.currentCandle) return;

        const priceChange = this.currentCandle.close - this.currentCandle.open;
        const isBullish = priceChange >= this.minBullishMove;

        if (isBullish) {
            this.candle1 = { ...this.currentCandle };
            this.state = 'FORMING_CANDLE_2';
            this.writeLog(`Candle 1 (Bullish) formed: Open=${this.candle1.open.toFixed(2)}, Close=${this.candle1.close.toFixed(2)}, Change=${priceChange.toFixed(2)}`);
        } else {
            this.writeLog(`Candle 1 not bullish enough: Change=${priceChange.toFixed(2)}, Required=${this.minBullishMove}`);
            // Stay in FORMING_CANDLE_1, next candle might be bullish
        }
    }

    /**
     * Second Candle (Indecision): A small body (like a Doji or spinning top),
     * often gapping up, showing market pause and uncertainty.
     */
    private evaluateSecondCandle(): void {
        if (!this.currentCandle || !this.candle1) return;

        const candleRange = this.currentCandle.high - this.currentCandle.low;
        const bodySize = Math.abs(this.currentCandle.close - this.currentCandle.open);
        const isIndecision = candleRange <= this.maxIndecisionRange;

        // Check for gap up (open above previous close)
        const hasGapUp = this.currentCandle.open > this.candle1.close;

        if (isIndecision) {
            this.candle2 = { ...this.currentCandle };
            this.state = 'FORMING_CANDLE_3';
            this.writeLog(`Candle 2 (Indecision) formed: Range=${candleRange.toFixed(2)}, Body=${bodySize.toFixed(2)}, GapUp=${hasGapUp}`);
        } else {
            this.writeLog(`Candle 2 not indecision: Range=${candleRange.toFixed(2)}, MaxAllowed=${this.maxIndecisionRange}`);
            // Reset to look for new pattern
            this.resetPatternSearch();
        }
    }

    /**
     * Third Candle (Bearish): A strong bearish candle that closes significantly
     * into the first candle's body (below its midpoint), signaling sellers are taking over.
     */
    private evaluateThirdCandle(): void {
        if (!this.currentCandle || !this.candle1 || !this.candle2) return;

        const priceChange = this.currentCandle.close - this.currentCandle.open;
        const isBearish = priceChange <= -this.minBearishMove;

        // Check if close is below midpoint of first candle
        const firstCandleMidpoint = (this.candle1.open + this.candle1.close) / 2;
        const closesBelowMidpoint = this.currentCandle.close < firstCandleMidpoint;

        if (isBearish && closesBelowMidpoint) {
            this.candle3 = { ...this.currentCandle };
            this.state = 'PATTERN_DETECTED';
            this.writeLog(`Evening Star Pattern DETECTED!`);
            this.writeLog(`  Candle 1: Open=${this.candle1.open.toFixed(2)}, Close=${this.candle1.close.toFixed(2)}`);
            this.writeLog(`  Candle 2: Open=${this.candle2.open.toFixed(2)}, Close=${this.candle2.close.toFixed(2)}`);
            this.writeLog(`  Candle 3: Open=${this.candle3.open.toFixed(2)}, Close=${this.candle3.close.toFixed(2)}`);
            this.writeLog(`  First candle midpoint: ${firstCandleMidpoint.toFixed(2)}`);
        } else {
            this.writeLog(`Candle 3 not bearish enough: Change=${priceChange.toFixed(2)}, Required=${-this.minBearishMove}, ClosesBelowMidpoint=${closesBelowMidpoint}`);
            // Reset to look for new pattern
            this.resetPatternSearch();
        }
    }

    private resetPatternSearch(): void {
        this.state = 'FORMING_CANDLE_1';
        this.candle1 = undefined;
        this.candle2 = undefined;
        this.candle3 = undefined;
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
        if (this.buyOrder) return;

        // Evening Star is a bearish reversal - buy the DOWN token
        const orderBooks = await this.marketInfo.getLiveData(this.targetedMarket);
        const tokenId = orderBooks.BtcDownTokenId;

        const totalCost = this.targetBuyPrice * this.targetSize;

        if (!this.checkIfOrderIsValid(this.targetBuyPrice, this.targetSize)) return;
        if (!this.canSpend(totalCost)) return;

        this.buyOrder = await this.makeOrder(
            'eveningstar-buy',
            tokenId,
            this.targetBuyPrice,
            this.targetSize,
            Side.BUY
        );

        this.state = 'TRADE_ENTERED';

        this.buyOrder?.once('tradeMatched', () => {
            this.createSellOrder();
        });
    }

    private async createSellOrder(): Promise<void> {
        if (this.sellOrder || !this.buyOrder) return;

        const orderBooks = await this.marketInfo.getLiveData(this.targetedMarket);
        const tokenId = orderBooks.BtcDownTokenId;

        this.sellOrder = await this.makeOrder(
            'eveningstar-sell',
            tokenId,
            this.targetSellPrice,
            this.targetSize,
            Side.SELL
        );
    }

    // -------------------------------------------------------------------------
    // Price Data
    // -------------------------------------------------------------------------

    private async getCurrentBtcPrice(): Promise<number | null> {
        try {
            const cdMarketData = CDMarketData.getInstance();
            return await cdMarketData.getCurrentPriceByMarket(this.targetedMarket);
        } catch (error) {
            this.writeError(error);
            return null;
        }
    }

    // -------------------------------------------------------------------------
    // Cutoff Handling
    // -------------------------------------------------------------------------

    private isAfterCutoff(): boolean {
        const currentMinute = new Date().getMinutes();
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
