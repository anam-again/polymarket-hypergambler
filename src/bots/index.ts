/**
 * Bots Module
 *
 * Barrel exports for trading bot implementations.
 *
 * Key components:
 * - QuantBot: Base class for all trading bots
 * - OrderBatcher: API call batching for efficiency
 * - MSPEQBotBase: Base class for multi-signal parameter bots
 * - Strategy implementations: FirstCandle, EarlyBuyer, MarketMaker, Contrarian, etc.
 */

// Core Infrastructure
export {
    QuantBot,
    OrderBatcher,
    runBotWithRestartOnFailure,
    type QuantBotProps,
    type QuantBotRun,
    type TradeOrder,
    TradeStatus,
} from './QuantBot.js';

export { OrderBatcher as OrderBatcherDirect } from './OrderBatcher.js';

export { MSPEQBotBase, type MSPEQBotConfig } from './MSPEQBotBase.js';

// ML-Powered Strategies
export { SuddenArb, type SuddenArbMLConfig } from './SuddenArb.js';
export { YOLOMLBot } from './YOLOMLBot.js';

// FirstCandle Family
export { FirstCandle } from './FirstCandle.js';
export { FirstCandleV2 } from './FirstCandleV2.js';
export { FirstCandleMSPEQ } from './FirstCandleMSPEQ.js';

// EarlyBuyer Family
export { EarlyBuyer } from './EarlyBuyer.js';
export { EarlyBuyerV2 } from './EarlyBuyerV2.js';
export { EarlyBuyerMSPEQ } from './EarlyBuyerMSPEQ.js';
export { EarlyLimitV2 } from './EarlyLimitV2.js';

// NCandle Family
export { NCandle } from './NCandle.js';
export { NCandleMSPEQ } from './NCandleMSPEQ.js';

// Market Making
export { MarketMaker } from './MarketMaker.js';
export { MarketMakerMSPEQ } from './MarketMakerMSPEQ.js';

// Trend & Mean Reversion
export { TrendFollowing } from './TrendFollowing.js';
export { MeanReversion } from './MeanReversion.js';
export { Contrarian } from './Contrarian.js';
export { ContrarianV2 } from './ContrarianV2.js';

// Cross-Period
export { CrossPeriodMomentumMSPEQ } from './CrossPeriodMomentumMSPEQ.js';

// Time-Based
export { MorningStar } from './MorningStar.js';
export { EveningStar } from './EveningStar.js';

// Experimental
export { Arbitrage98 } from './Arbitrage98.js';
export { EsotericNormalization } from './EsotericNormalization.js';
