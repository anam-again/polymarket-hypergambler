/**
 * Signals Module
 *
 * Barrel exports for real-time market data and signal computation.
 *
 * Key components:
 * - SignalProvider: Interface for computing trading signals (candleSize, volatility, etc.)
 * - WebSockets: Real-time price feeds from Binance and Polymarket
 * - SharedWebSocketManager: Connection pooling for WebSocket feeds
 * - OrderBookDepthAnalyzer: Order book depth features for ML models
 */

// Signal Provider Interface & Implementations
export {
    SignalSnapshot,
    SignalProviderConfig,
    DEFAULT_SIGNAL_CONFIG,
    ISignalProvider,
    BaseSignalProvider,
} from './SignalProvider.js';

export {
    MockSignalProvider,
    HistoricalSignalProvider,
    MockSignalValues,
} from './MockSignalProvider.js';

export {
    LiveSignalProvider,
    LiveSignalProviderConfig,
} from './LiveSignalProvider.js';

// WebSocket Feeds
export {
    BinanceWebSocket,
    BinanceWebSocketManager,
    type BinanceSymbol,
} from './BinanceWebSocket.js';

export {
    PolymarketWebSocket,
    type PolymarketPriceUpdate,
    type PolymarketBook,
} from './PolymarketWebSocket.js';

export {
    RealTimePriceBuffer,
} from './RealTimePriceBuffer.js';

// Shared Connection Managers
export {
    SharedPriceBufferManager,
    SharedPolymarketManager,
    type PolymarketSubscriber,
} from './SharedWebSocketManager.js';

// Order Book Analysis
export {
    OrderBookDepthAnalyzer,
    type OrderBookDepthFeatures,
} from './OrderBookDepthAnalyzer.js';

// Data Logging
export {
    DataLogger,
} from './DataLogger.js';
