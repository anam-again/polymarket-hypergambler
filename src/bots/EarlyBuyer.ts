import { OrderResponse, Side } from "@polymarket/clob-client";
import { QuantBot, QuantBotProps, QuantBotRun, TradeStatus } from "./QuantBot.js";

interface EarlyBuyerProps extends QuantBotProps {
    targetBuyPrice: number;
    targetSize: number;
    cutoffMinute: number;
    targetSellPrice: number;
    btcDirection: BtcDirection;
}

export enum BtcDirection {
    UP = "UP",
    DOWN = "DOWN",
}

export class EarlyBuyer extends QuantBot implements QuantBotRun {

    private targetBuyPrice!: number;
    private targetSize!: number;
    private cutoffMinute!: number;
    private targetSellPrice!: number;
    private btcDirection!: BtcDirection;

    private sellDone: boolean = false;

    constructor(props: EarlyBuyerProps) {
        super(props);

        this.targetBuyPrice = props.targetBuyPrice;
        this.targetSellPrice = props.targetSellPrice;
        this.targetSize = props.targetSize;
        this.cutoffMinute = props.cutoffMinute;
        this.btcDirection = props.btcDirection;
    }

    public async resetOnHour() {
        this.sellDone = false;
    }

    public async startHourlyReset() {
        await this.resetOnHour();  // Run once now

        // Calculate ms until the next hour
        const now = new Date();
        const msUntilNextHour = (60 - now.getMinutes()) * 60 * 1000 - now.getSeconds() * 1000 - now.getMilliseconds();

        // Wait until the next hour, then run every hour on the hour
        setTimeout(() => {
            this.resetOnHour();
            setInterval(this.resetOnHour.bind(this), 60 * 60 * 1000);
        }, msUntilNextHour);
    }

    public async run() {

        this.startHourlyReset();

        this.tickWrapper(1000 * 30, 1000 * 5, async () => {
            const now = new Date();
            const currentMinute = now.getMinutes();

            const orderBooks = await this.marketInfo.getLiveData();

            await this.auditOrders();
            
            if (!this.sellDone) {
                this.tradeResults.forEach(async (trade) => {
                    if (trade.tradeStatus === TradeStatus.SOLD) {
                        await this.makeOrder(
                            'followup-sell',
                            this.btcDirection === BtcDirection.UP ? orderBooks.BtcUpTokenId : orderBooks.BtcDownTokenId,
                            this.targetSellPrice,
                            this.targetSize,
                            Side.SELL,
                        )
                        this.sellDone = true;
                    }
                })
            }

            // Cancel buy orders after the first N mins, and return
            if (currentMinute >= this.cutoffMinute) {
                this.tradeResults.forEach((tr) => {
                    if (tr.tradeStatus === TradeStatus.LIVE && tr.side == Side.BUY) {
                        this.cancelTrade(tr);
                    }
                })
                return;
            }

            const canSpendAmount = await this.canSpend(this.targetBuyPrice * this.targetSize);
            const orderIsPossible = [
                this.checkIfOrderIsValid(this.targetBuyPrice, this.targetSize),
                canSpendAmount,
            ].every((r) => r === true);

            if (orderIsPossible) {
                this.makeOrder(
                    'init-buy',
                    this.btcDirection === BtcDirection.UP ? orderBooks.BtcUpTokenId : orderBooks.BtcDownTokenId,
                    this.targetBuyPrice,
                    this.targetSize,
                    Side.BUY,
                );
            }
        });
    }
}
