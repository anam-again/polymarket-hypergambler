import { QuantBotRun } from "../bots/QuantBot.js";
import { TargetedMarket } from "../types/interfaces.js";

/**
 * Formats milliseconds as a human-readable duration string.
 */
export function formatDuration(ms: number): string {
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.floor((ms % 60000) / 1000);
    return `${minutes}m ${seconds}s`;
}

/**
 * Calculates milliseconds until the next hour boundary.
 * @returns Milliseconds until the start of the next hour.
 */
export function getMsUntilNextHour(): number {
    const now = new Date();
    const nextHour = new Date(now);
    nextHour.setHours(now.getHours() + 1, 0, 0, 0);
    return nextHour.getTime() - now.getTime();
}

export function targetMarketToShortname(targetMarket: TargetedMarket): string {
    switch (targetMarket) {
        case TargetedMarket.BITCOIN_HOURLY:
            return 'btc';
        case TargetedMarket.BITCOIN_QUARTERLY:
            return 'btc15';
        case TargetedMarket.ETHEREUM_HOURLY:
            return 'eth';
        case TargetedMarket.ETHEREUM_QUARTERLY:
            return 'eth15';
        case TargetedMarket.SOLANA_HOURLY:
            return 'sol';
        case TargetedMarket.SOLANA_QUARTERLY:
            return 'sol15';
        case TargetedMarket.XRP_HOURLY:
            return 'xrp';
        case TargetedMarket.XRP_QUARTERLY:
            return 'xrp15';
    }
}

export function checkIfBotsHaveMatchingNames(quantBots: QuantBotRun[]) {
    const names =  new Set<string>();

    function botName(quantBot: QuantBotRun) {
        return `${quantBot.PROD_MODE ? 'prod' : 'test'}-${quantBot.name}`;
    }

    quantBots.forEach((bot) => {
        const name = botName(bot);
        if(names.has(name)) {
            throw Error(`Two bots of matching name found: ${name}`)
        } else {
            names.add(name);
        }
    })
}