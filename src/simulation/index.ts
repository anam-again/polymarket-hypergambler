import { Side } from '@polymarket/clob-client';
import {
    HistoricalSimulator,
    BotConfig,
    BotParams,
    SimulatedBot,
    SimulatedTrade,
} from './HistoricalSimulator.js';
import { SimulationClock } from './SimulationClock.js';
import { MockMarketInfo } from './MockMarketInfo.js';

// ============================================================================
// Simulated Bot Implementations
// ============================================================================

/**
 * Simple Contrarian Bot - bets opposite to recent trend
 */
function createContrarianBot(botParams: BotParams): SimulatedBot {
    const { name, clock, marketInfo, params } = botParams;

    const targetSize = (params.targetSize as number) ?? 10;
    const targetBuyPrice = (params.targetBuyPrice as number) ?? 0.50;
    const targetSellPrice = (params.targetSellPrice as number) ?? 0.60;
    const lookbackHours = (params.lookbackHours as number) ?? 3;
    const cutoffMinute = (params.cutoffMinute as number) ?? 30;

    const trades: SimulatedTrade[] = [];
    let currentBuyOrder: SimulatedTrade | null = null;
    let currentSellOrder: SimulatedTrade | null = null;
    let hasBetThisHour = false;

    const getHourWinner = async (hoursAgo: number): Promise<'UP' | 'DOWN' | null> => {
        const targetTime = clock.now() - (hoursAgo * 60 * 60 * 1000);
        return marketInfo.getHourWinner(targetTime);
    };

    const getMajorityDirection = async (): Promise<'UP' | 'DOWN' | 'TIE' | null> => {
        const results: ('UP' | 'DOWN')[] = [];

        for (let i = 1; i <= lookbackHours; i++) {
            const winner = await getHourWinner(i);
            if (!winner) return null;
            results.push(winner);
        }

        const upCount = results.filter(r => r === 'UP').length;
        const downCount = results.filter(r => r === 'DOWN').length;

        if (upCount > downCount) return 'UP';
        if (downCount > upCount) return 'DOWN';
        return 'TIE';
    };

    const checkOrderFill = async (order: SimulatedTrade): Promise<boolean> => {
        const currentPrice = await marketInfo.getPrice(order.tokenId, order.side);

        if (order.side === Side.BUY && currentPrice <= order.price) {
            return true;
        }
        if (order.side === Side.SELL && currentPrice >= order.price) {
            return true;
        }
        return false;
    };

    return {
        name,

        async onTick() {
            const minute = clock.getMinutes();

            // Check if buy order filled
            if (currentBuyOrder && currentBuyOrder.status === 'PENDING') {
                if (await checkOrderFill(currentBuyOrder)) {
                    currentBuyOrder.status = 'MATCHED';
                    currentBuyOrder.pnl = -(currentBuyOrder.price * currentBuyOrder.amount);
                }
            }

            // Check if sell order filled
            if (currentSellOrder && currentSellOrder.status === 'PENDING') {
                if (await checkOrderFill(currentSellOrder)) {
                    currentSellOrder.status = 'MATCHED';
                    currentSellOrder.pnl = currentSellOrder.price * currentSellOrder.amount;
                }
            }

            // Create sell order if buy was matched
            if (currentBuyOrder?.status === 'MATCHED' && !currentSellOrder) {
                currentSellOrder = {
                    timestamp: clock.now(),
                    botName: name,
                    side: Side.SELL,
                    tokenId: currentBuyOrder.tokenId,
                    price: targetSellPrice,
                    amount: targetSize,
                    status: 'PENDING',
                };
                trades.push(currentSellOrder);
            }

            // Cancel unfilled buys after cutoff
            if (minute >= cutoffMinute && currentBuyOrder?.status === 'PENDING') {
                currentBuyOrder.status = 'CANCELED';
                return;
            }

            // Skip if already bet this hour
            if (hasBetThisHour) return;

            // Determine bet direction
            const majority = await getMajorityDirection();
            if (!majority || majority === 'TIE') {
                hasBetThisHour = true;
                return;
            }

            const betDirection = majority === 'UP' ? 'DOWN' : 'UP';
            const liveData = await marketInfo.getLiveData();
            const tokenId = betDirection === 'UP' ? liveData.BtcUpTokenId : liveData.BtcDownTokenId;

            // Place buy order
            currentBuyOrder = {
                timestamp: clock.now(),
                botName: name,
                side: Side.BUY,
                tokenId,
                price: targetBuyPrice,
                amount: targetSize,
                status: 'PENDING',
            };
            trades.push(currentBuyOrder);
            hasBetThisHour = true;
        },

        async onHourChange() {
            // Expire pending orders
            if (currentBuyOrder?.status === 'PENDING') {
                currentBuyOrder.status = 'EXPIRED';
            }
            if (currentSellOrder?.status === 'PENDING') {
                currentSellOrder.status = 'EXPIRED';
            }

            // Settle matched buy that wasn't sold
            if (currentBuyOrder?.status === 'MATCHED' && (!currentSellOrder || currentSellOrder.status !== 'MATCHED')) {
                // Determine if we won (token went to 1) or lost (token went to 0)
                const hourWinner = marketInfo.getHourWinner(clock.now() - 30 * 60 * 1000);
                const isUpToken = currentBuyOrder.tokenId.startsWith('UP-');
                const won = (hourWinner === 'UP' && isUpToken) || (hourWinner === 'DOWN' && !isUpToken);

                const expiryTrade: SimulatedTrade = {
                    timestamp: clock.now(),
                    botName: name,
                    side: Side.BUY,
                    tokenId: currentBuyOrder.tokenId,
                    price: 0,
                    amount: currentBuyOrder.amount,
                    status: 'EXPIRED',
                    pnl: won ? currentBuyOrder.amount : 0,
                };
                trades.push(expiryTrade);
            }

            // Reset for next hour
            currentBuyOrder = null;
            currentSellOrder = null;
            hasBetThisHour = false;
        },

        getTrades() {
            return trades;
        },

        reset() {
            trades.length = 0;
            currentBuyOrder = null;
            currentSellOrder = null;
            hasBetThisHour = false;
        },
    };
}

