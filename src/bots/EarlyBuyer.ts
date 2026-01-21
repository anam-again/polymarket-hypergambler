import { Side } from "@polymarket/clob-client";

import { QuantBot, QuantBotProps, QuantBotRun, TradeOrder, TradeStatus } from "./QuantBot.js";
import { BtcDirection, MarketSchedule } from "../types/interfaces.js";

interface EarlyBuyerProps extends QuantBotProps {
    targetBuyPrice: number;
    targetSize: number;
    cutoffMinute: number;
    targetSellPrice: number;
    btcDirection: BtcDirection;
}

// ============================================================================
// EarlyBuyer Class
// ============================================================================

export class EarlyBuyer extends QuantBot implements QuantBotRun {

    // --- Properties ---

    private targetBuyPrice: number;
    private targetSize: number;
    private cutoffMinute: number;
    private targetSellPrice: number;
    private btcDirection: BtcDirection;

    private buyOrder?: TradeOrder;
    private sellOrder?: TradeOrder;
    private isPastCutoff: boolean = false;

    // --- Constructor ---

    constructor(props: EarlyBuyerProps) {
        super(props);

        this.targetBuyPrice = props.targetBuyPrice;
        this.targetSellPrice = props.targetSellPrice;
        this.targetSize = props.targetSize;
        this.cutoffMinute = props.cutoffMinute;
        this.btcDirection = props.btcDirection;
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

            if (this.shouldCreateBuyOrder()) {
                await this.createBuyOrder();
            }
        });
    }

    // -------------------------------------------------------------------------
    // Order Logic
    // -------------------------------------------------------------------------

    private shouldCreateBuyOrder(): boolean {
        if (this.buyOrder) return false;
        if (!this.checkIfOrderIsValid(this.targetBuyPrice, this.targetSize)) return false;
        if (!this.canSpend(this.targetBuyPrice * this.targetSize)) return false;
        return true;
    }

    private shouldCreateSellOrder(): boolean {
        if (this.sellOrder) return false;
        if (!this.buyOrder) return false;
        if (this.buyOrder.status === TradeStatus.MATCHED) return true;
        return false;
    }

    private async createBuyOrder(): Promise<void> {
        const tokenId = await this.getTargetTokenId();

        this.buyOrder = await this.makeOrder(
            'init-buy',
            tokenId,
            this.targetBuyPrice,
            this.targetSize,
            Side.BUY
        );

        this.buyOrder?.once('tradeMatched', () => {
            this.createSellOrder();
        });
    }

    private async createSellOrder(): Promise<void> {
        if (this.sellOrder) return;

        const tokenId = await this.getTargetTokenId();

        this.sellOrder = await this.makeOrder(
            'followup-sell',
            tokenId,
            this.targetSellPrice,
            this.targetSize,
            Side.SELL
        );
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

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    private async getTargetTokenId(): Promise<string> {
        const orderBooks = await this.marketInfo.getLiveData(this.targetedMarket);
        return this.btcDirection === BtcDirection.UP
            ? orderBooks.BtcUpTokenId
            : orderBooks.BtcDownTokenId;
    }
}
