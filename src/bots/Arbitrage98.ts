import { Side } from "@polymarket/clob-client";
import { QuantBot, QuantBotRun } from "./QuantBot.js";


export class Arbitrage98 extends QuantBot implements QuantBotRun {

    public async run() {
        this.tickWrapper(1000 * 5, 1000 * 2, async () => {
            const orderBooks = await this.marketInfo.getLiveData();
            const upAsks = orderBooks.BtcUp.asks;
            const downAsks = orderBooks.BtcDown.asks;

            if (upAsks.length === 0 || downAsks.length === 0) {
                // Probably at end of run, literally no asks
                return;
            }

            // Find minimum ask price and size for BtcUp
            const minUpAsk = upAsks.reduce((min, ask) =>
                parseFloat(ask.price) < parseFloat(min.price) ? ask : min
                , upAsks[0]);

            // Find minimum ask price and size for BtcDown
            const minDownAsk = downAsks.reduce((min, ask) =>
                parseFloat(ask.price) < parseFloat(min.price) ? ask : min
                , downAsks[0]);

            const minUpPrice = parseFloat(minUpAsk.price);
            const minDownPrice = parseFloat(minDownAsk.price);
            const minUpSize = parseFloat(minUpAsk.size);
            const minDownSize = parseFloat(minDownAsk.size);

            const combinedPrice = minUpPrice + minDownPrice;

            const isArbitrage98 =  combinedPrice <= .98;

            if (isArbitrage98) {
                const maxSize = Math.min(minUpSize, minDownSize);
                this.writeLog(`Potential Order: ${maxSize}@[up=${minUpPrice}, down=${minDownPrice}, tot=${combinedPrice}]`)

                const [canSpendUp, canSpendDown] = await Promise.all([
                    this.canSpend(minUpPrice * maxSize),
                    this.canSpend(minDownPrice * maxSize),
                ]);
                const orderIsPossible = [
                    this.checkIfOrderIsValid(minUpPrice, maxSize),
                    this.checkIfOrderIsValid(minDownPrice, maxSize),
                    canSpendUp,
                    canSpendDown,
                ].every((r) => r === true);

                if (orderIsPossible) {
                    // Execute both orders in parallel
                    const result = await Promise.all([
                        this.makeOrder('btcUp', orderBooks.BtcUpTokenId, minUpPrice, maxSize, Side.BUY),
                        this.makeOrder('btcDown', orderBooks.BtcDownTokenId, minDownPrice, maxSize, Side.BUY),
                    ]);

                    if (result.some((r) => r === null)) {
                        this.writeError(`Order failed: ${result}`)
                    } else {
                        // all orders succeeded

                    }
                } else {
                    this.writeLog('Order cannot be made.. cancelling.')
                }

            }
        });
    }

}