import { Side } from "@polymarket/clob-client";
import { QuantBot, QuantBotProps, QuantBotRun, TradeOrder, TradeStatus } from "./QuantBot.js";
import { BtcDirection, MarketSchedule } from "../types/interfaces.js";

interface EarlyLimitProps extends QuantBotProps {
    btcDirection: BtcDirection;       // Which side to monitor (BTC UP or BTC DOWN)
    triggerPrice: number;           // Price threshold M that triggers the order
    targetBuyPrice: number;             // Limit order price N
    targetSellPrice: number;
    targetAmount: number;              // Size of the limit order
    cutoffMinute: number;           // Cancel orders after this minute of the hour

}

export class EarlyLimit extends QuantBot implements QuantBotRun {

    private btcDirection!: BtcDirection;
    private triggerPrice!: number;
    private targetBuyPrice!: number;
    private targetAmount!: number;
    private cutoffMinute!: number;
    private targetSellPrice!: number;

    private buyOrder: TradeOrder | undefined = undefined;
    private sellOrder: TradeOrder | undefined = undefined;

    private doNothing: boolean = false;

    constructor(props: EarlyLimitProps) {
        super(props);

        this.btcDirection = props.btcDirection;
        this.triggerPrice = props.triggerPrice;
        this.targetBuyPrice = props.targetBuyPrice;
        this.targetAmount = props.targetAmount;
        this.cutoffMinute = props.cutoffMinute;
        this.targetSellPrice = props.targetSellPrice;
        this.doNothing = false;
    }

    public async run() {
        this.on('hourly', async () => {
            await this.updateOrders();
            await this.auditAndReset()
            this.buyOrder = undefined;
            this.sellOrder = undefined;
            this.doNothing = false;
        })

        this.tickWrapper(1000 * 4, 1000 * 2, async () => {
            if (this.doNothing) {
                return;
            }

            const now = new Date();
            const currentMinute = now.getMinutes();

            // Cancel BUY orders after cutoff minute
            let isCutoff = false;
            if (this.marketSchedule === MarketSchedule.QUARTERLY) {
                isCutoff = currentMinute % 15 >= this.cutoffMinute;
            } else {
                isCutoff = currentMinute >= this.cutoffMinute;
            }
            if (isCutoff) {
                await this.handleCutoff();
                return;
            }

            await this.updateOrders();

            const orderBooks = await this.marketInfo.getLiveData(this.targetedMarket);

            const makeSellOrder = async () => {
                if (!this.sellOrder) {
                    this.sellOrder = await this.makeOrder(
                        'followup-sell',
                        this.btcDirection === BtcDirection.UP ? orderBooks.BtcUpTokenId : orderBooks.BtcDownTokenId,
                        this.targetSellPrice,
                        this.targetAmount,
                        Side.SELL,
                    )
                }
            }

            if (this.buyOrder && this.buyOrder.status === TradeStatus.MATCHED) {
                await makeSellOrder();
            }

            if (!this.buyOrder) {
                const tokenId = this.btcDirection === BtcDirection.UP
                    ? orderBooks.BtcUpTokenId
                    : orderBooks.BtcDownTokenId;

                const currentPrice = await this.marketInfo.getPrice(
                    tokenId,
                    Side.BUY
                );
                if (currentPrice >= this.triggerPrice) {
                    const totalCost = this.targetBuyPrice * this.targetAmount;
                    if (this.checkIfOrderIsValid(this.targetBuyPrice, this.targetAmount) && this.canSpend(totalCost)) {
                        this.buyOrder = await this.makeOrder(
                            'learly-buy',
                            tokenId,
                            this.targetBuyPrice,
                            this.targetAmount,
                            Side.BUY,
                        );
                    }
                }
            }

        });
    }

    // -------------------------------------------------------------------------
    // Cutoff Handling
    // -------------------------------------------------------------------------

    private async handleCutoff(): Promise<void> {
        this.doNothing = true;
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
