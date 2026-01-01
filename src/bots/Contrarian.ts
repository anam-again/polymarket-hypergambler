import { Side } from "@polymarket/clob-client";
import { QuantBot, QuantBotProps, QuantBotRun, TradeStatus } from "./QuantBot.js";

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

    private buyDone: boolean = false;
    private sellDone: boolean = false;

    constructor(props: ContrarianProps) {
        super(props);

        this.targetSize = props.targetSize;
        this.cutoffMinute = props.cutoffMinute;
        this.targetSellPrice = props.targetSellPrice;
        this.targetBuyPrice = props.targetBuyPrice;
        this.lookbackHours = props.lookbackHours;
    }

    public async resetOnHour() {
        this.buyDone = false;
        this.sellDone = false;
    }

    public async startHourlyReset() {
        await this.resetOnHour();

        const now = new Date();
        const msUntilNextHour = (60 - now.getMinutes()) * 60 * 1000 - now.getSeconds() * 1000 - now.getMilliseconds();

        setTimeout(() => {
            this.resetOnHour();
            setInterval(this.resetOnHour.bind(this), 60 * 60 * 1000);
        }, msUntilNextHour);
    }

    /**
     * Gets the winning direction for a specific hour in the past.
     * @param hoursAgo - How many hours ago (1 = previous hour, 2 = two hours ago, etc.)
     * @returns 'UP' if BtcUp won, 'DOWN' if BtcDown won, or null if unable to determine.
     */
    private async getHourWinner(hoursAgo: number): Promise<'UP' | 'DOWN' | null> {
        try {
            const hourUrl = this.marketInfo.getBitcoinHourlyUrl(
                this.marketInfo.getCurrentEstTimestamp() - (hoursAgo * 60 * 60 * 1000)
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
        this.startHourlyReset();

        this.tickWrapper(1000 * 30, 1000 * 5, async () => {
            const now = new Date();
            const currentMinute = now.getMinutes();

            const orderBooks = await this.marketInfo.getLiveData();

            await this.auditOrders();

            // Handle sell orders for matched buys
            if (!this.sellDone) {
                for (const trade of this.tradeResults) {
                    if (trade.tradeStatus === TradeStatus.SOLD) {
                        const order = await this.makeOrder(
                            'followup-sell',
                            trade.clobTokenId,
                            this.targetSellPrice,
                            this.targetSize,
                            Side.SELL,
                        );
                        this.sellDone = true;
                    }
                }
            }

            // Cancel buy orders after cutoff minute
            if (currentMinute >= this.cutoffMinute) {
                this.tradeResults.forEach((tr) => {
                    if (tr.tradeStatus === TradeStatus.LIVE && tr.side === Side.BUY) {
                        this.cancelTrade(tr);
                    }
                });
                return;
            }

            // Only make one buy per hour
            if (this.buyDone) {
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
                this.buyDone = true; // Prevent retrying this hour
                return;
            }

            const betDirection = previousHours.majority === 'UP' ? 'DOWN' : 'UP';
            const tokenId = betDirection === 'UP' ? orderBooks.BtcUpTokenId : orderBooks.BtcDownTokenId;

            this.writeLog(`Previous ${this.lookbackHours} hours: [${previousHours.results.join(', ')}] -> majority: ${previousHours.majority}, betting on: ${betDirection}`);

            const canSpendAmount = await this.canSpend(this.targetBuyPrice * this.targetSize);
            const orderIsPossible = [
                this.checkIfOrderIsValid(this.targetBuyPrice, this.targetSize),
                canSpendAmount,
            ].every((r) => r === true);

            if (orderIsPossible) {
                const order = await this.makeOrder(
                    'contrarian-buy',
                    tokenId,
                    this.targetBuyPrice,
                    this.targetSize,
                    Side.BUY,
                );
                if (order) {
                    this.buyDone = true;
                }
            }
        });
    }
}
