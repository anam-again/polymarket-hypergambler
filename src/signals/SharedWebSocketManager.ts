import { EventEmitter } from 'events';
import { RealTimePriceBuffer, BinanceSymbol } from './RealTimePriceBuffer.js';
import { PolymarketWebSocket, PolymarketPriceUpdate, PolymarketBook } from './PolymarketWebSocket.js';

/**
 * Shared manager for RealTimePriceBuffer instances.
 * Reuses existing buffers when multiple bots track the same Binance symbol.
 *
 * Usage:
 *   const buffer = SharedPriceBufferManager.getBuffer('BTCUSDT');
 *   // Both bots get the same buffer instance for BTCUSDT
 */
export class SharedPriceBufferManager {
    private static buffers: Map<BinanceSymbol, RealTimePriceBuffer> = new Map();
    private static refCounts: Map<BinanceSymbol, number> = new Map();

    /**
     * Gets or creates a shared price buffer for the given symbol.
     * Increments reference count for cleanup tracking.
     */
    public static getBuffer(symbol: BinanceSymbol, maxAgeMs: number = 5 * 60 * 1000): RealTimePriceBuffer {
        let buffer = this.buffers.get(symbol);

        if (!buffer) {
            buffer = new RealTimePriceBuffer(symbol, maxAgeMs);
            buffer.start();
            this.buffers.set(symbol, buffer);
            this.refCounts.set(symbol, 0);
            console.log(`[SharedPriceBuffer] Created new buffer for ${symbol}`);
        }

        // Increment reference count
        this.refCounts.set(symbol, (this.refCounts.get(symbol) ?? 0) + 1);
        console.log(`[SharedPriceBuffer] ${symbol} now has ${this.refCounts.get(symbol)} subscribers`);

        return buffer;
    }

    /**
     * Releases a reference to a buffer. Stops the buffer when no more references.
     */
    public static releaseBuffer(symbol: BinanceSymbol): void {
        const count = (this.refCounts.get(symbol) ?? 1) - 1;
        this.refCounts.set(symbol, count);

        console.log(`[SharedPriceBuffer] ${symbol} now has ${count} subscribers`);

        if (count <= 0) {
            const buffer = this.buffers.get(symbol);
            if (buffer) {
                buffer.stop();
                this.buffers.delete(symbol);
                this.refCounts.delete(symbol);
                console.log(`[SharedPriceBuffer] Stopped buffer for ${symbol}`);
            }
        }
    }

    /**
     * Gets statistics about active buffers.
     */
    public static getStats(): { symbol: BinanceSymbol; subscribers: number; bufferSize: number }[] {
        const stats: { symbol: BinanceSymbol; subscribers: number; bufferSize: number }[] = [];

        for (const [symbol, buffer] of this.buffers) {
            stats.push({
                symbol,
                subscribers: this.refCounts.get(symbol) ?? 0,
                bufferSize: buffer.getBufferSize(),
            });
        }

        return stats;
    }

    /**
     * Stops all buffers. Use for graceful shutdown.
     */
    public static stopAll(): void {
        for (const [symbol, buffer] of this.buffers) {
            buffer.stop();
            console.log(`[SharedPriceBuffer] Stopped buffer for ${symbol}`);
        }
        this.buffers.clear();
        this.refCounts.clear();
    }
}

/**
 * Callback type for Polymarket WebSocket events.
 */
export interface PolymarketSubscriber {
    id: string;
    assetIds: string[];
    onPrice?: (update: PolymarketPriceUpdate) => void;
    onBook?: (book: PolymarketBook) => void;
    onError?: (error: Error) => void;
}

/**
 * Shared manager for Polymarket WebSocket connections.
 * All bots share a single WebSocket connection with multiplexed subscriptions.
 *
 * Usage:
 *   const subscriberId = SharedPolymarketManager.subscribe({
 *       id: 'bot1',
 *       assetIds: [upTokenId, downTokenId],
 *       onPrice: (update) => { ... },
 *       onBook: (book) => { ... },
 *   });
 *
 *   // Later: SharedPolymarketManager.unsubscribe(subscriberId);
 */
export class SharedPolymarketManager extends EventEmitter {
    private static instance: SharedPolymarketManager | null = null;
    private ws: PolymarketWebSocket | null = null;
    private subscribers: Map<string, PolymarketSubscriber> = new Map();
    private allAssetIds: Set<string> = new Set();
    private pendingAssetIds: Set<string> = new Set(); // Assets to add once connected
    private isConnecting = false;
    private isConnected = false;

    private constructor() {
        super();
    }

    /**
     * Gets the singleton instance.
     */
    public static getInstance(): SharedPolymarketManager {
        if (!this.instance) {
            this.instance = new SharedPolymarketManager();
        }
        return this.instance;
    }

