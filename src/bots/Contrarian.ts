import { Side } from "@polymarket/clob-client";

import { QuantBot, QuantBotProps, QuantBotRun, TradeOrder, TradeStatus } from "./QuantBot.js";

interface ContrarianProps extends QuantBotProps {
    targetSize: number;
    cutoffMinute: number;
    targetSellPrice: number;
    lookbackHours: number;
    targetBuyPrice: number;
}

export class Contrarian extends QuantBot implements QuantBotRun {

    private targetSize!: number;
    private cutoffMinute!: number;
    private targetSellPrice!: number;
    private targetBuyPrice!: number;
    private lookbackHours!: number;

    private buyOrder: TradeOrder | undefined = undefined;
    private sellOrder: TradeOrder | undefined = undefined;
    private isTie: boolean = false;

    private doNothing: boolean = false;

    constructor(props: ContrarianProps) {
        super(props);

        this.targetSize = props.targetSize;
        this.cutoffMinute = props.cutoffMinute;
        this.targetSellPrice = props.targetSellPrice;
        this.targetBuyPrice = props.targetBuyPrice;
        this.lookbackHours = props.lookbackHours;

        this.doNothing = false;
    }

    /**
     * Gets the winning direction for a specific hour in the past.
     * @param hoursAgo - How many hours ago (1 = previous hour, 2 = two hours ago, etc.)
     * @returns 'UP' if BtcUp won, 'DOWN' if BtcDown won, or null if unable to determine.
     */
    private async getHourWinner(hoursAgo: number): Promise<'UP' | 'DOWN' | null> {
        try {
            const hourUrl = this.marketInfo.getUrl(
                this.marketInfo.getCurrentEstTimestamp() - (hoursAgo * 60 * 60 * 1000),
                this.targetedMarket,
            );
            const market = await this.marketInfo.getMarketInfo(hourUrl);

            const upPrice = parseFloat(market.outcomePrices[0]);
            const downPrice = parseFloat(market.outcomePrices[1]);

            if (upPrice >= downPrice) {
                return 'UP';
            } else {
                return 'DOWN';
            }
        } catch (e) {
            this.writeError(e);
            return null;
        }
    }

    /**
     * Gets the majority direction from the previous N hours.
     * @returns 'UP' if majority were UP, 'DOWN' if majority were DOWN, 'TIE' if equal, or null if unable to determine.
     */
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

    public async run() {
        this.on('hourly', async () => {
            await this.updateOrders();
            await this.auditAndReset()
            this.buyOrder = undefined;
            this.sellOrder = undefined;
            this.isTie = false;
            this.doNothing = false;
        })

        this.tickWrapper(1000 * 5, 1000 * 2, async () => {

            await this.updateOrders();

            if (this.doNothing) {
                return;
            }

            const orderBooks = await this.marketInfo.getLiveData(this.targetedMarket);

            const makeSellOrder = async () => {
                if (!this.sellOrder && this.buyOrder) {
                    this.sellOrder = await this.makeOrder(
                        'followup-sell',
                        this.buyOrder.clobTokenId,
                        this.targetSellPrice,
                        this.targetSize,
                        Side.SELL,
                    );
                }
            }

            if (!this.sellOrder && this.buyOrder && this.buyOrder.status === TradeStatus.MATCHED) {
                makeSellOrder();
            }

            const now = new Date();
            const currentMinute = now.getMinutes();

            if (currentMinute >= this.cutoffMinute) {
                this.trades.forEach((trade) => {
                    if (trade.status === TradeStatus.LIVE && trade.side == Side.BUY) {
                        this.cancelTrade(trade);
                    }
                })
                this.doNothing = true;
                return;
            }

            if (this.buyOrder || this.isTie) {
                return;
            }

            // Determine which direction to bet (opposite of previous N hours majority)
            const previousHours = await this.getPreviousHoursMajority();
            if (!previousHours) {
                this.writeLog('Unable to determine previous hours majority, skipping');
                return;
            }

            // Skip betting on ties
            if (previousHours.majority === 'TIE') {
                this.writeLog(`Previous ${this.lookbackHours} hours: [${previousHours.results.join(', ')}] -> TIE, skipping this hour`);
                this.isTie = true; // Prevent retrying this hour
                return;
            }

            const betDirection = previousHours.majority === 'UP' ? 'DOWN' : 'UP';
            const tokenId = betDirection === 'UP' ? orderBooks.BtcUpTokenId : orderBooks.BtcDownTokenId;

            this.writeLog(`Previous ${this.lookbackHours} hours: [${previousHours.results.join(', ')}] -> majority: ${previousHours.majority}, betting on: ${betDirection}`);

            if (this.checkIfOrderIsValid(this.targetBuyPrice, this.targetSize) && this.canSpend(this.targetBuyPrice * this.targetSize)) {
                this.buyOrder = await this.makeOrder(
                    'contrarian-buy',
                    tokenId,
                    this.targetBuyPrice,
                    this.targetSize,
                    Side.BUY,
                );
                this.buyOrder?.on('tradeMatched', () => {
                    makeSellOrder();
                })
            }
        });
    }
}
