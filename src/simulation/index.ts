import { Side } from '@polymarket/clob-client';
import {
    HistoricalSimulator,
    BotConfig,
    BotParams,
    SimulatedBot,
    SimulatedTrade,
    CoinType,
} from './HistoricalSimulator.js';
import { SimulationClock } from './SimulationClock.js';
import { MockMarketInfo } from './MockMarketInfo.js';
import { MockCDMarketData } from './MockCDMarketData.js';
import { createSimulatedBot, createMockClobClient, QuantBotSimulationAdapter } from './QuantBotSimulationAdapter.js';
import { TargetedMarket } from '../types/interfaces.js';
import { SimulatorLogger } from './SimulatorLogger.js';

// Re-export adapter utilities for external use
export { createSimulatedBot, createMockClobClient, QuantBotSimulationAdapter } from './QuantBotSimulationAdapter.js';

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Gets the minute within the current period.
 * For quarterly markets (15-min periods), returns minute % 15.
 * For hourly markets, returns the full minute (0-59).
 */
function getMinuteInPeriod(clock: SimulationClock, targetedMarket: TargetedMarket): number {
    const minute = clock.getMinutes();
    const isQuarterly = targetedMarket.toString().includes('QUARTERLY');
    return isQuarterly ? minute % 15 : minute;
}

/**
 * Checks if the current time is past the cutoff minute for the period.
 */
function isAfterCutoff(clock: SimulationClock, targetedMarket: TargetedMarket, cutoffMinute: number): boolean {
    return getMinuteInPeriod(clock, targetedMarket) >= cutoffMinute;
}

// ============================================================================
// Simulated Bot Implementations
// ============================================================================

/**
 * Simple Contrarian Bot - bets opposite to recent trend
 */