    /**
     * Subscribes to Polymarket WebSocket events for specific asset IDs.
     * Returns subscriber ID for later unsubscription.
     */
    public async subscribe(subscriber: PolymarketSubscriber): Promise<string> {
        // Store subscriber
        this.subscribers.set(subscriber.id, subscriber);

        // Track new asset IDs
        const newAssetIds = subscriber.assetIds.filter(id => !this.allAssetIds.has(id));
        subscriber.assetIds.forEach(id => this.allAssetIds.add(id));

        console.log(`[SharedPolymarket] Subscriber ${subscriber.id} added with ${subscriber.assetIds.length} assets`);
        console.log(`[SharedPolymarket] Total unique assets: ${this.allAssetIds.size}`);

        // Create or update WebSocket
        if (!this.ws && !this.isConnecting) {
            await this.connect();
        } else if (this.ws && this.isConnected && newAssetIds.length > 0) {
            // Add new subscriptions to existing connection
            await this.ws.addAssets(newAssetIds);
            console.log(`[SharedPolymarket] Added ${newAssetIds.length} new asset subscriptions`);
        } else if (this.isConnecting && newAssetIds.length > 0) {
            // Connection in progress - queue assets to add once connected
            newAssetIds.forEach(id => this.pendingAssetIds.add(id));
            console.log(`[SharedPolymarket] Queued ${newAssetIds.length} assets (connection in progress)`);
        }

        return subscriber.id;
    }

    /**
     * Unsubscribes a bot from the shared WebSocket.
     */
    public async unsubscribe(subscriberId: string): Promise<void> {
        const subscriber = this.subscribers.get(subscriberId);
        if (!subscriber) return;

        this.subscribers.delete(subscriberId);
        console.log(`[SharedPolymarket] Subscriber ${subscriberId} removed`);

        // Recalculate which asset IDs are still needed
        const stillNeeded = new Set<string>();
        for (const sub of this.subscribers.values()) {
            sub.assetIds.forEach(id => stillNeeded.add(id));
        }

        // Find asset IDs no longer needed
        const toRemove = [...this.allAssetIds].filter(id => !stillNeeded.has(id));
        this.allAssetIds = stillNeeded;

        if (toRemove.length > 0 && this.ws && this.isConnected) {
            await this.ws.removeAssets(toRemove);
            console.log(`[SharedPolymarket] Removed ${toRemove.length} asset subscriptions`);
        }

        // If no more subscribers, disconnect
        if (this.subscribers.size === 0) {
            this.disconnect();
        }
    }

    /**
     * Connects to Polymarket WebSocket with all current asset IDs.
     */
    private async connect(): Promise<void> {
        if (this.isConnecting || this.isConnected) return;

        this.isConnecting = true;
        console.log(`[SharedPolymarket] Connecting with ${this.allAssetIds.size} assets`);

        this.ws = new PolymarketWebSocket([...this.allAssetIds]);

        // Route events to appropriate subscribers
        this.ws.on('price', (update: PolymarketPriceUpdate) => {
            for (const subscriber of this.subscribers.values()) {
                if (subscriber.assetIds.includes(update.assetId) && subscriber.onPrice) {
                    subscriber.onPrice(update);
                }
            }
        });

        this.ws.on('book', (book: PolymarketBook) => {
            for (const subscriber of this.subscribers.values()) {
                if (subscriber.assetIds.includes(book.assetId) && subscriber.onBook) {
                    subscriber.onBook(book);
                }
            }
        });

        this.ws.on('error', (error: Error) => {
            for (const subscriber of this.subscribers.values()) {
                if (subscriber.onError) {
                    subscriber.onError(error);
                }
            }
        });

        this.ws.on('connected', async () => {
            this.isConnected = true;
            this.isConnecting = false;
            console.log('[SharedPolymarket] Connected');

            // Add any assets that were queued during connection
            if (this.pendingAssetIds.size > 0 && this.ws) {
                const pending = [...this.pendingAssetIds];
                this.pendingAssetIds.clear();
                await this.ws.addAssets(pending);
                console.log(`[SharedPolymarket] Added ${pending.length} queued assets after connection`);
            }

            this.emit('connected');
        });

        this.ws.on('disconnected', () => {
            this.isConnected = false;
            console.log('[SharedPolymarket] Disconnected');
            this.emit('disconnected');
        });

        await this.ws.connect();
    }

    /**
     * Disconnects from Polymarket WebSocket.
     */
    public disconnect(): void {
        if (this.ws) {
            this.ws.disconnect();
            this.ws = null;
        }
        this.isConnected = false;
        this.isConnecting = false;
        console.log('[SharedPolymarket] Disconnected and cleaned up');
    }

    /**
     * Checks if connected.
     */
    public isActive(): boolean {
        return this.isConnected;
    }

    /**
     * Gets the last known price for an asset.
     */
    public getLastPrice(assetId: string): PolymarketPriceUpdate | undefined {
        return this.ws?.getLastPrice(assetId);
    }

    /**
     * Gets the last known order book for an asset.
     */
    public getLastBook(assetId: string): PolymarketBook | undefined {
        return this.ws?.getLastBook(assetId);
    }

    /**
     * Gets statistics about the shared connection.
     */
    public getStats(): {
        subscriberCount: number;
        assetCount: number;
        isConnected: boolean;
        wsStats: { openWebSockets: number; assetIds: number } | null;
    } {
        return {
            subscriberCount: this.subscribers.size,
            assetCount: this.allAssetIds.size,
            isConnected: this.isConnected,
            wsStats: this.ws?.getStatistics() ?? null,
        };
    }

    /**
     * Resets the singleton (for testing).
     */
    public static reset(): void {
        if (this.instance) {
            this.instance.disconnect();
            this.instance = null;
        }
    }
}
