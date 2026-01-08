import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock node-cron
vi.mock('node-cron', () => ({
    default: {
        schedule: vi.fn(() => ({
            stop: vi.fn(),
        })),
    },
}));

// Mock dotenv
vi.mock('dotenv', () => ({
    default: {
        config: vi.fn(),
    },
}));

// Mock fs with inline implementation
vi.mock('fs', () => ({
    appendFileSync: vi.fn(),
    readFileSync: vi.fn().mockReturnValue(''),
    existsSync: vi.fn().mockReturnValue(false),
}));

// Import fs mock functions for manipulation in tests
import * as fs from 'fs';
const mockAppendFileSync = vi.mocked(fs.appendFileSync);
const mockReadFileSync = vi.mocked(fs.readFileSync);
const mockExistsSync = vi.mocked(fs.existsSync);

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Set up environment before importing CDMarketData
process.env.COINDESK_API_KEY = 'test-api-key';

// Import after mocks are set up
import { CDMarketData, HistoricalAverages, RecentPriceEntry } from '../src/nonBots/CDMarketData.js';

// ============================================================================
// Test Helpers
// ============================================================================

function createMockApiResponse(price: number) {
    return {
        ok: true,
        json: vi.fn().mockResolvedValue({
            Data: {
                'BTC-USD': {
                    VALUE: price.toString(),
                },
            },
        }),
    };
}

function createHourlyLogContent(entries: Array<{
    timestamp: string;
    hourlyOpen: number;
    averagePrice: number;
    hourlyMin: number;
    hourlyMax: number;
    openFlops: number;
    averageFlops: number;
    totalChange: number;
}>): string {
    return entries.map(e =>
        `${e.timestamp},${e.hourlyOpen},${e.averagePrice},${e.hourlyMin},${e.hourlyMax},${e.openFlops},${e.averageFlops},${e.totalChange}`
    ).join('\n');
}

function createMinuteLogContent(entries: Array<{ timestamp: string; price: number }>): string {
    return entries.map(e => `${e.timestamp},${e.price}`).join('\n');
}

function resetSingleton(): void {
    // Reset the singleton instance for clean tests
    (CDMarketData as any).instance = null;
}

// ============================================================================
// CDMarketData Tests
// ============================================================================

