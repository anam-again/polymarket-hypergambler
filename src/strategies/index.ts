/**
 * Strategy Registry - Centralized Strategy Identification
 *
 * Re-exports all types and utilities from StrategyRegistry.
 */

export {
    // Types
    type StrategyBaseType,
    type StrategyMetadata,

    // Registry
    STRATEGY_REGISTRY,

    // Lookup utilities
    getStrategyMetadata,
    getBaseType,
    isStrategyOfBaseType,
    isMSPEQStrategy,
    isRegimeAwareStrategy,
    isQuarterlyStrategy,
    getSignalNames,
    getBaseParamNames,
    getAllStrategyNames,
    getStrategiesWhere,
    getAllMSPEQStrategyNames,
    getAllRegimeAwareStrategyNames,
} from './StrategyRegistry.js';
