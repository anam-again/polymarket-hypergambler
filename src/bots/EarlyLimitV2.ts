import { Side } from "@polymarket/clob-client";

import { QuantBot, QuantBotProps, QuantBotRun, TradeOrder, TradeStatus } from "./QuantBot.js";
import { MarketSchedule } from "../types/interfaces.js";

// ============================================================================
// Types & Interfaces
// ============================================================================

type BetDirection = 'UP' | 'DOWN';

interface EarlyLimitV2Props extends QuantBotProps {
    triggerPrice: number;
    targetBuyPrice: number;
    targetSellPrice: number;
    targetAmount: number;
    cutoffMinute: number;
    maxFlops: number;
    flopsLookbackHours: number;
}

// ============================================================================
// EarlyLimitV2 Class
// ============================================================================

export class EarlyLimitV2 extends QuantBot implements QuantBotRun {

    // --- Properties ---

    private triggerPrice: number;
    private targetBuyPrice: number;
    private targetSellPrice: number;
    private targetAmount: number;
    private cutoffMinute: number;
    private maxFlops: number;
    private flopsLookbackHours: number;

    private buyOrder?: TradeOrder;
    private sellOrder?: TradeOrder;
    private isPastCutoff: boolean = false;
    private currentDirection?: BetDirection;

    // --- Constructor ---

    constructor(props: EarlyLimitV2Props) {
        super(props);

        this.triggerPrice = props.triggerPrice;
        this.targetBuyPrice = props.targetBuyPrice;
        this.targetSellPrice = props.targetSellPrice;
        this.targetAmount = props.targetAmount;
        this.cutoffMinute = props.cutoffMinute;
        this.maxFlops = props.maxFlops;
        this.flopsLookbackHours = props.flopsLookbackHours;
    }

    // --- Main Run Loop ---

    public async run(): Promise<void> {
        this.setupPeriodReset();
        this.startTradingLoop();
    }

    // -------------------------------------------------------------------------
    // Setup
    // -------------------------------------------------------------------------

    private setupPeriodReset(): void {
        this.registerResetHandler(async () => {
            await this.updateOrders();
            await this.auditAndReset();
            this.resetState();
        });
    }

    private resetState(): void {
        this.buyOrder = undefined;
        this.sellOrder = undefined;
        this.isPastCutoff = false;
        this.currentDirection = undefined;
    }

    // -------------------------------------------------------------------------
    // Trading Loop
    // -------------------------------------------------------------------------

    private startTradingLoop(): void {
        this.tickWrapper(1000 * 4, 1000 * 2, async () => {
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

            if (this.shouldCreateBuyOrder()) {
                await this.attemptBuyOrder();
            }
        });
    }

    // -------------------------------------------------------------------------
    // Order Logic
    // -------------------------------------------------------------------------

    private shouldCreateBuyOrder(): boolean {
        if (this.buyOrder) return false;
        if (!this.hasEnoughFlops()) return false;
        return true;
    }

    private shouldCreateSellOrder(): boolean {
        if (this.sellOrder) return false;
        if (!this.buyOrder) return false;
        return this.buyOrder.status === TradeStatus.MATCHED;
    }

    private async attemptBuyOrder(): Promise<void> {
        // Determine direction from market data if not yet set
        if (!this.currentDirection) {
            const direction = this.getWeightedDirection();
            if (!direction) {
                return;
            }
            this.currentDirection = direction;
            this.writeLog(`Betting direction: ${this.currentDirection}`);
        }

        const orderBooks = await this.marketInfo.getLiveData(this.targetedMarket);
        const tokenId = this.currentDirection === 'UP'
            ? orderBooks.BtcUpTokenId
            : orderBooks.BtcDownTokenId;

        const currentPrice = await this.marketInfo.getPrice(tokenId, Side.BUY);

        if (currentPrice < this.triggerPrice) {
            return;
        }

        const totalCost = this.targetBuyPrice * this.targetAmount;

        if (!this.checkIfOrderIsValid(this.targetBuyPrice, this.targetAmount)) return;
        if (!this.canSpend(totalCost)) return;

        this.buyOrder = await this.makeOrder(
            'limitv2-buy',
            tokenId,
            this.targetBuyPrice,
            this.targetAmount,
            Side.BUY
        );

    }

    private async createSellOrder(): Promise<void> {
        if (this.sellOrder || !this.currentDirection) return;

        const orderBooks = await this.marketInfo.getLiveData(this.targetedMarket);
        const tokenId = this.currentDirection === 'UP'
            ? orderBooks.BtcUpTokenId
            : orderBooks.BtcDownTokenId;

        this.sellOrder = await this.makeOrder(
            'limitv2-sell',
            tokenId,
            this.targetSellPrice,
            this.targetAmount,
            Side.SELL
        );
    }

    // -------------------------------------------------------------------------
    // Direction & Flops Check
    // -------------------------------------------------------------------------

    private getWeightedDirection(): BetDirection | null {
        const cdMarketData = this.getCdMarketData();
        const averages = cdMarketData.getAverages(this.flopsLookbackHours, this.targetedMarket);

        if (!averages) {
            this.writeLog(`Insufficient data for ${this.flopsLookbackHours} hours lookback`);
            this.isPastCutoff = true;
            return null;
        }

        // Compare weighted average price to hourly open to determine trend
        // If average > open, market trending UP; if average < open, trending DOWN
        const direction: BetDirection = averages.averagePrice > averages.hourlyOpen ? 'UP' : 'DOWN';

        this.writeLog(`Direction calc: avgPrice=${averages.averagePrice.toFixed(4)}, hourlyOpen=${averages.hourlyOpen.toFixed(4)} -> ${direction}`);

        return direction;
    }

    private hasEnoughFlops(): boolean {
        const cdMarketData = this.getCdMarketData();
        const averages = cdMarketData.getAverages(this.flopsLookbackHours, this.targetedMarket);

        if (!averages) {
            this.writeLog(`Insufficient flops data for ${this.flopsLookbackHours} hours lookback`);
            this.isPastCutoff = true;
            return false;
        }

        const avgFlops = (averages.openFlops + averages.averageFlops) / 2;

        if (avgFlops > this.maxFlops) {
            this.writeLog(`Flops too high: avg=${avgFlops.toFixed(2)}, max=${this.maxFlops}`);
            this.isPastCutoff = true;
            return false;
        }

        return true;
    }

    // -------------------------------------------------------------------------
    // Cutoff Handling
    // -------------------------------------------------------------------------

    private isAfterCutoff(): boolean {
        const currentMinute = this.clock.getMinutes();
        if (this.marketSchedule === MarketSchedule.QUARTERLY) {
            return currentMinute % 15 >= this.cutoffMinute;
        } else {
            return currentMinute >= this.cutoffMinute;
        }
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