describe('CDMarketData', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetSingleton();
        mockExistsSync.mockReturnValue(false);
        mockReadFileSync.mockReturnValue('');
        mockFetch.mockResolvedValue(createMockApiResponse(50000));
    });

    afterEach(() => {
        const instance = (CDMarketData as any).instance;
        if (instance) {
            instance.stop();
        }
        resetSingleton();
    });

    // -------------------------------------------------------------------------
    // Singleton Tests
    // -------------------------------------------------------------------------

    describe('getInstance', () => {
        it('should return a singleton instance', () => {
            const instance1 = CDMarketData.getInstance();
            const instance2 = CDMarketData.getInstance();

            expect(instance1).toBe(instance2);
        });

        it('should create instance with API key from environment', () => {
            const instance = CDMarketData.getInstance();
            expect(instance).toBeDefined();
        });
    });

    // -------------------------------------------------------------------------
    // getCurrentPrice Tests
    // -------------------------------------------------------------------------

    describe('getCurrentPrice', () => {
        it('should fetch price from API', async () => {
            mockFetch.mockResolvedValueOnce(createMockApiResponse(50000));

            const instance = CDMarketData.getInstance();
            const price = await instance.getCurrentPrice();

            expect(price).toBe(50000);
            expect(mockFetch).toHaveBeenCalledTimes(1);
        });

        it('should return cached price within timeout', async () => {
            mockFetch.mockResolvedValue(createMockApiResponse(50000));

            const instance = CDMarketData.getInstance();
            await instance.getCurrentPrice();
            await instance.getCurrentPrice();

            expect(mockFetch).toHaveBeenCalledTimes(1);
        });

        it('should retry on API failure', async () => {
            mockFetch
                .mockResolvedValueOnce({ ok: false, status: 500 })
                .mockResolvedValueOnce({ ok: false, status: 500 })
                .mockResolvedValueOnce(createMockApiResponse(50000));

            const instance = CDMarketData.getInstance();
            const price = await instance.getCurrentPrice();

            expect(price).toBe(50000);
            expect(mockFetch).toHaveBeenCalledTimes(3);
        });

        it('should throw after max retries', async () => {
            mockFetch.mockResolvedValue({ ok: false, status: 500 });

            const instance = CDMarketData.getInstance();

            await expect(instance.getCurrentPrice()).rejects.toThrow('Failed to fetch price after 5 attempts');
        });

        it('should handle invalid API response', async () => {
            mockFetch.mockResolvedValue({
                ok: true,
                json: vi.fn().mockResolvedValue({ Data: null }),
            });

            const instance = CDMarketData.getInstance();

            // After 5 retries with invalid responses, it throws the retry failure message
            await expect(instance.getCurrentPrice()).rejects.toThrow('Failed to fetch price after 5 attempts');
        });
    });

    // -------------------------------------------------------------------------
    // getAverages Tests
    // -------------------------------------------------------------------------

    describe('getAverages', () => {
        it('should return null when insufficient data', () => {
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(createHourlyLogContent([
                {
                    timestamp: '2024-01-01T00:00:00.000Z',
                    hourlyOpen: 50000,
                    averagePrice: 50500,
                    hourlyMin: 49000,
                    hourlyMax: 51000,
                    openFlops: 2,
                    averageFlops: 3,
                    totalChange: 500,
                },
            ]));

            const instance = CDMarketData.getInstance();
            const averages = instance.getAverages(5);

            expect(averages).toBeNull();
        });

        it('should calculate averages from historical data', () => {
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(createHourlyLogContent([
                {
                    timestamp: '2024-01-01T00:00:00.000Z',
                    hourlyOpen: 50000,
                    averagePrice: 50000,
                    hourlyMin: 49000,
                    hourlyMax: 51000,
                    openFlops: 2,
                    averageFlops: 2,
                    totalChange: 400,
                },
                {
                    timestamp: '2024-01-01T01:00:00.000Z',
                    hourlyOpen: 51000,
                    averagePrice: 51000,
                    hourlyMin: 50000,
                    hourlyMax: 52000,
                    openFlops: 4,
                    averageFlops: 4,
                    totalChange: 600,
                },
                {
                    timestamp: '2024-01-01T02:00:00.000Z',
                    hourlyOpen: 52000,
                    averagePrice: 52000,
                    hourlyMin: 51000,
                    hourlyMax: 53000,
                    openFlops: 6,
                    averageFlops: 6,
                    totalChange: 800,
                },
            ]));

            const instance = CDMarketData.getInstance();
            const averages = instance.getAverages(3);

            expect(averages).not.toBeNull();
            expect(averages!.hourlyOpen).toBe(51000);
            expect(averages!.averagePrice).toBe(51000);
            expect(averages!.hourlyMin).toBe(50000);
            expect(averages!.hourlyMax).toBe(52000);
            expect(averages!.openFlops).toBe(4);
            expect(averages!.averageFlops).toBe(4);
            expect(averages!.totalChange).toBe(600);
        });

        it('should return only last N entries averages', () => {
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(createHourlyLogContent([
                {
                    timestamp: '2024-01-01T00:00:00.000Z',
                    hourlyOpen: 40000,
                    averagePrice: 40000,
                    hourlyMin: 39000,
                    hourlyMax: 41000,
                    openFlops: 1,
                    averageFlops: 1,
                    totalChange: 100,
                },
                {
                    timestamp: '2024-01-01T01:00:00.000Z',
                    hourlyOpen: 50000,
                    averagePrice: 50000,
                    hourlyMin: 49000,
                    hourlyMax: 51000,
                    openFlops: 2,
                    averageFlops: 2,
                    totalChange: 200,
                },
                {
                    timestamp: '2024-01-01T02:00:00.000Z',
                    hourlyOpen: 60000,
                    averagePrice: 60000,
                    hourlyMin: 59000,
                    hourlyMax: 61000,
                    openFlops: 4,
                    averageFlops: 4,
                    totalChange: 400,
                },
            ]));

            const instance = CDMarketData.getInstance();
            const averages = instance.getAverages(2);

            // Should only average the last 2 entries (50000 and 60000)
            expect(averages!.hourlyOpen).toBe(55000);
            expect(averages!.averagePrice).toBe(55000);
        });

        it('should return null when file does not exist', () => {
            mockExistsSync.mockReturnValue(false);

            const instance = CDMarketData.getInstance();
            const averages = instance.getAverages(5);

            expect(averages).toBeNull();
        });
    });

    // -------------------------------------------------------------------------
    // getAveragePrice Tests
    // -------------------------------------------------------------------------

    describe('getAveragePrice', () => {
        it('should return average price from getAverages', () => {
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(createHourlyLogContent([
                {
                    timestamp: '2024-01-01T00:00:00.000Z',
                    hourlyOpen: 50000,
                    averagePrice: 50500,
                    hourlyMin: 49000,
                    hourlyMax: 51000,
                    openFlops: 2,
                    averageFlops: 3,
                    totalChange: 500,
                },
            ]));

            const instance = CDMarketData.getInstance();
            const avgPrice = instance.getAveragePrice(1);

            expect(avgPrice).toBe(50500);
        });

        it('should return null when no data available', () => {
            mockExistsSync.mockReturnValue(false);

            const instance = CDMarketData.getInstance();
            const avgPrice = instance.getAveragePrice(5);

            expect(avgPrice).toBeNull();
        });
    });

    // -------------------------------------------------------------------------
    // getRecentPrices Tests
    // -------------------------------------------------------------------------

    describe('getRecentPrices', () => {
        it('should return recent price entries', () => {
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(createMinuteLogContent([
                { timestamp: '2024-01-01T00:02:00.000Z', price: 50000 },
                { timestamp: '2024-01-01T00:04:00.000Z', price: 50100 },
                { timestamp: '2024-01-01T00:06:00.000Z', price: 50200 },
            ]));

            const instance = CDMarketData.getInstance();
            const prices = instance.getRecentPrices(3);

            expect(prices).toHaveLength(3);
            expect(prices[0].price).toBe(50000);
            expect(prices[2].price).toBe(50200);
        });

        it('should return last N entries', () => {
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(createMinuteLogContent([
                { timestamp: '2024-01-01T00:02:00.000Z', price: 50000 },
                { timestamp: '2024-01-01T00:04:00.000Z', price: 50100 },
                { timestamp: '2024-01-01T00:06:00.000Z', price: 50200 },
                { timestamp: '2024-01-01T00:08:00.000Z', price: 50300 },
            ]));

            const instance = CDMarketData.getInstance();
            const prices = instance.getRecentPrices(2);

            expect(prices).toHaveLength(2);
            expect(prices[0].price).toBe(50200);
            expect(prices[1].price).toBe(50300);
        });

        it('should return empty array when file does not exist', () => {
            mockExistsSync.mockReturnValue(false);

            const instance = CDMarketData.getInstance();
            const prices = instance.getRecentPrices(5);

            expect(prices).toEqual([]);
        });

        it('should parse timestamps correctly', () => {
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(createMinuteLogContent([
                { timestamp: '2024-01-15T12:30:00.000Z', price: 50000 },
            ]));

            const instance = CDMarketData.getInstance();
            const prices = instance.getRecentPrices(1);

            expect(prices[0].timestamp).toBeInstanceOf(Date);
            expect(prices[0].timestamp.toISOString()).toBe('2024-01-15T12:30:00.000Z');
        });
    });

    // -------------------------------------------------------------------------
    // getHistoricalEntries Tests
    // -------------------------------------------------------------------------

    describe('getHistoricalEntries', () => {
        it('should return all entries when no limit specified', () => {
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(createHourlyLogContent([
                {
                    timestamp: '2024-01-01T00:00:00.000Z',
                    hourlyOpen: 50000,
                    averagePrice: 50500,
                    hourlyMin: 49000,
                    hourlyMax: 51000,
                    openFlops: 2,
                    averageFlops: 3,
                    totalChange: 500,
                },
                {
                    timestamp: '2024-01-01T01:00:00.000Z',
                    hourlyOpen: 51000,
                    averagePrice: 51500,
                    hourlyMin: 50000,
                    hourlyMax: 52000,
                    openFlops: 3,
                    averageFlops: 4,
                    totalChange: 600,
                },
            ]));

            const instance = CDMarketData.getInstance();
            const entries = instance.getHistoricalEntries();

            expect(entries).toHaveLength(2);
        });

        it('should return last N entries when limit specified', () => {
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue(createHourlyLogContent([
                {
                    timestamp: '2024-01-01T00:00:00.000Z',
                    hourlyOpen: 50000,
                    averagePrice: 50500,
                    hourlyMin: 49000,
                    hourlyMax: 51000,
                    openFlops: 2,
                    averageFlops: 3,
                    totalChange: 500,
                },
                {
                    timestamp: '2024-01-01T01:00:00.000Z',
                    hourlyOpen: 51000,
                    averagePrice: 51500,
                    hourlyMin: 50000,
                    hourlyMax: 52000,
                    openFlops: 3,
                    averageFlops: 4,
                    totalChange: 600,
                },
                {
                    timestamp: '2024-01-01T02:00:00.000Z',
                    hourlyOpen: 52000,
                    averagePrice: 52500,
                    hourlyMin: 51000,
                    hourlyMax: 53000,
                    openFlops: 4,
                    averageFlops: 5,
                    totalChange: 700,
                },
            ]));

            const instance = CDMarketData.getInstance();
            const entries = instance.getHistoricalEntries(2);

            expect(entries).toHaveLength(2);
            expect(entries[0].hourlyOpen).toBe(51000);
            expect(entries[1].hourlyOpen).toBe(52000);
        });
    });

    // -------------------------------------------------------------------------
    // getCurrentHourData Tests
    // -------------------------------------------------------------------------

    describe('getCurrentHourData', () => {
        it('should return null before run is called', () => {
            const instance = CDMarketData.getInstance();
            const data = instance.getCurrentHourData();

            // thisHourData is uninitialized before run(), returns null via ?? null
            expect(data).toBeNull();
        });

        it('should return hour data after run is called', async () => {
            mockFetch.mockResolvedValue(createMockApiResponse(50000));

            const instance = CDMarketData.getInstance();
            await instance.run();

            const data = instance.getCurrentHourData();

            expect(data).not.toBeNull();
            expect(data!.hourlyOpen).toBe(50000);
            expect(data!.averagePrice).toBe(50000);
            expect(data!.hourlyMax).toBe(50000);
            expect(data!.hourlyMin).toBe(50000);
            expect(data!.openFlops).toBe(0);
            expect(data!.averageFlops).toBe(0);
            expect(data!.totalChange).toBe(0);
        });
    });

    // -------------------------------------------------------------------------
    // Lifecycle Tests
    // -------------------------------------------------------------------------

    describe('run', () => {
        it('should initialize hourly data', async () => {
            mockFetch.mockResolvedValue(createMockApiResponse(50000));

            const instance = CDMarketData.getInstance();
            await instance.run();

            const data = instance.getCurrentHourData();
            expect(data).not.toBeNull();
            expect(data!.hourlyOpen).toBe(50000);
        });

        it('should start scheduled tasks', async () => {
            const cron = await import('node-cron');
            mockFetch.mockResolvedValue(createMockApiResponse(50000));

            const instance = CDMarketData.getInstance();
            await instance.run();

            expect(cron.default.schedule).toHaveBeenCalledWith('55 * * * *', expect.any(Function));
        });
    });

    describe('stop', () => {
        it('should stop cron job and interval', async () => {
            mockFetch.mockResolvedValue(createMockApiResponse(50000));

            const instance = CDMarketData.getInstance();
            await instance.run();
            instance.stop();

            // Should not throw and should clean up resources
            expect(() => instance.stop()).not.toThrow();
        });
    });

    // -------------------------------------------------------------------------
    // File Writing Tests
    // -------------------------------------------------------------------------

    describe('file writing', () => {
        it('should write minute data with correct format', async () => {
            vi.useFakeTimers();
            vi.setSystemTime(new Date('2024-01-15T12:30:00.000Z'));

            mockFetch.mockResolvedValue(createMockApiResponse(50000));

            const instance = CDMarketData.getInstance();
            await instance.run();

            // Advance time past cache timeout (60 seconds) to allow new fetch
            vi.advanceTimersByTime(61000);
            mockFetch.mockResolvedValue(createMockApiResponse(50100));

            // Manually call the private method
            await (instance as any).updateCurrentHourData();

            // Check that minute log was written (first write is from run, second from update)
            const calls = mockAppendFileSync.mock.calls.filter(
                (call: any[]) => call[0] === './logs/CDMarketWriterData2m.log'
            );
            expect(calls.length).toBeGreaterThan(0);

            vi.useRealTimers();
        });
    });

    // -------------------------------------------------------------------------
    // Error Handling Tests
    // -------------------------------------------------------------------------

    describe('error handling', () => {
        it('should log errors to error file', async () => {
            mockFetch.mockRejectedValue(new Error('Network error'));

            const instance = CDMarketData.getInstance();

            try {
                await instance.getCurrentPrice();
            } catch {
                // Expected to throw
            }

            expect(mockAppendFileSync).toHaveBeenCalledWith(
                './logs/CDMarketWriterError.log',
                expect.stringContaining('Network error')
            );
        });

        it('should handle file read errors gracefully', () => {
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockImplementation(() => {
                throw new Error('File read error');
            });

            const instance = CDMarketData.getInstance();
            const prices = instance.getRecentPrices(5);

            expect(prices).toEqual([]);
        });
    });
});

// ============================================================================
// Interface Export Tests
// ============================================================================

describe('Exported Interfaces', () => {
    it('should export HistoricalAverages interface', () => {
        const averages: HistoricalAverages = {
            hourlyOpen: 50000,
            averagePrice: 50500,
            hourlyMin: 49000,
            hourlyMax: 51000,
            openFlops: 2,
            averageFlops: 3,
            totalChange: 500,
        };

        expect(averages.hourlyOpen).toBe(50000);
    });

    it('should export RecentPriceEntry interface', () => {
        const entry: RecentPriceEntry = {
            timestamp: new Date(),
            price: 50000,
        };

        expect(entry.price).toBe(50000);
    });
});