/**
 * Trend Following Bot - bets with the recent trend
 */
function createTrendFollowingBot(botParams: BotParams): SimulatedBot {
    const { name, clock, marketInfo, params } = botParams;

    const targetSize = (params.targetSize as number) ?? 10;
    const targetBuyPrice = (params.targetBuyPrice as number) ?? 0.50;
    const lookbackHours = (params.lookbackHours as number) ?? 2;
    const cutoffMinute = (params.cutoffMinute as number) ?? 20;

    const trades: SimulatedTrade[] = [];
    let currentOrder: SimulatedTrade | null = null;
    let hasBetThisHour = false;

    return {
        name,

        async onTick() {
            const minute = clock.getMinutes();

            // Check order fill
            if (currentOrder?.status === 'PENDING') {
                const price = await marketInfo.getPrice(currentOrder.tokenId, currentOrder.side);
                if (price <= currentOrder.price) {
                    currentOrder.status = 'MATCHED';
                    currentOrder.pnl = -(currentOrder.price * currentOrder.amount);
                }
            }

            if (minute >= cutoffMinute && currentOrder?.status === 'PENDING') {
                currentOrder.status = 'CANCELED';
                return;
            }

            if (hasBetThisHour) return;

            // Get trend direction
            const results: ('UP' | 'DOWN')[] = [];
            for (let i = 1; i <= lookbackHours; i++) {
                const winner = marketInfo.getHourWinner(clock.now() - (i * 60 * 60 * 1000));
                if (winner) results.push(winner);
            }

            if (results.length < lookbackHours) {
                hasBetThisHour = true;
                return;
            }

            // Follow the trend (same direction as majority)
            const upCount = results.filter(r => r === 'UP').length;
            const betDirection = upCount > lookbackHours / 2 ? 'UP' : 'DOWN';

            const liveData = await marketInfo.getLiveData();
            const tokenId = betDirection === 'UP' ? liveData.BtcUpTokenId : liveData.BtcDownTokenId;

            currentOrder = {
                timestamp: clock.now(),
                botName: name,
                side: Side.BUY,
                tokenId,
                price: targetBuyPrice,
                amount: targetSize,
                status: 'PENDING',
            };
            trades.push(currentOrder);
            hasBetThisHour = true;
        },

        async onHourChange() {
            if (currentOrder?.status === 'PENDING') {
                currentOrder.status = 'EXPIRED';
            }

            if (currentOrder?.status === 'MATCHED') {
                const hourWinner = marketInfo.getHourWinner(clock.now() - 30 * 60 * 1000);
                const isUpToken = currentOrder.tokenId.startsWith('UP-');
                const won = (hourWinner === 'UP' && isUpToken) || (hourWinner === 'DOWN' && !isUpToken);

                const expiryTrade: SimulatedTrade = {
                    timestamp: clock.now(),
                    botName: name,
                    side: Side.BUY,
                    tokenId: currentOrder.tokenId,
                    price: 0,
                    amount: currentOrder.amount,
                    status: 'EXPIRED',
                    pnl: won ? currentOrder.amount : 0,
                };
                trades.push(expiryTrade);
            }

            currentOrder = null;
            hasBetThisHour = false;
        },

        getTrades() {
            return trades;
        },

        reset() {
            trades.length = 0;
            currentOrder = null;
            hasBetThisHour = false;
        },
    };
}

