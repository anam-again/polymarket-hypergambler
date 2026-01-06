import { readFileSync } from "fs";
import { QuantBot, QuantBotProps, QuantBotRun } from "./QuantBot.js";
import { CDMarketData } from "./../nonBots/CDMarketData.js";

interface MarketDataEntry {
    timestamp: Date;
    btcPrice: number;
    priceChange: number;
}

interface MarketContrarianProps extends QuantBotProps {
    targetSize: number;
    cutoffMinute: number;
    targetSellPrice: number;
    lookbackHours: number;
    targetBuyPrice: number;
    cdMarketData: CDMarketData;
}

export class MarketContrarian extends QuantBot implements QuantBotRun {

    private static readonly DEFAULT_LOG_PATH = './logs/MarketWriterData.log';

    private targetSize!: number;
    private cutoffMinute!: number;
    private targetSellPrice!: number;
    private targetBuyPrice!: number;
    private lookbackHours!: number;
    private marketDataLogPath!: string;
    private cdMarketData: CDMarketData;

    private buyDone: boolean = false;
    private sellDone: boolean = false;

    constructor(props: MarketContrarianProps) {
        super(props);

        this.targetSize = props.targetSize;
        this.cutoffMinute = props.cutoffMinute;
        this.targetSellPrice = props.targetSellPrice;
        this.targetBuyPrice = props.targetBuyPrice;
        this.lookbackHours = props.lookbackHours;
        this.marketDataLogPath = MarketContrarian.DEFAULT_LOG_PATH;
        this.cdMarketData = props.cdMarketData;
    }

    /**
     * Reads and parses CSV data from MarketWriterData.log
     * Format: timestamp, btcPrice, priceChange
     */
    private readMarketData(): MarketDataEntry[] {
        try {
            const content = readFileSync(this.marketDataLogPath, 'utf-8');
            const lines = content.trim().split('\n').filter(line => line.trim());

            return lines.map(line => {
                const parts = line.split(',').map(p => p.trim());
                return {
                    timestamp: new Date(parts[0]),
                    btcPrice: parseFloat(parts[1]),
                    priceChange: parseFloat(parts[2]),
                };
            });
        } catch (error) {
            this.writeLog(`Error reading market data: ${error}`);
            return [];
        }
    }

    /**
     * Gets the average price of the previous N entries
     * @param n - Number of entries to look back
     * @returns Average price change, or null if insufficient data
     */
    private getAveragePrice(n: number): number | null {
        const data = this.readMarketData();

        if (data.length < n) {
            this.writeLog(`Insufficient data: have ${data.length} entries, need ${n}`);
            return null;
        }

        const recentEntries = data.slice(-n);
        const sum = recentEntries.reduce((acc, entry) => acc + entry.btcPrice, 0);
        return sum / n;
    }

    /**
     * Determines bet direction based on average price change of previous N entries
     * @param n - Number of entries to look back
     * @returns 'UP' if average is positive, 'DOWN' if negative, null if insufficient data
     */
    public async getBetDirection(n: number): Promise<"UP" | "DOWN" | null> {
        const avgPrice = this.getAveragePrice(n);
        const currentPrice = await this.cdMarketData.getCurrentPrice();
        if (avgPrice === null) {
            return null;
        }

        const betDirection = avgPrice - currentPrice >= 0 ? 'UP' : 'DOWN';

        this.writeLog(`Average price over last ${n} hours: ${avgPrice}, currentPrice: ${currentPrice}. Betting: ${betDirection}`);

        return betDirection;
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

    public async run() {
        this.startHourlyReset();

        this.tickWrapper(1000 * 5, 1000 * 2, async () => {
            // const now = new Date();
            // const currentMinute = now.getMinutes();

            // const orderBooks = await this.marketInfo.getLiveData();

            // await this.auditOrders();

            // // Handle sell orders for matched buys
            // if (!this.sellDone) {
            //     for (const trade of this.tradeResults) {
            //         if (trade.tradeStatus === TradeStatus.EXECUTED) {
            //             const order = await this.makeOrder(
            //                 'followup-sell',
            //                 trade.clobTokenId,
            //                 this.targetSellPrice,
            //                 this.targetSize,
            //                 Side.SELL,
            //             );
            //             if (order) {
            //                 this.sellDone = true;
            //             }
            //         }
            //     }
            // }

            // // Cancel buy orders after cutoff minute
            // if (currentMinute >= this.cutoffMinute) {
            //     this.tradeResults.forEach((tr) => {
            //         if (tr.tradeStatus === TradeStatus.LIVE && tr.side === Side.BUY) {
            //             this.cancelTrade(tr);
            //         }
            //     });
            //     return;
            // }

            // // Only make one buy per hour
            // if (this.buyDone) {
            //     return;
            // }


            // const direction = await this.getBetDirection(this.lookbackHours);

            // if (!direction) {
            //     this.writeLog('Unable to determine bet direction from average, skipping');
            //     return;
            // }

            // const buyTokenId = direction === 'UP' ? orderBooks.BtcUpTokenId : orderBooks.BtcDownTokenId;

            // const canSpendAmount = await this.canSpend(this.targetBuyPrice * this.targetSize);
            // const orderIsPossible = [
            //     this.checkIfOrderIsValid(this.targetBuyPrice, this.targetSize),
            //     canSpendAmount,
            // ].every((r) => r === true);

            // if (orderIsPossible) {
            //     const order = await this.makeOrder(
            //         'average-trend-buy',
            //         buyTokenId,
            //         this.targetBuyPrice,
            //         this.targetSize,
            //         Side.BUY,
            //     );
            //     if (order) {
            //         this.buyDone = true;
            //     }
            // }
        });
    }
}
