import { Side } from "@polymarket/clob-client";

import { QuantBot, QuantBotProps, QuantBotRun, TradeOrder, TradeStatus } from "./QuantBot.js";
import { MarketSchedule } from "../types/interfaces.js";

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
     * Gets the time offset in milliseconds for one period based on market schedule.
     */
    private getPeriodOffsetMs(): number {
        if (this.marketSchedule === MarketSchedule.QUARTERLY) {
            return 15 * 60 * 1000; // 15 minutes
        }
        return 60 * 60 * 1000; // 1 hour
    }

    /**
     * Gets the winning direction for a specific period in the past.
     * @param periodsAgo - How many periods ago (1 = previous period, 2 = two periods ago, etc.)
     * @returns 'UP' if BtcUp won, 'DOWN' if BtcDown won, or null if unable to determine.
     */
    private async getPeriodWinner(periodsAgo: number): Promise<'UP' | 'DOWN' | null> {
        try {
            const periodOffsetMs = this.getPeriodOffsetMs();
            const currTime = this.marketInfo.getCurrentEstTimestamp();
            const periodUrl = this.marketInfo.getUrl(
                currTime - (periodsAgo * periodOffsetMs),
                this.targetedMarket,
            );
            const market = await this.marketInfo.getMarketInfo(periodUrl);

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

    private isAfterCutoff() {
        const now = new Date();
        const currentMinute = now.getMinutes();
        if (this.marketSchedule === MarketSchedule.QUARTERLY) {
            return (currentMinute % 15) >= this.cutoffMinute;
        } else {
            return currentMinute >= this.cutoffMinute;
        }
    }

    /**
     * Gets the majority direction from the previous N periods (hours or 15-min chunks based on market schedule).
     * @returns 'UP' if majority were UP, 'DOWN' if majority were DOWN, 'TIE' if equal, or null if unable to determine.
     */
    private async getPreviousPeriodsMajority(): Promise<{ majority: 'UP' | 'DOWN' | 'TIE', results: ('UP' | 'DOWN')[] } | null> {
        const results: ('UP' | 'DOWN')[] = [];
        const periodLabel = this.marketSchedule === MarketSchedule.QUARTERLY ? '15-min periods' : 'hours';

        for (let i = 1; i <= this.lookbackHours; i++) {
            const winner = await this.getPeriodWinner(i);
            if (winner === null) {
                this.writeLog(`Unable to get winner for ${i} ${periodLabel} ago`);
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
        this.on('reset', async () => {
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
                await makeSellOrder();
            }

            if (this.isAfterCutoff()) {
                await this.handleCutoff();
                return;
            }

            if (this.buyOrder || this.isTie) {
                return;
            }

            // Determine which direction to bet (opposite of previous N periods majority)
            const previousPeriods = await this.getPreviousPeriodsMajority();
            const periodLabel = this.marketSchedule === MarketSchedule.QUARTERLY ? '15-min periods' : 'hours';
            if (!previousPeriods) {
                this.writeLog(`Unable to determine previous ${periodLabel} majority, skipping`);
                return;
            }
            // Skip betting on ties
            if (previousPeriods.majority === 'TIE') {
                this.writeLog(`Previous ${this.lookbackHours} ${periodLabel}: [${previousPeriods.results.join(', ')}] -> TIE, skipping this period`);
                this.isTie = true; // Prevent retrying this period
                return;
            }

            const betDirection = previousPeriods.majority === 'UP' ? 'DOWN' : 'UP';
            const tokenId = betDirection === 'UP' ? orderBooks.BtcUpTokenId : orderBooks.BtcDownTokenId;

            this.writeLog(`Previous ${this.lookbackHours} ${periodLabel}: [${previousPeriods.results.join(', ')}] -> majority: ${previousPeriods.majority}, betting on: ${betDirection}`);

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
