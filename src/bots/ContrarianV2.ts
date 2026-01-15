import { Side } from "@polymarket/clob-client";

import { QuantBot, QuantBotProps, QuantBotRun, TradeOrder, TradeStatus } from "./QuantBot.js";
import { CDMarketData } from "../nonBots/CDMarketData.js";

// ============================================================================
// Types & Interfaces
// ============================================================================

interface ContrarianV2Props extends QuantBotProps {
    targetSize: number;
    cutoffMinute: number;
    targetSellPrice: number;
    lookbackHours: number;
    targetBuyPrice: number;
    cdLookbackHours: number;
}

// ============================================================================
// ContrarianV2 Class
// ============================================================================

export class ContrarianV2 extends QuantBot implements QuantBotRun {

    // --- Properties ---

    private targetSize: number;
    private cutoffMinute: number;
    private targetSellPrice: number;
    private targetBuyPrice: number;
    private lookbackHours: number;
    private cdLookbackHours: number;

    private buyOrder?: TradeOrder;
    private sellOrder?: TradeOrder;
    private isTie: boolean = false;
    private isPastCutoff: boolean = false;

    // --- Constructor ---

    constructor(props: ContrarianV2Props) {
        super(props);

        this.targetSize = props.targetSize;
        this.cutoffMinute = props.cutoffMinute;
        this.targetSellPrice = props.targetSellPrice;
        this.targetBuyPrice = props.targetBuyPrice;
        this.lookbackHours = props.lookbackHours;
        this.cdLookbackHours = props.cdLookbackHours;
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
        this.isTie = false;
        this.isPastCutoff = false;
    }

    // -------------------------------------------------------------------------
    // Trading Loop
    // -------------------------------------------------------------------------

    private startTradingLoop(): void {
        this.tickWrapper(1000 * 5, 1000 * 2, async () => {
            await this.updateOrders();

            if (this.isPastCutoff) {
                return;
            }

            if (this.shouldCreateSellOrder()) {
                await this.createSellOrder();
            }

            if (this.isAfterCutoff()) {
                await this.handleCutoff();
                return;
            }

            if (this.buyOrder || this.isTie) {
                return;
            }

            await this.attemptBuyOrder();
        });
    }

    // -------------------------------------------------------------------------
    // Order Logic
    // -------------------------------------------------------------------------

    private shouldCreateSellOrder(): boolean {
        if (this.sellOrder) return false;
        if (!this.buyOrder) return false;
        return this.buyOrder.status === TradeStatus.MATCHED;
    }

    private async createSellOrder(): Promise<void> {
        if (this.sellOrder || !this.buyOrder) return;

        this.sellOrder = await this.makeOrder(
            'followup-sell',
            this.buyOrder.clobTokenId,
            this.targetSellPrice,
            this.targetSize,
            Side.SELL
        );
    }

    private async attemptBuyOrder(): Promise<void> {
        const orderBooks = await this.marketInfo.getLiveData(this.targetedMarket);

        const previousHours = await this.getPreviousHoursMajority();
        if (!previousHours) {
            this.writeLog('Unable to determine previous hours majority, skipping');
            return;
        }

        if (previousHours.majority === 'TIE') {
            this.writeLog(`Previous ${this.lookbackHours} hours: [${previousHours.results.join(', ')}] -> TIE, skipping this hour`);
            this.isTie = true;
            return;
        }

        const betDirection = previousHours.majority === 'UP' ? 'DOWN' : 'UP';

        // Check if totalChange agrees with bet direction
        if (!this.doesTotalChangeAgree(betDirection)) {
            this.writeLog(`TotalChange does not agree with bet direction ${betDirection}, skipping`);
            this.isPastCutoff = true;
            return;
        }

        const tokenId = betDirection === 'UP' ? orderBooks.BtcUpTokenId : orderBooks.BtcDownTokenId;

        this.writeLog(`Previous ${this.lookbackHours} hours: [${previousHours.results.join(', ')}] -> majority: ${previousHours.majority}, betting on: ${betDirection}`);

        if (!this.checkIfOrderIsValid(this.targetBuyPrice, this.targetSize)) return;
        if (!this.canSpend(this.targetBuyPrice * this.targetSize)) return;

        this.buyOrder = await this.makeOrder(
            'contrarian-buy',
            tokenId,
            this.targetBuyPrice,
            this.targetSize,
            Side.BUY
        );

        this.buyOrder?.on('tradeMatched', () => {
            this.createSellOrder();
        });
    }

    // -------------------------------------------------------------------------
    // Market Data Validation
    // -------------------------------------------------------------------------

    private doesTotalChangeAgree(betDirection: 'UP' | 'DOWN'): boolean {
        const cdMarketData = CDMarketData.getInstance();
        const averages = cdMarketData.getAverages(this.cdLookbackHours, this.targetedMarket);

        if (!averages) {
            this.writeLog(`Insufficient CDMarketData for ${this.cdLookbackHours} hours lookback`);
            return false;
        }

        // totalChange is the sum of absolute price movements
        // A negative average totalChange relative to price indicates downward pressure
        // We use the relationship between hourlyOpen and averagePrice to determine direction
        const priceDirection = averages.averagePrice > averages.hourlyOpen ? 'UP' : 'DOWN';

        const agrees = priceDirection !== betDirection;

        this.writeLog(`CDMarketData: avgPrice=${averages.averagePrice.toFixed(2)}, hourlyOpen=${averages.hourlyOpen.toFixed(2)}, totalChange=${averages.totalChange.toFixed(2)}, priceDirection=${priceDirection}, betDirection=${betDirection}, agrees=${agrees}`);

        return agrees;
    }

    // -------------------------------------------------------------------------
    // Previous Hours Analysis
    // -------------------------------------------------------------------------

    private async getHourWinner(hoursAgo: number): Promise<'UP' | 'DOWN' | null> {
        try {
            const hourUrl = this.marketInfo.getUrl(
                this.marketInfo.getCurrentEstTimestamp() - (hoursAgo * 60 * 60 * 1000),
                this.targetedMarket,
            );
            const market = await this.marketInfo.getMarketInfo(hourUrl);

            const upPrice = parseFloat(market.outcomePrices[0]);
            const downPrice = parseFloat(market.outcomePrices[1]);

            return upPrice >= downPrice ? 'UP' : 'DOWN';
        } catch (e) {
            this.writeError(e);
            return null;
        }
    }

    private async getPreviousHoursMajority(): Promise<{ majority: 'UP' | 'DOWN' | 'TIE', results: ('UP' | 'DOWN')[] } | null> {
        const results: ('UP' | 'DOWN')[] = [];

        for (let i = 1; i <= this.lookbackHours; i++) {
            const winner = await this.getHourWinner(i);
            if (winner === null) {
                this.writeLog(`Unable to get winner for ${i} hours ago`);
                return null;
            }
            results.push(winner);
        }

        const upCount = results.filter(r => r === 'UP').length;
        const downCount = results.filter(r => r === 'DOWN').length;

        let majority: 'UP' | 'DOWN' | 'TIE';
        if (upCount > downCount) {
            majority = 'UP';
        } else if (downCount > upCount) {
            majority = 'DOWN';
        } else {
            majority = 'TIE';
        }

        return { majority, results };
    }

    // -------------------------------------------------------------------------
    // Cutoff Handling
    // -------------------------------------------------------------------------

    private isAfterCutoff(): boolean {
        return this.clock.getMinutes() >= this.cutoffMinute;
    }

    private async handleCutoff(): Promise<void> {
        this.isPastCutoff = true;
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
