import { WSSubscriptionManager, BookEvent, PolymarketPriceUpdateEvent, LastTradePriceEvent, PriceChangeEvent, PriceLevel } from '@nevuamarkets/poly-websockets';
import { EventEmitter } from 'events';

/**
 * WebSocket connection to Polymarket for real-time order book and price updates.
 * Uses the @nevuamarkets/poly-websockets library for managed connections.
 *
 * Events:
 * - 'book': Full order book snapshot
 * - 'priceChange': Order book level updates
 * - 'price': Calculated mid-price update (using Polymarket's display logic)
 * - 'lastTrade': Last trade price update
 * - 'connected': WebSocket connected
 * - 'disconnected': WebSocket disconnected
 * - 'error': Connection or parsing error
 */
export interface PolymarketPriceUpdate {
    assetId: string;
    midPrice: number;
    bestBid: number;
    bestAsk: number;
    spread: number;
    timestamp: number;
}

export interface PolymarketBookLevel {
    price: number;
    size: number;
}

export interface PolymarketBook {
    assetId: string;
    bids: PolymarketBookLevel[];
    asks: PolymarketBookLevel[];
    timestamp: number;
}

export class PolymarketWebSocket extends EventEmitter {
    private manager: WSSubscriptionManager | null = null;
    private assetIds: string[] = [];
    private isConnected = false;
    private lastPrices: Map<string, PolymarketPriceUpdate> = new Map();
    private lastBooks: Map<string, PolymarketBook> = new Map();

    constructor(assetIds: string[]) {
        super();
        this.assetIds = [...assetIds];
    }

    /**
     * Connects to Polymarket WebSocket and subscribes to asset IDs.
     */
    public async connect(): Promise<void> {
        console.log(`[PolymarketWS] Connecting with ${this.assetIds.length} assets`);

        this.manager = new WSSubscriptionManager({
            onWSOpen: async () => {
                console.log('[PolymarketWS] Connected');
                this.isConnected = true;
                this.emit('connected');
            },

            onWSClose: async () => {
                console.log('[PolymarketWS] Disconnected');
                this.isConnected = false;
                this.emit('disconnected');
            },

            onBook: async (events: BookEvent[]) => {
                for (const event of events) {
                    const book = this.convertBookEvent(event);
                    this.lastBooks.set(book.assetId, book);
                    this.emit('book', book);
                    this.updatePriceFromBook(book);
                }
            },

            onPriceChange: async (events: PriceChangeEvent[]) => {
                for (const event of events) {
                    this.emit('priceChange', event);
                }
            },

            onLastTradePrice: async (events: LastTradePriceEvent[]) => {
                for (const event of events) {
                    this.emit('lastTrade', {
                        assetId: event.asset_id,
                        price: parseFloat(event.price),
                        timestamp: parseInt(event.timestamp),
                    });
                }
            },

            onPolymarketPriceUpdate: async (events: PolymarketPriceUpdateEvent[]) => {
                for (const event of events) {
                    const bestBid = this.getBestBid(event.book.bids);
                    const bestAsk = this.getBestAsk(event.book.asks);

                    const update: PolymarketPriceUpdate = {
                        assetId: event.asset_id,
                        midPrice: parseFloat(event.price),
                        bestBid,
                        bestAsk,
                        spread: parseFloat(event.spread),
                        timestamp: parseInt(event.timestamp) || Date.now(),
                    };
                    this.lastPrices.set(update.assetId, update);
                    this.emit('price', update);
                }
            },

            onError: async (error: Error) => {
                console.error(`[PolymarketWS] Error: ${error.message}`);
                this.emit('error', error);
            },
        });

        // Subscribe to initial asset IDs
        await this.manager.addSubscriptions(this.assetIds);
    }

    /**
     * Converts BookEvent from library to our PolymarketBook format.
     */
    private convertBookEvent(event: BookEvent): PolymarketBook {
        return {
            assetId: event.asset_id,
            bids: event.bids.map((b: PriceLevel) => ({
                price: parseFloat(b.price),
                size: parseFloat(b.size),
            })),
            asks: event.asks.map((a: PriceLevel) => ({
                price: parseFloat(a.price),
                size: parseFloat(a.size),
            })),
            timestamp: parseInt(event.timestamp) || Date.now(),
        };
    }

    /**
     * Gets best bid from price levels.
     */
    private getBestBid(bids: PriceLevel[]): number {
        if (bids.length === 0) return 0;
        return Math.max(...bids.map(b => parseFloat(b.price)));
    }

    /**
     * Gets best ask from price levels.
     */
    private getBestAsk(asks: PriceLevel[]): number {
        if (asks.length === 0) return 1;
        return Math.min(...asks.map(a => parseFloat(a.price)));
    }

    /**
     * Updates internal price state from order book.
     */
    private updatePriceFromBook(book: PolymarketBook): void {
        const bestBid = book.bids.length > 0
            ? Math.max(...book.bids.map(b => b.price))
            : 0;
        const bestAsk = book.asks.length > 0
            ? Math.min(...book.asks.map(a => a.price))
            : 1;

        const update: PolymarketPriceUpdate = {
            assetId: book.assetId,
            midPrice: (bestBid + bestAsk) / 2,
            bestBid,
            bestAsk,
            spread: bestAsk - bestBid,
            timestamp: book.timestamp,
        };

        this.lastPrices.set(book.assetId, update);
        this.emit('price', update);
    }

    /**
     * Adds new asset IDs to subscription (dynamic).
     */
    public async addAssets(assetIds: string[]): Promise<void> {
        if (!this.manager) return;
        this.assetIds.push(...assetIds);
        await this.manager.addSubscriptions(assetIds);
    }

    /**
     * Removes asset IDs from subscription.
     */
    public async removeAssets(assetIds: string[]): Promise<void> {
        if (!this.manager) return;
        this.assetIds = this.assetIds.filter(id => !assetIds.includes(id));
        await this.manager.removeSubscriptions(assetIds);
    }

    /**
     * Gets the last known price for an asset.
     */
    public getLastPrice(assetId: string): PolymarketPriceUpdate | undefined {
        return this.lastPrices.get(assetId);
    }

    /**
     * Gets the last known order book for an asset.
     */
    public getLastBook(assetId: string): PolymarketBook | undefined {
        return this.lastBooks.get(assetId);
    }

    /**
     * Checks if connected.
     */
    public isActive(): boolean {
        return this.isConnected;
    }

    /**
     * Returns statistics about the connection.
     */
    public getStatistics(): { openWebSockets: number; assetIds: number } | null {
        if (!this.manager) return null;
        return this.manager.getStatistics();
    }

    /**
     * Disconnects and cleans up.
     */
    public disconnect(): void {
        if (this.manager) {
            this.manager.clearState();
            this.manager = null;
        }
        this.isConnected = false;
        this.lastPrices.clear();
        this.lastBooks.clear();
    }
}
