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
 * Trend Following Bot - Uses technical indicators for trend detection
 * Implements: Moving Average crossovers, ADX for trend strength, Donchian breakouts
 */
function createTrendFollowingBot(botParams: BotParams): SimulatedBot {
    const { name, clock, marketInfo, cdMarketData, params } = botParams;

    // Parameters matching actual TrendFollowing bot
    const shortMaPeriod = (params.shortMaPeriod as number) ?? 5;
    const longMaPeriod = (params.longMaPeriod as number) ?? 20;
    const adxPeriod = (params.adxPeriod as number) ?? 14;
    const adxThreshold = (params.adxThreshold as number) ?? 25;
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

    const calculateIndicators = () => {
        const requiredPeriods = Math.max(longMaPeriod, adxPeriod) + 10;
        if (priceHistory.length < requiredPeriods) return null;

        const prices = priceHistory.slice(-requiredPeriods);
        const currentPrice = prices[prices.length - 1];

        const shortMa = calculateSMA(prices, shortMaPeriod);
        const longMa = calculateSMA(prices, longMaPeriod);
        const adx = calculateADX(prices, adxPeriod);
        const donchian = calculateDonchian(prices, longMaPeriod);

        return { shortMa, longMa, adx, currentPrice, donchianHigh: donchian.high, donchianLow: donchian.low };
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
        const currentPrice = await marketInfo.getPrice(order.tokenId, order.side);
        if (order.side === Side.BUY && currentPrice <= order.price) return true;
        if (order.side === Side.SELL && currentPrice >= order.price) return true;
        return false;
    };

    const resetState = () => {
        priceHistory.length = 0;
        state = 'WAITING_DATA';
        tradeDirection = null;
        previousShortMa = null;
        previousLongMa = null;
        currentBuyOrder = null;
        currentSellOrder = null;
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
                    const liveData = await marketInfo.getLiveData();
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
            if (minute >= cutoffMinute && state !== 'POSITION_OPEN') {
                if (currentBuyOrder?.status === 'PENDING') currentBuyOrder.status = 'CANCELED';
                state = 'PAST_CUTOFF';
                return;
            }

            if (state === 'PAST_CUTOFF' || state === 'POSITION_OPEN') return;

            // Calculate indicators
            const indicators = calculateIndicators();
            if (!indicators) {
                state = 'WAITING_DATA';
                return;
            }

            const { shortMa, longMa, adx, currentPrice, donchianHigh, donchianLow } = indicators;

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
                const liveData = await marketInfo.getLiveData();
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
    const { name, clock, marketInfo, cdMarketData, params } = botParams;

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
        const currentPrice = await marketInfo.getPrice(order.tokenId, order.side);
        if (order.side === Side.BUY && currentPrice <= order.price) return true;
        if (order.side === Side.SELL && currentPrice >= order.price) return true;
        return false;
    };

    return {
        name,

        async onTick() {
            const minute = clock.getMinutes();
            const btcPrice = await cdMarketData.getCurrentPrice();

            // Check buy order fill
            if (currentBuyOrder?.status === 'PENDING') {
                if (await checkOrderFill(currentBuyOrder)) {
                    currentBuyOrder.status = 'MATCHED';
                    currentBuyOrder.pnl = -(currentBuyOrder.price * currentBuyOrder.amount);

                    // Create sell order
                    if (!currentSellOrder && breakoutDirection) {
                        const liveData = await marketInfo.getLiveData();
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
            if (minute >= cutoffMinute && state !== 'TRADE_ENTERED') {
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
                            const liveData = await marketInfo.getLiveData();
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
    const { name, clock, marketInfo, cdMarketData, params } = botParams;

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
        const currentPrice = await marketInfo.getPrice(order.tokenId, order.side);
        if (order.side === Side.BUY && currentPrice <= order.price) return true;
        if (order.side === Side.SELL && currentPrice >= order.price) return true;
        return false;
    };

    return {
        name,

        async onTick() {
            const minute = clock.getMinutes();
            const btcPrice = await cdMarketData.getCurrentPrice();

            // Check buy order fill
            if (currentBuyOrder?.status === 'PENDING') {
                if (await checkOrderFill(currentBuyOrder)) {
                    currentBuyOrder.status = 'MATCHED';
                    currentBuyOrder.pnl = -(currentBuyOrder.price * currentBuyOrder.amount);

                    // Create sell order with dynamic pricing
                    if (!currentSellOrder && breakoutDirection && actualBuyPrice) {
                        const liveData = await marketInfo.getLiveData();
                        const tokenId = breakoutDirection === 'UP' ? liveData.BtcUpTokenId : liveData.BtcDownTokenId;

                        const currentBidPrice = await marketInfo.getPrice(tokenId, Side.SELL);
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
            if (minute >= cutoffMinute && state !== 'TRADE_ENTERED') {
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
                            const liveData = await marketInfo.getLiveData();
                            const tokenId = breakoutDirection === 'UP' ? liveData.BtcUpTokenId : liveData.BtcDownTokenId;

                            // Dynamic buy price based on current ask
                            const currentAskPrice = await marketInfo.getPrice(tokenId, Side.BUY);
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
    const { name, clock, marketInfo, cdMarketData, params } = botParams;

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
        const currentPrice = await marketInfo.getPrice(order.tokenId, order.side);
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
                    const liveData = await marketInfo.getLiveData();
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
            if (minute >= cutoffMinute && state !== 'TRADE_ENTERED') {
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
                const liveData = await marketInfo.getLiveData();
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
    const { name, clock, marketInfo, cdMarketData, params } = botParams;

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
        const currentPrice = await marketInfo.getPrice(order.tokenId, order.side);
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
                    const liveData = await marketInfo.getLiveData();
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
            if (minute >= cutoffMinute && state !== 'TRADE_ENTERED') {
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
                const liveData = await marketInfo.getLiveData();
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
    const { name, clock, marketInfo, cdMarketData, params } = botParams;

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
        const currentPrice = await marketInfo.getPrice(order.tokenId, order.side);
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
                    const liveData = await marketInfo.getLiveData();
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
            if (minute >= cutoffMinute) {
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
                const liveData = await marketInfo.getLiveData();
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
                const liveData = await marketInfo.getLiveData();
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
    targetBuyPrice: { min: 0.05, max: 0.95 },
    targetSellPrice: { min: 0.05, max: 0.95 },
    cutoffMinute: { min: 10, max: 50, step: 5 },
};

const firstCandleBounds: ParameterBounds = {
    targetSize: { min: 5, max: 20, step: 1 },
    candleMinutes: { min: 5, max: 30, step: 2 },
    breakoutBuffer: { min: 10, max: 300 },
    pullbackBuffer: { min: 10, max: 400 },
    targetBuyPrice: { min: 0.05, max: 0.95 },
    targetSellPrice: { min: 0.05, max: 0.95 },
    cutoffMinute: { min: 5, max: 55, step: 5 },
};

const firstCandleV2Bounds: ParameterBounds = {
    targetSize: { min: 5, max: 20, step: 1 },
    candleMinutes: { min: 5, max: 30, step: 2 },
    breakoutBuffer: { min: 10, max: 300 },
    pullbackBuffer: { min: 5, max: 400 },
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

const geneticStrategies = [
    { name: 'Contrarian', factory: createContrarianBot, bounds: contrarianBounds },
    { name: 'TrendFollowing', factory: createTrendFollowingBot, bounds: trendFollowingBounds },
    { name: 'FirstCandle', factory: createFirstCandleBot, bounds: firstCandleBounds },
    { name: 'FirstCandleV2', factory: createFirstCandleV2Bot, bounds: firstCandleV2Bounds },
    { name: 'EveningStar', factory: createEveningStarBot, bounds: eveningStarBounds },
    { name: 'MorningStar', factory: createMorningStarBot, bounds: morningStarBounds },
    { name: 'MeanReversion', factory: createMeanReversionBot, bounds: meanReversionBounds },
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
            case '--help':
            case '-h':
                printHelp();
                process.exit(0);
        }
    }

    // Create simulator
    const simulator = new HistoricalSimulator({
        lookbackDays,
        tickIntervalMs: 60 * 1000,
    });

    if (useGenetic) {
        // Genetic Algorithm Mode
        console.log('');
        console.log('╔════════════════════════════════════════════════════════════╗');
        console.log('║      GENETIC ALGORITHM OPTIMIZATION - Historical Sim       ║');
        console.log('╚════════════════════════════════════════════════════════════╝');

        console.log(`\nConfiguration:`);
        console.log(`  Lookback Days: ${lookbackDays}`);
        console.log(`  Max Generations: ${maxGenerations}`);
        console.log(`  Convergence Threshold: $${convergenceThreshold.toFixed(2)}`);
        console.log(`  Population Size: ${populationSize}`);

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
                s.name.toLowerCase().includes(strategyFilter!.toLowerCase())
            );
            if (strategies.length === 0) {
                console.error(`\nNo strategies matching '${strategyFilter}' found.`);
                console.log('Available strategies:', geneticStrategies.map(s => s.name).join(', '));
                process.exit(1);
            }
            console.log(`  Strategy Filter: ${strategyFilter} (${strategies.length} matched)`);
        }

        try {
            await simulator.runMultiStrategyGeneticOptimization(strategies, geneticConfig);
        } catch (error) {
            console.error('\nGenetic optimization failed:', error);
            process.exit(1);
        }
    } else {
        // Parameter Sweep Mode
        console.log('');
        console.log('╔════════════════════════════════════════════════════════════╗');
        console.log('║         HISTORICAL SIMULATION - Parameter Sweep            ║');
        console.log('╚════════════════════════════════════════════════════════════╝');

        console.log(`\nConfiguration:`);
        console.log(`  Lookback Days: ${lookbackDays}`);
        console.log(`  Bot Strategies: ${botConfigs.length}`);
        console.log(`  Total Parameter Sets: ${botConfigs.reduce((sum, b) => sum + b.parameterSets.length, 0)}`);

        try {
            const results = await simulator.runParameterSweep(botConfigs);
            simulator.printSummary(results);
        } catch (error) {
            console.error('\nSimulation failed:', error);
            process.exit(1);
        }
    }

    console.log('\n✓ Simulation complete\n');
}

function printHelp(): void {
    console.log(`
Historical Simulation & Genetic Optimization

Usage: npm run histSim -- [options]

Options:
  -d, --days <n>        Lookback days for simulation (default: 7)
  -g, --genetic         Use genetic algorithm optimization instead of parameter sweep
  -m, --max-gen <n>     Maximum generations for genetic optimization (default: 50)
  -t, --threshold <n>   Convergence threshold - stop if improvement < n (default: 1.0)
  -p, --population <n>  Population size per generation (default: 15)
  -s, --strategy <name> Only optimize specific strategy (e.g., "FirstCandle")
  -h, --help            Show this help message

Examples:
  npm run histSim -- --days 14
  npm run histSim -- --genetic --days 7 --max-gen 30
  npm run histSim -- -g -d 14 -m 100 -t 0.5 -p 20
  npm run histSim -- -g -s FirstCandle --max-gen 50
`);
}

main();
