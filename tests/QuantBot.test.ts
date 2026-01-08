import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Side } from '@polymarket/clob-client';
import { QuantBot, TradeOrder, TradeStatus, QuantBotProps } from '../src/bots/QuantBot.js';

// Mock node-cron
vi.mock('node-cron', () => ({
    default: {
        schedule: vi.fn(),
    },
}));

// Mock fs
vi.mock('fs', () => ({
    appendFileSync: vi.fn(),
}));

// ============================================================================
// Mock Factories
// ============================================================================

function createMockMarketInfo() {
    return {
        getLiveData: vi.fn().mockResolvedValue({
            BtcUpTokenId: 'mock-up-token',
            BtcDownTokenId: 'mock-down-token',
        }),
        getPrice: vi.fn().mockResolvedValue(0.5),
        getBitcoinHourlyUrl: vi.fn().mockReturnValue('mock-url'),
        getCurrentEstTimestamp: vi.fn().mockReturnValue(Date.now()),
        getMarketInfo: vi.fn().mockResolvedValue({
            outcomePrices: ['0.6', '0.4'],
            clobTokenIds: ['token-up', 'token-down'],
        }),
    };
}

function createMockClobClient() {
    return {
        createAndPostOrder: vi.fn().mockResolvedValue({
            orderID: 'mock-order-id',
            success: true,
            errorMsg: '',
            status: 'LIVE',
        }),
        cancelOrder: vi.fn().mockResolvedValue({}),
        getOrder: vi.fn().mockResolvedValue({
            status: 'LIVE',
            size_matched: '0',
            price: '0.5',
        }),
    };
}

function createQuantBotProps(overrides?: Partial<QuantBotProps>): QuantBotProps {
    return {
        name: 'test-bot',
        hourlyDollarLimit: 10,
        client: createMockClobClient() as any,
        marketInfo: createMockMarketInfo() as any,
        PROD_MODE: false,
        ...overrides,
    };
}

// ============================================================================
// TestableQuantBot - Exposes protected methods for testing
// ============================================================================

class TestableQuantBot extends QuantBot {
    public getSpentThisHour(): number {
        return (this as any).spentThisHour;
    }

    public setSpentThisHour(amount: number): void {
        (this as any).spentThisHour = amount;
    }
}

// ============================================================================
// TradeOrder Tests
// ============================================================================

describe('TradeOrder', () => {
    describe('constructor', () => {
        it('should create a TradeOrder with all properties', () => {
            const props = {
                orderId: 'order-123',
                name: 'test-order',
                createdAt: Date.now(),
                targetBuyPrice: 0.5,
                amount: 10,
                totalCost: 5,
                isProd: false,
                clobTokenId: 'token-123',
                status: TradeStatus.LIVE,
                side: Side.BUY,
            };

            const order = new TradeOrder(props);

            expect(order.orderId).toBe('order-123');
            expect(order.name).toBe('test-order');
            expect(order.targetBuyPrice).toBe(0.5);
            expect(order.amount).toBe(10);
            expect(order.totalCost).toBe(5);
            expect(order.isProd).toBe(false);
            expect(order.status).toBe(TradeStatus.LIVE);
            expect(order.side).toBe(Side.BUY);
        });
    });

    describe('events', () => {
        it('should emit and receive events', () => {
            const order = new TradeOrder({
                orderId: 'order-123',
                name: 'test-order',
                createdAt: Date.now(),
                amount: 10,
                totalCost: 5,
                isProd: false,
                clobTokenId: 'token-123',
                status: TradeStatus.LIVE,
                side: Side.BUY,
            });

            const listener = vi.fn();
            order.on('tradeMatched', listener);
            order.emit('tradeMatched');

            expect(listener).toHaveBeenCalledTimes(1);
        });

        it('should remove event listeners with off', () => {
            const order = new TradeOrder({
                orderId: 'order-123',
                name: 'test-order',
                createdAt: Date.now(),
                amount: 10,
                totalCost: 5,
                isProd: false,
                clobTokenId: 'token-123',
                status: TradeStatus.LIVE,
                side: Side.BUY,
            });

            const listener = vi.fn();
            order.on('tradeMatched', listener);
            order.off('tradeMatched', listener);
            order.emit('tradeMatched');

            expect(listener).not.toHaveBeenCalled();
        });

        it('should handle once listeners', () => {
            const order = new TradeOrder({
                orderId: 'order-123',
                name: 'test-order',
                createdAt: Date.now(),
                amount: 10,
                totalCost: 5,
                isProd: false,
                clobTokenId: 'token-123',
                status: TradeStatus.LIVE,
                side: Side.BUY,
            });

            const listener = vi.fn();
            order.once('tradeMatched', listener);
            order.emit('tradeMatched');
            order.emit('tradeMatched');

            expect(listener).toHaveBeenCalledTimes(1);
        });
    });
});

// ============================================================================
// QuantBot Tests
// ============================================================================

