import WebSocket from 'ws';
import { EventEmitter } from 'events';

/**
 * WebSocket connection to Binance for real-time price feeds.
 * Provides sub-100ms price updates vs 15-second REST polling.
 */
export type BinanceSymbol = 'BTCUSDT' | 'ETHUSDT' | 'SOLUSDT' | 'XRPUSDT';

interface BinanceAggTradeMessage {
    e: 'aggTrade';        // Event type
    E: number;            // Event time
    s: string;            // Symbol
    p: string;            // Price
    q: string;            // Quantity
    T: number;            // Trade time
}

export interface BinancePriceEvent {
    price: number;
    timestamp: number;
    symbol: BinanceSymbol;
}

export class BinanceWebSocket extends EventEmitter {
    private ws: WebSocket | null = null;
    private symbol: BinanceSymbol;
    private reconnectAttempts = 0;
    private maxReconnectAttempts = 10;
    private reconnectDelayMs = 1000;
    private isConnected = false;
    private lastPrice: number = 0;
    private lastPriceTime: number = 0;

    constructor(symbol: BinanceSymbol) {
        super();
        this.symbol = symbol;
    }

    /**
     * Connects to Binance WebSocket stream.
     * Uses aggTrade stream for optimal balance of speed and data volume.
     */
    public connect(): void {
        const streamName = this.symbol.toLowerCase() + '@aggTrade';
        const url = `wss://stream.binance.com:9443/ws/${streamName}`;

        console.log(`[BinanceWS] Connecting to ${url}`);

        this.ws = new WebSocket(url);

        this.ws.on('open', () => {
            console.log(`[BinanceWS] Connected to ${this.symbol}`);
            this.isConnected = true;
            this.reconnectAttempts = 0;
            this.emit('connected');
        });

        this.ws.on('message', (data: WebSocket.Data) => {
            try {
                const message = JSON.parse(data.toString()) as BinanceAggTradeMessage;
                if (message.e === 'aggTrade') {
                    const price = parseFloat(message.p);
                    const timestamp = message.T;

                    this.lastPrice = price;
                    this.lastPriceTime = timestamp;

                    const event: BinancePriceEvent = { price, timestamp, symbol: this.symbol };
                    this.emit('price', event);
                }
            } catch (error) {
                console.error(`[BinanceWS] Parse error: ${error}`);
            }
        });

        this.ws.on('close', () => {
            console.log(`[BinanceWS] Disconnected from ${this.symbol}`);
            this.isConnected = false;
            this.emit('disconnected');
            this.attemptReconnect();
        });

        this.ws.on('error', (error) => {
            console.error(`[BinanceWS] Error: ${error}`);
            this.emit('error', error);
        });
    }

    private attemptReconnect(): void {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.error(`[BinanceWS] Max reconnect attempts reached for ${this.symbol}`);
            this.emit('failed');
            return;
        }

        this.reconnectAttempts++;
        const delay = this.reconnectDelayMs * Math.pow(2, this.reconnectAttempts - 1);

        console.log(`[BinanceWS] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

        setTimeout(() => this.connect(), delay);
    }

    public disconnect(): void {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        this.isConnected = false;
    }

    public getLastPrice(): number {
        return this.lastPrice;
    }

    public getLastPriceTime(): number {
        return this.lastPriceTime;
    }

    public isActive(): boolean {
        return this.isConnected;
    }
}

/**
 * Manages multiple WebSocket connections for different symbols.
 */
export class BinanceWebSocketManager {
    private connections: Map<BinanceSymbol, BinanceWebSocket> = new Map();

    public connect(symbol: BinanceSymbol): BinanceWebSocket {
        if (this.connections.has(symbol)) {
            return this.connections.get(symbol)!;
        }

        const ws = new BinanceWebSocket(symbol);
        this.connections.set(symbol, ws);
        ws.connect();
        return ws;
    }

    public disconnect(symbol: BinanceSymbol): void {
        const ws = this.connections.get(symbol);
        if (ws) {
            ws.disconnect();
            this.connections.delete(symbol);
        }
    }

    public disconnectAll(): void {
        for (const [, ws] of this.connections) {
            ws.disconnect();
        }
        this.connections.clear();
    }

    public get(symbol: BinanceSymbol): BinanceWebSocket | undefined {
        return this.connections.get(symbol);
    }
}