// ============================================================================
// Bot Configurations with Parameter Sweeps
// ============================================================================

const botConfigs: BotConfig[] = [
    {
        name: 'Contrarian',
        factory: createContrarianBot,
        parameterSets: [
            { targetSize: 10, targetBuyPrice: 0.48, targetSellPrice: 0.58, lookbackHours: 2, cutoffMinute: 25 },
            { targetSize: 10, targetBuyPrice: 0.48, targetSellPrice: 0.58, lookbackHours: 3, cutoffMinute: 25 },
            { targetSize: 10, targetBuyPrice: 0.48, targetSellPrice: 0.58, lookbackHours: 4, cutoffMinute: 25 },
            { targetSize: 10, targetBuyPrice: 0.50, targetSellPrice: 0.60, lookbackHours: 2, cutoffMinute: 30 },
            { targetSize: 10, targetBuyPrice: 0.50, targetSellPrice: 0.60, lookbackHours: 3, cutoffMinute: 30 },
            { targetSize: 10, targetBuyPrice: 0.50, targetSellPrice: 0.60, lookbackHours: 4, cutoffMinute: 30 },
            { targetSize: 10, targetBuyPrice: 0.52, targetSellPrice: 0.62, lookbackHours: 3, cutoffMinute: 35 },
            { targetSize: 10, targetBuyPrice: 0.45, targetSellPrice: 0.55, lookbackHours: 3, cutoffMinute: 20 },
        ],
    },
    {
        name: 'TrendFollowing',
        factory: createTrendFollowingBot,
        parameterSets: [
            { targetSize: 10, targetBuyPrice: 0.48, lookbackHours: 2, cutoffMinute: 20 },
            { targetSize: 10, targetBuyPrice: 0.48, lookbackHours: 3, cutoffMinute: 20 },
            { targetSize: 10, targetBuyPrice: 0.50, lookbackHours: 2, cutoffMinute: 25 },
            { targetSize: 10, targetBuyPrice: 0.50, lookbackHours: 3, cutoffMinute: 25 },
            { targetSize: 10, targetBuyPrice: 0.52, lookbackHours: 2, cutoffMinute: 30 },
            { targetSize: 10, targetBuyPrice: 0.52, lookbackHours: 3, cutoffMinute: 30 },
        ],
    },
];

// ============================================================================
// Main Entry Point
// ============================================================================

async function main() {
    console.log('');
    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║         HISTORICAL SIMULATION - Parameter Sweep            ║');
    console.log('╚════════════════════════════════════════════════════════════╝');

    // Parse command line arguments
    const args = process.argv.slice(2);
    let lookbackDays = 7; // Default

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--days' || args[i] === '-d') {
            lookbackDays = parseInt(args[i + 1]) || 7;
        }
    }

    console.log(`\nConfiguration:`);
    console.log(`  Lookback Days: ${lookbackDays}`);
    console.log(`  Bot Strategies: ${botConfigs.length}`);
    console.log(`  Total Parameter Sets: ${botConfigs.reduce((sum, b) => sum + b.parameterSets.length, 0)}`);

    // Create and run simulator
    const simulator = new HistoricalSimulator({
        lookbackDays,
        tickIntervalMs: 60 * 1000, // 1 minute ticks
    });

    try {
        const results = await simulator.runParameterSweep(botConfigs);
        simulator.printSummary(results);
    } catch (error) {
        console.error('\nSimulation failed:', error);
        process.exit(1);
    }

    console.log('\n✓ Simulation complete\n');
}

main();