describe('QuantBot', () => {
    let bot: TestableQuantBot;

    beforeEach(() => {
        vi.clearAllMocks();
        bot = new TestableQuantBot(createQuantBotProps());
    });

    describe('constructor', () => {
        it('should initialize with correct properties', () => {
            expect(bot.trades).toEqual([]);
            expect(bot.marketInfo).toBeDefined();
            expect(bot.client).toBeDefined();
        });
    });

    describe('canSpend', () => {
        it('should return true when within budget', () => {
            expect(bot.canSpend(5)).toBe(true);
        });

        it('should return true when exactly at budget', () => {
            expect(bot.canSpend(10)).toBe(true);
        });

        it('should return false when over budget', () => {
            expect(bot.canSpend(11)).toBe(false);
        });

        it('should account for already spent amount', () => {
            bot.setSpentThisHour(8);
            expect(bot.canSpend(2)).toBe(true);
            expect(bot.canSpend(3)).toBe(false);
        });
    });

    describe('recordSpend', () => {
        it('should record spending for BUY orders', () => {
            const result = bot.recordSpend(5, Side.BUY);
            expect(result).toBe(true);
            expect(bot.getSpentThisHour()).toBe(5);
        });

        it('should not record spending for SELL orders', () => {
            const result = bot.recordSpend(5, Side.SELL);
            expect(result).toBe(true);
            expect(bot.getSpentThisHour()).toBe(0);
        });

        it('should reject spend that exceeds limit', () => {
            bot.setSpentThisHour(8);
            const result = bot.recordSpend(5, Side.BUY);
            expect(result).toBe(false);
        });
    });

    describe('checkIfOrderIsValid', () => {
        it('should reject orders with amount less than 5', () => {
            expect(bot.checkIfOrderIsValid(0.5, 4)).toBe(false);
        });

        it('should reject orders with total cost less than 1', () => {
            expect(bot.checkIfOrderIsValid(0.1, 5)).toBe(false);
        });

        it('should accept valid orders', () => {
            expect(bot.checkIfOrderIsValid(0.5, 10)).toBe(true);
        });

        it('should accept orders exactly at minimum', () => {
            expect(bot.checkIfOrderIsValid(0.2, 5)).toBe(true);
        });
    });

    describe('makeOrder', () => {
        it('should create an order in test mode', async () => {
            const order = await bot.makeOrder(
                'test-buy',
                'token-123',
                0.5,
                10,
                Side.BUY
            );

            expect(order).toBeDefined();
            expect(order?.name).toBe('test-buy');
            expect(order?.status).toBe(TradeStatus.LIVE);
            expect(order?.side).toBe(Side.BUY);
            expect(bot.trades.length).toBe(1);
        });

        it('should return existing order if name already exists', async () => {
            const order1 = await bot.makeOrder('test-buy', 'token-123', 0.5, 10, Side.BUY);
            const order2 = await bot.makeOrder('test-buy', 'token-456', 0.6, 20, Side.BUY);

            expect(order1).toBe(order2);
            expect(bot.trades.length).toBe(1);
        });

        it('should reject order when budget exceeded', async () => {
            bot.setSpentThisHour(9);
            const order = await bot.makeOrder('test-buy', 'token-123', 0.5, 10, Side.BUY);

            expect(order).toBeUndefined();
            expect(bot.trades.length).toBe(0);
        });

        it('should not check budget for SELL orders', async () => {
            bot.setSpentThisHour(10);
            const order = await bot.makeOrder('test-sell', 'token-123', 0.5, 10, Side.SELL);

            expect(order).toBeDefined();
            expect(bot.trades.length).toBe(1);
        });
    });

    describe('cancelTrade', () => {
        it('should cancel a trade and update status', async () => {
            const order = await bot.makeOrder('test-buy', 'token-123', 0.5, 10, Side.BUY);
            expect(order).toBeDefined();

            const result = await bot.cancelTrade(order!);
            expect(result).toBe(true);
            expect(order!.status).toBe(TradeStatus.CANCELED);
        });

        it('should refund spent amount on cancel', async () => {
            await bot.makeOrder('test-buy', 'token-123', 0.5, 10, Side.BUY);
            expect(bot.getSpentThisHour()).toBe(5);

            await bot.cancelTrade(bot.trades[0]);
            expect(bot.getSpentThisHour()).toBe(0);
        });
    });

    describe('events', () => {
        it('should emit and receive hourly events', () => {
            const listener = vi.fn();
            bot.on('hourly', listener);
            bot.emit('hourly');

            expect(listener).toHaveBeenCalledTimes(1);
        });

        it('should handle once listeners', () => {
            const listener = vi.fn();
            bot.once('hourly', listener);
            bot.emit('hourly');
            bot.emit('hourly');

            expect(listener).toHaveBeenCalledTimes(1);
        });
    });

    describe('tickWrapper', () => {
        beforeEach(() => {
            vi.useFakeTimers();
        });

        afterEach(() => {
            vi.useRealTimers();
        });

        it('should execute function immediately', async () => {
            const fn = vi.fn();
            bot.tickWrapper(1000, 0, fn);

            await vi.advanceTimersByTimeAsync(0);
            expect(fn).toHaveBeenCalledTimes(1);
        });

        it('should stop when stop function is called', async () => {
            const fn = vi.fn();
            const stop = bot.tickWrapper(100, 0, fn);

            await vi.advanceTimersByTimeAsync(0);
            expect(fn).toHaveBeenCalledTimes(1);

            stop();
            await vi.advanceTimersByTimeAsync(500);
            expect(fn).toHaveBeenCalledTimes(1);
        });
    });
});

// ============================================================================
// TradeStatus Enum Tests
// ============================================================================

describe('TradeStatus', () => {
    it('should have correct values', () => {
        expect(TradeStatus.LIVE).toBe('LIVE');
        expect(TradeStatus.MATCHED).toBe('MATCHED');
        expect(TradeStatus.EXPIRED).toBe('EXPIRED');
        expect(TradeStatus.CANCELED).toBe('CANCELED');
        expect(TradeStatus.PARTIAL).toBe('PARTIAL');
    });
});