function createContrarianBot(botParams: BotParams): SimulatedBot {
    const { name, clock, marketInfo, params, targetedMarket } = botParams;

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
        const currentPrice = await marketInfo.getPrice(order.tokenId, order.side, targetedMarket);

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
            if (isAfterCutoff(clock, targetedMarket, cutoffMinute) && currentBuyOrder?.status === 'PENDING') {
                currentBuyOrder.status = 'CANCELED';
                return;
            }

            // Skip if already bet this period
            if (hasBetThisHour) return;

            // Determine bet direction
            const majority = await getMajorityDirection();
            if (!majority || majority === 'TIE') {
                hasBetThisHour = true;
                return;
            }

            const betDirection = majority === 'UP' ? 'DOWN' : 'UP';
            const liveData = await marketInfo.getLiveData(targetedMarket);
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
 * Trend Following Bot - Uses technical indicators for trend detection
 * Implements: Moving Average crossovers, ADX for trend strength, Donchian breakouts
 */
function createTrendFollowingBot(botParams: BotParams): SimulatedBot {
    const { name, clock, marketInfo, cdMarketData, params, targetedMarket } = botParams;

    // Parameters matching actual TrendFollowing bot
    const shortMaPeriod = (params.shortMaPeriod as number) ?? 5;
    const longMaPeriod = (params.longMaPeriod as number) ?? 20;
    const adxPeriod = (params.adxPeriod as number) ?? 14;
    const adxThreshold = (params.adxThreshold as number) ?? 25;
    const atrPeriod = (params.atrPeriod as number) ?? 14;
    const atrStopMultiple = (params.atrStopMultiple as number) ?? 2.0;
    const targetBuyPrice = (params.targetBuyPrice as number) ?? 0.50;
    const targetSellPrice = (params.targetSellPrice as number) ?? 0.60;
    const targetSize = (params.targetSize as number) ?? 10;
    const cutoffMinute = (params.cutoffMinute as number) ?? 30;

    type TradingState = 'WAITING_DATA' | 'MONITORING' | 'POSITION_OPEN' | 'PAST_CUTOFF';

    const trades: SimulatedTrade[] = [];
    const priceHistory: number[] = [];
    let state: TradingState = 'WAITING_DATA';
    let tradeDirection: 'UP' | 'DOWN' | null = null;
    let previousShortMa: number | null = null;
    let previousLongMa: number | null = null;
    let currentBuyOrder: SimulatedTrade | null = null;
    let currentSellOrder: SimulatedTrade | null = null;
    let entryPrice: number | null = null;

    // --- Technical Indicator Calculations ---

    const calculateSMA = (prices: number[], period: number): number => {
        const slice = prices.slice(-period);
        return slice.reduce((sum, p) => sum + p, 0) / slice.length;
    };

    const wilderSmooth = (values: number[], period: number): number => {
        if (values.length < period) return 0;
        let smooth = values.slice(0, period).reduce((a, b) => a + b, 0);
        for (let i = period; i < values.length; i++) {
            smooth = smooth - (smooth / period) + values[i];
        }
        return smooth / period;
    };

    const calculateADX = (prices: number[], period: number): number => {
        if (prices.length < period + 1) return 0;

        const trueRanges: number[] = [];
        const plusDMs: number[] = [];
        const minusDMs: number[] = [];

        for (let i = 1; i < prices.length; i++) {
            const current = prices[i];
            const prev = prices[i - 1];

            // True Range (simplified for single price series)
            const tr = Math.abs(current - prev);
            trueRanges.push(tr);

            // Directional Movement
            const upMove = current - prev;
            const downMove = prev - current;

            plusDMs.push(upMove > downMove && upMove > 0 ? upMove : 0);
            minusDMs.push(downMove > upMove && downMove > 0 ? downMove : 0);
        }

        const smoothTR = wilderSmooth(trueRanges, period);
        const smoothPlusDM = wilderSmooth(plusDMs, period);
        const smoothMinusDM = wilderSmooth(minusDMs, period);

        if (smoothTR === 0) return 0;

        const plusDI = (smoothPlusDM / smoothTR) * 100;
        const minusDI = (smoothMinusDM / smoothTR) * 100;
        const diSum = plusDI + minusDI;

        if (diSum === 0) return 0;
        return (Math.abs(plusDI - minusDI) / diSum) * 100;
    };

    const calculateDonchian = (prices: number[], period: number): { high: number; low: number } => {
        const slice = prices.slice(-period);
        return {
            high: Math.max(...slice),
            low: Math.min(...slice),
        };
    };

    const calculateATR = (prices: number[], period: number): number => {
        if (prices.length < period + 1) return 0;

        const trueRanges: number[] = [];

        for (let i = 1; i < prices.length; i++) {
            const current = prices[i];
            const previous = prices[i - 1];
            // Simplified TR for single-price series
            const tr = Math.abs(current - previous);
            trueRanges.push(tr);
        }

        // Simple average of recent TRs
        const recentTRs = trueRanges.slice(-period);
        return recentTRs.reduce((a, b) => a + b, 0) / recentTRs.length;
    };

    const calculateIndicators = () => {
        const requiredPeriods = Math.max(longMaPeriod, adxPeriod, atrPeriod) + 10;
        if (priceHistory.length < requiredPeriods) return null;

        const prices = priceHistory.slice(-requiredPeriods);
        const currentPrice = prices[prices.length - 1];

        const shortMa = calculateSMA(prices, shortMaPeriod);
        const longMa = calculateSMA(prices, longMaPeriod);
        const adx = calculateADX(prices, adxPeriod);
        const atr = calculateATR(prices, atrPeriod);
        const donchian = calculateDonchian(prices, longMaPeriod);

        return { shortMa, longMa, adx, atr, currentPrice, donchianHigh: donchian.high, donchianLow: donchian.low };
    };

    const detectCrossover = (shortMa: number, longMa: number): 'GOLDEN_CROSS' | 'DEATH_CROSS' | 'NONE' => {
        if (previousShortMa === null || previousLongMa === null) return 'NONE';

        const prevShortAboveLong = previousShortMa > previousLongMa;
        const currShortAboveLong = shortMa > longMa;

        if (!prevShortAboveLong && currShortAboveLong) return 'GOLDEN_CROSS';
        if (prevShortAboveLong && !currShortAboveLong) return 'DEATH_CROSS';
        return 'NONE';
    };

    const checkOrderFill = async (order: SimulatedTrade): Promise<boolean> => {
        const currentPrice = await marketInfo.getPrice(order.tokenId, order.side, targetedMarket);
        if (order.side === Side.BUY && currentPrice <= order.price) return true;
        if (order.side === Side.SELL && currentPrice >= order.price) return true;
        return false;
    };

    const resetState = () => {
        // DON'T clear priceHistory - indicators need continuous historical data across periods
        // priceHistory.length = 0;
        state = 'WAITING_DATA';
        tradeDirection = null;
        previousShortMa = null;
        previousLongMa = null;
        currentBuyOrder = null;
        currentSellOrder = null;
        entryPrice = null;
    };

    return {
        name,

        async onTick() {
            const minute = clock.getMinutes();
            const btcPrice = await cdMarketData.getCurrentPrice();

            // Build price history
            priceHistory.push(btcPrice);
            if (priceHistory.length > (longMaPeriod + adxPeriod) * 2) {
                priceHistory.shift();
            }

            // Check order fills
            if (currentBuyOrder?.status === 'PENDING' && await checkOrderFill(currentBuyOrder)) {
                currentBuyOrder.status = 'MATCHED';
                currentBuyOrder.pnl = -(currentBuyOrder.price * currentBuyOrder.amount);

                // Create sell order
                if (!currentSellOrder && tradeDirection) {
                    const liveData = await marketInfo.getLiveData(targetedMarket);
                    const tokenId = tradeDirection === 'UP' ? liveData.BtcUpTokenId : liveData.BtcDownTokenId;
                    currentSellOrder = {
                        timestamp: clock.now(),
                        botName: name,
                        side: Side.SELL,
                        tokenId,
                        price: targetSellPrice,
                        amount: targetSize,
                        status: 'PENDING',
                    };
                    trades.push(currentSellOrder);
                }
            }

            if (currentSellOrder?.status === 'PENDING' && await checkOrderFill(currentSellOrder)) {
                currentSellOrder.status = 'MATCHED';
                currentSellOrder.pnl = currentSellOrder.price * currentSellOrder.amount;
            }

            // Handle cutoff
            if (isAfterCutoff(clock, targetedMarket, cutoffMinute) && state !== 'POSITION_OPEN') {
                if (currentBuyOrder?.status === 'PENDING') currentBuyOrder.status = 'CANCELED';
                state = 'PAST_CUTOFF';
                return;
            }

            if (state === 'PAST_CUTOFF') return;

            // Calculate indicators
            const indicators = calculateIndicators();
            if (!indicators) {
                state = 'WAITING_DATA';
                return;
            }

            const { shortMa, longMa, adx, atr, currentPrice, donchianHigh, donchianLow } = indicators;

            // Handle POSITION_OPEN state - monitor for ATR-based stop-loss
            if (state === 'POSITION_OPEN') {
                if (entryPrice !== null && atr > 0) {
                    const stopDistance = atr * atrStopMultiple;

                    // Check if price moved against our position beyond ATR stop
                    const priceAgainstPosition = tradeDirection === 'UP'
                        ? currentPrice < entryPrice - stopDistance
                        : currentPrice > entryPrice + stopDistance;

                    // Also check for trend reversal (MAs crossed against position)
                    const trendReversed = tradeDirection === 'UP'
                        ? shortMa < longMa
                        : shortMa > longMa;

                    // If stop hit and trend reversed, cancel pending buy
                    if (priceAgainstPosition && trendReversed && currentBuyOrder?.status === 'PENDING') {
                        currentBuyOrder.status = 'CANCELED';
                        state = 'PAST_CUTOFF';  // Stop trading for this period
                    }
                }

                // Update previous MAs even in position
                previousShortMa = shortMa;
                previousLongMa = longMa;
                return;
            }

            if (state === 'WAITING_DATA') {
                state = 'MONITORING';
                previousShortMa = shortMa;
                previousLongMa = longMa;
                return;
            }

            // Check for entry signals
            const signal = detectCrossover(shortMa, longMa);
            const trendStrong = adx >= adxThreshold;

            let shouldEnter = false;
            let direction: 'UP' | 'DOWN' | null = null;

            // MA Crossover signals
            if (signal === 'GOLDEN_CROSS' && trendStrong) {
                shouldEnter = true;
                direction = 'UP';
            } else if (signal === 'DEATH_CROSS' && trendStrong) {
                shouldEnter = true;
                direction = 'DOWN';
            }

            // Donchian breakout signals (if no crossover)
            if (!shouldEnter && trendStrong) {
                if (currentPrice >= donchianHigh && shortMa > longMa) {
                    shouldEnter = true;
                    direction = 'UP';
                } else if (currentPrice <= donchianLow && shortMa < longMa) {
                    shouldEnter = true;
                    direction = 'DOWN';
                }
            }

            // Enter trade
            if (shouldEnter && direction && !currentBuyOrder) {
                tradeDirection = direction;
                entryPrice = currentPrice;  // Track entry price for ATR stop-loss
                const liveData = await marketInfo.getLiveData(targetedMarket);
                const tokenId = direction === 'UP' ? liveData.BtcUpTokenId : liveData.BtcDownTokenId;

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
                state = 'POSITION_OPEN';
            }

            // Update previous MAs
            previousShortMa = shortMa;
            previousLongMa = longMa;
        },

        async onHourChange() {
            if (currentBuyOrder?.status === 'PENDING') currentBuyOrder.status = 'EXPIRED';
            if (currentSellOrder?.status === 'PENDING') currentSellOrder.status = 'EXPIRED';

            if (currentBuyOrder?.status === 'MATCHED' && (!currentSellOrder || currentSellOrder.status !== 'MATCHED')) {
                const hourWinner = marketInfo.getHourWinner(clock.now() - 30 * 60 * 1000);
                const isUpToken = currentBuyOrder.tokenId.startsWith('UP-');
                const won = (hourWinner === 'UP' && isUpToken) || (hourWinner === 'DOWN' && !isUpToken);

                trades.push({
                    timestamp: clock.now(),
                    botName: name,
                    side: Side.BUY,
                    tokenId: currentBuyOrder.tokenId,
                    price: 0,
                    amount: currentBuyOrder.amount,
                    status: 'EXPIRED',
                    pnl: won ? currentBuyOrder.amount : 0,
                });
            }

            resetState();
        },

        getTrades() {
            return trades;
        },

        reset() {
            trades.length = 0;
            resetState();
        },
    };
}

/**
 * FirstCandle Bot - Breakout pullback strategy based on BTC price action
 * Forms a candle during first N minutes, waits for breakout, then pullback confirmation
 */
function createFirstCandleBot(botParams: BotParams): SimulatedBot {
    const { name, clock, marketInfo, cdMarketData, params, targetedMarket } = botParams;

    const candleMinutes = (params.candleMinutes as number) ?? 15;
    const breakoutBuffer = (params.breakoutBuffer as number) ?? 50;
    const pullbackBuffer = (params.pullbackBuffer as number) ?? 100;
    const targetBuyPrice = (params.targetBuyPrice as number) ?? 0.50;
    const targetSellPrice = (params.targetSellPrice as number) ?? 0.60;
    const targetSize = (params.targetSize as number) ?? 10;
    const cutoffMinute = (params.cutoffMinute as number) ?? 45;

    type TradingState = 'FORMING_CANDLE' | 'WAITING_BREAKOUT' | 'WAITING_PULLBACK' | 'TRADE_ENTERED' | 'PAST_CUTOFF';

    const trades: SimulatedTrade[] = [];
    let state: TradingState = 'FORMING_CANDLE';
    let candleHigh = 0;
    let candleLow = Infinity;
    let breakoutDirection: 'UP' | 'DOWN' | null = null;
    let breakoutConfirmedPrice: number | null = null;
    let currentBuyOrder: SimulatedTrade | null = null;
    let currentSellOrder: SimulatedTrade | null = null;

    const resetState = () => {
        state = 'FORMING_CANDLE';
        candleHigh = 0;
        candleLow = Infinity;
        breakoutDirection = null;
        breakoutConfirmedPrice = null;
        currentBuyOrder = null;
        currentSellOrder = null;
    };

    const checkOrderFill = async (order: SimulatedTrade): Promise<boolean> => {
        const currentPrice = await marketInfo.getPrice(order.tokenId, order.side, targetedMarket);
        if (order.side === Side.BUY && currentPrice <= order.price) return true;
        if (order.side === Side.SELL && currentPrice >= order.price) return true;
        return false;
    };

    return {
        name,

        async onTick() {
            const rawMinute = clock.getMinutes();
            const isQuarterlyMarket = targetedMarket.includes('Quarterly');
            const minute = isQuarterlyMarket ? rawMinute % 15 : rawMinute;
            const btcPrice = await cdMarketData.getCurrentPrice();

            // Check buy order fill
            if (currentBuyOrder?.status === 'PENDING') {
                if (await checkOrderFill(currentBuyOrder)) {
                    currentBuyOrder.status = 'MATCHED';
                    currentBuyOrder.pnl = -(currentBuyOrder.price * currentBuyOrder.amount);

                    // Create sell order
                    if (!currentSellOrder && breakoutDirection) {
                        const liveData = await marketInfo.getLiveData(targetedMarket);
                        const tokenId = breakoutDirection === 'UP' ? liveData.BtcUpTokenId : liveData.BtcDownTokenId;
                        currentSellOrder = {
                            timestamp: clock.now(),
                            botName: name,
                            side: Side.SELL,
                            tokenId,
                            price: targetSellPrice,
                            amount: targetSize,
                            status: 'PENDING',
                        };
                        trades.push(currentSellOrder);
                    }
                }
            }

            // Check sell order fill
            if (currentSellOrder?.status === 'PENDING') {
                if (await checkOrderFill(currentSellOrder)) {
                    currentSellOrder.status = 'MATCHED';
                    currentSellOrder.pnl = currentSellOrder.price * currentSellOrder.amount;
                }
            }

            // Handle cutoff
            if (isAfterCutoff(clock, targetedMarket, cutoffMinute) && state !== 'TRADE_ENTERED') {
                if (currentBuyOrder?.status === 'PENDING') {
                    currentBuyOrder.status = 'CANCELED';
                }
                state = 'PAST_CUTOFF';
                return;
            }

            if (state === 'PAST_CUTOFF' || state === 'TRADE_ENTERED') return;

            // State machine
            switch (state) {
                case 'FORMING_CANDLE':
                    candleHigh = Math.max(candleHigh, btcPrice);
                    candleLow = Math.min(candleLow, btcPrice);
                    if (minute >= candleMinutes) {
                        state = 'WAITING_BREAKOUT';
                    }
                    break;

                case 'WAITING_BREAKOUT':
                    if (btcPrice > candleHigh + breakoutBuffer) {
                        breakoutDirection = 'UP';
                        breakoutConfirmedPrice = candleHigh;
                        state = 'WAITING_PULLBACK';
                    } else if (btcPrice < candleLow - breakoutBuffer) {
                        breakoutDirection = 'DOWN';
                        breakoutConfirmedPrice = candleLow;
                        state = 'WAITING_PULLBACK';
                    }
                    break;

                case 'WAITING_PULLBACK':
                    if (breakoutDirection && breakoutConfirmedPrice) {
                        let isPullbackConfirmed = false;

                        if (breakoutDirection === 'UP') {
                            const pullbackToSupport = Math.abs(btcPrice - breakoutConfirmedPrice) <= pullbackBuffer;
                            const stillAboveSupport = btcPrice >= breakoutConfirmedPrice;
                            isPullbackConfirmed = pullbackToSupport && stillAboveSupport;
                        } else {
                            const pullbackToResistance = Math.abs(btcPrice - breakoutConfirmedPrice) <= pullbackBuffer;
                            const stillBelowResistance = btcPrice <= breakoutConfirmedPrice;
                            isPullbackConfirmed = pullbackToResistance && stillBelowResistance;
                        }

                        if (isPullbackConfirmed) {
                            const liveData = await marketInfo.getLiveData(targetedMarket);
                            const tokenId = breakoutDirection === 'UP' ? liveData.BtcUpTokenId : liveData.BtcDownTokenId;

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
                            state = 'TRADE_ENTERED';
                        }
                    }
                    break;
            }
        },

        async onHourChange() {
            // Expire pending orders
            if (currentBuyOrder?.status === 'PENDING') currentBuyOrder.status = 'EXPIRED';
            if (currentSellOrder?.status === 'PENDING') currentSellOrder.status = 'EXPIRED';

            // Settle matched buy that wasn't sold
            if (currentBuyOrder?.status === 'MATCHED' && (!currentSellOrder || currentSellOrder.status !== 'MATCHED')) {
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

            resetState();
        },

        getTrades() {
            return trades;
        },

        reset() {
            trades.length = 0;
            resetState();
        },
    };
}

/**
 * FirstCandleV2 Bot - Same as FirstCandle but with dynamic pricing based on market
 */
function createFirstCandleV2Bot(botParams: BotParams): SimulatedBot {
    const { name, clock, marketInfo, cdMarketData, params, targetedMarket } = botParams;

    const candleMinutes = (params.candleMinutes as number) ?? 15;
    const breakoutBuffer = (params.breakoutBuffer as number) ?? 50;
    const pullbackBuffer = (params.pullbackBuffer as number) ?? 100;
    const buyPriceBuffer = (params.buyPriceBuffer as number) ?? 0.02;
    const sellPriceBuffer = (params.sellPriceBuffer as number) ?? 0.02;
    const minProfitMargin = (params.minProfitMargin as number) ?? 0.05;
    const maxSellPrice = (params.maxSellPrice as number) ?? 0.95;  // MAX_SELL_PRICE
    const targetSize = (params.targetSize as number) ?? 10;
    const cutoffMinute = (params.cutoffMinute as number) ?? 45;

    type TradingState = 'FORMING_CANDLE' | 'WAITING_BREAKOUT' | 'WAITING_PULLBACK' | 'TRADE_ENTERED' | 'PAST_CUTOFF';

    const trades: SimulatedTrade[] = [];
    let state: TradingState = 'FORMING_CANDLE';
    let candleHigh = 0;
    let candleLow = Infinity;
    let breakoutDirection: 'UP' | 'DOWN' | null = null;
    let breakoutConfirmedPrice: number | null = null;
    let currentBuyOrder: SimulatedTrade | null = null;
    let currentSellOrder: SimulatedTrade | null = null;
    let actualBuyPrice: number | null = null;

    const resetState = () => {
        state = 'FORMING_CANDLE';
        candleHigh = 0;
        candleLow = Infinity;
        breakoutDirection = null;
        breakoutConfirmedPrice = null;
        currentBuyOrder = null;
        currentSellOrder = null;
        actualBuyPrice = null;
    };

    const checkOrderFill = async (order: SimulatedTrade): Promise<boolean> => {
        const currentPrice = await marketInfo.getPrice(order.tokenId, order.side, targetedMarket);
        if (order.side === Side.BUY && currentPrice <= order.price) return true;
        if (order.side === Side.SELL && currentPrice >= order.price) return true;
        return false;
    };

    return {
        name,

        async onTick() {
            const rawMinute = clock.getMinutes();
            const isQuarterlyMarket = targetedMarket.includes('Quarterly');
            const minute = isQuarterlyMarket ? rawMinute % 15 : rawMinute;
            const btcPrice = await cdMarketData.getCurrentPrice();

            // Check buy order fill
            if (currentBuyOrder?.status === 'PENDING') {
                if (await checkOrderFill(currentBuyOrder)) {
                    currentBuyOrder.status = 'MATCHED';
                    currentBuyOrder.pnl = -(currentBuyOrder.price * currentBuyOrder.amount);

                    // Create sell order with dynamic pricing
                    if (!currentSellOrder && breakoutDirection && actualBuyPrice) {
                        const liveData = await marketInfo.getLiveData(targetedMarket);
                        const tokenId = breakoutDirection === 'UP' ? liveData.BtcUpTokenId : liveData.BtcDownTokenId;

                        const currentBidPrice = await marketInfo.getPrice(tokenId, Side.SELL, targetedMarket);
                        const marketSellPrice = Math.round((currentBidPrice - sellPriceBuffer) * 100) / 100;
                        const minSellPrice = Math.round((actualBuyPrice + minProfitMargin) * 100) / 100;
                        // Cap at maxSellPrice (MAX_SELL_PRICE)
                        const dynamicSellPrice = Math.min(Math.max(marketSellPrice, minSellPrice), maxSellPrice);

                        currentSellOrder = {
                            timestamp: clock.now(),
                            botName: name,
                            side: Side.SELL,
                            tokenId,
                            price: dynamicSellPrice,
                            amount: targetSize,
                            status: 'PENDING',
                        };
                        trades.push(currentSellOrder);
                    }
                }
            }

            // Check sell order fill
            if (currentSellOrder?.status === 'PENDING') {
                if (await checkOrderFill(currentSellOrder)) {
                    currentSellOrder.status = 'MATCHED';
                    currentSellOrder.pnl = currentSellOrder.price * currentSellOrder.amount;
                }
            }

            // Handle cutoff
            if (isAfterCutoff(clock, targetedMarket, cutoffMinute) && state !== 'TRADE_ENTERED') {
                if (currentBuyOrder?.status === 'PENDING') {
                    currentBuyOrder.status = 'CANCELED';
                }
                state = 'PAST_CUTOFF';
                return;
            }

            if (state === 'PAST_CUTOFF' || state === 'TRADE_ENTERED') return;

            // State machine
            switch (state) {
                case 'FORMING_CANDLE':
                    candleHigh = Math.max(candleHigh, btcPrice);
                    candleLow = Math.min(candleLow, btcPrice);
                    if (minute >= candleMinutes) {
                        state = 'WAITING_BREAKOUT';
                    }
                    break;

                case 'WAITING_BREAKOUT':
                    if (btcPrice > candleHigh + breakoutBuffer) {
                        breakoutDirection = 'UP';
                        breakoutConfirmedPrice = candleHigh;
                        state = 'WAITING_PULLBACK';
                    } else if (btcPrice < candleLow - breakoutBuffer) {
                        breakoutDirection = 'DOWN';
                        breakoutConfirmedPrice = candleLow;
                        state = 'WAITING_PULLBACK';
                    }
                    break;

                case 'WAITING_PULLBACK':
                    if (breakoutDirection && breakoutConfirmedPrice) {
                        let isPullbackConfirmed = false;

                        if (breakoutDirection === 'UP') {
                            const pullbackToSupport = Math.abs(btcPrice - breakoutConfirmedPrice) <= pullbackBuffer;
                            const stillAboveSupport = btcPrice >= breakoutConfirmedPrice;
                            isPullbackConfirmed = pullbackToSupport && stillAboveSupport;
                        } else {
                            const pullbackToResistance = Math.abs(btcPrice - breakoutConfirmedPrice) <= pullbackBuffer;
                            const stillBelowResistance = btcPrice <= breakoutConfirmedPrice;
                            isPullbackConfirmed = pullbackToResistance && stillBelowResistance;
                        }

                        if (isPullbackConfirmed) {
                            const liveData = await marketInfo.getLiveData(targetedMarket);
                            const tokenId = breakoutDirection === 'UP' ? liveData.BtcUpTokenId : liveData.BtcDownTokenId;

                            // Dynamic buy price based on current ask
                            const currentAskPrice = await marketInfo.getPrice(tokenId, Side.BUY, targetedMarket);
                            const dynamicBuyPrice = Math.round((currentAskPrice + buyPriceBuffer) * 100) / 100;
                            actualBuyPrice = dynamicBuyPrice;

                            currentBuyOrder = {
                                timestamp: clock.now(),
                                botName: name,
                                side: Side.BUY,
                                tokenId,
                                price: dynamicBuyPrice,
                                amount: targetSize,
                                status: 'PENDING',
                            };
                            trades.push(currentBuyOrder);
                            state = 'TRADE_ENTERED';
                        }
                    }
                    break;
            }
        },

        async onHourChange() {
            // Expire pending orders
            if (currentBuyOrder?.status === 'PENDING') currentBuyOrder.status = 'EXPIRED';
            if (currentSellOrder?.status === 'PENDING') currentSellOrder.status = 'EXPIRED';

            // Settle matched buy that wasn't sold
            if (currentBuyOrder?.status === 'MATCHED' && (!currentSellOrder || currentSellOrder.status !== 'MATCHED')) {
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

            resetState();
        },

        getTrades() {
            return trades;
        },

        reset() {
            trades.length = 0;
            resetState();
        },
    };
}

/**
 * EveningStar Bot - Bearish reversal candlestick pattern
 * Candle 1: Bullish, Candle 2: Indecision, Candle 3: Bearish -> Buy DOWN
 */
function createEveningStarBot(botParams: BotParams): SimulatedBot {
    const { name, clock, marketInfo, cdMarketData, params, targetedMarket } = botParams;

    const candleMinutes = (params.candleMinutes as number) ?? 10;
    const minBullishMove = (params.minBullishMove as number) ?? 50;
    const maxIndecisionRange = (params.maxIndecisionRange as number) ?? 30;
    const minBearishMove = (params.minBearishMove as number) ?? 50;
    const targetBuyPrice = (params.targetBuyPrice as number) ?? 0.50;
    const targetSellPrice = (params.targetSellPrice as number) ?? 0.60;
    const targetSize = (params.targetSize as number) ?? 10;
    const cutoffMinute = (params.cutoffMinute as number) ?? 45;

    interface Candle {
        open: number;
        close: number;
        high: number;
        low: number;
        startMinute: number;
    }

    type TradingState = 'FORMING_CANDLE_1' | 'FORMING_CANDLE_2' | 'FORMING_CANDLE_3' | 'PATTERN_DETECTED' | 'TRADE_ENTERED' | 'PAST_CUTOFF';

    const trades: SimulatedTrade[] = [];
    let state: TradingState = 'FORMING_CANDLE_1';
    let candle1: Candle | null = null;
    let candle2: Candle | null = null;
    let currentCandle: Candle | null = null;
    let lastCandleIndex = -1;
    let currentBuyOrder: SimulatedTrade | null = null;
    let currentSellOrder: SimulatedTrade | null = null;

    const resetState = () => {
        state = 'FORMING_CANDLE_1';
        candle1 = null;
        candle2 = null;
        currentCandle = null;
        lastCandleIndex = -1;
        currentBuyOrder = null;
        currentSellOrder = null;
    };

    const getCandleIndex = (minute: number) => Math.floor(minute / candleMinutes);

    const checkOrderFill = async (order: SimulatedTrade): Promise<boolean> => {
        const currentPrice = await marketInfo.getPrice(order.tokenId, order.side, targetedMarket);
        if (order.side === Side.BUY && currentPrice <= order.price) return true;
        if (order.side === Side.SELL && currentPrice >= order.price) return true;
        return false;
    };

    return {
        name,

        async onTick() {
            const minute = clock.getMinutes();
            const candleIndex = getCandleIndex(minute);
            const btcPrice = await cdMarketData.getCurrentPrice();

            // Check order fills
            if (currentBuyOrder?.status === 'PENDING' && await checkOrderFill(currentBuyOrder)) {
                currentBuyOrder.status = 'MATCHED';
                currentBuyOrder.pnl = -(currentBuyOrder.price * currentBuyOrder.amount);

                if (!currentSellOrder) {
                    const liveData = await marketInfo.getLiveData(targetedMarket);
                    currentSellOrder = {
                        timestamp: clock.now(),
                        botName: name,
                        side: Side.SELL,
                        tokenId: liveData.BtcDownTokenId,
                        price: targetSellPrice,
                        amount: targetSize,
                        status: 'PENDING',
                    };
                    trades.push(currentSellOrder);
                }
            }

            if (currentSellOrder?.status === 'PENDING' && await checkOrderFill(currentSellOrder)) {
                currentSellOrder.status = 'MATCHED';
                currentSellOrder.pnl = currentSellOrder.price * currentSellOrder.amount;
            }

            // Handle cutoff
            if (isAfterCutoff(clock, targetedMarket, cutoffMinute) && state !== 'TRADE_ENTERED') {
                if (currentBuyOrder?.status === 'PENDING') currentBuyOrder.status = 'CANCELED';
                state = 'PAST_CUTOFF';
                return;
            }

            if (state === 'PAST_CUTOFF' || state === 'TRADE_ENTERED') return;

            // Candle management
            if (candleIndex !== lastCandleIndex) {
                // Finalize previous candle
                if (currentCandle && state !== 'PATTERN_DETECTED') {
                    const priceChange = currentCandle.close - currentCandle.open;
                    const candleRange = currentCandle.high - currentCandle.low;

                    if (state === 'FORMING_CANDLE_1' && priceChange >= minBullishMove) {
                        candle1 = { ...currentCandle };
                        state = 'FORMING_CANDLE_2';
                    } else if (state === 'FORMING_CANDLE_2' && candle1 && candleRange <= maxIndecisionRange) {
                        candle2 = { ...currentCandle };
                        state = 'FORMING_CANDLE_3';
                    } else if (state === 'FORMING_CANDLE_3' && candle1 && candle2) {
                        const firstCandleMidpoint = (candle1.open + candle1.close) / 2;
                        if (priceChange <= -minBearishMove && currentCandle.close < firstCandleMidpoint) {
                            state = 'PATTERN_DETECTED';
                        } else {
                            state = 'FORMING_CANDLE_1';
                            candle1 = null;
                            candle2 = null;
                        }
                    } else if (state === 'FORMING_CANDLE_2' || state === 'FORMING_CANDLE_3') {
                        state = 'FORMING_CANDLE_1';
                        candle1 = null;
                        candle2 = null;
                    }
                }

                // Start new candle
                currentCandle = { open: btcPrice, close: btcPrice, high: btcPrice, low: btcPrice, startMinute: minute };
                lastCandleIndex = candleIndex;
            }

            // Update current candle
            if (currentCandle) {
                currentCandle.close = btcPrice;
                currentCandle.high = Math.max(currentCandle.high, btcPrice);
                currentCandle.low = Math.min(currentCandle.low, btcPrice);
            }

            // Create buy order when pattern detected
            if (state === 'PATTERN_DETECTED' && !currentBuyOrder) {
                const liveData = await marketInfo.getLiveData(targetedMarket);
                currentBuyOrder = {
                    timestamp: clock.now(),
                    botName: name,
                    side: Side.BUY,
                    tokenId: liveData.BtcDownTokenId,  // Evening Star = bearish = buy DOWN
                    price: targetBuyPrice,
                    amount: targetSize,
                    status: 'PENDING',
                };
                trades.push(currentBuyOrder);
                state = 'TRADE_ENTERED';
            }
        },

        async onHourChange() {
            if (currentBuyOrder?.status === 'PENDING') currentBuyOrder.status = 'EXPIRED';
            if (currentSellOrder?.status === 'PENDING') currentSellOrder.status = 'EXPIRED';

            if (currentBuyOrder?.status === 'MATCHED' && (!currentSellOrder || currentSellOrder.status !== 'MATCHED')) {
                const hourWinner = marketInfo.getHourWinner(clock.now() - 30 * 60 * 1000);
                const isDownToken = currentBuyOrder.tokenId.includes('DOWN');
                const won = (hourWinner === 'DOWN' && isDownToken) || (hourWinner === 'UP' && !isDownToken);

                trades.push({
                    timestamp: clock.now(),
                    botName: name,
                    side: Side.BUY,
                    tokenId: currentBuyOrder.tokenId,
                    price: 0,
                    amount: currentBuyOrder.amount,
                    status: 'EXPIRED',
                    pnl: won ? currentBuyOrder.amount : 0,
                });
            }

            resetState();
        },

        getTrades() { return trades; },
        reset() { trades.length = 0; resetState(); },
    };
}

/**
 * MorningStar Bot - Bullish reversal candlestick pattern
 * Candle 1: Bearish, Candle 2: Indecision, Candle 3: Bullish -> Buy UP
 */
function createMorningStarBot(botParams: BotParams): SimulatedBot {
    const { name, clock, marketInfo, cdMarketData, params, targetedMarket } = botParams;

    const candleMinutes = (params.candleMinutes as number) ?? 10;
    const minBearishMove = (params.minBearishMove as number) ?? 50;
    const maxIndecisionRange = (params.maxIndecisionRange as number) ?? 30;
    const minBullishMove = (params.minBullishMove as number) ?? 50;
    const targetBuyPrice = (params.targetBuyPrice as number) ?? 0.50;
    const targetSellPrice = (params.targetSellPrice as number) ?? 0.60;
    const targetSize = (params.targetSize as number) ?? 10;
    const cutoffMinute = (params.cutoffMinute as number) ?? 45;

    interface Candle {
        open: number;
        close: number;
        high: number;
        low: number;
        startMinute: number;
    }

    type TradingState = 'FORMING_CANDLE_1' | 'FORMING_CANDLE_2' | 'FORMING_CANDLE_3' | 'PATTERN_DETECTED' | 'TRADE_ENTERED' | 'PAST_CUTOFF';

    const trades: SimulatedTrade[] = [];
    let state: TradingState = 'FORMING_CANDLE_1';
    let candle1: Candle | null = null;
    let candle2: Candle | null = null;
    let currentCandle: Candle | null = null;
    let lastCandleIndex = -1;
    let currentBuyOrder: SimulatedTrade | null = null;
    let currentSellOrder: SimulatedTrade | null = null;

    const resetState = () => {
        state = 'FORMING_CANDLE_1';
        candle1 = null;
        candle2 = null;
        currentCandle = null;
        lastCandleIndex = -1;
        currentBuyOrder = null;
        currentSellOrder = null;
    };

    const getCandleIndex = (minute: number) => Math.floor(minute / candleMinutes);

    const checkOrderFill = async (order: SimulatedTrade): Promise<boolean> => {
        const currentPrice = await marketInfo.getPrice(order.tokenId, order.side, targetedMarket);
        if (order.side === Side.BUY && currentPrice <= order.price) return true;
        if (order.side === Side.SELL && currentPrice >= order.price) return true;
        return false;
    };

    return {
        name,

        async onTick() {
            const minute = clock.getMinutes();
            const candleIndex = getCandleIndex(minute);
            const btcPrice = await cdMarketData.getCurrentPrice();

            // Check order fills
            if (currentBuyOrder?.status === 'PENDING' && await checkOrderFill(currentBuyOrder)) {
                currentBuyOrder.status = 'MATCHED';
                currentBuyOrder.pnl = -(currentBuyOrder.price * currentBuyOrder.amount);

                if (!currentSellOrder) {
                    const liveData = await marketInfo.getLiveData(targetedMarket);
                    currentSellOrder = {
                        timestamp: clock.now(),
                        botName: name,
                        side: Side.SELL,
                        tokenId: liveData.BtcUpTokenId,
                        price: targetSellPrice,
                        amount: targetSize,
                        status: 'PENDING',
                    };
                    trades.push(currentSellOrder);
                }
            }

            if (currentSellOrder?.status === 'PENDING' && await checkOrderFill(currentSellOrder)) {
                currentSellOrder.status = 'MATCHED';
                currentSellOrder.pnl = currentSellOrder.price * currentSellOrder.amount;
            }

            // Handle cutoff
            if (isAfterCutoff(clock, targetedMarket, cutoffMinute) && state !== 'TRADE_ENTERED') {
                if (currentBuyOrder?.status === 'PENDING') currentBuyOrder.status = 'CANCELED';
                state = 'PAST_CUTOFF';
                return;
            }

            if (state === 'PAST_CUTOFF' || state === 'TRADE_ENTERED') return;

            // Candle management
            if (candleIndex !== lastCandleIndex) {
                // Finalize previous candle
                if (currentCandle && state !== 'PATTERN_DETECTED') {
                    const priceChange = currentCandle.close - currentCandle.open;
                    const candleRange = currentCandle.high - currentCandle.low;

                    if (state === 'FORMING_CANDLE_1' && priceChange <= -minBearishMove) {
                        candle1 = { ...currentCandle };
                        state = 'FORMING_CANDLE_2';
                    } else if (state === 'FORMING_CANDLE_2' && candle1 && candleRange <= maxIndecisionRange) {
                        candle2 = { ...currentCandle };
                        state = 'FORMING_CANDLE_3';
                    } else if (state === 'FORMING_CANDLE_3' && candle1 && candle2) {
                        const firstCandleMidpoint = (candle1.open + candle1.close) / 2;
                        if (priceChange >= minBullishMove && currentCandle.close > firstCandleMidpoint) {
                            state = 'PATTERN_DETECTED';
                        } else {
                            state = 'FORMING_CANDLE_1';
                            candle1 = null;
                            candle2 = null;
                        }
                    } else if (state === 'FORMING_CANDLE_2' || state === 'FORMING_CANDLE_3') {
                        state = 'FORMING_CANDLE_1';
                        candle1 = null;
                        candle2 = null;
                    }
                }

                // Start new candle
                currentCandle = { open: btcPrice, close: btcPrice, high: btcPrice, low: btcPrice, startMinute: minute };
                lastCandleIndex = candleIndex;
            }

            // Update current candle
            if (currentCandle) {
                currentCandle.close = btcPrice;
                currentCandle.high = Math.max(currentCandle.high, btcPrice);
                currentCandle.low = Math.min(currentCandle.low, btcPrice);
            }

            // Create buy order when pattern detected
            if (state === 'PATTERN_DETECTED' && !currentBuyOrder) {
                const liveData = await marketInfo.getLiveData(targetedMarket);
                currentBuyOrder = {
                    timestamp: clock.now(),
                    botName: name,
                    side: Side.BUY,
                    tokenId: liveData.BtcUpTokenId,  // Morning Star = bullish = buy UP
                    price: targetBuyPrice,
                    amount: targetSize,
                    status: 'PENDING',
                };
                trades.push(currentBuyOrder);
                state = 'TRADE_ENTERED';
            }
        },

        async onHourChange() {
            if (currentBuyOrder?.status === 'PENDING') currentBuyOrder.status = 'EXPIRED';
            if (currentSellOrder?.status === 'PENDING') currentSellOrder.status = 'EXPIRED';

            if (currentBuyOrder?.status === 'MATCHED' && (!currentSellOrder || currentSellOrder.status !== 'MATCHED')) {
                const hourWinner = marketInfo.getHourWinner(clock.now() - 30 * 60 * 1000);
                const isUpToken = currentBuyOrder.tokenId.includes('UP');
                const won = (hourWinner === 'UP' && isUpToken) || (hourWinner === 'DOWN' && !isUpToken);

                trades.push({
                    timestamp: clock.now(),
                    botName: name,
                    side: Side.BUY,
                    tokenId: currentBuyOrder.tokenId,
                    price: 0,
                    amount: currentBuyOrder.amount,
                    status: 'EXPIRED',
                    pnl: won ? currentBuyOrder.amount : 0,
                });
            }

            resetState();
        },

        getTrades() { return trades; },
        reset() { trades.length = 0; resetState(); },
    };
}

/**
 * MeanReversion Bot - Statistical mean reversion using Z-score
 * When Z-score <= -threshold: price is low, buy UP (expect reversion up)
 * When Z-score >= threshold: price is high, buy DOWN (expect reversion down)
 */
function createMeanReversionBot(botParams: BotParams): SimulatedBot {
    const { name, clock, marketInfo, cdMarketData, params, targetedMarket } = botParams;

    const lookbackPeriods = (params.lookbackPeriods as number) ?? 20;
    const entryThreshold = (params.entryThreshold as number) ?? 2.0;
    const targetBuyPrice = (params.targetBuyPrice as number) ?? 0.50;
    const targetSellPrice = (params.targetSellPrice as number) ?? 0.60;
    const targetSize = (params.targetSize as number) ?? 10;
    const cutoffMinute = (params.cutoffMinute as number) ?? 45;

    const trades: SimulatedTrade[] = [];
    const priceHistory: number[] = [];
    let tradeDirection: 'UP' | 'DOWN' | null = null;
    let currentBuyOrder: SimulatedTrade | null = null;
    let currentSellOrder: SimulatedTrade | null = null;
    let hasTradedThisHour = false;

    const resetState = () => {
        priceHistory.length = 0;
        tradeDirection = null;
        currentBuyOrder = null;
        currentSellOrder = null;
        hasTradedThisHour = false;
    };

    const calculateStats = () => {
        if (priceHistory.length < lookbackPeriods) return null;

        const prices = priceHistory.slice(-lookbackPeriods);
        const mean = prices.reduce((a, b) => a + b, 0) / prices.length;

        const squaredDiffs = prices.map(p => Math.pow(p - mean, 2));
        const variance = squaredDiffs.reduce((a, b) => a + b, 0) / (prices.length - 1);
        const stdDev = Math.sqrt(variance);

        if (stdDev === 0) return null;

        const currentPrice = prices[prices.length - 1];
        const zScore = (currentPrice - mean) / stdDev;

        return { mean, stdDev, zScore, currentPrice };
    };

    const checkOrderFill = async (order: SimulatedTrade): Promise<boolean> => {
        const currentPrice = await marketInfo.getPrice(order.tokenId, order.side, targetedMarket);
        if (order.side === Side.BUY && currentPrice <= order.price) return true;
        if (order.side === Side.SELL && currentPrice >= order.price) return true;
        return false;
    };

    return {
        name,

        async onTick() {
            const minute = clock.getMinutes();
            const btcPrice = await cdMarketData.getCurrentPrice();

            // Build price history
            priceHistory.push(btcPrice);
            if (priceHistory.length > lookbackPeriods * 2) {
                priceHistory.shift();
            }

            // Check order fills
            if (currentBuyOrder?.status === 'PENDING' && await checkOrderFill(currentBuyOrder)) {
                currentBuyOrder.status = 'MATCHED';
                currentBuyOrder.pnl = -(currentBuyOrder.price * currentBuyOrder.amount);

                if (!currentSellOrder && tradeDirection) {
                    const liveData = await marketInfo.getLiveData(targetedMarket);
                    const tokenId = tradeDirection === 'UP' ? liveData.BtcUpTokenId : liveData.BtcDownTokenId;
                    currentSellOrder = {
                        timestamp: clock.now(),
                        botName: name,
                        side: Side.SELL,
                        tokenId,
                        price: targetSellPrice,
                        amount: targetSize,
                        status: 'PENDING',
                    };
                    trades.push(currentSellOrder);
                }
            }

            if (currentSellOrder?.status === 'PENDING' && await checkOrderFill(currentSellOrder)) {
                currentSellOrder.status = 'MATCHED';
                currentSellOrder.pnl = currentSellOrder.price * currentSellOrder.amount;
            }

            // Handle cutoff
            if (isAfterCutoff(clock, targetedMarket, cutoffMinute)) {
                if (currentBuyOrder?.status === 'PENDING') currentBuyOrder.status = 'CANCELED';
                return;
            }

            // Skip if already traded
            if (hasTradedThisHour) return;

            // Calculate stats and check for entry
            const stats = calculateStats();
            if (!stats) return;

            const { zScore } = stats;

            if (zScore <= -entryThreshold) {
                // Price significantly below mean - buy UP
                tradeDirection = 'UP';
                const liveData = await marketInfo.getLiveData(targetedMarket);
                currentBuyOrder = {
                    timestamp: clock.now(),
                    botName: name,
                    side: Side.BUY,
                    tokenId: liveData.BtcUpTokenId,
                    price: targetBuyPrice,
                    amount: targetSize,
                    status: 'PENDING',
                };
                trades.push(currentBuyOrder);
                hasTradedThisHour = true;
            } else if (zScore >= entryThreshold) {
                // Price significantly above mean - buy DOWN
                tradeDirection = 'DOWN';
                const liveData = await marketInfo.getLiveData(targetedMarket);
                currentBuyOrder = {
                    timestamp: clock.now(),
                    botName: name,
                    side: Side.BUY,
                    tokenId: liveData.BtcDownTokenId,
                    price: targetBuyPrice,
                    amount: targetSize,
                    status: 'PENDING',
                };
                trades.push(currentBuyOrder);
                hasTradedThisHour = true;
            }
        },

        async onHourChange() {
            if (currentBuyOrder?.status === 'PENDING') currentBuyOrder.status = 'EXPIRED';
            if (currentSellOrder?.status === 'PENDING') currentSellOrder.status = 'EXPIRED';

            if (currentBuyOrder?.status === 'MATCHED' && (!currentSellOrder || currentSellOrder.status !== 'MATCHED')) {
                const hourWinner = marketInfo.getHourWinner(clock.now() - 30 * 60 * 1000);
                const isUpToken = currentBuyOrder.tokenId.includes('UP');
                const won = (hourWinner === 'UP' && isUpToken) || (hourWinner === 'DOWN' && !isUpToken);

                trades.push({
                    timestamp: clock.now(),
                    botName: name,
                    side: Side.BUY,
                    tokenId: currentBuyOrder.tokenId,
                    price: 0,
                    amount: currentBuyOrder.amount,
                    status: 'EXPIRED',
                    pnl: won ? currentBuyOrder.amount : 0,
                });
            }

            resetState();
        },

        getTrades() { return trades; },
        reset() { trades.length = 0; resetState(); },
    };
}

/**
 * EarlyBuyerV2 Bot - Early entry with flops-based filtering
 * Checks market volatility (flops) before entering trades in a specific direction
 */
function createEarlyBuyerV2Bot(botParams: BotParams): SimulatedBot {
    const { name, clock, marketInfo, cdMarketData, params, targetedMarket } = botParams;

    const targetBuyPrice = (params.targetBuyPrice as number) ?? 0.50;
    const targetSellPrice = (params.targetSellPrice as number) ?? 0.60;
    const targetSize = (params.targetSize as number) ?? 10;
    const cutoffMinute = (params.cutoffMinute as number) ?? 30;
    // btcDirection: can be 'UP', 'DOWN', or numeric (0 = DOWN, 1 = UP from genetic algorithm)
    const btcDirectionParam = params.btcDirection;
    const btcDirection = typeof btcDirectionParam === 'number'
        ? (btcDirectionParam >= 1 ? 'UP' : 'DOWN')
        : ((btcDirectionParam as string) ?? 'UP');
    const minFlops = (params.minFlops as number) ?? 3;
    const flopsLookbackHours = (params.flopsLookbackHours as number) ?? 4;

    const trades: SimulatedTrade[] = [];
    let currentBuyOrder: SimulatedTrade | null = null;
    let currentSellOrder: SimulatedTrade | null = null;
    let isPastCutoff = false;
    let hasCheckedFlops = false;
    let flopsCheckPassed = false;

    const resetState = () => {
        currentBuyOrder = null;
        currentSellOrder = null;
        isPastCutoff = false;
        hasCheckedFlops = false;
        flopsCheckPassed = false;
    };

    const checkFlops = (): boolean => {
        if (hasCheckedFlops) return flopsCheckPassed;
        hasCheckedFlops = true;

        const averages = cdMarketData.getAverages(flopsLookbackHours);
        if (!averages) {
            flopsCheckPassed = false;
            return false;
        }

        const avgFlops = (averages.openFlops + averages.averageFlops) / 2;
        flopsCheckPassed = avgFlops >= minFlops;
        return flopsCheckPassed;
    };

    const checkOrderFill = async (order: SimulatedTrade): Promise<boolean> => {
        const currentPrice = await marketInfo.getPrice(order.tokenId, order.side, targetedMarket);
        if (order.side === Side.BUY && currentPrice <= order.price) return true;
        if (order.side === Side.SELL && currentPrice >= order.price) return true;
        return false;
    };

    return {
        name,

        async onTick() {
            if (isPastCutoff) return;

            const minute = clock.getMinutes();

            try {
                // Check order fills
                if (currentBuyOrder?.status === 'PENDING' && await checkOrderFill(currentBuyOrder)) {
                    currentBuyOrder.status = 'MATCHED';
                    currentBuyOrder.pnl = -(currentBuyOrder.price * currentBuyOrder.amount);

                    // Create sell order
                    if (!currentSellOrder) {
                        const liveData = await marketInfo.getLiveData(targetedMarket);
                        const tokenId = btcDirection === 'UP' ? liveData.BtcUpTokenId : liveData.BtcDownTokenId;
                        currentSellOrder = {
                            timestamp: clock.now(),
                            botName: name,
                            side: Side.SELL,
                            tokenId,
                            price: targetSellPrice,
                            amount: targetSize,
                            status: 'PENDING',
                        };
                        trades.push(currentSellOrder);
                    }
                }

                if (currentSellOrder?.status === 'PENDING' && await checkOrderFill(currentSellOrder)) {
                    currentSellOrder.status = 'MATCHED';
                    currentSellOrder.pnl = currentSellOrder.price * currentSellOrder.amount;
                }

                // Handle cutoff
                if (isAfterCutoff(clock, targetedMarket, cutoffMinute)) {
                    isPastCutoff = true;
                    if (currentBuyOrder?.status === 'PENDING') currentBuyOrder.status = 'CANCELED';
                    return;
                }

                // Create buy order if conditions met
                if (!currentBuyOrder && checkFlops()) {
                    const liveData = await marketInfo.getLiveData(targetedMarket);
                    const tokenId = btcDirection === 'UP' ? liveData.BtcUpTokenId : liveData.BtcDownTokenId;
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
                }
            } catch {
                // Price data not available
            }
        },

        async onHourChange() {
            if (currentBuyOrder?.status === 'PENDING') currentBuyOrder.status = 'EXPIRED';
            if (currentSellOrder?.status === 'PENDING') currentSellOrder.status = 'EXPIRED';

            if (currentBuyOrder?.status === 'MATCHED' && (!currentSellOrder || currentSellOrder.status !== 'MATCHED')) {
                const hourWinner = marketInfo.getHourWinner(clock.now() - 30 * 60 * 1000);
                const isUpToken = currentBuyOrder.tokenId.includes('UP');
                const won = (hourWinner === 'UP' && isUpToken) || (hourWinner === 'DOWN' && !isUpToken);

                trades.push({
                    timestamp: clock.now(),
                    botName: name,
                    side: Side.BUY,
                    tokenId: currentBuyOrder.tokenId,
                    price: 0,
                    amount: currentBuyOrder.amount,
                    status: 'EXPIRED',
                    pnl: won ? currentBuyOrder.amount : 0,
                });
            }

            resetState();
        },

        getTrades() { return trades; },
        reset() { trades.length = 0; resetState(); },
    };
}

// ============================================================================
// Normal Distribution Helper
// ============================================================================

/**
 * Approximation of standard normal cumulative distribution function (CDF)
 * Returns probability that a standard normal random variable is <= x
 */
function normalCDF(x: number): number {
    const a1 = 0.254829592;
    const a2 = -0.284496736;
    const a3 = 1.421413741;
    const a4 = -1.453152027;
    const a5 = 1.061405429;
    const p = 0.3275911;

    const sign = x < 0 ? -1 : 1;
    const absX = Math.abs(x) / Math.sqrt(2);

    const t = 1.0 / (1.0 + p * absX);
    const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX);

    return 0.5 * (1.0 + sign * y);
}

// ============================================================================
// EsotericNormalization Bot Implementations
// ============================================================================

/**
 * EsotericNormalization Bot - Uses normal distribution to predict token prices
 *
 * The bot calculates an "expected token price" based on:
 * 1. BTC price movement from period start (determines mean/direction)
 * 2. Time elapsed in period (affects distribution spread - flattens over time)
 *
 * Early in period: Large price movements still uncertain, token ~0.50
 * Late in period: Same price movements more decisive, token approaches 0 or 1
 *
 * Trades when actual token price differs significantly from expected price.
 */
function createEsotericNormalizationBot(botParams: BotParams): SimulatedBot {
    const { name, clock, marketInfo, cdMarketData, params, targetedMarket } = botParams;

    const PERIOD_MINUTES = 60;

    // Distribution shape parameters
    const baseStdDev = (params.baseStdDev as number) ?? 150;              // Initial std dev in $ at period start
    const minStdDevRatio = (params.minStdDevRatio as number) ?? 0.25;    // Min std dev as ratio of base at period end
    const timeDecayPower = (params.timeDecayPower as number) ?? 1.5;     // How fast std dev shrinks (higher = faster)
    const priceScaleMultiplier = (params.priceScaleMultiplier as number) ?? 1.0;  // Multiplier for price sensitivity
    const priceScaleConstant = (params.priceScaleConstant as number) ?? 0;        // Constant offset for price calc

    // Trading parameters
    const purchaseThreshold = (params.purchaseThreshold as number) ?? 0.08;  // Min diff to trigger buy
    const sellPremium = (params.sellPremium as number) ?? 0.04;              // Sell this much above expected
    const targetSize = (params.targetSize as number) ?? 10;
    const cutoffMinute = (params.cutoffMinute as number) ?? 45;
    const maxTradesPerPeriod = (params.maxTradesPerPeriod as number) ?? 2;

    const trades: SimulatedTrade[] = [];
    let startPrice: number | null = null;
    let currentBuyOrder: SimulatedTrade | null = null;
    let currentSellOrder: SimulatedTrade | null = null;
    let tradesThisPeriod = 0;
    let lastExpectedPrice = 0.5;

    const resetState = () => {
        startPrice = null;
        currentBuyOrder = null;
        currentSellOrder = null;
        tradesThisPeriod = 0;
        lastExpectedPrice = 0.5;
    };

    /**
     * Calculate the expected token price based on BTC price movement and time
     * Returns expected price for UP token (0-1)
     */
    const calculateExpectedPrice = (currentBtcPrice: number, minuteInPeriod: number): number => {
        if (startPrice === null) return 0.5;

        // Price difference from start (positive = BTC went up)
        const priceChange = (currentBtcPrice - startPrice) * priceScaleMultiplier + priceScaleConstant;

        // Time factor: 0 at start, 1 at end
        const timeFactor = Math.min(1, minuteInPeriod / PERIOD_MINUTES);

        // Standard deviation shrinks over time (curve gets steeper)
        // At start: stdDev = baseStdDev
        // At end: stdDev = baseStdDev * minStdDevRatio
        const stdDev = baseStdDev * (1 - (1 - minStdDevRatio) * Math.pow(timeFactor, timeDecayPower));

        // Z-score: how many std devs is the price change
        const zScore = priceChange / stdDev;

        // CDF gives probability that UP wins (expected UP token price)
        const expectedUpPrice = normalCDF(zScore);

        // Clamp to reasonable range
        return Math.max(0.02, Math.min(0.98, expectedUpPrice));
    };

    const checkOrderFill = async (order: SimulatedTrade): Promise<boolean> => {
        const currentPrice = await marketInfo.getPrice(order.tokenId, order.side, targetedMarket);
        if (order.side === Side.BUY && currentPrice <= order.price) return true;
        if (order.side === Side.SELL && currentPrice >= order.price) return true;
        return false;
    };

    return {
        name,

        async onTick() {
            const minute = clock.getMinutes();

            try {
                const currentBtcPrice = await cdMarketData.getCurrentPrice();

                // Capture start price at beginning of period
                if (startPrice === null) {
                    startPrice = currentBtcPrice;
                }

                // Calculate expected token prices
                const expectedUpPrice = calculateExpectedPrice(currentBtcPrice, minute);
                const expectedDownPrice = 1 - expectedUpPrice;
                lastExpectedPrice = expectedUpPrice;

                // Get actual market prices
                const liveData = await marketInfo.getLiveData(targetedMarket);
                const actualUpPrice = parseFloat(liveData.BtcUp.asks[0]?.price ?? '0.50');
                const actualDownPrice = parseFloat(liveData.BtcDown.asks[0]?.price ?? '0.50');

                // Check order fills
                if (currentBuyOrder?.status === 'PENDING' && await checkOrderFill(currentBuyOrder)) {
                    currentBuyOrder.status = 'MATCHED';
                    currentBuyOrder.pnl = -(currentBuyOrder.price * currentBuyOrder.amount);
                    trades.push({ ...currentBuyOrder });

                    // Create sell order at expected price + premium
                    if (!currentSellOrder) {
                        const isUpToken = currentBuyOrder.tokenId.includes('UP');
                        const expectedSellPrice = isUpToken ? expectedUpPrice : expectedDownPrice;
                        const sellPrice = Math.min(0.95, expectedSellPrice + sellPremium);

                        currentSellOrder = {
                            timestamp: clock.now(),
                            botName: name,
                            side: Side.SELL,
                            tokenId: currentBuyOrder.tokenId,
                            price: sellPrice,
                            amount: targetSize,
                            status: 'PENDING',
                        };
                    }
                }

                if (currentSellOrder?.status === 'PENDING') {
                    // Update sell price based on current expected value
                    const isUpToken = currentSellOrder.tokenId.includes('UP');
                    const currentExpected = isUpToken ? expectedUpPrice : expectedDownPrice;
                    currentSellOrder.price = Math.min(0.95, currentExpected + sellPremium);

                    if (await checkOrderFill(currentSellOrder)) {
                        currentSellOrder.status = 'MATCHED';
                        currentSellOrder.pnl = currentSellOrder.price * currentSellOrder.amount;
                        trades.push({
                            ...currentSellOrder,
                            pnl: currentSellOrder.price * currentSellOrder.amount
                        });
                        currentBuyOrder = null;
                        currentSellOrder = null;
                    }
                }

                // Check for new trade opportunity
                if (minute < cutoffMinute && !currentBuyOrder && tradesThisPeriod < maxTradesPerPeriod) {
                    // Look for mispriced UP token
                    const upDiff = expectedUpPrice - actualUpPrice;
                    // Look for mispriced DOWN token
                    const downDiff = expectedDownPrice - actualDownPrice;

                    let selectedToken: 'UP' | 'DOWN' | null = null;
                    let buyPrice = 0;

                    if (upDiff >= purchaseThreshold && upDiff >= downDiff) {
                        selectedToken = 'UP';
                        buyPrice = actualUpPrice;
                    } else if (downDiff >= purchaseThreshold) {
                        selectedToken = 'DOWN';
                        buyPrice = actualDownPrice;
                    }

                    if (selectedToken) {
                        const tokenId = selectedToken === 'UP' ? liveData.BtcUpTokenId : liveData.BtcDownTokenId;
                        currentBuyOrder = {
                            timestamp: clock.now(),
                            botName: name,
                            side: Side.BUY,
                            tokenId,
                            price: buyPrice,
                            amount: targetSize,
                            status: 'PENDING',
                        };
                        tradesThisPeriod++;
                    }
                }

            } catch {
                // Price data not available
            }
        },

        async onHourChange() {
            if (currentBuyOrder?.status === 'PENDING') currentBuyOrder.status = 'EXPIRED';
            if (currentSellOrder?.status === 'PENDING') currentSellOrder.status = 'EXPIRED';

            // Settle matched buy that wasn't sold
            if (currentBuyOrder?.status === 'MATCHED' && (!currentSellOrder || currentSellOrder.status !== 'MATCHED')) {
                const hourWinner = marketInfo.getHourWinner(clock.now() - 30 * 60 * 1000);
                const isUpToken = currentBuyOrder.tokenId.includes('UP');
                const won = (hourWinner === 'UP' && isUpToken) || (hourWinner === 'DOWN' && !isUpToken);

                trades.push({
                    timestamp: clock.now(),
                    botName: name,
                    side: Side.BUY,
                    tokenId: currentBuyOrder.tokenId,
                    price: 0,
                    amount: currentBuyOrder.amount,
                    status: 'EXPIRED',
                    pnl: won ? currentBuyOrder.amount : 0,
                });
            }

            resetState();
        },

        getTrades() { return trades; },
        reset() { trades.length = 0; resetState(); },
    };
}

/**
 * Quarterly EsotericNormalization Bot - Normal distribution prediction for 15-minute markets
 */
function createQuarterlyEsotericNormalizationBot(botParams: BotParams): SimulatedBot {
    const { name, clock, marketInfo, cdMarketData, params, targetedMarket } = botParams;

    const PERIOD_MINUTES = 15;

    // Distribution shape parameters (adjusted for shorter period)
    const baseStdDev = (params.baseStdDev as number) ?? 75;               // Smaller for 15-min period
    const minStdDevRatio = (params.minStdDevRatio as number) ?? 0.25;
    const timeDecayPower = (params.timeDecayPower as number) ?? 1.5;
    const priceScaleMultiplier = (params.priceScaleMultiplier as number) ?? 1.0;
    const priceScaleConstant = (params.priceScaleConstant as number) ?? 0;

    // Trading parameters
    const purchaseThreshold = (params.purchaseThreshold as number) ?? 0.08;
    const sellPremium = (params.sellPremium as number) ?? 0.04;
    const targetSize = (params.targetSize as number) ?? 10;
    const cutoffMinute = (params.cutoffMinute as number) ?? 10;  // Within 15-min period
    const maxTradesPerPeriod = (params.maxTradesPerPeriod as number) ?? 1;

    const trades: SimulatedTrade[] = [];
    let startPrice: number | null = null;
    let currentBuyOrder: SimulatedTrade | null = null;
    let currentSellOrder: SimulatedTrade | null = null;
    let tradesThisPeriod = 0;
    let lastExpectedPrice = 0.5;

    const resetState = () => {
        startPrice = null;
        currentBuyOrder = null;
        currentSellOrder = null;
        tradesThisPeriod = 0;
        lastExpectedPrice = 0.5;
    };

    const getMinuteInPeriod = (): number => {
        return clock.getMinutes() % PERIOD_MINUTES;
    };

    const calculateExpectedPrice = (currentBtcPrice: number, minuteInPeriod: number): number => {
        if (startPrice === null) return 0.5;

        const priceChange = (currentBtcPrice - startPrice) * priceScaleMultiplier + priceScaleConstant;
        const timeFactor = Math.min(1, minuteInPeriod / PERIOD_MINUTES);
        const stdDev = baseStdDev * (1 - (1 - minStdDevRatio) * Math.pow(timeFactor, timeDecayPower));
        const zScore = priceChange / stdDev;
        const expectedUpPrice = normalCDF(zScore);

        return Math.max(0.02, Math.min(0.98, expectedUpPrice));
    };

    const checkOrderFill = async (order: SimulatedTrade): Promise<boolean> => {
        const currentPrice = await marketInfo.getPrice(order.tokenId, order.side, targetedMarket);
        if (order.side === Side.BUY && currentPrice <= order.price) return true;
        if (order.side === Side.SELL && currentPrice >= order.price) return true;
        return false;
    };

    return {
        name,

        async onTick() {
            const minuteInPeriod = getMinuteInPeriod();

            try {
                const currentBtcPrice = await cdMarketData.getCurrentPrice();

                // Capture start price at beginning of period
                if (startPrice === null) {
                    startPrice = currentBtcPrice;
                }

                const expectedUpPrice = calculateExpectedPrice(currentBtcPrice, minuteInPeriod);
                const expectedDownPrice = 1 - expectedUpPrice;
                lastExpectedPrice = expectedUpPrice;

                const liveData = await marketInfo.getLiveData(targetedMarket);
                const actualUpPrice = parseFloat(liveData.BtcUp.asks[0]?.price ?? '0.50');
                const actualDownPrice = parseFloat(liveData.BtcDown.asks[0]?.price ?? '0.50');

                // Check order fills
                if (currentBuyOrder?.status === 'PENDING' && await checkOrderFill(currentBuyOrder)) {
                    currentBuyOrder.status = 'MATCHED';
                    currentBuyOrder.pnl = -(currentBuyOrder.price * currentBuyOrder.amount);
                    trades.push({ ...currentBuyOrder });

                    if (!currentSellOrder) {
                        const isUpToken = currentBuyOrder.tokenId.includes('UP');
                        const expectedSellPrice = isUpToken ? expectedUpPrice : expectedDownPrice;
                        const sellPrice = Math.min(0.95, expectedSellPrice + sellPremium);

                        currentSellOrder = {
                            timestamp: clock.now(),
                            botName: name,
                            side: Side.SELL,
                            tokenId: currentBuyOrder.tokenId,
                            price: sellPrice,
                            amount: targetSize,
                            status: 'PENDING',
                        };
                    }
                }

                if (currentSellOrder?.status === 'PENDING') {
                    const isUpToken = currentSellOrder.tokenId.includes('UP');
                    const currentExpected = isUpToken ? expectedUpPrice : expectedDownPrice;
                    currentSellOrder.price = Math.min(0.95, currentExpected + sellPremium);

                    if (await checkOrderFill(currentSellOrder)) {
                        currentSellOrder.status = 'MATCHED';
                        currentSellOrder.pnl = currentSellOrder.price * currentSellOrder.amount;
                        trades.push({ ...currentSellOrder });
                        currentBuyOrder = null;
                        currentSellOrder = null;
                    }
                }

                // Check for new trade opportunity
                if (minuteInPeriod < cutoffMinute && !currentBuyOrder && tradesThisPeriod < maxTradesPerPeriod) {
                    const upDiff = expectedUpPrice - actualUpPrice;
                    const downDiff = expectedDownPrice - actualDownPrice;

                    let selectedToken: 'UP' | 'DOWN' | null = null;
                    let buyPrice = 0;

                    if (upDiff >= purchaseThreshold && upDiff >= downDiff) {
                        selectedToken = 'UP';
                        buyPrice = actualUpPrice;
                    } else if (downDiff >= purchaseThreshold) {
                        selectedToken = 'DOWN';
                        buyPrice = actualDownPrice;
                    }

                    if (selectedToken) {
                        const tokenId = selectedToken === 'UP' ? liveData.BtcUpTokenId : liveData.BtcDownTokenId;
                        currentBuyOrder = {
                            timestamp: clock.now(),
                            botName: name,
                            side: Side.BUY,
                            tokenId,
                            price: buyPrice,
                            amount: targetSize,
                            status: 'PENDING',
                        };
                        tradesThisPeriod++;
                    }
                }

            } catch {
                // Price data not available
            }
        },

        async onHourChange() {
            // Settle at period end (called every 15 minutes for quarterly markets)
            if (currentBuyOrder?.status === 'PENDING') currentBuyOrder.status = 'EXPIRED';
            if (currentSellOrder?.status === 'PENDING') currentSellOrder.status = 'EXPIRED';

            if (currentBuyOrder?.status === 'MATCHED' && (!currentSellOrder || currentSellOrder.status !== 'MATCHED')) {
                const quarterWinner = marketInfo.getQuarterWinner(clock.now() - 60 * 1000);
                const isUpToken = currentBuyOrder.tokenId.includes('UP');
                const won = (quarterWinner === 'UP' && isUpToken) || (quarterWinner === 'DOWN' && !isUpToken);

                trades.push({
                    timestamp: clock.now(),
                    botName: name,
                    side: Side.BUY,
                    tokenId: currentBuyOrder.tokenId,
                    price: 0,
                    amount: currentBuyOrder.amount,
                    status: 'EXPIRED',
                    pnl: won ? currentBuyOrder.amount : 0,
                });
            }

            resetState();
        },

        getTrades() { return trades; },
        reset() { trades.length = 0; resetState(); },
    };
}

/**
 * Quarterly EarlyBuyerV2 Bot - Early entry with flops-based filtering for 15-minute markets
 * Checks market volatility (flops) before entering trades in a specific direction
 */
function createQuarterlyEarlyBuyerV2Bot(botParams: BotParams): SimulatedBot {
    const { name, clock, marketInfo, cdMarketData, params, targetedMarket } = botParams;

    const PERIOD_MINUTES = 15;

    const targetBuyPrice = (params.targetBuyPrice as number) ?? 0.50;
    const targetSellPrice = (params.targetSellPrice as number) ?? 0.60;
    const targetSize = (params.targetSize as number) ?? 10;
    const cutoffMinute = (params.cutoffMinute as number) ?? 10;  // Within 15-min period
    // btcDirection: can be 'UP', 'DOWN', or numeric (0 = DOWN, 1 = UP from genetic algorithm)
    const btcDirectionParam = params.btcDirection;
    const btcDirection = typeof btcDirectionParam === 'number'
        ? (btcDirectionParam >= 1 ? 'UP' : 'DOWN')
        : ((btcDirectionParam as string) ?? 'UP');
    const minFlops = (params.minFlops as number) ?? 3;
    const flopsLookbackHours = (params.flopsLookbackHours as number) ?? 4;

    const trades: SimulatedTrade[] = [];
    let currentBuyOrder: SimulatedTrade | null = null;
    let currentSellOrder: SimulatedTrade | null = null;
    let isPastCutoff = false;
    let hasCheckedFlops = false;
    let flopsCheckPassed = false;

    const resetState = () => {
        currentBuyOrder = null;
        currentSellOrder = null;
        isPastCutoff = false;
        hasCheckedFlops = false;
        flopsCheckPassed = false;
    };

    const getMinuteInPeriod = (): number => {
        return clock.getMinutes() % PERIOD_MINUTES;
    };

    const checkFlops = (): boolean => {
        if (hasCheckedFlops) return flopsCheckPassed;
        hasCheckedFlops = true;

        const averages = cdMarketData.getAverages(flopsLookbackHours);
        if (!averages) {
            flopsCheckPassed = false;
            return false;
        }

        const avgFlops = (averages.openFlops + averages.averageFlops) / 2;
        flopsCheckPassed = avgFlops >= minFlops;
        return flopsCheckPassed;
    };

    const checkOrderFill = async (order: SimulatedTrade): Promise<boolean> => {
        const currentPrice = await marketInfo.getPrice(order.tokenId, order.side, targetedMarket);
        if (order.side === Side.BUY && currentPrice <= order.price) return true;
        if (order.side === Side.SELL && currentPrice >= order.price) return true;
        return false;
    };

    return {
        name,

        async onTick() {
            if (isPastCutoff) return;

            const minuteInPeriod = getMinuteInPeriod();

            try {
                // Check order fills
                if (currentBuyOrder?.status === 'PENDING' && await checkOrderFill(currentBuyOrder)) {
                    currentBuyOrder.status = 'MATCHED';
                    currentBuyOrder.pnl = -(currentBuyOrder.price * currentBuyOrder.amount);

                    // Create sell order
                    if (!currentSellOrder) {
                        const liveData = await marketInfo.getLiveData(targetedMarket);
                        const tokenId = btcDirection === 'UP' ? liveData.BtcUpTokenId : liveData.BtcDownTokenId;
                        currentSellOrder = {
                            timestamp: clock.now(),
                            botName: name,
                            side: Side.SELL,
                            tokenId,
                            price: targetSellPrice,
                            amount: targetSize,
                            status: 'PENDING',
                        };
                        trades.push(currentSellOrder);
                    }
                }

                if (currentSellOrder?.status === 'PENDING' && await checkOrderFill(currentSellOrder)) {
                    currentSellOrder.status = 'MATCHED';
                    currentSellOrder.pnl = currentSellOrder.price * currentSellOrder.amount;
                }

                // Handle cutoff (within 15-minute period)
                if (isAfterCutoff(clock, targetedMarket, cutoffMinute)) {
                    isPastCutoff = true;
                    if (currentBuyOrder?.status === 'PENDING') currentBuyOrder.status = 'CANCELED';
                    return;
                }

                // Create buy order if conditions met
                if (!currentBuyOrder && checkFlops()) {
                    const liveData = await marketInfo.getLiveData(targetedMarket);
                    const tokenId = btcDirection === 'UP' ? liveData.BtcUpTokenId : liveData.BtcDownTokenId;
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
                }
            } catch {
                // Price data not available
            }
        },

        async onHourChange() {
            // Settle at period end (called every 15 minutes for quarterly markets)
            if (currentBuyOrder?.status === 'PENDING') currentBuyOrder.status = 'EXPIRED';
            if (currentSellOrder?.status === 'PENDING') currentSellOrder.status = 'EXPIRED';

            // Settle matched buy that wasn't sold
            if (currentBuyOrder?.status === 'MATCHED' && (!currentSellOrder || currentSellOrder.status !== 'MATCHED')) {
                const quarterWinner = marketInfo.getQuarterWinner(clock.now() - 60 * 1000);
                const isUpToken = currentBuyOrder.tokenId.includes('UP');
                const won = (quarterWinner === 'UP' && isUpToken) || (quarterWinner === 'DOWN' && !isUpToken);

                trades.push({
                    timestamp: clock.now(),
                    botName: name,
                    side: Side.BUY,
                    tokenId: currentBuyOrder.tokenId,
                    price: 0,
                    amount: currentBuyOrder.amount,
                    status: 'EXPIRED',
                    pnl: won ? currentBuyOrder.amount : 0,
                });
            }

            resetState();
        },

        getTrades() { return trades; },
        reset() { trades.length = 0; resetState(); },
    };
}

// ============================================================================
// Quarterly Market Bot Implementations (15-minute periods)
// ============================================================================

/**
 * Quarterly First Candle Bot - breakout strategy for 15-minute markets
 * Uses smaller candle periods appropriate for quarterly timeframe
 */
function createQuarterlyFirstCandleBot(botParams: BotParams): SimulatedBot {
    const { name, clock, marketInfo, cdMarketData, params, targetedMarket } = botParams;

    const targetSize = (params.targetSize as number) ?? 10;
    const candleMinutes = (params.candleMinutes as number) ?? 3;  // Smaller candle for 15-min period
    const breakoutBuffer = (params.breakoutBuffer as number) ?? 30;
    const pullbackBuffer = (params.pullbackBuffer as number) ?? 50;
    const targetBuyPrice = (params.targetBuyPrice as number) ?? 0.50;
    const targetSellPrice = (params.targetSellPrice as number) ?? 0.60;
    const cutoffMinute = (params.cutoffMinute as number) ?? 10;  // Cutoff within 15-min period

    const PERIOD_MINUTES = 15;
    const trades: SimulatedTrade[] = [];

    let candleHigh: number | null = null;
    let candleLow: number | null = null;
    let breakoutDirection: 'UP' | 'DOWN' | null = null;
    let currentBuyOrder: SimulatedTrade | null = null;
    let currentSellOrder: SimulatedTrade | null = null;
    let actualBuyPrice: number | null = null;

    const resetState = () => {
        candleHigh = null;
        candleLow = null;
        breakoutDirection = null;
        currentBuyOrder = null;
        currentSellOrder = null;
        actualBuyPrice = null;
    };

    const getMinuteInPeriod = (): number => {
        return clock.getMinutes() % PERIOD_MINUTES;
    };

    return {
        name,
        async onTick() {
            const minuteInPeriod = getMinuteInPeriod();

            try {
                const currentPrice = await cdMarketData.getCurrentPrice();

                // Phase 1: Build candle (first N minutes of 15-min period)
                if (minuteInPeriod < candleMinutes) {
                    if (candleHigh === null || candleLow === null) {
                        candleHigh = currentPrice;
                        candleLow = currentPrice;
                    } else {
                        candleHigh = Math.max(candleHigh, currentPrice);
                        candleLow = Math.min(candleLow, currentPrice);
                    }
                }

                // Phase 2: Watch for breakout
                if (minuteInPeriod >= candleMinutes && minuteInPeriod < cutoffMinute && candleHigh && candleLow) {
                    if (!breakoutDirection) {
                        if (currentPrice > candleHigh + breakoutBuffer) {
                            breakoutDirection = 'UP';
                        } else if (currentPrice < candleLow - breakoutBuffer) {
                            breakoutDirection = 'DOWN';
                        }
                    }

                    // Create sell order with dynamic pricing
                    if (!currentSellOrder && breakoutDirection && actualBuyPrice) {
                        const liveData = await marketInfo.getLiveData(targetedMarket);
                        const tokenId = breakoutDirection === 'UP' ? liveData.BtcUpTokenId : liveData.BtcDownTokenId;

                        const dynamicSellPrice = Math.min(0.95, actualBuyPrice + (targetSellPrice - targetBuyPrice));

                        currentSellOrder = {
                            timestamp: clock.now(),
                            botName: name,
                            side: Side.SELL,
                            tokenId,
                            price: dynamicSellPrice,
                            amount: targetSize,
                            status: 'PENDING',
                        };
                    }

                    // Look for pullback entry
                    if (breakoutDirection && !currentBuyOrder) {
                        const isPullbackConfirmed =
                            (breakoutDirection === 'UP' && currentPrice <= candleHigh + pullbackBuffer) ||
                            (breakoutDirection === 'DOWN' && currentPrice >= candleLow - pullbackBuffer);

                        if (isPullbackConfirmed) {
                            const liveData = await marketInfo.getLiveData(targetedMarket);
                            const tokenId = breakoutDirection === 'UP' ? liveData.BtcUpTokenId : liveData.BtcDownTokenId;

                            currentBuyOrder = {
                                timestamp: clock.now(),
                                botName: name,
                                side: Side.BUY,
                                tokenId,
                                price: targetBuyPrice,
                                amount: targetSize,
                                status: 'PENDING',
                            };
                        }
                    }
                }

                // Simulate order fills
                if (currentBuyOrder?.status === 'PENDING') {
                    const liveData = await marketInfo.getLiveData(targetedMarket);
                    const orderBook = currentBuyOrder.tokenId.includes('UP') ? liveData.BtcUp : liveData.BtcDown;
                    const askPrice = parseFloat(orderBook.asks[0]?.price ?? '1');

                    if (currentBuyOrder.price >= askPrice) {
                        currentBuyOrder.status = 'MATCHED';
                        actualBuyPrice = askPrice;
                        trades.push({
                            ...currentBuyOrder,
                            pnl: -currentBuyOrder.amount * currentBuyOrder.price
                        });
                    }
                }

                if (currentSellOrder?.status === 'PENDING' && currentBuyOrder?.status === 'MATCHED') {
                    const liveData = await marketInfo.getLiveData(targetedMarket);
                    const orderBook = currentSellOrder.tokenId.includes('UP') ? liveData.BtcUp : liveData.BtcDown;
                    const bidPrice = parseFloat(orderBook.bids[0]?.price ?? '0');

                    if (currentSellOrder.price <= bidPrice) {
                        currentSellOrder.status = 'MATCHED';
                        currentSellOrder.pnl = (bidPrice - (actualBuyPrice ?? targetBuyPrice)) * targetSize;
                        trades.push({
                            ...currentSellOrder,
                            pnl: -currentSellOrder.amount * currentSellOrder.price
                        });
                    }
                }

            } catch {
                // Price data not available
            }
        },

        async onHourChange() {
            // Settle at period end (called every 15 minutes for quarterly markets)
            if (currentBuyOrder?.status === 'PENDING') currentBuyOrder.status = 'EXPIRED';
            if (currentSellOrder?.status === 'PENDING') currentSellOrder.status = 'EXPIRED';

            // Settle matched buy that wasn't sold
            if (currentBuyOrder?.status === 'MATCHED' && (!currentSellOrder || currentSellOrder.status !== 'MATCHED')) {
                const quarterWinner = marketInfo.getQuarterWinner(clock.now() - 60 * 1000);
                const isUpToken = currentBuyOrder.tokenId.includes('UP');
                const won = (quarterWinner === 'UP' && isUpToken) || (quarterWinner === 'DOWN' && !isUpToken);

                trades.push({
                    timestamp: clock.now(),
                    botName: name,
                    side: Side.BUY,
                    tokenId: currentBuyOrder.tokenId,
                    price: 0,
                    amount: currentBuyOrder.amount,
                    status: 'EXPIRED',
                    pnl: won ? currentBuyOrder.amount : 0,
                });
            }
            resetState();
        },

        getTrades() { return trades; },
        reset() { trades.length = 0; resetState(); },
    };
}

/**
 * Quarterly Mean Reversion Bot - mean reversion for 15-minute markets
 */
function createQuarterlyMeanReversionBot(botParams: BotParams): SimulatedBot {
    const { name, clock, marketInfo, cdMarketData, params, targetedMarket } = botParams;

    const targetSize = (params.targetSize as number) ?? 10;
    const lookbackPeriods = (params.lookbackPeriods as number) ?? 10;
    const entryThreshold = (params.entryThreshold as number) ?? 1.5;  // Tighter for faster markets
    const targetBuyPrice = (params.targetBuyPrice as number) ?? 0.50;
    const targetSellPrice = (params.targetSellPrice as number) ?? 0.60;
    const cutoffMinute = (params.cutoffMinute as number) ?? 10;

    const PERIOD_MINUTES = 15;
    const trades: SimulatedTrade[] = [];
    const priceHistory: number[] = [];

    let tradeDirection: 'UP' | 'DOWN' | null = null;
    let currentBuyOrder: SimulatedTrade | null = null;
    let currentSellOrder: SimulatedTrade | null = null;

    const resetState = () => {
        tradeDirection = null;
        currentBuyOrder = null;
        currentSellOrder = null;
    };

    const getMinuteInPeriod = (): number => {
        return clock.getMinutes() % PERIOD_MINUTES;
    };

    const calculateStats = () => {
        if (priceHistory.length < lookbackPeriods) return null;
        const recent = priceHistory.slice(-lookbackPeriods);
        const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
        const variance = recent.reduce((sum, p) => sum + Math.pow(p - mean, 2), 0) / recent.length;
        const stdDev = Math.sqrt(variance);
        return { mean, stdDev };
    };

    return {
        name,
        async onTick() {
            const minuteInPeriod = getMinuteInPeriod();

            try {
                const currentPrice = await cdMarketData.getCurrentPrice();
                priceHistory.push(currentPrice);
                if (priceHistory.length > 100) priceHistory.shift();

                // Create sell order if we have a buy
                if (!currentSellOrder && tradeDirection && currentBuyOrder?.status === 'MATCHED') {
                    const liveData = await marketInfo.getLiveData(targetedMarket);
                    const tokenId = tradeDirection === 'UP' ? liveData.BtcUpTokenId : liveData.BtcDownTokenId;
                    currentSellOrder = {
                        timestamp: clock.now(),
                        botName: name,
                        side: Side.SELL,
                        tokenId,
                        price: targetSellPrice,
                        amount: targetSize,
                        status: 'PENDING',
                    };
                }

                // Entry logic - only before cutoff
                if (minuteInPeriod < cutoffMinute && !currentBuyOrder) {
                    const stats = calculateStats();
                    if (stats && stats.stdDev > 0) {
                        const zScore = (currentPrice - stats.mean) / stats.stdDev;

                        if (zScore < -entryThreshold) {
                            tradeDirection = 'UP';
                            const liveData = await marketInfo.getLiveData(targetedMarket);
                            currentBuyOrder = {
                                timestamp: clock.now(),
                                botName: name,
                                side: Side.BUY,
                                tokenId: liveData.BtcUpTokenId,
                                price: targetBuyPrice,
                                amount: targetSize,
                                status: 'PENDING',
                            };
                        } else if (zScore > entryThreshold) {
                            tradeDirection = 'DOWN';
                            const liveData = await marketInfo.getLiveData(targetedMarket);
                            currentBuyOrder = {
                                timestamp: clock.now(),
                                botName: name,
                                side: Side.BUY,
                                tokenId: liveData.BtcDownTokenId,
                                price: targetBuyPrice,
                                amount: targetSize,
                                status: 'PENDING',
                            };
                        }
                    }
                }

                // Simulate order fills
                if (currentBuyOrder?.status === 'PENDING') {
                    const liveData = await marketInfo.getLiveData(targetedMarket);
                    const orderBook = currentBuyOrder.tokenId.includes('UP') ? liveData.BtcUp : liveData.BtcDown;
                    const askPrice = parseFloat(orderBook.asks[0]?.price ?? '1');

                    if (currentBuyOrder.price >= askPrice) {
                        currentBuyOrder.status = 'MATCHED';
                        trades.push({
                            ...currentBuyOrder,
                            pnl: -currentBuyOrder.amount * currentBuyOrder.price
                        });
                    }
                }

                if (currentSellOrder?.status === 'PENDING' && currentBuyOrder?.status === 'MATCHED') {
                    const liveData = await marketInfo.getLiveData(targetedMarket);
                    const orderBook = currentSellOrder.tokenId.includes('UP') ? liveData.BtcUp : liveData.BtcDown;
                    const bidPrice = parseFloat(orderBook.bids[0]?.price ?? '0');

                    if (currentSellOrder.price <= bidPrice) {
                        currentSellOrder.status = 'MATCHED';
                        currentSellOrder.pnl = (bidPrice - targetBuyPrice) * targetSize;
                        trades.push({
                            ...currentSellOrder,
                            pnl: currentSellOrder.amount * currentSellOrder.price
                        });
                    }
                }

            } catch {
                // Price data not available
            }
        },

        async onHourChange() {
            // Settle at period end (called every 15 minutes for quarterly markets)
            if (currentBuyOrder?.status === 'PENDING') currentBuyOrder.status = 'EXPIRED';
            if (currentSellOrder?.status === 'PENDING') currentSellOrder.status = 'EXPIRED';

            // Settle matched buy that wasn't sold
            if (currentBuyOrder?.status === 'MATCHED' && (!currentSellOrder || currentSellOrder.status !== 'MATCHED')) {
                const quarterWinner = marketInfo.getQuarterWinner(clock.now() - 60 * 1000);
                const isUpToken = currentBuyOrder.tokenId.includes('UP');
                const won = (quarterWinner === 'UP' && isUpToken) || (quarterWinner === 'DOWN' && !isUpToken);

                trades.push({
                    timestamp: clock.now(),
                    botName: name,
                    side: Side.BUY,
                    tokenId: currentBuyOrder.tokenId,
                    price: 0,
                    amount: currentBuyOrder.amount,
                    status: 'EXPIRED',
                    pnl: won ? currentBuyOrder.amount : 0,
                });
            }
            resetState();
        },

        getTrades() { return trades; },
        reset() { trades.length = 0; resetState(); priceHistory.length = 0; },
    };
}

/**
 * Quarterly Trend Following Bot - trend following for 15-minute markets
 * Uses same indicators as hourly version: MA crossovers, ADX, ATR, Donchian
 */
function createQuarterlyTrendFollowingBot(botParams: BotParams): SimulatedBot {
    const { name, clock, marketInfo, cdMarketData, params, targetedMarket } = botParams;

    const PERIOD_MINUTES = 15;

    // Parameters matching actual TrendFollowing bot (adjusted defaults for quarterly)
    const shortMaPeriod = (params.shortMaPeriod as number) ?? 3;
    const longMaPeriod = (params.longMaPeriod as number) ?? 10;
    const adxPeriod = (params.adxPeriod as number) ?? 7;
    const adxThreshold = (params.adxThreshold as number) ?? 20;
    const atrPeriod = (params.atrPeriod as number) ?? 7;
    const atrStopMultiple = (params.atrStopMultiple as number) ?? 2.0;
    const targetBuyPrice = (params.targetBuyPrice as number) ?? 0.50;
    const targetSellPrice = (params.targetSellPrice as number) ?? 0.60;
    const targetSize = (params.targetSize as number) ?? 10;
    const cutoffMinute = (params.cutoffMinute as number) ?? 10;

    type TradingState = 'WAITING_DATA' | 'MONITORING' | 'POSITION_OPEN' | 'PAST_CUTOFF';

    const trades: SimulatedTrade[] = [];
    const priceHistory: number[] = [];
    let state: TradingState = 'WAITING_DATA';
    let tradeDirection: 'UP' | 'DOWN' | null = null;
    let previousShortMa: number | null = null;
    let previousLongMa: number | null = null;
    let currentBuyOrder: SimulatedTrade | null = null;
    let currentSellOrder: SimulatedTrade | null = null;
    let entryPrice: number | null = null;

    const getMinuteInPeriod = (): number => {
        return clock.getMinutes() % PERIOD_MINUTES;
    };

    // --- Technical Indicator Calculations ---

    const calculateSMA = (prices: number[], period: number): number => {
        const slice = prices.slice(-period);
        return slice.reduce((sum, p) => sum + p, 0) / slice.length;
    };

    const wilderSmooth = (values: number[], period: number): number => {
        if (values.length < period) return 0;
        let smooth = values.slice(0, period).reduce((a, b) => a + b, 0);
        for (let i = period; i < values.length; i++) {
            smooth = smooth - (smooth / period) + values[i];
        }
        return smooth / period;
    };

    const calculateADX = (prices: number[], period: number): number => {
        if (prices.length < period + 1) return 0;

        const trueRanges: number[] = [];
        const plusDMs: number[] = [];
        const minusDMs: number[] = [];

        for (let i = 1; i < prices.length; i++) {
            const current = prices[i];
            const prev = prices[i - 1];
            const tr = Math.abs(current - prev);
            trueRanges.push(tr);

            const upMove = current - prev;
            const downMove = prev - current;
            plusDMs.push(upMove > downMove && upMove > 0 ? upMove : 0);
            minusDMs.push(downMove > upMove && downMove > 0 ? downMove : 0);
        }

        const smoothTR = wilderSmooth(trueRanges, period);
        const smoothPlusDM = wilderSmooth(plusDMs, period);
        const smoothMinusDM = wilderSmooth(minusDMs, period);

        if (smoothTR === 0) return 0;

        const plusDI = (smoothPlusDM / smoothTR) * 100;
        const minusDI = (smoothMinusDM / smoothTR) * 100;
        const diSum = plusDI + minusDI;

        if (diSum === 0) return 0;
        return (Math.abs(plusDI - minusDI) / diSum) * 100;
    };

    const calculateATR = (prices: number[], period: number): number => {
        if (prices.length < period + 1) return 0;

        const trueRanges: number[] = [];
        for (let i = 1; i < prices.length; i++) {
            const tr = Math.abs(prices[i] - prices[i - 1]);
            trueRanges.push(tr);
        }

        const recentTRs = trueRanges.slice(-period);
        return recentTRs.reduce((a, b) => a + b, 0) / recentTRs.length;
    };

    const calculateDonchian = (prices: number[], period: number): { high: number; low: number } => {
        const slice = prices.slice(-period);
        return { high: Math.max(...slice), low: Math.min(...slice) };
    };

    const calculateIndicators = () => {
        const requiredPeriods = Math.max(longMaPeriod, adxPeriod, atrPeriod) + 10;
        if (priceHistory.length < requiredPeriods) return null;

        const prices = priceHistory.slice(-requiredPeriods);
        const currentPrice = prices[prices.length - 1];

        return {
            shortMa: calculateSMA(prices, shortMaPeriod),
            longMa: calculateSMA(prices, longMaPeriod),
            adx: calculateADX(prices, adxPeriod),
            atr: calculateATR(prices, atrPeriod),
            currentPrice,
            ...calculateDonchian(prices, longMaPeriod),
        };
    };

    const detectCrossover = (shortMa: number, longMa: number): 'GOLDEN_CROSS' | 'DEATH_CROSS' | 'NONE' => {
        if (previousShortMa === null || previousLongMa === null) return 'NONE';
        const prevShortAboveLong = previousShortMa > previousLongMa;
        const currShortAboveLong = shortMa > longMa;

        if (!prevShortAboveLong && currShortAboveLong) return 'GOLDEN_CROSS';
        if (prevShortAboveLong && !currShortAboveLong) return 'DEATH_CROSS';
        return 'NONE';
    };

    const checkOrderFill = async (order: SimulatedTrade): Promise<boolean> => {
        const currentPrice = await marketInfo.getPrice(order.tokenId, order.side, targetedMarket);
        if (order.side === Side.BUY && currentPrice <= order.price) return true;
        if (order.side === Side.SELL && currentPrice >= order.price) return true;
        return false;
    };

    const resetState = () => {
        // DON'T clear priceHistory - indicators need continuous historical data across periods
        // priceHistory.length = 0;
        state = 'WAITING_DATA';
        tradeDirection = null;
        previousShortMa = null;
        previousLongMa = null;
        currentBuyOrder = null;
        currentSellOrder = null;
        entryPrice = null;
    };

    return {
        name,

        async onTick() {
            const minuteInPeriod = getMinuteInPeriod();
            const btcPrice = await cdMarketData.getCurrentPrice();

            // Build price history
            priceHistory.push(btcPrice);
            if (priceHistory.length > (longMaPeriod + adxPeriod + atrPeriod) * 2) {
                priceHistory.shift();
            }

            // Check order fills
            if (currentBuyOrder?.status === 'PENDING' && await checkOrderFill(currentBuyOrder)) {
                currentBuyOrder.status = 'MATCHED';
                currentBuyOrder.pnl = -(currentBuyOrder.price * currentBuyOrder.amount);

                // Create sell order
                if (!currentSellOrder && tradeDirection) {
                    const liveData = await marketInfo.getLiveData(targetedMarket);
                    const tokenId = tradeDirection === 'UP' ? liveData.BtcUpTokenId : liveData.BtcDownTokenId;
                    currentSellOrder = {
                        timestamp: clock.now(),
                        botName: name,
                        side: Side.SELL,
                        tokenId,
                        price: targetSellPrice,
                        amount: targetSize,
                        status: 'PENDING',
                    };
                    trades.push(currentSellOrder);
                }
            }

            if (currentSellOrder?.status === 'PENDING' && await checkOrderFill(currentSellOrder)) {
                currentSellOrder.status = 'MATCHED';
                currentSellOrder.pnl = currentSellOrder.price * currentSellOrder.amount;
            }

            // Handle cutoff
            if (isAfterCutoff(clock, targetedMarket, cutoffMinute) && state !== 'POSITION_OPEN') {
                if (currentBuyOrder?.status === 'PENDING') currentBuyOrder.status = 'CANCELED';
                state = 'PAST_CUTOFF';
                return;
            }

            if (state === 'PAST_CUTOFF') return;

            // Calculate indicators
            const indicators = calculateIndicators();
            if (!indicators) {
                state = 'WAITING_DATA';
                return;
            }

            const { shortMa, longMa, adx, atr, currentPrice, high: donchianHigh, low: donchianLow } = indicators;

            // Handle POSITION_OPEN state - monitor for ATR-based stop-loss
            if (state === 'POSITION_OPEN') {
                if (entryPrice !== null && atr > 0) {
                    const stopDistance = atr * atrStopMultiple;
                    const priceAgainstPosition = tradeDirection === 'UP'
                        ? currentPrice < entryPrice - stopDistance
                        : currentPrice > entryPrice + stopDistance;
                    const trendReversed = tradeDirection === 'UP'
                        ? shortMa < longMa
                        : shortMa > longMa;

                    if (priceAgainstPosition && trendReversed && currentBuyOrder?.status === 'PENDING') {
                        currentBuyOrder.status = 'CANCELED';
                        state = 'PAST_CUTOFF';
                    }
                }

                previousShortMa = shortMa;
                previousLongMa = longMa;
                return;
            }

            if (state === 'WAITING_DATA') {
                state = 'MONITORING';
                previousShortMa = shortMa;
                previousLongMa = longMa;
                return;
            }

            // Check for entry signals
            const signal = detectCrossover(shortMa, longMa);
            const trendStrong = adx >= adxThreshold;

            let shouldEnter = false;
            let direction: 'UP' | 'DOWN' | null = null;

            // MA Crossover signals
            if (signal === 'GOLDEN_CROSS' && trendStrong) {
                shouldEnter = true;
                direction = 'UP';
            } else if (signal === 'DEATH_CROSS' && trendStrong) {
                shouldEnter = true;
                direction = 'DOWN';
            }

            // Donchian breakout signals
            if (!shouldEnter && trendStrong) {
                if (currentPrice >= donchianHigh && shortMa > longMa) {
                    shouldEnter = true;
                    direction = 'UP';
                } else if (currentPrice <= donchianLow && shortMa < longMa) {
                    shouldEnter = true;
                    direction = 'DOWN';
                }
            }

            // Enter trade
            if (shouldEnter && direction && !currentBuyOrder) {
                tradeDirection = direction;
                entryPrice = currentPrice;
                const liveData = await marketInfo.getLiveData(targetedMarket);
                const tokenId = direction === 'UP' ? liveData.BtcUpTokenId : liveData.BtcDownTokenId;

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
                state = 'POSITION_OPEN';
            }

            previousShortMa = shortMa;
            previousLongMa = longMa;
        },

        async onHourChange() {
            // Settle at period end (called every 15 minutes for quarterly markets)
            if (currentBuyOrder?.status === 'PENDING') currentBuyOrder.status = 'EXPIRED';
            if (currentSellOrder?.status === 'PENDING') currentSellOrder.status = 'EXPIRED';

            // Settle matched buy that wasn't sold
            if (currentBuyOrder?.status === 'MATCHED' && (!currentSellOrder || currentSellOrder.status !== 'MATCHED')) {
                const quarterWinner = marketInfo.getQuarterWinner(clock.now() - 60 * 1000);
                const isUpToken = currentBuyOrder.tokenId.includes('UP');
                const won = (quarterWinner === 'UP' && isUpToken) || (quarterWinner === 'DOWN' && !isUpToken);

                trades.push({
                    timestamp: clock.now(),
                    botName: name,
                    side: Side.BUY,
                    tokenId: currentBuyOrder.tokenId,
                    price: 0,
                    amount: currentBuyOrder.amount,
                    status: 'EXPIRED',
                    pnl: won ? currentBuyOrder.amount : 0,
                });
            }
            resetState();
        },

        getTrades() { return trades; },
        reset() { trades.length = 0; resetState(); },
    };
}

/**
 * NCandle Bot - Multi-candle breakout with pullback confirmation and stop-loss
 * Features: Dynamic candle tracking, breakout detection, pullback confirmation,
 * stop-loss based on candle range, multiple trades per hour support
 */
function createNCandleBot(botParams: BotParams): SimulatedBot {
    const { name, clock, marketInfo, cdMarketData, params, targetedMarket } = botParams;

    // Parameters
    const candleMinutes = (params.candleMinutes as number) ?? 10;
    const breakoutBuffer = (params.breakoutBuffer as number) ?? 50;
    const pullbackBuffer = (params.pullbackBuffer as number) ?? 100;
    const buyPriceBuffer = (params.buyPriceBuffer as number) ?? 0.02;
    const sellPriceBuffer = (params.sellPriceBuffer as number) ?? 0.02;
    const minProfitMargin = (params.minProfitMargin as number) ?? 0.05;
    const stopLossMultiplier = (params.stopLossMultiplier as number) ?? 1.5;
    const targetSize = (params.targetSize as number) ?? 10;
    const cutoffMinute = (params.cutoffMinute as number) ?? 45;
    const maxTradesPerHour = (params.maxTradesPerHour as number) ?? 3;
    const maxSellPrice = 0.95;

    type TradingState = 'FORMING_CANDLE' | 'WAITING_BREAKOUT' | 'WAITING_PULLBACK' | 'TRADE_ACTIVE' | 'PAST_CUTOFF';

    interface Candle {
        high: number;
        low: number;
        open: number;
        close: number;
        startMinute: number;
    }

    const trades: SimulatedTrade[] = [];
    let state: TradingState = 'FORMING_CANDLE';
    let currentCandle: Candle | null = null;
    let lastCandleIndex = -1;
    let breakoutDirection: 'UP' | 'DOWN' | null = null;
    let breakoutConfirmedPrice: number | null = null;
    let currentBuyOrder: SimulatedTrade | null = null;
    let currentSellOrder: SimulatedTrade | null = null;
    let actualBuyPrice: number | null = null;
    let stopLossPrice: number | null = null;
    let tradesThisHour = 0;
    let candleRange = 0;

    const resetState = () => {
        state = 'FORMING_CANDLE';
        currentCandle = null;
        lastCandleIndex = -1;
        breakoutDirection = null;
        breakoutConfirmedPrice = null;
        currentBuyOrder = null;
        currentSellOrder = null;
        actualBuyPrice = null;
        stopLossPrice = null;
        tradesThisHour = 0;
        candleRange = 0;
    };

    const resetTradeState = () => {
        state = 'FORMING_CANDLE';
        currentCandle = null;
        breakoutDirection = null;
        breakoutConfirmedPrice = null;
        currentBuyOrder = null;
        currentSellOrder = null;
        actualBuyPrice = null;
        stopLossPrice = null;
        candleRange = 0;
        // Keep lastCandleIndex and tradesThisHour for continuity
    };

    const calculateStopLoss = (buyPrice: number, range: number): number => {
        const stopLossOffset = (range * stopLossMultiplier) / 10000;
        const stopLoss = Math.max(0.01, buyPrice - stopLossOffset);
        return Math.round(stopLoss * 100) / 100;
    };

    const checkOrderFill = async (order: SimulatedTrade): Promise<boolean> => {
        const currentPrice = await marketInfo.getPrice(order.tokenId, order.side, targetedMarket);
        if (order.side === Side.BUY && currentPrice <= order.price) return true;
        if (order.side === Side.SELL && currentPrice >= order.price) return true;
        return false;
    };

    const updateCandleTracking = (btcPrice: number) => {
        const minute = clock.getMinutes();
        const candleIndex = Math.floor(minute / candleMinutes);

        // New candle started
        if (candleIndex !== lastCandleIndex) {
            // Finalize previous candle if exists
            if (currentCandle) {
                currentCandle.close = btcPrice;
                candleRange = currentCandle.high - currentCandle.low;

                // If we were waiting for breakout/pullback and candle changed, reset
                if (state === 'WAITING_BREAKOUT' || state === 'WAITING_PULLBACK') {
                    state = 'FORMING_CANDLE';
                    breakoutDirection = null;
                    breakoutConfirmedPrice = null;
                }
            }

            // Start new candle
            currentCandle = {
                high: btcPrice,
                low: btcPrice,
                open: btcPrice,
                close: btcPrice,
                startMinute: candleIndex * candleMinutes,
            };
            lastCandleIndex = candleIndex;
        }

        // Update current candle
        if (currentCandle) {
            currentCandle.high = Math.max(currentCandle.high, btcPrice);
            currentCandle.low = Math.min(currentCandle.low, btcPrice);
            currentCandle.close = btcPrice;
        }
    };

    return {
        name,

        async onTick() {
            const minute = clock.getMinutes();
            const btcPrice = await cdMarketData.getCurrentPrice();

            // Update candle tracking
            updateCandleTracking(btcPrice);

            // Check buy order fill
            if (currentBuyOrder?.status === 'PENDING') {
                if (await checkOrderFill(currentBuyOrder)) {
                    currentBuyOrder.status = 'MATCHED';
                    currentBuyOrder.pnl = -(currentBuyOrder.price * currentBuyOrder.amount);

                    // Create sell order with dynamic pricing
                    if (!currentSellOrder && breakoutDirection && actualBuyPrice) {
                        const liveData = await marketInfo.getLiveData(targetedMarket);
                        const tokenId = breakoutDirection === 'UP' ? liveData.BtcUpTokenId : liveData.BtcDownTokenId;
                        const currentBidPrice = await marketInfo.getPrice(tokenId, Side.SELL, targetedMarket);

                        const marketSellPrice = Math.round((currentBidPrice - sellPriceBuffer) * 100) / 100;
                        const minSellPrice = Math.round((actualBuyPrice + minProfitMargin) * 100) / 100;
                        const dynamicSellPrice = Math.min(Math.max(marketSellPrice, minSellPrice), maxSellPrice);

                        currentSellOrder = {
                            timestamp: clock.now(),
                            botName: name,
                            side: Side.SELL,
                            tokenId,
                            price: dynamicSellPrice,
                            amount: targetSize,
                            status: 'PENDING',
                        };
                        trades.push(currentSellOrder);
                    }
                }
            }

            // Check stop-loss if buy matched but sell pending
            if (currentBuyOrder?.status === 'MATCHED' && currentSellOrder?.status === 'PENDING' && stopLossPrice && breakoutDirection) {
                const liveData = await marketInfo.getLiveData(targetedMarket);
                const tokenId = breakoutDirection === 'UP' ? liveData.BtcUpTokenId : liveData.BtcDownTokenId;
                const currentBidPrice = await marketInfo.getPrice(tokenId, Side.SELL, targetedMarket);

                if (currentBidPrice <= stopLossPrice) {
                    // Stop-loss triggered - update sell order to emergency price
                    currentSellOrder.price = Math.max(0.01, currentBidPrice - 0.02);
                    currentSellOrder.status = 'MATCHED';
                    currentSellOrder.pnl = currentSellOrder.price * currentSellOrder.amount;
                }
            }

            // Check sell order fill
            if (currentSellOrder?.status === 'PENDING') {
                if (await checkOrderFill(currentSellOrder)) {
                    currentSellOrder.status = 'MATCHED';
                    currentSellOrder.pnl = currentSellOrder.price * currentSellOrder.amount;
                }
            }

            // Check if trade completed - prepare for next trade
            if (currentBuyOrder?.status === 'MATCHED' && currentSellOrder?.status === 'MATCHED') {
                if (tradesThisHour < maxTradesPerHour && minute < cutoffMinute) {
                    resetTradeState();
                } else {
                    state = 'PAST_CUTOFF';
                }
                return;
            }

            // Handle cutoff
            if (isAfterCutoff(clock, targetedMarket, cutoffMinute) && state !== 'TRADE_ACTIVE') {
                if (currentBuyOrder?.status === 'PENDING') {
                    currentBuyOrder.status = 'CANCELED';
                }
                state = 'PAST_CUTOFF';
                return;
            }

            if (state === 'PAST_CUTOFF' || state === 'TRADE_ACTIVE') return;
            if (tradesThisHour >= maxTradesPerHour) return;
            if (!currentCandle) return;

            // State machine
            switch (state) {
                case 'FORMING_CANDLE': {
                    const candleEndMinute = currentCandle.startMinute + candleMinutes;
                    if (minute >= candleEndMinute) {
                        candleRange = currentCandle.high - currentCandle.low;
                        state = 'WAITING_BREAKOUT';
                    }
                    break;
                }

                case 'WAITING_BREAKOUT': {
                    const brokeAbove = btcPrice > currentCandle.high + breakoutBuffer;
                    const brokeBelow = btcPrice < currentCandle.low - breakoutBuffer;

                    if (brokeAbove) {
                        breakoutDirection = 'UP';
                        breakoutConfirmedPrice = currentCandle.high;
                        state = 'WAITING_PULLBACK';
                    } else if (brokeBelow) {
                        breakoutDirection = 'DOWN';
                        breakoutConfirmedPrice = currentCandle.low;
                        state = 'WAITING_PULLBACK';
                    }
                    break;
                }

                case 'WAITING_PULLBACK': {
                    if (!breakoutDirection || !breakoutConfirmedPrice) break;

                    let isPullbackConfirmed = false;
                    if (breakoutDirection === 'UP') {
                        const pullbackToSupport = Math.abs(btcPrice - breakoutConfirmedPrice) <= pullbackBuffer;
                        const stillAboveSupport = btcPrice >= breakoutConfirmedPrice;
                        isPullbackConfirmed = pullbackToSupport && stillAboveSupport;
                    } else {
                        const pullbackToResistance = Math.abs(btcPrice - breakoutConfirmedPrice) <= pullbackBuffer;
                        const stillBelowResistance = btcPrice <= breakoutConfirmedPrice;
                        isPullbackConfirmed = pullbackToResistance && stillBelowResistance;
                    }

                    if (isPullbackConfirmed) {
                        const liveData = await marketInfo.getLiveData(targetedMarket);
                        const tokenId = breakoutDirection === 'UP' ? liveData.BtcUpTokenId : liveData.BtcDownTokenId;
                        const currentAskPrice = await marketInfo.getPrice(tokenId, Side.BUY, targetedMarket);

                        const dynamicBuyPrice = Math.round((currentAskPrice + buyPriceBuffer) * 100) / 100;
                        actualBuyPrice = dynamicBuyPrice;
                        stopLossPrice = calculateStopLoss(dynamicBuyPrice, candleRange);

                        currentBuyOrder = {
                            timestamp: clock.now(),
                            botName: name,
                            side: Side.BUY,
                            tokenId,
                            price: dynamicBuyPrice,
                            amount: targetSize,
                            status: 'PENDING',
                        };
                        trades.push(currentBuyOrder);
                        tradesThisHour++;
                        state = 'TRADE_ACTIVE';
                    }
                    break;
                }
            }
        },

        async onHourChange() {
            // Expire pending orders
            if (currentBuyOrder?.status === 'PENDING') currentBuyOrder.status = 'EXPIRED';
            if (currentSellOrder?.status === 'PENDING') currentSellOrder.status = 'EXPIRED';

            // Settle matched buy that wasn't sold
            if (currentBuyOrder?.status === 'MATCHED' && (!currentSellOrder || currentSellOrder.status !== 'MATCHED')) {
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

            resetState();
        },

        getTrades() {
            return trades;
        },

        reset() {
            trades.length = 0;
            resetState();
        },
    };
}

/**
 * Quarterly NCandle Bot - NCandle strategy adapted for 15-minute quarterly markets
 * Features: Dynamic candle tracking, breakout detection, pullback confirmation,
 * stop-loss based on candle range, multiple trades per period support
 */
function createQuarterlyNCandleBot(botParams: BotParams): SimulatedBot {
    const { name, clock, marketInfo, cdMarketData, params, targetedMarket } = botParams;

    // Parameters adjusted for 15-minute periods
    const candleMinutes = (params.candleMinutes as number) ?? 3;
    const rawBreakoutBuffer = (params.breakoutBuffer as number) ?? 50;
    const rawPullbackBuffer = (params.pullbackBuffer as number) ?? 100;
    const buyPriceBuffer = (params.buyPriceBuffer as number) ?? 0.02;
    const sellPriceBuffer = (params.sellPriceBuffer as number) ?? 0.02;
    const minProfitMargin = (params.minProfitMargin as number) ?? 0.05;
    const stopLossMultiplier = (params.stopLossMultiplier as number) ?? 1.5;
    const targetSize = (params.targetSize as number) ?? 10;
    const rawCutoffMinute = (params.cutoffMinute as number) ?? 10;
    const maxTradesPerPeriod = (params.maxTradesPerPeriod as number) ?? 2;
    const maxSellPrice = 0.95;

    const PERIOD_MINUTES = 15;

    // Runtime constraints to ensure valid trading conditions:
    // 1. cutoffMinute must be > candleMinutes + 3 (time for breakout/pullback pattern)
    const minCutoff = candleMinutes + 4;
    const cutoffMinute = Math.max(rawCutoffMinute, minCutoff);
    // 2. pullbackBuffer must be >= breakoutBuffer for pullback to be confirmable at breakout
    const breakoutBuffer = rawBreakoutBuffer;
    const pullbackBuffer = Math.max(rawPullbackBuffer, rawBreakoutBuffer);

    type TradingState = 'FORMING_CANDLE' | 'WAITING_BREAKOUT' | 'WAITING_PULLBACK' | 'TRADE_ACTIVE' | 'PAST_CUTOFF';

    interface Candle {
        high: number;
        low: number;
        open: number;
        close: number;
        startMinute: number;
    }

    const trades: SimulatedTrade[] = [];
    let state: TradingState = 'FORMING_CANDLE';
    let currentCandle: Candle | null = null;
    let lastCandleIndex = -1;
    let breakoutDirection: 'UP' | 'DOWN' | null = null;
    let breakoutConfirmedPrice: number | null = null;
    let currentBuyOrder: SimulatedTrade | null = null;
    let currentSellOrder: SimulatedTrade | null = null;
    let actualBuyPrice: number | null = null;
    let stopLossPrice: number | null = null;
    let tradesThisPeriod = 0;
    let candleRange = 0;
    let lastPeriodIndex = -1;

    const getMinuteInPeriod = (): number => {
        return clock.getMinutes() % PERIOD_MINUTES;
    };

    const getPeriodIndex = (): number => {
        return Math.floor(clock.getMinutes() / PERIOD_MINUTES);
    };

    const resetState = () => {
        state = 'FORMING_CANDLE';
        currentCandle = null;
        lastCandleIndex = -1;
        breakoutDirection = null;
        breakoutConfirmedPrice = null;
        currentBuyOrder = null;
        currentSellOrder = null;
        actualBuyPrice = null;
        stopLossPrice = null;
        tradesThisPeriod = 0;
        candleRange = 0;
    };

    const resetTradeState = () => {
        state = 'FORMING_CANDLE';
        currentCandle = null;
        breakoutDirection = null;
        breakoutConfirmedPrice = null;
        currentBuyOrder = null;
        currentSellOrder = null;
        actualBuyPrice = null;
        stopLossPrice = null;
        candleRange = 0;
    };

    const calculateStopLoss = (buyPrice: number, range: number): number => {
        const stopLossOffset = (range * stopLossMultiplier) / 10000;
        const stopLoss = Math.max(0.01, buyPrice - stopLossOffset);
        return Math.round(stopLoss * 100) / 100;
    };

    const checkOrderFill = async (order: SimulatedTrade): Promise<boolean> => {
        const currentPrice = await marketInfo.getPrice(order.tokenId, order.side, targetedMarket);
        if (order.side === Side.BUY && currentPrice <= order.price) return true;
        if (order.side === Side.SELL && currentPrice >= order.price) return true;
        return false;
    };

    const updateCandleTracking = (btcPrice: number, minuteInPeriod: number) => {
        const candleIndex = Math.floor(minuteInPeriod / candleMinutes);

        // New candle started
        if (candleIndex !== lastCandleIndex) {
            if (currentCandle) {
                currentCandle.close = btcPrice;
                candleRange = currentCandle.high - currentCandle.low;

                // For quarterly markets, DON'T reset state on new candles
                // Allow breakout/pullback patterns to span multiple candles
                // since the 15-minute period is too short for patterns to
                // develop within a single candle window
            }

            currentCandle = {
                high: btcPrice,
                low: btcPrice,
                open: btcPrice,
                close: btcPrice,
                startMinute: candleIndex * candleMinutes,
            };
            lastCandleIndex = candleIndex;
        }

        if (currentCandle) {
            currentCandle.high = Math.max(currentCandle.high, btcPrice);
            currentCandle.low = Math.min(currentCandle.low, btcPrice);
            currentCandle.close = btcPrice;
        }
    };

    return {
        name,

        async onTick() {
            const minuteInPeriod = getMinuteInPeriod();
            const periodIndex = getPeriodIndex();

            // Reset on new period
            if (periodIndex !== lastPeriodIndex) {
                // Expire pending orders from previous period
                if (currentBuyOrder?.status === 'PENDING') currentBuyOrder.status = 'EXPIRED';
                if (currentSellOrder?.status === 'PENDING') currentSellOrder.status = 'EXPIRED';

                // Settle matched buy that wasn't sold
                if (currentBuyOrder?.status === 'MATCHED' && (!currentSellOrder || currentSellOrder.status !== 'MATCHED')) {
                    const quarterWinner = marketInfo.getQuarterWinner(clock.now() - 60 * 1000);
                    const isUpToken = currentBuyOrder.tokenId.startsWith('UP-');
                    const won = (quarterWinner === 'UP' && isUpToken) || (quarterWinner === 'DOWN' && !isUpToken);

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

                resetState();
                lastPeriodIndex = periodIndex;
            }

            try {
                const btcPrice = await cdMarketData.getCurrentPrice();

                // Update candle tracking
                updateCandleTracking(btcPrice, minuteInPeriod);

                // Check buy order fill
                if (currentBuyOrder?.status === 'PENDING') {
                    if (await checkOrderFill(currentBuyOrder)) {
                        currentBuyOrder.status = 'MATCHED';
                        currentBuyOrder.pnl = -(currentBuyOrder.price * currentBuyOrder.amount);

                        // Create sell order with dynamic pricing
                        if (!currentSellOrder && breakoutDirection && actualBuyPrice) {
                            const liveData = await marketInfo.getLiveData(targetedMarket);
                            const tokenId = breakoutDirection === 'UP' ? liveData.BtcUpTokenId : liveData.BtcDownTokenId;
                            const currentBidPrice = await marketInfo.getPrice(tokenId, Side.SELL, targetedMarket);

                            const marketSellPrice = Math.round((currentBidPrice - sellPriceBuffer) * 100) / 100;
                            const minSellPrice = Math.round((actualBuyPrice + minProfitMargin) * 100) / 100;
                            const dynamicSellPrice = Math.min(Math.max(marketSellPrice, minSellPrice), maxSellPrice);

                            currentSellOrder = {
                                timestamp: clock.now(),
                                botName: name,
                                side: Side.SELL,
                                tokenId,
                                price: dynamicSellPrice,
                                amount: targetSize,
                                status: 'PENDING',
                            };
                            trades.push(currentSellOrder);
                        }
                    }
                }

                // Check stop-loss
                if (currentBuyOrder?.status === 'MATCHED' && currentSellOrder?.status === 'PENDING' && stopLossPrice && breakoutDirection) {
                    const liveData = await marketInfo.getLiveData(targetedMarket);
                    const tokenId = breakoutDirection === 'UP' ? liveData.BtcUpTokenId : liveData.BtcDownTokenId;
                    const currentBidPrice = await marketInfo.getPrice(tokenId, Side.SELL, targetedMarket);

                    if (currentBidPrice <= stopLossPrice) {
                        currentSellOrder.price = Math.max(0.01, currentBidPrice - 0.02);
                        currentSellOrder.status = 'MATCHED';
                        currentSellOrder.pnl = currentSellOrder.price * currentSellOrder.amount;
                    }
                }

                // Check sell order fill
                if (currentSellOrder?.status === 'PENDING') {
                    if (await checkOrderFill(currentSellOrder)) {
                        currentSellOrder.status = 'MATCHED';
                        currentSellOrder.pnl = currentSellOrder.price * currentSellOrder.amount;
                    }
                }

                // Check if trade completed - prepare for next trade
                if (currentBuyOrder?.status === 'MATCHED' && currentSellOrder?.status === 'MATCHED') {
                    if (tradesThisPeriod < maxTradesPerPeriod && minuteInPeriod < cutoffMinute) {
                        resetTradeState();
                    } else {
                        state = 'PAST_CUTOFF';
                    }
                    return;
                }

                // Handle cutoff
                if (isAfterCutoff(clock, targetedMarket, cutoffMinute) && state !== 'TRADE_ACTIVE') {
                    if (currentBuyOrder?.status === 'PENDING') {
                        currentBuyOrder.status = 'CANCELED';
                    }
                    state = 'PAST_CUTOFF';
                    return;
                }

                if (state === 'PAST_CUTOFF' || state === 'TRADE_ACTIVE') return;
                if (tradesThisPeriod >= maxTradesPerPeriod) return;
                if (!currentCandle) return;

                // State machine
                switch (state) {
                    case 'FORMING_CANDLE': {
                        const candleEndMinute = currentCandle.startMinute + candleMinutes;
                        if (minuteInPeriod >= candleEndMinute) {
                            candleRange = currentCandle.high - currentCandle.low;
                            state = 'WAITING_BREAKOUT';
                        }
                        break;
                    }

                    case 'WAITING_BREAKOUT': {
                        const brokeAbove = btcPrice > currentCandle.high + breakoutBuffer;
                        const brokeBelow = btcPrice < currentCandle.low - breakoutBuffer;

                        if (brokeAbove) {
                            breakoutDirection = 'UP';
                            breakoutConfirmedPrice = currentCandle.high;
                            state = 'WAITING_PULLBACK';
                        } else if (brokeBelow) {
                            breakoutDirection = 'DOWN';
                            breakoutConfirmedPrice = currentCandle.low;
                            state = 'WAITING_PULLBACK';
                        }
                        break;
                    }

                    case 'WAITING_PULLBACK': {
                        if (!breakoutDirection || !breakoutConfirmedPrice) break;

                        let isPullbackConfirmed = false;
                        if (breakoutDirection === 'UP') {
                            const pullbackToSupport = Math.abs(btcPrice - breakoutConfirmedPrice) <= pullbackBuffer;
                            const stillAboveSupport = btcPrice >= breakoutConfirmedPrice;
                            isPullbackConfirmed = pullbackToSupport && stillAboveSupport;
                        } else {
                            const pullbackToResistance = Math.abs(btcPrice - breakoutConfirmedPrice) <= pullbackBuffer;
                            const stillBelowResistance = btcPrice <= breakoutConfirmedPrice;
                            isPullbackConfirmed = pullbackToResistance && stillBelowResistance;
                        }

                        if (isPullbackConfirmed) {
                            const liveData = await marketInfo.getLiveData(targetedMarket);
                            const tokenId = breakoutDirection === 'UP' ? liveData.BtcUpTokenId : liveData.BtcDownTokenId;
                            const currentAskPrice = await marketInfo.getPrice(tokenId, Side.BUY, targetedMarket);

                            const dynamicBuyPrice = Math.round((currentAskPrice + buyPriceBuffer) * 100) / 100;
                            actualBuyPrice = dynamicBuyPrice;
                            stopLossPrice = calculateStopLoss(dynamicBuyPrice, candleRange);

                            currentBuyOrder = {
                                timestamp: clock.now(),
                                botName: name,
                                side: Side.BUY,
                                tokenId,
                                price: dynamicBuyPrice,
                                amount: targetSize,
                                status: 'PENDING',
                            };
                            trades.push(currentBuyOrder);
                            tradesThisPeriod++;
                            state = 'TRADE_ACTIVE';
                        }
                        break;
                    }
                }
            } catch {
                // Price data not available
            }
        },

        async onHourChange() {
            // Settle at period end (called every 15 minutes for quarterly markets)
            if (currentBuyOrder?.status === 'PENDING') currentBuyOrder.status = 'EXPIRED';
            if (currentSellOrder?.status === 'PENDING') currentSellOrder.status = 'EXPIRED';

            // Settle matched buy that wasn't sold
            if (currentBuyOrder?.status === 'MATCHED' && (!currentSellOrder || currentSellOrder.status !== 'MATCHED')) {
                const quarterWinner = marketInfo.getQuarterWinner(clock.now() - 60 * 1000);
                const isUpToken = currentBuyOrder.tokenId.includes('UP');
                const won = (quarterWinner === 'UP' && isUpToken) || (quarterWinner === 'DOWN' && !isUpToken);

                trades.push({
                    timestamp: clock.now(),
                    botName: name,
                    side: Side.BUY,
                    tokenId: currentBuyOrder.tokenId,
                    price: 0,
                    amount: currentBuyOrder.amount,
                    status: 'EXPIRED',
                    pnl: won ? currentBuyOrder.amount : 0,
                });
            }
            resetState();
        },

        getTrades() {
            return trades;
        },

        reset() {
            trades.length = 0;
            resetState();
            lastPeriodIndex = -1;
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
            // Vary MA periods
            { targetSize: 10, shortMaPeriod: 3, longMaPeriod: 10, adxPeriod: 14, adxThreshold: 25, targetBuyPrice: 0.50, targetSellPrice: 0.60, cutoffMinute: 30 },
            { targetSize: 10, shortMaPeriod: 5, longMaPeriod: 15, adxPeriod: 14, adxThreshold: 25, targetBuyPrice: 0.50, targetSellPrice: 0.60, cutoffMinute: 30 },
            { targetSize: 10, shortMaPeriod: 5, longMaPeriod: 20, adxPeriod: 14, adxThreshold: 25, targetBuyPrice: 0.50, targetSellPrice: 0.60, cutoffMinute: 30 },
            { targetSize: 10, shortMaPeriod: 7, longMaPeriod: 25, adxPeriod: 14, adxThreshold: 25, targetBuyPrice: 0.50, targetSellPrice: 0.60, cutoffMinute: 30 },
            // Vary ADX threshold
            { targetSize: 10, shortMaPeriod: 5, longMaPeriod: 20, adxPeriod: 14, adxThreshold: 20, targetBuyPrice: 0.50, targetSellPrice: 0.60, cutoffMinute: 30 },
            { targetSize: 10, shortMaPeriod: 5, longMaPeriod: 20, adxPeriod: 14, adxThreshold: 30, targetBuyPrice: 0.50, targetSellPrice: 0.60, cutoffMinute: 30 },
            { targetSize: 10, shortMaPeriod: 5, longMaPeriod: 20, adxPeriod: 14, adxThreshold: 35, targetBuyPrice: 0.50, targetSellPrice: 0.60, cutoffMinute: 30 },
            // Vary ADX period
            { targetSize: 10, shortMaPeriod: 5, longMaPeriod: 20, adxPeriod: 10, adxThreshold: 25, targetBuyPrice: 0.50, targetSellPrice: 0.60, cutoffMinute: 30 },
            { targetSize: 10, shortMaPeriod: 5, longMaPeriod: 20, adxPeriod: 20, adxThreshold: 25, targetBuyPrice: 0.50, targetSellPrice: 0.60, cutoffMinute: 30 },
            // Vary buy/sell prices
            { targetSize: 10, shortMaPeriod: 5, longMaPeriod: 20, adxPeriod: 14, adxThreshold: 25, targetBuyPrice: 0.48, targetSellPrice: 0.58, cutoffMinute: 30 },
            { targetSize: 10, shortMaPeriod: 5, longMaPeriod: 20, adxPeriod: 14, adxThreshold: 25, targetBuyPrice: 0.52, targetSellPrice: 0.62, cutoffMinute: 30 },
            // Vary cutoff
            { targetSize: 10, shortMaPeriod: 5, longMaPeriod: 20, adxPeriod: 14, adxThreshold: 25, targetBuyPrice: 0.50, targetSellPrice: 0.60, cutoffMinute: 25 },
            { targetSize: 10, shortMaPeriod: 5, longMaPeriod: 20, adxPeriod: 14, adxThreshold: 25, targetBuyPrice: 0.50, targetSellPrice: 0.60, cutoffMinute: 35 },
        ],
    },
    {
        name: 'FirstCandle',
        factory: createFirstCandleBot,
        parameterSets: [
            // Vary candle formation time
            { targetSize: 10, candleMinutes: 10, breakoutBuffer: 50, pullbackBuffer: 100, targetBuyPrice: 0.50, targetSellPrice: 0.60, cutoffMinute: 45 },
            { targetSize: 10, candleMinutes: 15, breakoutBuffer: 50, pullbackBuffer: 100, targetBuyPrice: 0.50, targetSellPrice: 0.60, cutoffMinute: 45 },
            { targetSize: 10, candleMinutes: 20, breakoutBuffer: 50, pullbackBuffer: 100, targetBuyPrice: 0.50, targetSellPrice: 0.60, cutoffMinute: 45 },
            // Vary breakout buffer
            { targetSize: 10, candleMinutes: 15, breakoutBuffer: 30, pullbackBuffer: 75, targetBuyPrice: 0.50, targetSellPrice: 0.60, cutoffMinute: 45 },
            { targetSize: 10, candleMinutes: 15, breakoutBuffer: 75, pullbackBuffer: 125, targetBuyPrice: 0.50, targetSellPrice: 0.60, cutoffMinute: 45 },
            { targetSize: 10, candleMinutes: 15, breakoutBuffer: 100, pullbackBuffer: 150, targetBuyPrice: 0.50, targetSellPrice: 0.60, cutoffMinute: 45 },
            // Vary buy/sell prices
            { targetSize: 10, candleMinutes: 15, breakoutBuffer: 50, pullbackBuffer: 100, targetBuyPrice: 0.48, targetSellPrice: 0.58, cutoffMinute: 45 },
            { targetSize: 10, candleMinutes: 15, breakoutBuffer: 50, pullbackBuffer: 100, targetBuyPrice: 0.52, targetSellPrice: 0.62, cutoffMinute: 45 },
            // Vary cutoff
            { targetSize: 10, candleMinutes: 15, breakoutBuffer: 50, pullbackBuffer: 100, targetBuyPrice: 0.50, targetSellPrice: 0.60, cutoffMinute: 40 },
            { targetSize: 10, candleMinutes: 15, breakoutBuffer: 50, pullbackBuffer: 100, targetBuyPrice: 0.50, targetSellPrice: 0.60, cutoffMinute: 50 },
        ],
    },
    {
        name: 'FirstCandleV2',
        factory: createFirstCandleV2Bot,
        parameterSets: [
            // Vary candle formation time
            { targetSize: 10, candleMinutes: 10, breakoutBuffer: 50, pullbackBuffer: 100, buyPriceBuffer: 0.02, sellPriceBuffer: 0.02, minProfitMargin: 0.05, cutoffMinute: 45 },
            { targetSize: 10, candleMinutes: 15, breakoutBuffer: 50, pullbackBuffer: 100, buyPriceBuffer: 0.02, sellPriceBuffer: 0.02, minProfitMargin: 0.05, cutoffMinute: 45 },
            { targetSize: 10, candleMinutes: 20, breakoutBuffer: 50, pullbackBuffer: 100, buyPriceBuffer: 0.02, sellPriceBuffer: 0.02, minProfitMargin: 0.05, cutoffMinute: 45 },
            // Vary breakout buffer
            { targetSize: 10, candleMinutes: 15, breakoutBuffer: 30, pullbackBuffer: 75, buyPriceBuffer: 0.02, sellPriceBuffer: 0.02, minProfitMargin: 0.05, cutoffMinute: 45 },
            { targetSize: 10, candleMinutes: 15, breakoutBuffer: 75, pullbackBuffer: 125, buyPriceBuffer: 0.02, sellPriceBuffer: 0.02, minProfitMargin: 0.05, cutoffMinute: 45 },
            { targetSize: 10, candleMinutes: 15, breakoutBuffer: 100, pullbackBuffer: 150, buyPriceBuffer: 0.02, sellPriceBuffer: 0.02, minProfitMargin: 0.05, cutoffMinute: 45 },
            // Vary price buffers
            { targetSize: 10, candleMinutes: 15, breakoutBuffer: 50, pullbackBuffer: 100, buyPriceBuffer: 0.01, sellPriceBuffer: 0.01, minProfitMargin: 0.03, cutoffMinute: 45 },
            { targetSize: 10, candleMinutes: 15, breakoutBuffer: 50, pullbackBuffer: 100, buyPriceBuffer: 0.03, sellPriceBuffer: 0.03, minProfitMargin: 0.07, cutoffMinute: 45 },
            { targetSize: 10, candleMinutes: 15, breakoutBuffer: 50, pullbackBuffer: 100, buyPriceBuffer: 0.02, sellPriceBuffer: 0.01, minProfitMargin: 0.04, cutoffMinute: 45 },
            // Vary cutoff
            { targetSize: 10, candleMinutes: 15, breakoutBuffer: 50, pullbackBuffer: 100, buyPriceBuffer: 0.02, sellPriceBuffer: 0.02, minProfitMargin: 0.05, cutoffMinute: 40 },
            { targetSize: 10, candleMinutes: 15, breakoutBuffer: 50, pullbackBuffer: 100, buyPriceBuffer: 0.02, sellPriceBuffer: 0.02, minProfitMargin: 0.05, cutoffMinute: 50 },
        ],
    },
    {
        name: 'EveningStar',
        factory: createEveningStarBot,
        parameterSets: [
            // Vary candle duration
            { targetSize: 10, candleMinutes: 5, minBullishMove: 50, maxIndecisionRange: 30, minBearishMove: 50, targetBuyPrice: 0.50, targetSellPrice: 0.60, cutoffMinute: 45 },
            { targetSize: 10, candleMinutes: 10, minBullishMove: 50, maxIndecisionRange: 30, minBearishMove: 50, targetBuyPrice: 0.50, targetSellPrice: 0.60, cutoffMinute: 45 },
            { targetSize: 10, candleMinutes: 15, minBullishMove: 50, maxIndecisionRange: 30, minBearishMove: 50, targetBuyPrice: 0.50, targetSellPrice: 0.60, cutoffMinute: 45 },
            // Vary move thresholds
            { targetSize: 10, candleMinutes: 10, minBullishMove: 30, maxIndecisionRange: 20, minBearishMove: 30, targetBuyPrice: 0.50, targetSellPrice: 0.60, cutoffMinute: 45 },
            { targetSize: 10, candleMinutes: 10, minBullishMove: 75, maxIndecisionRange: 40, minBearishMove: 75, targetBuyPrice: 0.50, targetSellPrice: 0.60, cutoffMinute: 45 },
            { targetSize: 10, candleMinutes: 10, minBullishMove: 100, maxIndecisionRange: 50, minBearishMove: 100, targetBuyPrice: 0.50, targetSellPrice: 0.60, cutoffMinute: 45 },
            // Vary buy/sell prices
            { targetSize: 10, candleMinutes: 10, minBullishMove: 50, maxIndecisionRange: 30, minBearishMove: 50, targetBuyPrice: 0.48, targetSellPrice: 0.58, cutoffMinute: 45 },
            { targetSize: 10, candleMinutes: 10, minBullishMove: 50, maxIndecisionRange: 30, minBearishMove: 50, targetBuyPrice: 0.52, targetSellPrice: 0.62, cutoffMinute: 45 },
            // Vary cutoff
            { targetSize: 10, candleMinutes: 10, minBullishMove: 50, maxIndecisionRange: 30, minBearishMove: 50, targetBuyPrice: 0.50, targetSellPrice: 0.60, cutoffMinute: 40 },
            { targetSize: 10, candleMinutes: 10, minBullishMove: 50, maxIndecisionRange: 30, minBearishMove: 50, targetBuyPrice: 0.50, targetSellPrice: 0.60, cutoffMinute: 50 },
        ],
    },
    {
        name: 'MorningStar',
        factory: createMorningStarBot,
        parameterSets: [
            // Vary candle duration
            { targetSize: 10, candleMinutes: 5, minBearishMove: 50, maxIndecisionRange: 30, minBullishMove: 50, targetBuyPrice: 0.50, targetSellPrice: 0.60, cutoffMinute: 45 },
            { targetSize: 10, candleMinutes: 10, minBearishMove: 50, maxIndecisionRange: 30, minBullishMove: 50, targetBuyPrice: 0.50, targetSellPrice: 0.60, cutoffMinute: 45 },
            { targetSize: 10, candleMinutes: 15, minBearishMove: 50, maxIndecisionRange: 30, minBullishMove: 50, targetBuyPrice: 0.50, targetSellPrice: 0.60, cutoffMinute: 45 },
            // Vary move thresholds
            { targetSize: 10, candleMinutes: 10, minBearishMove: 30, maxIndecisionRange: 20, minBullishMove: 30, targetBuyPrice: 0.50, targetSellPrice: 0.60, cutoffMinute: 45 },
            { targetSize: 10, candleMinutes: 10, minBearishMove: 75, maxIndecisionRange: 40, minBullishMove: 75, targetBuyPrice: 0.50, targetSellPrice: 0.60, cutoffMinute: 45 },
            { targetSize: 10, candleMinutes: 10, minBearishMove: 100, maxIndecisionRange: 50, minBullishMove: 100, targetBuyPrice: 0.50, targetSellPrice: 0.60, cutoffMinute: 45 },
            // Vary buy/sell prices
            { targetSize: 10, candleMinutes: 10, minBearishMove: 50, maxIndecisionRange: 30, minBullishMove: 50, targetBuyPrice: 0.48, targetSellPrice: 0.58, cutoffMinute: 45 },
            { targetSize: 10, candleMinutes: 10, minBearishMove: 50, maxIndecisionRange: 30, minBullishMove: 50, targetBuyPrice: 0.52, targetSellPrice: 0.62, cutoffMinute: 45 },
            // Vary cutoff
            { targetSize: 10, candleMinutes: 10, minBearishMove: 50, maxIndecisionRange: 30, minBullishMove: 50, targetBuyPrice: 0.50, targetSellPrice: 0.60, cutoffMinute: 40 },
            { targetSize: 10, candleMinutes: 10, minBearishMove: 50, maxIndecisionRange: 30, minBullishMove: 50, targetBuyPrice: 0.50, targetSellPrice: 0.60, cutoffMinute: 50 },
        ],
    },
    {
        name: 'MeanReversion',
        factory: createMeanReversionBot,
        parameterSets: [
            // Vary lookback periods
            { targetSize: 10, lookbackPeriods: 10, entryThreshold: 2.0, targetBuyPrice: 0.50, targetSellPrice: 0.60, cutoffMinute: 45 },
            { targetSize: 10, lookbackPeriods: 20, entryThreshold: 2.0, targetBuyPrice: 0.50, targetSellPrice: 0.60, cutoffMinute: 45 },
            { targetSize: 10, lookbackPeriods: 30, entryThreshold: 2.0, targetBuyPrice: 0.50, targetSellPrice: 0.60, cutoffMinute: 45 },
            // Vary entry threshold
            { targetSize: 10, lookbackPeriods: 20, entryThreshold: 1.5, targetBuyPrice: 0.50, targetSellPrice: 0.60, cutoffMinute: 45 },
            { targetSize: 10, lookbackPeriods: 20, entryThreshold: 2.5, targetBuyPrice: 0.50, targetSellPrice: 0.60, cutoffMinute: 45 },
            { targetSize: 10, lookbackPeriods: 20, entryThreshold: 3.0, targetBuyPrice: 0.50, targetSellPrice: 0.60, cutoffMinute: 45 },
            // Vary buy/sell prices
            { targetSize: 10, lookbackPeriods: 20, entryThreshold: 2.0, targetBuyPrice: 0.48, targetSellPrice: 0.58, cutoffMinute: 45 },
            { targetSize: 10, lookbackPeriods: 20, entryThreshold: 2.0, targetBuyPrice: 0.52, targetSellPrice: 0.62, cutoffMinute: 45 },
            // Vary cutoff
            { targetSize: 10, lookbackPeriods: 20, entryThreshold: 2.0, targetBuyPrice: 0.50, targetSellPrice: 0.60, cutoffMinute: 40 },
            { targetSize: 10, lookbackPeriods: 20, entryThreshold: 2.0, targetBuyPrice: 0.50, targetSellPrice: 0.60, cutoffMinute: 50 },
            // Combined variations
            { targetSize: 10, lookbackPeriods: 15, entryThreshold: 1.75, targetBuyPrice: 0.48, targetSellPrice: 0.58, cutoffMinute: 40 },
            { targetSize: 10, lookbackPeriods: 25, entryThreshold: 2.25, targetBuyPrice: 0.52, targetSellPrice: 0.62, cutoffMinute: 50 },
        ],
    },
    // =========================================================================
    // Quarterly Market Bots (15-minute periods)
    // =========================================================================
    {
        name: 'QuarterlyFirstCandle',
        factory: createQuarterlyFirstCandleBot,
        parameterSets: [
            // Vary candle formation time (smaller for 15-min period)
            { targetSize: 10, candleMinutes: 2, breakoutBuffer: 30, pullbackBuffer: 50, targetBuyPrice: 0.50, targetSellPrice: 0.60, cutoffMinute: 10 },
            { targetSize: 10, candleMinutes: 3, breakoutBuffer: 30, pullbackBuffer: 50, targetBuyPrice: 0.50, targetSellPrice: 0.60, cutoffMinute: 10 },
            { targetSize: 10, candleMinutes: 4, breakoutBuffer: 30, pullbackBuffer: 50, targetBuyPrice: 0.50, targetSellPrice: 0.60, cutoffMinute: 10 },
            { targetSize: 10, candleMinutes: 5, breakoutBuffer: 30, pullbackBuffer: 50, targetBuyPrice: 0.50, targetSellPrice: 0.60, cutoffMinute: 10 },
            // Vary breakout buffer
            { targetSize: 10, candleMinutes: 3, breakoutBuffer: 20, pullbackBuffer: 40, targetBuyPrice: 0.50, targetSellPrice: 0.60, cutoffMinute: 10 },
            { targetSize: 10, candleMinutes: 3, breakoutBuffer: 50, pullbackBuffer: 75, targetBuyPrice: 0.50, targetSellPrice: 0.60, cutoffMinute: 10 },
            { targetSize: 10, candleMinutes: 3, breakoutBuffer: 75, pullbackBuffer: 100, targetBuyPrice: 0.50, targetSellPrice: 0.60, cutoffMinute: 10 },
            // Vary buy/sell prices
            { targetSize: 10, candleMinutes: 3, breakoutBuffer: 30, pullbackBuffer: 50, targetBuyPrice: 0.48, targetSellPrice: 0.58, cutoffMinute: 10 },
            { targetSize: 10, candleMinutes: 3, breakoutBuffer: 30, pullbackBuffer: 50, targetBuyPrice: 0.52, targetSellPrice: 0.62, cutoffMinute: 10 },
            // Vary cutoff (within 15-min period)
            { targetSize: 10, candleMinutes: 3, breakoutBuffer: 30, pullbackBuffer: 50, targetBuyPrice: 0.50, targetSellPrice: 0.60, cutoffMinute: 8 },
            { targetSize: 10, candleMinutes: 3, breakoutBuffer: 30, pullbackBuffer: 50, targetBuyPrice: 0.50, targetSellPrice: 0.60, cutoffMinute: 12 },
        ],
    },
    {
        name: 'QuarterlyMeanReversion',
        factory: createQuarterlyMeanReversionBot,
        parameterSets: [
            // Vary lookback periods
            { targetSize: 10, lookbackPeriods: 5, entryThreshold: 1.5, targetBuyPrice: 0.50, targetSellPrice: 0.60, cutoffMinute: 10 },
            { targetSize: 10, lookbackPeriods: 10, entryThreshold: 1.5, targetBuyPrice: 0.50, targetSellPrice: 0.60, cutoffMinute: 10 },
            { targetSize: 10, lookbackPeriods: 15, entryThreshold: 1.5, targetBuyPrice: 0.50, targetSellPrice: 0.60, cutoffMinute: 10 },
            // Vary entry threshold (tighter for faster markets)
            { targetSize: 10, lookbackPeriods: 10, entryThreshold: 1.0, targetBuyPrice: 0.50, targetSellPrice: 0.60, cutoffMinute: 10 },
            { targetSize: 10, lookbackPeriods: 10, entryThreshold: 2.0, targetBuyPrice: 0.50, targetSellPrice: 0.60, cutoffMinute: 10 },
            { targetSize: 10, lookbackPeriods: 10, entryThreshold: 2.5, targetBuyPrice: 0.50, targetSellPrice: 0.60, cutoffMinute: 10 },
            // Vary buy/sell prices
            { targetSize: 10, lookbackPeriods: 10, entryThreshold: 1.5, targetBuyPrice: 0.48, targetSellPrice: 0.58, cutoffMinute: 10 },
            { targetSize: 10, lookbackPeriods: 10, entryThreshold: 1.5, targetBuyPrice: 0.52, targetSellPrice: 0.62, cutoffMinute: 10 },
            // Vary cutoff
            { targetSize: 10, lookbackPeriods: 10, entryThreshold: 1.5, targetBuyPrice: 0.50, targetSellPrice: 0.60, cutoffMinute: 8 },
            { targetSize: 10, lookbackPeriods: 10, entryThreshold: 1.5, targetBuyPrice: 0.50, targetSellPrice: 0.60, cutoffMinute: 12 },
        ],
    },
    {
        name: 'QuarterlyTrendFollowing',
        factory: createQuarterlyTrendFollowingBot,
        parameterSets: [
            // Vary MA periods
            { targetSize: 10, shortMaPeriod: 2, longMaPeriod: 5, momentumThreshold: 0.5, targetBuyPrice: 0.50, targetSellPrice: 0.60, cutoffMinute: 10 },
            { targetSize: 10, shortMaPeriod: 3, longMaPeriod: 8, momentumThreshold: 0.5, targetBuyPrice: 0.50, targetSellPrice: 0.60, cutoffMinute: 10 },
            { targetSize: 10, shortMaPeriod: 4, longMaPeriod: 10, momentumThreshold: 0.5, targetBuyPrice: 0.50, targetSellPrice: 0.60, cutoffMinute: 10 },
            // Vary momentum threshold
            { targetSize: 10, shortMaPeriod: 3, longMaPeriod: 8, momentumThreshold: 0.3, targetBuyPrice: 0.50, targetSellPrice: 0.60, cutoffMinute: 10 },
            { targetSize: 10, shortMaPeriod: 3, longMaPeriod: 8, momentumThreshold: 0.75, targetBuyPrice: 0.50, targetSellPrice: 0.60, cutoffMinute: 10 },
            { targetSize: 10, shortMaPeriod: 3, longMaPeriod: 8, momentumThreshold: 1.0, targetBuyPrice: 0.50, targetSellPrice: 0.60, cutoffMinute: 10 },
            // Vary buy/sell prices
            { targetSize: 10, shortMaPeriod: 3, longMaPeriod: 8, momentumThreshold: 0.5, targetBuyPrice: 0.48, targetSellPrice: 0.58, cutoffMinute: 10 },
            { targetSize: 10, shortMaPeriod: 3, longMaPeriod: 8, momentumThreshold: 0.5, targetBuyPrice: 0.52, targetSellPrice: 0.62, cutoffMinute: 10 },
            // Vary cutoff
            { targetSize: 10, shortMaPeriod: 3, longMaPeriod: 8, momentumThreshold: 0.5, targetBuyPrice: 0.50, targetSellPrice: 0.60, cutoffMinute: 8 },
            { targetSize: 10, shortMaPeriod: 3, longMaPeriod: 8, momentumThreshold: 0.5, targetBuyPrice: 0.50, targetSellPrice: 0.60, cutoffMinute: 12 },
        ],
    },
];

// ============================================================================
// Parameter Bounds for Genetic Optimization
// ============================================================================

import { ParameterBounds } from './GeneticOptimizer.js';

const contrarianBounds: ParameterBounds = {
    targetSize: { min: 5, max: 20, step: 1 },
    targetBuyPrice: { min: 0.40, max: 0.55 },
    targetSellPrice: { min: 0.55, max: 0.70 },
    lookbackHours: { min: 1, max: 6, step: 1 },
    cutoffMinute: { min: 15, max: 45, step: 5 },
};

const trendFollowingBounds: ParameterBounds = {
    targetSize: { min: 5, max: 20, step: 1 },
    shortMaPeriod: { min: 1, max: 20, step: 1 },
    longMaPeriod: { min: 4, max: 60, step: 1 },
    adxPeriod: { min: 2, max: 50, step: 1 },
    adxThreshold: { min: 7, max: 80 },
    atrPeriod: { min: 5, max: 30, step: 1 },
    atrStopMultiple: { min: 1.0, max: 4.0 },
    targetBuyPrice: { min: 0.05, max: 0.95 },
    targetSellPrice: { min: 0.05, max: 0.95 },
    cutoffMinute: { min: 10, max: 50, step: 5 },
};

const firstCandleBounds: ParameterBounds = {
    targetSize: { min: 5, max: 20, step: 1 },
    candleMinutes: { min: 5, max: 30, step: 2 },
    breakoutBuffer: { min: 0, max: 1000 },
    pullbackBuffer: { min: 0, max: 1000 },
    targetBuyPrice: { min: 0.05, max: 0.95 },
    targetSellPrice: { min: 0.05, max: 0.95 },
    cutoffMinute: { min: 5, max: 55, step: 5 },
};

const firstCandleV2Bounds: ParameterBounds = {
    targetSize: { min: 5, max: 20, step: 1 },
    candleMinutes: { min: 5, max: 30, step: 2 },
    breakoutBuffer: { min: 10, max: 300 },
    pullbackBuffer: { min: 0, max: 1000 },
    buyPriceBuffer: { min: 0.01, max: 0.90 },
    sellPriceBuffer: { min: 0.01, max: 0.90 },
    minProfitMargin: { min: 0.01, max: 0.90 },
    maxSellPrice: { min: 0.60, max: 0.95 },  // MAX_SELL_PRICE capped at 0.95
    cutoffMinute: { min: 5, max: 55, step: 5 },
};

const eveningStarBounds: ParameterBounds = {
    targetSize: { min: 5, max: 20, step: 1 },
    candleMinutes: { min: 3, max: 20, step: 1 },
    minBullishMove: { min: 20, max: 150 },
    maxIndecisionRange: { min: 10, max: 75 },
    minBearishMove: { min: 20, max: 150 },
    targetBuyPrice: { min: 0.1, max: 0.9 },
    targetSellPrice: { min: 0.1, max: 0.9 },
    cutoffMinute: { min: 30, max: 55, step: 5 },
};

const morningStarBounds: ParameterBounds = {
    targetSize: { min: 5, max: 20, step: 1 },
    candleMinutes: { min: 3, max: 20, step: 1 },
    minBearishMove: { min: 20, max: 150 },
    maxIndecisionRange: { min: 10, max: 75 },
    minBullishMove: { min: 20, max: 150 },
    targetBuyPrice: { min: 0.10, max: 0.95 },
    targetSellPrice: { min: 0.10, max: 0.95 },
    cutoffMinute: { min: 30, max: 55, step: 5 },
};

const meanReversionBounds: ParameterBounds = {
    targetSize: { min: 5, max: 20, step: 1 },
    lookbackPeriods: { min: 5, max: 50, step: 1 },
    entryThreshold: { min: 1.0, max: 4.0 },
    targetBuyPrice: { min: 0.05, max: 0.95 },
    targetSellPrice: { min: 0.05, max: 0.95 },
    cutoffMinute: { min: 30, max: 55, step: 5 },
};

const nCandleBounds: ParameterBounds = {
    targetSize: { min: 5, max: 20, step: 1 },
    candleMinutes: { min: 3, max: 20, step: 1 },
    breakoutBuffer: { min: 0, max: 200 },
    pullbackBuffer: { min: 0, max: 250 },
    buyPriceBuffer: { min: 0.01, max: 0.10 },
    sellPriceBuffer: { min: 0.01, max: 0.10 },
    minProfitMargin: { min: 0.02, max: 0.15 },
    stopLossMultiplier: { min: 0.5, max: 3.0 },
    cutoffMinute: { min: 10, max: 55, step: 5 },
    maxTradesPerHour: { min: 1, max: 5, step: 1 },
};

// ============================================================================
// Quarterly Market Bounds (15-minute periods)
// ============================================================================

const quarterlyFirstCandleBounds: ParameterBounds = {
    targetSize: { min: 5, max: 20, step: 1 },
    candleMinutes: { min: 1, max: 12, step: 1 },  // Smaller for 15-min period
    breakoutBuffer: { min: 0, max: 500 },
    pullbackBuffer: { min: 0, max: 500 },
    targetBuyPrice: { min: 0.05, max: 0.95 },
    targetSellPrice: { min: 0.05, max: 0.95 },
    cutoffMinute: { min: 5, max: 13, step: 1 },  // Within 15-min period
};

const quarterlyMeanReversionBounds: ParameterBounds = {
    targetSize: { min: 5, max: 20, step: 1 },
    lookbackPeriods: { min: 3, max: 25, step: 1 },
    entryThreshold: { min: 0.5, max: 3.0 },  // Tighter for faster markets
    targetBuyPrice: { min: 0.05, max: 0.95 },
    targetSellPrice: { min: 0.05, max: 0.95 },
    cutoffMinute: { min: 5, max: 13, step: 1 },
};

const quarterlyTrendFollowingBounds: ParameterBounds = {
    targetSize: { min: 5, max: 20, step: 1 },
    shortMaPeriod: { min: 1, max: 8, step: 1 },
    longMaPeriod: { min: 1, max: 20, step: 1 },
    adxPeriod: { min: 1, max: 15, step: 1 },
    adxThreshold: { min: 1, max: 50 },
    atrPeriod: { min: 1, max: 15, step: 1 },
    atrStopMultiple: { min: 1.0, max: 4.0 },
    targetBuyPrice: { min: 0.05, max: 0.95 },
    targetSellPrice: { min: 0.05, max: 0.95 },
    cutoffMinute: { min: 5, max: 13, step: 1 },
};

const quarterlyNCandleBounds: ParameterBounds = {
    targetSize: { min: 5, max: 20, step: 1 },
    candleMinutes: { min: 1, max: 4, step: 1 },  // Short candles (1-4 min) to leave time for breakout/pullback
    breakoutBuffer: { min: 20, max: 150 },       // BTC price movement in $ to confirm breakout
    pullbackBuffer: { min: 50, max: 200 },       // Must be >= breakoutBuffer for pattern to work
    buyPriceBuffer: { min: 0.01, max: 0.05 },
    sellPriceBuffer: { min: 0.01, max: 0.05 },
    minProfitMargin: { min: 0.02, max: 0.08 },
    stopLossMultiplier: { min: 0.5, max: 2.0 },
    cutoffMinute: { min: 8, max: 13, step: 1 },  // Leave time after candle forms (min 8 ensures candle + pattern time)
    maxTradesPerPeriod: { min: 1, max: 2, step: 1 },
};

const earlyBuyerV2Bounds: ParameterBounds = {
    targetBuyPrice: { min: 0.40, max: 0.55 },    // Target buying below fair value
    targetSellPrice: { min: 0.55, max: 0.75 },   // Target selling above fair value
    targetSize: { min: 5, max: 25, step: 1 },
    cutoffMinute: { min: 15, max: 45, step: 1 }, // For hourly markets, how late to enter
    minFlops: { min: 1, max: 6 },                // Minimum market volatility to trade
    flopsLookbackHours: { min: 2, max: 12, step: 1 },  // Hours of flops data to average
    btcDirection: { min: 0, max: 1, step: 1 },   // 0 = DOWN, 1 = UP (will be converted to string)
};

const quarterlyEarlyBuyerV2Bounds: ParameterBounds = {
    targetBuyPrice: { min: 0.05, max: 0.95 },    // Target buying below fair value
    targetSellPrice: { min: 0.05, max: 0.95 },   // Target selling above fair value
    targetSize: { min: 5, max: 25, step: 1 },
    cutoffMinute: { min: 4, max: 12, step: 1 },  // Within 15-min period
    minFlops: { min: 1, max: 10 },                // Minimum market volatility to trade
    flopsLookbackHours: { min: 2, max: 12, step: 1 },  // Hours of flops data to average
    btcDirection: { min: 0, max: 1, step: 1 },   // 0 = DOWN, 1 = UP (will be converted to string)
};

const esotericNormalizationBounds: ParameterBounds = {
    // Distribution shape parameters
    baseStdDev: { min: 0, max: 300 },              // Initial std dev in $ at period start
    minStdDevRatio: { min: 0.1, max: 0.5 },         // Min std dev as ratio of base at period end
    timeDecayPower: { min: 0.5, max: 3.0 },         // How fast std dev shrinks (higher = faster)
    priceScaleMultiplier: { min: 0.5, max: 2.0 },   // Multiplier for price sensitivity
    priceScaleConstant: { min: -50, max: 50 },      // Constant offset for price calc
    // Trading parameters
    purchaseThreshold: { min: 0.04, max: 0.15 },    // Min diff to trigger buy
    sellPremium: { min: 0.02, max: 0.10 },          // Sell this much above expected
    targetSize: { min: 5, max: 25, step: 1 },
    cutoffMinute: { min: 30, max: 50, step: 1 },    // For hourly markets
    maxTradesPerPeriod: { min: 1, max: 3, step: 1 },
};

const quarterlyEsotericNormalizationBounds: ParameterBounds = {
    // Distribution shape parameters (adjusted for 15-min period)
    baseStdDev: { min: 0, max: 150 },              // Smaller for shorter period
    minStdDevRatio: { min: 0.1, max: 0.5 },
    timeDecayPower: { min: 0.5, max: 3.0 },
    priceScaleMultiplier: { min: 0.5, max: 2.0 },
    priceScaleConstant: { min: -25, max: 25 },
    // Trading parameters
    purchaseThreshold: { min: 0.04, max: 0.15 },
    sellPremium: { min: 0.02, max: 0.10 },
    targetSize: { min: 5, max: 25, step: 1 },
    cutoffMinute: { min: 5, max: 12, step: 1 },     // Within 15-min period
    maxTradesPerPeriod: { min: 1, max: 2, step: 1 },
};

const geneticStrategies = [
    { name: 'Contrarian', factory: createContrarianBot, bounds: contrarianBounds },
    { name: 'TrendFollowing', factory: createTrendFollowingBot, bounds: trendFollowingBounds },
    { name: 'FirstCandle', factory: createFirstCandleBot, bounds: firstCandleBounds },
    { name: 'FirstCandleV2', factory: createFirstCandleV2Bot, bounds: firstCandleV2Bounds },
    { name: 'EveningStar', factory: createEveningStarBot, bounds: eveningStarBounds },
    { name: 'MorningStar', factory: createMorningStarBot, bounds: morningStarBounds },
    { name: 'MeanReversion', factory: createMeanReversionBot, bounds: meanReversionBounds },
    { name: 'NCandle', factory: createNCandleBot, bounds: nCandleBounds },
    // Quarterly Market Strategies
    { name: 'QuarterlyFirstCandle', factory: createQuarterlyFirstCandleBot, bounds: quarterlyFirstCandleBounds },
    { name: 'QuarterlyMeanReversion', factory: createQuarterlyMeanReversionBot, bounds: quarterlyMeanReversionBounds },
    { name: 'QuarterlyTrendFollowing', factory: createQuarterlyTrendFollowingBot, bounds: quarterlyTrendFollowingBounds },
    { name: 'QuarterlyNCandle', factory: createQuarterlyNCandleBot, bounds: quarterlyNCandleBounds },
    { name: 'QuarterlyEarlyBuyerV2', factory: createQuarterlyEarlyBuyerV2Bot, bounds: quarterlyEarlyBuyerV2Bounds },
    { name: 'QuarterlyEsotericNormalization', factory: createQuarterlyEsotericNormalizationBot, bounds: quarterlyEsotericNormalizationBounds },
    // Flops-based Strategies (Hourly)
    { name: 'EarlyBuyerV2', factory: createEarlyBuyerV2Bot, bounds: earlyBuyerV2Bounds },
    // Normal Distribution Strategies
    { name: 'EsotericNormalization', factory: createEsotericNormalizationBot, bounds: esotericNormalizationBounds },
];

// ============================================================================
// Main Entry Point
// ============================================================================

async function main() {
    // Parse command line arguments
    const args = process.argv.slice(2);
    let lookbackDays = 7;
    let useGenetic = false;
    let maxGenerations = 50;
    let convergenceThreshold = 1.0;
    let populationSize = 15;
    let strategyFilter: string | null = null;
    let coinType: CoinType = CoinType.BTC;
    let auditTradesCount = 0; // Number of top trades to audit (0 = disabled)
    let targetedMarket: TargetedMarket = TargetedMarket.BITCOIN_HOURLY;

    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case '--days':
            case '-d':
                lookbackDays = parseInt(args[i + 1]) || 7;
                break;
            case '--genetic':
            case '-g':
                useGenetic = true;
                break;
            case '--max-gen':
            case '-m':
                maxGenerations = parseInt(args[i + 1]) || 50;
                break;
            case '--threshold':
            case '-t':
                convergenceThreshold = parseFloat(args[i + 1]) || 1.0;
                break;
            case '--population':
            case '-p':
                populationSize = parseInt(args[i + 1]) || 15;
                break;
            case '--strategy':
            case '-s':
                strategyFilter = args[i + 1] || null;
                break;
            case '--coin':
            case '-c':
                {
                    const coinArg = (args[i + 1] || '').toLowerCase();
                    if (coinArg === 'btc') coinType = CoinType.BTC;
                    else if (coinArg === 'eth') coinType = CoinType.ETH;
                    else if (coinArg === 'sol') coinType = CoinType.SOL;
                    else if (coinArg === 'xrp') coinType = CoinType.XRP;
                    else {
                        console.error(`Invalid coin type: ${args[i + 1]}. Valid options: btc, eth, sol, xrp`);
                        process.exit(1);
                    }
                    break;
                }
            case '--audit-trades':
            case '-a':
                auditTradesCount = parseInt(args[i + 1]) || 10;
                break;
            case '--market':
            case '-M':
                {
                    const marketArg = (args[i + 1] || '').toLowerCase();
                    if (marketArg === 'btc-hourly' || marketArg === 'bitcoin-hourly') {
                        targetedMarket = TargetedMarket.BITCOIN_HOURLY;
                    } else if (marketArg === 'btc-quarterly' || marketArg === 'bitcoin-quarterly') {
                        targetedMarket = TargetedMarket.BITCOIN_QUARTERLY;
                    } else if (marketArg === 'eth-hourly' || marketArg === 'ethereum-hourly') {
                        targetedMarket = TargetedMarket.ETHEREUM_HOURLY;
                    } else if (marketArg === 'eth-quarterly' || marketArg === 'ethereum-quarterly') {
                        targetedMarket = TargetedMarket.ETHEREUM_QUARTERLY;
                    } else if (marketArg === 'sol-quarterly' || marketArg === 'solana-quarterly') {
                        targetedMarket = TargetedMarket.SOLANA_QUARTERLY;
                    } else if (marketArg === 'solana-hourly' || marketArg === 'sol-hourly') {
                        targetedMarket = TargetedMarket.SOLANA_HOURLY
                    } else if (marketArg === 'xrp-hourly') {
                        targetedMarket = TargetedMarket.XRP_HOURLY;
                    } else if (marketArg === 'xrp-quarterly') {
                        targetedMarket = TargetedMarket.XRP_QUARTERLY;
                    } else {
                        console.error(`Invalid market: ${args[i + 1]}. Valid options: btc-hourly, btc-quarterly, eth-hourly, eth-quarterly, sol-quarterly,  sol-hourly, xrp-hourly, xrp-quarterly`);
                        process.exit(1);
                    }
                    break;
                }
            case '--help':
            case '-h':
                printHelp();
                process.exit(0);
        }
    }

    // Create logger and simulator
    const logger = new SimulatorLogger(useGenetic ? `genetic-${coinType}` : `sweep-${coinType}`);
    logger.log(`Log file: ${logger.getLogFilePath()}`);

    const simulator = new HistoricalSimulator({
        lookbackDays,
        tickIntervalMs: 60 * 1000,
        coinType,
        auditTradesCount,
        targetedMarket,
    });

    if (useGenetic) {
        // Genetic Algorithm Mode
        logger.log('');
        logger.log('╔════════════════════════════════════════════════════════════╗');
        logger.log('║      GENETIC ALGORITHM OPTIMIZATION - Historical Sim       ║');
        logger.log('╚════════════════════════════════════════════════════════════╝');

        logger.log(`\nConfiguration:`);
        logger.log(`  Coin Type: ${coinType.toUpperCase()}`);
        logger.log(`  Lookback Days: ${lookbackDays}`);
        logger.log(`  Max Generations: ${maxGenerations}`);
        logger.log(`  Convergence Threshold: $${convergenceThreshold.toFixed(2)}`);
        logger.log(`  Population Size: ${populationSize}`);

        const geneticConfig = {
            populationSize,
            maxGenerations,
            convergenceThreshold,
            convergenceGenerations: 5,
            mutationRate: 0.25,
            mutationStrength: 0.3,
            eliteCount: 2,
            crossoverRate: 0.7,
        };

        // Filter strategies if specified
        let strategies = geneticStrategies;
        if (strategyFilter) {
            strategies = geneticStrategies.filter(s =>
                s.name.toLowerCase() == strategyFilter!.toLowerCase()
            );
            if (strategies.length === 0) {
                logger.error(`\nNo strategies matching '${strategyFilter}' found.`);
                logger.log('Available strategies: ' + geneticStrategies.map(s => s.name).join(', '));
                process.exit(1);
            }
            logger.log(`  Strategy Filter: ${strategyFilter} (${strategies.length} matched)`);
        }

        try {
            await simulator.runMultiStrategyGeneticOptimization(strategies, geneticConfig);
        } catch (error) {
            logger.error(`\nGenetic optimization failed: ${error}`);
            process.exit(1);
        }
    } else {
        // Parameter Sweep Mode
        logger.log('');
        logger.log('╔════════════════════════════════════════════════════════════╗');
        logger.log('║         HISTORICAL SIMULATION - Parameter Sweep            ║');
        logger.log('╚════════════════════════════════════════════════════════════╝');

        logger.log(`\nConfiguration:`);
        logger.log(`  Coin Type: ${coinType.toUpperCase()}`);
        logger.log(`  Lookback Days: ${lookbackDays}`);
        logger.log(`  Bot Strategies: ${botConfigs.length}`);
        logger.log(`  Total Parameter Sets: ${botConfigs.reduce((sum, b) => sum + b.parameterSets.length, 0)}`);

        try {
            const results = await simulator.runParameterSweep(botConfigs);
            simulator.printSummary(results);
        } catch (error) {
            logger.error(`\nSimulation failed: ${error}`);
            process.exit(1);
        }
    }

    logger.log('\n✓ Simulation complete\n');
    logger.log(`Results saved to: ${logger.getLogFilePath()}`);
}

function printHelp(): void {
    console.log(`
Historical Simulation & Genetic Optimization

Usage: npm run histSim -- [options]

Options:
  -d, --days <n>        Lookback days for simulation (default: 7)
  -c, --coin <type>     Coin type to simulate: btc, eth, sol, xrp (default: btc)
  -M, --market <type>   Target market: btc-hourly, btc-quarterly, eth-hourly, eth-quarterly (default: btc-hourly)
  -g, --genetic         Use genetic algorithm optimization instead of parameter sweep
  -m, --max-gen <n>     Maximum generations for genetic optimization (default: 50)
  -t, --threshold <n>   Convergence threshold - stop if improvement < n (default: 1.0)
  -p, --population <n>  Population size per generation (default: 15)
  -s, --strategy <name> Only optimize specific strategy (e.g., "FirstCandle", "QuarterlyFirstCandle")
  -a, --audit-trades <n> Write top N and avg trades with parameters to audit file (default: 10 when enabled)
  -h, --help            Show this help message

Available Strategies:
  Hourly Markets (60-min periods):
    Contrarian, TrendFollowing, FirstCandle, FirstCandleV2,
    EveningStar, MorningStar, MeanReversion, EarlyBuyerV2,

  Quarterly Markets (15-min periods):
    QuarterlyFirstCandle, QuarterlyMeanReversion, QuarterlyTrendFollowing, QuarterlyEarlyBuyerV2

Examples:
  npm run histSim -- --days 14
  npm run histSim -- --coin eth --days 7
  npm run histSim -- --genetic --days 7 --max-gen 30
  npm run histSim -- -g -c sol -d 14 -m 100 -t 0.5 -p 20
  npm run histSim -- -g -s FirstCandle --max-gen 50
  npm run histSim -- -g -s QuarterlyFirstCandle --max-gen 30
`);
}

main();
