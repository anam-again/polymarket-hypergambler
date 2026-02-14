/**
 * SimulatorParamsAdapter
 *
 * Adapter to load bot parameters from simulator-generated YAML files
 * and instantiate bots for use in src/index.ts.
 *
 * Usage:
 *   import { loadFirstCandleMSPEQFromYaml, loadBotsFromYamlDir } from './adapters/SimulatorParamsAdapter.js';
 *
 *   // Single bot from YAML file
 *   const bot = loadFirstCandleMSPEQFromYaml('./logs/simulator/stage2-quarterlyfirstcandlemspeq-2026-02-10T04-09-13.yaml', {
 *     client: clobClient,
 *     marketInfo,
 *     PROD_MODE: true,
 *     hourlyDollarLimit: 50,
 *   });
 *
 *   // Multiple bots from directory
 *   const bots = loadBotsFromYamlDir('./logs/simulator', { ... });
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { parse as parseYaml } from 'yaml';
import { TargetedMarket } from '../types/interfaces.js';
import { MultiSignalPEQ, MultiSignalPEQConfig, SIGNAL_NAMES, STANDARD_NORMALIZATIONS } from '../utils/MultiSignalPEQ.js';
import { getBaseType } from '../strategies/index.js';
import { FirstCandleMSPEQ, FirstCandleMSPEQProps } from '../bots/FirstCandleMSPEQ.js';
import { EarlyBuyerMSPEQ, EarlyBuyerMSPEQProps } from '../bots/EarlyBuyerMSPEQ.js';
import { NCandleMSPEQ, NCandleMSPEQProps } from '../bots/NCandleMSPEQ.js';
import { CrossPeriodMomentumMSPEQ, CrossPeriodMomentumMSPEQProps } from '../bots/CrossPeriodMomentumMSPEQ.js';
import { MarketMakerMSPEQ, MarketMakerMSPEQProps } from '../bots/MarketMakerMSPEQ.js';
import { QuantBotRun } from '../bots/QuantBot.js';
import { ClobClient } from '@polymarket/clob-client';
import { MarketInfo } from '../nonBots/MarketInfo.js';
import { targetMarketToShortname } from '../utils/utils.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Raw YAML structure from simulator output (legacy stage2 format)
 */
export interface SimulatorYamlOutputLegacy {
    strategy: string;
    market: string;
    coin: string;
    days: number;
    stage2Only?: {
        baseParamsFile: string;
        fitness: number;
    };
    params: Record<string, number>;
}

/**
 * New schemaVersion format from iterative refinement / CMA-ES output
 */
export interface SimulatorYamlOutputV1 {
    schemaVersion: number;
    botStyle: string;
    strategy?: string;  // Optional, may be same as botStyle
    targetedMarket: string;
    optimization?: {
        bestPnl: number;
        avgPnl: number;
        generations: number;
        converged: boolean;
        convergenceReason: string;
        timestamp: string;
        lookbackDays: number;
        populationSize: number;
        maxGenerations: number;
        fitnessMode?: string;
        optimizationFitness?: number;
        sharpeRatio?: number;
        sortinoRatio?: number;
        calmarRatio?: number;
        winRate?: number;
        totalTrades?: number;
    };
    params: Record<string, number>;
    runtime?: {
        enabled: boolean;
        prodMode: boolean;
        hourlyDollarLimit: number;
    };
}

/**
 * Unified YAML output interface (normalized from either format)
 */
export interface SimulatorYamlOutput {
    strategy: string;
    market: string;
    coin: string;
    days: number;
    stage2Only?: {
        baseParamsFile: string;
        fitness: number;
    };
    params: Record<string, number>;
}

/**
 * Common bot configuration passed to all bots
 */
export interface CommonBotConfig {
    client: ClobClient;
    marketInfo: MarketInfo;
    PROD_MODE: boolean;
    hourlyDollarLimit: number;
    targetDollars?: number;
}

/**
 * Supported strategy types
 */
export type SupportedStrategy =
    | 'QuarterlyFirstCandleMSPEQ'
    | 'HourlyFirstCandleMSPEQ'
    | 'QuarterlyEarlyBuyerMSPEQ'
    | 'HourlyEarlyBuyerMSPEQ'
    | 'QuarterlyNCandleMSPEQ'
    | 'HourlyNCandleMSPEQ'
    | 'QuarterlyCrossPeriodMomentumMSPEQ'
    | 'HourlyCrossPeriodMomentumMSPEQ'
    | 'CrossPeriodMomentumMSPEQ'
    // RegimeAware strategies (use same underlying bots)
    | 'RegimeAwareFirstCandleMSPEQ'
    | 'RegimeAwareQuarterlyFirstCandleMSPEQ'
    | 'RegimeAwareEarlyBuyerMSPEQ'
    | 'RegimeAwareQuarterlyEarlyBuyerMSPEQ'
    | 'RegimeAwareNCandleMSPEQ'
    | 'RegimeAwareQuarterlyNCandleMSPEQ'
    | 'RegimeAwareMarketMakerMSPEQ'
    | 'RegimeAwareQuarterlyMarketMakerMSPEQ'
    | 'RegimeAwareCrossPeriodMomentumMSPEQ'
    | 'RegimeAwareQuarterlyCrossPeriodMomentumMSPEQ';

// ============================================================================
// Market Mapping
// ============================================================================

/**
 * Maps simulator market strings to TargetedMarket enum values
 */
const MARKET_MAP: Record<string, TargetedMarket> = {
    // Legacy format - Quarterly markets
    'btc-quarterly': TargetedMarket.BITCOIN_QUARTERLY,
    'eth-quarterly': TargetedMarket.ETHEREUM_QUARTERLY,
    'sol-quarterly': TargetedMarket.SOLANA_QUARTERLY,
    'xrp-quarterly': TargetedMarket.XRP_QUARTERLY,
    // Legacy format - Hourly markets
    'btc-hourly': TargetedMarket.BITCOIN_HOURLY,
    'eth-hourly': TargetedMarket.ETHEREUM_HOURLY,
    'sol-hourly': TargetedMarket.SOLANA_HOURLY,
    'xrp-hourly': TargetedMarket.XRP_HOURLY,
    // New schemaVersion format - uses TargetedMarket enum names directly
    'BitcoinQuarterly': TargetedMarket.BITCOIN_QUARTERLY,
    'EthereumQuarterly': TargetedMarket.ETHEREUM_QUARTERLY,
    'SolanaQuarterly': TargetedMarket.SOLANA_QUARTERLY,
    'XrpQuarterly': TargetedMarket.XRP_QUARTERLY,
    'BitcoinHourly': TargetedMarket.BITCOIN_HOURLY,
    'EthereumHourly': TargetedMarket.ETHEREUM_HOURLY,
    'SolanaHourly': TargetedMarket.SOLANA_HOURLY,
    'XrpHourly': TargetedMarket.XRP_HOURLY,
};

/**
 * Reverse mapping from TargetedMarket to legacy market string format
 */
const TARGETED_MARKET_TO_LEGACY: Record<string, string> = {
    'BitcoinQuarterly': 'btc-quarterly',
    'EthereumQuarterly': 'eth-quarterly',
    'SolanaQuarterly': 'sol-quarterly',
    'XrpQuarterly': 'xrp-quarterly',
    'BitcoinHourly': 'btc-hourly',
    'EthereumHourly': 'eth-hourly',
    'SolanaHourly': 'sol-hourly',
    'XrpHourly': 'xrp-hourly',
};

/**
 * Extract coin from market string
 */
function extractCoinFromMarket(market: string): string {
    const marketLower = market.toLowerCase();
    if (marketLower.includes('btc') || marketLower.includes('bitcoin')) return 'btc';
    if (marketLower.includes('eth') || marketLower.includes('ethereum')) return 'eth';
    if (marketLower.includes('sol') || marketLower.includes('solana')) return 'sol';
    if (marketLower.includes('xrp')) return 'xrp';
    return 'btc'; // default
}

/**
 * Resolves market string to TargetedMarket enum
 * Handles both legacy format (btc-quarterly) and new format (BitcoinQuarterly)
 */
export function resolveMarket(marketStr: string): TargetedMarket {
    // First try exact match (for new format like 'BitcoinQuarterly')
    if (MARKET_MAP[marketStr]) {
        return MARKET_MAP[marketStr];
    }

    // Then try lowercase match (for legacy format like 'btc-quarterly')
    const normalized = marketStr.toLowerCase().trim();
    const market = MARKET_MAP[normalized];

    if (!market) {
        throw new Error(
            `Unknown market: "${marketStr}". Valid markets: ${Object.keys(MARKET_MAP).join(', ')}`
        );
    }

    return market;
}

// ============================================================================
// MSPEQ Signal Names
// ============================================================================

/**
 * Signal names used in FirstCandleMSPEQ
 * (subset of all available signals that the simulator optimizes)
 */
const FIRSTCANDLE_MSPEQ_SIGNALS = ['candleSize', 'volatility', 'momentum'] as const;

/**
 * Signal names used in EarlyBuyerMSPEQ
 * (same 3 signals as FirstCandleMSPEQ)
 */
const EARLYBUYER_MSPEQ_SIGNALS = ['candleSize', 'volatility', 'momentum'] as const;

/**
 * Signal names used in NCandleMSPEQ
 * (same 3 signals as FirstCandleMSPEQ and EarlyBuyerMSPEQ)
 */
const NCANDLE_MSPEQ_SIGNALS = ['candleSize', 'volatility', 'momentum'] as const;

/**
 * Signal names used in CrossPeriodMomentumMSPEQ
 * (same 3 signals as other MSPEQ bots)
 */
const CROSSPERIODMOMENTUM_MSPEQ_SIGNALS = ['candleSize', 'volatility', 'momentum'] as const;

/**
 * Signal names used in MarketMakerMSPEQ
 * Includes timeLeft signal in addition to the standard signals
 */
const MARKETMAKER_MSPEQ_SIGNALS = ['candleSize', 'timeLeft', 'volatility', 'momentum'] as const;

/**
 * All possible signal names (used for auto-detection)
 */
const ALL_SIGNAL_NAMES = ['candleSize', 'timeLeft', 'volatility', 'momentum'] as const;

/**
 * Auto-detects which signals are present in the params for a given prefix.
 * This handles both 3-signal (non-regime) and 4-signal (regime-aware) strategies.
 */
function detectSignalsForPrefix(prefix: string, params: Record<string, number>): string[] {
    const detectedSignals: string[] = [];
    for (const signal of ALL_SIGNAL_NAMES) {
        const weightKey = `${prefix}_${signal}_w`;
        if (weightKey in params) {
            detectedSignals.push(signal);
        }
    }
    // Fall back to standard 3 signals if none detected (shouldn't happen with valid YAML)
    return detectedSignals.length > 0 ? detectedSignals : ['candleSize', 'volatility', 'momentum'];
}

// ============================================================================
// YAML Parsing
// ============================================================================

/**
 * Loads and parses a simulator YAML file.
 * Handles both legacy format and new schemaVersion format, normalizing to SimulatorYamlOutput.
 */
export function loadSimulatorYaml(filePath: string): SimulatorYamlOutput {
    if (!existsSync(filePath)) {
        throw new Error(`YAML file not found: ${filePath}`);
    }

    const content = readFileSync(filePath, 'utf-8');
    const raw = parseYaml(content) as SimulatorYamlOutputLegacy | SimulatorYamlOutputV1;

    // Check if this is the new schemaVersion format
    if ('schemaVersion' in raw && raw.schemaVersion === 1) {
        const v1 = raw as SimulatorYamlOutputV1;
        // Normalize to legacy format for compatibility
        const market = TARGETED_MARKET_TO_LEGACY[v1.targetedMarket] || v1.targetedMarket.toLowerCase();
        return {
            strategy: v1.strategy || v1.botStyle,
            market: market,
            coin: extractCoinFromMarket(v1.targetedMarket),
            days: v1.optimization?.lookbackDays || 14,
            stage2Only: v1.optimization ? {
                baseParamsFile: '',
                fitness: v1.optimization.bestPnl,
            } : undefined,
            params: v1.params,
        };
    }

    // Legacy format - return as-is
    return raw as SimulatorYamlOutput;
}

// ============================================================================
// FirstCandleMSPEQ Adapter
// ============================================================================

/**
 * Converts flat YAML params to MultiSignalPEQConfig
 * Auto-detects signals from params (supports both 3-signal and 4-signal variants)
 */
function extractMSPEQConfig(
    prefix: string,
    params: Record<string, number>,
    signalNames?: readonly string[]
): MultiSignalPEQConfig {
    // Auto-detect signals if not provided
    const signals = signalNames ?? detectSignalsForPrefix(prefix, params);
    return MultiSignalPEQ.fromFlatParams(
        prefix,
        params,
        [...signals],
        {
            normalizations: {
                candleSize: STANDARD_NORMALIZATIONS.candleSize,
                timeLeft: STANDARD_NORMALIZATIONS.timeLeft,
                volatility: STANDARD_NORMALIZATIONS.volatility,
                momentum: STANDARD_NORMALIZATIONS.momentum,
            },
        }
    ).getConfig();
}

/**
 * Extracts the base filename without extension from a file path
 */
function getBaseFilename(filePath: string): string {
    const filename = filePath.split(/[/\\]/).pop() ?? '';
    return filename.replace(/\.yaml$/i, '');
}

/**
 * Extracts FirstCandleMSPEQProps from simulator YAML params
 */
export function extractFirstCandleMSPEQProps(
    yaml: SimulatorYamlOutput,
    config: CommonBotConfig,
    filePath?: string
): FirstCandleMSPEQProps {
    const { params } = yaml;
    const targetedMarket = resolveMarket(yaml.market);

    // Generate bot name from filename + params
    const shortname = targetMarketToShortname(targetedMarket);
    const baseFilename = filePath ? getBaseFilename(filePath) : 'fcmspeq';
    const name = `${baseFilename}-${shortname}`;

    return {
        // Identity
        name,
        targetedMarket,

        // Common config
        client: config.client,
        marketInfo: config.marketInfo,
        PROD_MODE: config.PROD_MODE,
        hourlyDollarLimit: config.hourlyDollarLimit,

        // Base parameters from YAML
        candleMinutes: params.candleMinutes,
        breakoutBuffer: params.breakoutBuffer,
        pullbackBuffer: params.pullbackBuffer,
        targetDollars: config.targetDollars ?? params.targetDollars ?? 10,
        cutoffMinute: params.cutoffMinute,
        candleSizeReference: params.candleSizeReference ?? 1000,
        baseBuyPrice: params.baseBuyPrice,
        minProfitMargin: params.minProfitMargin,

        // Multi-Signal PEQ configs (converted from flat params)
        targetBuyPriceMSPEQ: extractMSPEQConfig('buyPrice', params),
        targetSellPriceMSPEQ: extractMSPEQConfig('sellPrice', params),
        earlySellTimeMSPEQ: extractMSPEQConfig('earlySellTime', params),
        earlySellPriceMSPEQ: extractMSPEQConfig('earlySellPrice', params),
        breakoutBufferMSPEQ: extractMSPEQConfig('breakoutBuffer', params),
        pullbackBufferMSPEQ: extractMSPEQConfig('pullbackBuffer', params),
    };
}

/**
 * Loads a FirstCandleMSPEQ bot from a simulator YAML file
 *
 * @param filePath - Path to the YAML file
 * @param config - Common bot configuration
 * @returns Configured FirstCandleMSPEQ bot instance
 *
 * @example
 * const bot = loadFirstCandleMSPEQFromYaml(
 *   './logs/simulator/stage2-quarterlyfirstcandlemspeq-2026-02-10T04-09-13.yaml',
 *   { client: clobClient, marketInfo, PROD_MODE: true, hourlyDollarLimit: 50 }
 * );
 */
export function loadFirstCandleMSPEQFromYaml(
    filePath: string,
    config: CommonBotConfig
): FirstCandleMSPEQ {
    const yaml = loadSimulatorYaml(filePath);

    if (getBaseType(yaml.strategy) !== 'FirstCandleMSPEQ') {
        console.warn(
            `[SimulatorParamsAdapter] Warning: YAML strategy "${yaml.strategy}" ` +
            `may not be compatible with FirstCandleMSPEQ`
        );
    }

    const props = extractFirstCandleMSPEQProps(yaml, config, filePath);
    return new FirstCandleMSPEQ(props);
}

// ============================================================================
// EarlyBuyerMSPEQ Adapter
// ============================================================================

/**
 * Converts flat YAML params to MultiSignalPEQConfig for EarlyBuyerMSPEQ
 * Auto-detects signals from params (supports both 3-signal and 4-signal variants)
 */
function extractEarlyBuyerMSPEQConfig(
    prefix: string,
    params: Record<string, number>,
    signalNames?: readonly string[]
): MultiSignalPEQConfig {
    // Auto-detect signals if not provided
    const signals = signalNames ?? detectSignalsForPrefix(prefix, params);
    return MultiSignalPEQ.fromFlatParams(
        prefix,
        params,
        [...signals],
        {
            normalizations: {
                candleSize: STANDARD_NORMALIZATIONS.candleSize,
                timeLeft: STANDARD_NORMALIZATIONS.timeLeft,
                volatility: STANDARD_NORMALIZATIONS.volatility,
                momentum: STANDARD_NORMALIZATIONS.momentum,
            },
        }
    ).getConfig();
}

/**
 * Extracts EarlyBuyerMSPEQProps from simulator YAML params
 */
export function extractEarlyBuyerMSPEQProps(
    yaml: SimulatorYamlOutput,
    config: CommonBotConfig,
    filePath?: string
): EarlyBuyerMSPEQProps {
    const { params } = yaml;
    const targetedMarket = resolveMarket(yaml.market);

    // Generate bot name from filename + params
    const shortname = targetMarketToShortname(targetedMarket);
    const baseFilename = filePath ? getBaseFilename(filePath) : 'ebmspeq';
    const name = `${baseFilename}-${shortname}`;

    return {
        // Identity
        name,
        targetedMarket,

        // Common config
        client: config.client,
        marketInfo: config.marketInfo,
        PROD_MODE: config.PROD_MODE,
        hourlyDollarLimit: config.hourlyDollarLimit,

        // Base parameters from YAML
        targetDollars: config.targetDollars ?? params.targetDollars ?? 10,
        baseBuyPrice: params.baseBuyPrice,
        baseSellPrice: params.baseSellPrice,
        baseCutoffMinute: params.baseCutoffMinute,
        candleSizeReference: params.candleSizeReference ?? 1000,
        minProfitMargin: params.minProfitMargin,
        directionThreshold: params.directionThreshold ?? 0.5,

        // Multi-Signal PEQ configs (converted from flat params)
        targetBuyPriceMSPEQ: extractEarlyBuyerMSPEQConfig('buyPrice', params),
        targetSellPriceMSPEQ: extractEarlyBuyerMSPEQConfig('sellPrice', params),
        cutoffMinuteMSPEQ: extractEarlyBuyerMSPEQConfig('cutoffMinute', params),
        btcDirectionMSPEQ: extractEarlyBuyerMSPEQConfig('btcDirection', params),
        earlySellTimeMSPEQ: extractEarlyBuyerMSPEQConfig('earlySellTime', params),
        earlySellPriceMSPEQ: extractEarlyBuyerMSPEQConfig('earlySellPrice', params),
    };
}

/**
 * Loads an EarlyBuyerMSPEQ bot from a simulator YAML file
 *
 * @param filePath - Path to the YAML file
 * @param config - Common bot configuration
 * @returns Configured EarlyBuyerMSPEQ bot instance
 *
 * @example
 * const bot = loadEarlyBuyerMSPEQFromYaml(
 *   './logs/simulator/stage2-quarterlyearlybuyermspeq-2026-02-10T04-09-13.yaml',
 *   { client: clobClient, marketInfo, PROD_MODE: true, hourlyDollarLimit: 50 }
 * );
 */
export function loadEarlyBuyerMSPEQFromYaml(
    filePath: string,
    config: CommonBotConfig
): EarlyBuyerMSPEQ {
    const yaml = loadSimulatorYaml(filePath);

    if (getBaseType(yaml.strategy) !== 'EarlyBuyerMSPEQ') {
        console.warn(
            `[SimulatorParamsAdapter] Warning: YAML strategy "${yaml.strategy}" ` +
            `may not be compatible with EarlyBuyerMSPEQ`
        );
    }

    const props = extractEarlyBuyerMSPEQProps(yaml, config, filePath);
    return new EarlyBuyerMSPEQ(props);
}

// ============================================================================
// NCandleMSPEQ Adapter
// ============================================================================

/**
 * Converts flat YAML params to MultiSignalPEQConfig for NCandleMSPEQ
 */
function extractNCandleMSPEQConfig(
    prefix: string,
    params: Record<string, number>,
    signalNames?: readonly string[]
): MultiSignalPEQConfig {
    // Auto-detect signals if not provided
    const signals = signalNames ?? detectSignalsForPrefix(prefix, params);
    return MultiSignalPEQ.fromFlatParams(
        prefix,
        params,
        [...signals],
        {
            normalizations: {
                candleSize: STANDARD_NORMALIZATIONS.candleSize,
                timeLeft: STANDARD_NORMALIZATIONS.timeLeft,
                volatility: STANDARD_NORMALIZATIONS.volatility,
                momentum: STANDARD_NORMALIZATIONS.momentum,
            },
        }
    ).getConfig();
}

/**
 * Extracts NCandleMSPEQProps from simulator YAML params
 */
export function extractNCandleMSPEQProps(
    yaml: SimulatorYamlOutput,
    config: CommonBotConfig,
    filePath?: string
): NCandleMSPEQProps {
    const { params } = yaml;
    const targetedMarket = resolveMarket(yaml.market);

    // Generate bot name from filename + params
    const shortname = targetMarketToShortname(targetedMarket);
    const baseFilename = filePath ? getBaseFilename(filePath) : 'ncmspeq';
    const name = `${baseFilename}-${shortname}`;

    return {
        // Identity
        name,
        targetedMarket,

        // Common config
        client: config.client,
        marketInfo: config.marketInfo,
        PROD_MODE: config.PROD_MODE,
        hourlyDollarLimit: config.hourlyDollarLimit,

        // Base parameters from YAML
        candleMinutes: params.candleMinutes,
        buyPriceBuffer: params.buyPriceBuffer,
        sellPriceBuffer: params.sellPriceBuffer,
        minProfitMargin: params.minProfitMargin,
        stopLossMultiplier: params.stopLossMultiplier,
        stoplossTimeout: params.stoplossTimeout,
        sellTimeout: params.sellTimeout,
        stoplossFailureTimeout: params.stoplossFailureTimeout ?? 15,
        earlySellScalar: params.earlySellScalar,
        targetDollars: config.targetDollars ?? params.targetDollars ?? 10,
        cutoffMinute: params.cutoffMinute,
        maxTradesPerHour: params.maxTradesPerHour ?? 5,
        candleSizeReference: params.candleSizeReference ?? 1000,

        // Multi-Signal PEQ configs (converted from flat params)
        buyPriceBufferMSPEQ: extractNCandleMSPEQConfig('buyPriceBuffer', params),
        minProfitMarginMSPEQ: extractNCandleMSPEQConfig('minProfitMargin', params),
        stoplossTimeoutMSPEQ: extractNCandleMSPEQConfig('stoplossTimeout', params),
        sellTimeoutMSPEQ: extractNCandleMSPEQConfig('sellTimeout', params),
        stoplossFailureTimeoutMSPEQ: extractNCandleMSPEQConfig('stoplossFailureTimeout', params),
    };
}

/**
 * Loads an NCandleMSPEQ bot from a simulator YAML file
 *
 * @param filePath - Path to the YAML file
 * @param config - Common bot configuration
 * @returns Configured NCandleMSPEQ bot instance
 *
 * @example
 * const bot = loadNCandleMSPEQFromYaml(
 *   './logs/simulator/stage2-quarterlyncandlemspeq-2026-02-10T04-09-13.yaml',
 *   { client: clobClient, marketInfo, PROD_MODE: true, hourlyDollarLimit: 50 }
 * );
 */
export function loadNCandleMSPEQFromYaml(
    filePath: string,
    config: CommonBotConfig
): NCandleMSPEQ {
    const yaml = loadSimulatorYaml(filePath);

    if (getBaseType(yaml.strategy) !== 'NCandleMSPEQ') {
        console.warn(
            `[SimulatorParamsAdapter] Warning: YAML strategy "${yaml.strategy}" ` +
            `may not be compatible with NCandleMSPEQ`
        );
    }

    const props = extractNCandleMSPEQProps(yaml, config, filePath);
    return new NCandleMSPEQ(props);
}

// ============================================================================
// CrossPeriodMomentumMSPEQ Adapter
// ============================================================================

/**
 * Converts flat YAML params to MultiSignalPEQConfig for CrossPeriodMomentumMSPEQ
 */
function extractCrossPeriodMomentumMSPEQConfig(
    prefix: string,
    params: Record<string, number>,
    signalNames?: readonly string[]
): MultiSignalPEQConfig {
    // Auto-detect signals if not provided
    const signals = signalNames ?? detectSignalsForPrefix(prefix, params);
    return MultiSignalPEQ.fromFlatParams(
        prefix,
        params,
        [...signals],
        {
            normalizations: {
                candleSize: STANDARD_NORMALIZATIONS.candleSize,
                timeLeft: STANDARD_NORMALIZATIONS.timeLeft,
                volatility: STANDARD_NORMALIZATIONS.volatility,
                momentum: STANDARD_NORMALIZATIONS.momentum,
            },
        }
    ).getConfig();
}

/**
 * Extracts CrossPeriodMomentumMSPEQProps from simulator YAML params
 */
export function extractCrossPeriodMomentumMSPEQProps(
    yaml: SimulatorYamlOutput,
    config: CommonBotConfig,
    filePath?: string
): CrossPeriodMomentumMSPEQProps {
    const { params } = yaml;
    const targetedMarket = resolveMarket(yaml.market);

    // Generate bot name from filename + params
    const shortname = targetMarketToShortname(targetedMarket);
    const baseFilename = filePath ? getBaseFilename(filePath) : 'cpmmspeq';
    const name = `${baseFilename}-${shortname}`;

    return {
        // Identity
        name,
        targetedMarket,

        // Common config
        client: config.client,
        marketInfo: config.marketInfo,
        PROD_MODE: config.PROD_MODE,
        hourlyDollarLimit: config.hourlyDollarLimit,

        // Base parameters from YAML
        targetDollars: config.targetDollars ?? params.targetDollars ?? 10,
        baseBuyPrice: params.baseBuyPrice ?? 0.52,
        baseSellPrice: params.baseSellPrice ?? 0.58,
        baseCutoffMinute: params.baseCutoffMinute ?? 30,
        candleSizeReference: params.candleSizeReference ?? 1000,
        minProfitMargin: params.minProfitMargin ?? 0.05,
        directionThreshold: params.directionThreshold ?? 0.5,
        baseMomentumThreshold: params.baseMomentumThreshold ?? 0.15,
        baseMinWinStreak: params.baseMinWinStreak ?? 1,

        // Multi-Signal PEQ configs (converted from flat params)
        targetBuyPriceMSPEQ: extractCrossPeriodMomentumMSPEQConfig('buyPrice', params),
        targetSellPriceMSPEQ: extractCrossPeriodMomentumMSPEQConfig('sellPrice', params),
        cutoffMinuteMSPEQ: extractCrossPeriodMomentumMSPEQConfig('cutoffMinute', params),
        btcDirectionMSPEQ: extractCrossPeriodMomentumMSPEQConfig('btcDirection', params),
        momentumThresholdMSPEQ: extractCrossPeriodMomentumMSPEQConfig('momentumThreshold', params),
        winStreakThresholdMSPEQ: extractCrossPeriodMomentumMSPEQConfig('winStreakThreshold', params),
        earlySellTimeMSPEQ: extractCrossPeriodMomentumMSPEQConfig('earlySellTime', params),
        earlySellPriceMSPEQ: extractCrossPeriodMomentumMSPEQConfig('earlySellPrice', params),
    };
}

/**
 * Loads a CrossPeriodMomentumMSPEQ bot from a simulator YAML file
 *
 * @param filePath - Path to the YAML file
 * @param config - Common bot configuration
 * @returns Configured CrossPeriodMomentumMSPEQ bot instance
 *
 * @example
 * const bot = loadCrossPeriodMomentumMSPEQFromYaml(
 *   './logs/simulator/stage2-crossperiodmomentummspeq-2026-02-10T04-09-13.yaml',
 *   { client: clobClient, marketInfo, PROD_MODE: true, hourlyDollarLimit: 50 }
 * );
 */
export function loadCrossPeriodMomentumMSPEQFromYaml(
    filePath: string,
    config: CommonBotConfig
): CrossPeriodMomentumMSPEQ {
    const yaml = loadSimulatorYaml(filePath);

    if (getBaseType(yaml.strategy) !== 'CrossPeriodMomentumMSPEQ') {
        console.warn(
            `[SimulatorParamsAdapter] Warning: YAML strategy "${yaml.strategy}" ` +
            `may not be compatible with CrossPeriodMomentumMSPEQ`
        );
    }

    const props = extractCrossPeriodMomentumMSPEQProps(yaml, config, filePath);
    return new CrossPeriodMomentumMSPEQ(props);
}

// ============================================================================
// MarketMakerMSPEQ Adapter
// ============================================================================

/**
 * Extracts MarketMakerMSPEQ MSPEQ config (uses 4 signals including timeLeft)
 */
function extractMarketMakerMSPEQConfig(
    prefix: string,
    params: Record<string, number>
): MultiSignalPEQConfig {
    return MultiSignalPEQ.fromFlatParams(
        prefix,
        params,
        [...MARKETMAKER_MSPEQ_SIGNALS],
        {
            normalizations: {
                candleSize: STANDARD_NORMALIZATIONS.candleSize,
                timeLeft: STANDARD_NORMALIZATIONS.timeLeft,
                volatility: STANDARD_NORMALIZATIONS.volatility,
                momentum: STANDARD_NORMALIZATIONS.momentum,
            },
        }
    ).getConfig();
}

/**
 * Extracts MarketMakerMSPEQ props from YAML
 */
function extractMarketMakerMSPEQProps(
    yaml: SimulatorYamlOutput,
    config: CommonBotConfig,
    filePath: string
): MarketMakerMSPEQProps {
    const params = yaml.params;
    const market = resolveMarket(yaml.market);
    const shortname = targetMarketToShortname(market);

    return {
        // Common props
        name: `mmaker-mspeq-${shortname}-${filePath.split('/').pop()?.replace('.yaml', '')}`,
        client: config.client,
        marketInfo: config.marketInfo,
        targetedMarket: market,
        PROD_MODE: config.PROD_MODE,
        hourlyDollarLimit: config.hourlyDollarLimit,

        // MarketMaker specific
        spreadSize: params.spreadSize ?? 5,
        baseSpreadDistance: params.baseSpreadDistance ?? 0.05,
        baseProfitMargin: params.baseProfitMargin ?? 0.15,
        baseMinPrice: params.baseMinPrice ?? 0.2,
        baseMaxPrice: params.baseMaxPrice ?? 0.8,
        baseStopLossAmount: params.baseStopLossAmount ?? 0.1,
        buyExpirySeconds: params.buyExpirySeconds ?? 60,
        totalActiveTrades: params.totalActiveTrades ?? 5,
        maxVolatility: params.maxVolatility ?? 100,
        minVolatility: params.minVolatility ?? 0,
        volatilityLookbackPeriods: params.volatilityLookbackPeriods ?? 20,
        targetDollars: config.targetDollars ?? params.targetDollars ?? 10,
        baseCutoffMinute: params.baseCutoffMinute ?? 10,
        candleSizeReference: params.candleSizeReference ?? 1000,

        // Multi-Signal PEQ configs
        profitMarginMSPEQ: extractMarketMakerMSPEQConfig('profitMargin', params),
        spreadDistanceMSPEQ: extractMarketMakerMSPEQConfig('spreadDistance', params),
        stopLossAmountMSPEQ: extractMarketMakerMSPEQConfig('stopLossAmount', params),
        cutoffMinuteMSPEQ: extractMarketMakerMSPEQConfig('cutoffMinute', params),
        minPriceMSPEQ: extractMarketMakerMSPEQConfig('minPrice', params),
        maxPriceMSPEQ: extractMarketMakerMSPEQConfig('maxPrice', params),
    };
}

/**
 * Loads a MarketMakerMSPEQ bot from a simulator YAML file
 */
export function loadMarketMakerMSPEQFromYaml(
    filePath: string,
    config: CommonBotConfig
): MarketMakerMSPEQ {
    const yaml = loadSimulatorYaml(filePath);

    if (getBaseType(yaml.strategy) !== 'MarketMakerMSPEQ') {
        console.warn(
            `[SimulatorParamsAdapter] Warning: YAML strategy "${yaml.strategy}" ` +
            `may not be compatible with MarketMakerMSPEQ`
        );
    }

    const props = extractMarketMakerMSPEQProps(yaml, config, filePath);
    return new MarketMakerMSPEQ(props);
}

// ============================================================================
// Batch Loading
// ============================================================================

/**
 * Filter options for batch loading
 */
export interface LoadBotsFilter {
    /** Only load files matching these strategies */
    strategies?: SupportedStrategy[];
    /** Only load files for these markets */
    markets?: string[];
    /** Only load files newer than this date */
    newerThan?: Date;
    /** File pattern to match (default: stage2-*.yaml) */
    pattern?: RegExp;
}

/**
 * Loads all compatible bots from a directory of YAML files
 *
 * @param dirPath - Directory containing YAML files
 * @param config - Common bot configuration
 * @param filter - Optional filter options
 * @returns Array of bot instances
 *
 * @example
 * const bots = loadBotsFromYamlDir('./logs/simulator', {
 *   client: clobClient,
 *   marketInfo,
 *   PROD_MODE: true,
 *   hourlyDollarLimit: 50,
 * }, {
 *   strategies: ['QuarterlyFirstCandleMSPEQ'],
 *   markets: ['btc-quarterly'],
 * });
 */
export function loadBotsFromYamlDir(
    dirPath: string,
    config: CommonBotConfig,
    filter?: LoadBotsFilter
): QuantBotRun[] {
    if (!existsSync(dirPath)) {
        console.warn(`[SimulatorParamsAdapter] Directory not found: ${dirPath}`);
        return [];
    }

    const pattern = filter?.pattern ?? /^stage2-.*\.yaml$/;
    const files = readdirSync(dirPath).filter((f) => pattern.test(f));

    const bots: QuantBotRun[] = [];

    for (const file of files) {
        const filePath = `${dirPath}/${file}`;

        try {
            const yaml = loadSimulatorYaml(filePath);

            // Skip files without a strategy field (not a valid simulator output)
            if (!yaml.strategy) {
                console.warn(`[SimulatorParamsAdapter] Skipping ${file}: missing 'strategy' field`);
                continue;
            }

            // Apply filters
            if (filter?.strategies && !filter.strategies.some((s) => yaml.strategy.includes(s.replace('Quarterly', '').replace('Hourly', '')))) {
                continue;
            }

            if (filter?.markets && !filter.markets.includes(yaml.market)) {
                continue;
            }

            // Determine bot type and load using registry
            const baseType = getBaseType(yaml.strategy);

            if (baseType === 'MarketMakerMSPEQ') {
                const bot = loadMarketMakerMSPEQFromYaml(filePath, config);
                bots.push(bot);
                console.log(`[SimulatorParamsAdapter] Loaded ${bot.name} from ${file}`);
            } else if (baseType === 'FirstCandleMSPEQ') {
                const bot = loadFirstCandleMSPEQFromYaml(filePath, config);
                bots.push(bot);
                console.log(`[SimulatorParamsAdapter] Loaded ${bot.name} from ${file}`);
            } else if (baseType === 'EarlyBuyerMSPEQ') {
                const bot = loadEarlyBuyerMSPEQFromYaml(filePath, config);
                bots.push(bot);
                console.log(`[SimulatorParamsAdapter] Loaded ${bot.name} from ${file}`);
            } else if (baseType === 'NCandleMSPEQ') {
                const bot = loadNCandleMSPEQFromYaml(filePath, config);
                bots.push(bot);
                console.log(`[SimulatorParamsAdapter] Loaded ${bot.name} from ${file}`);
            } else if (baseType === 'CrossPeriodMomentumMSPEQ') {
                const bot = loadCrossPeriodMomentumMSPEQFromYaml(filePath, config);
                bots.push(bot);
                console.log(`[SimulatorParamsAdapter] Loaded ${bot.name} from ${file}`);
            } else {
                console.warn(
                    `[SimulatorParamsAdapter] Unsupported strategy "${yaml.strategy}" in ${file}`
                );
            }
        } catch (error) {
            console.error(`[SimulatorParamsAdapter] Error loading ${file}:`, error);
        }
    }

    return bots;
}

// ============================================================================
// Convenience: Get Latest YAML for Strategy/Market
// ============================================================================

/**
 * Finds the most recent YAML file for a given strategy and market
 *
 * @param dirPath - Directory to search
 * @param strategy - Strategy type (e.g., 'QuarterlyFirstCandleMSPEQ')
 * @param market - Market string (e.g., 'btc-quarterly')
 * @returns Path to the latest YAML file, or null if not found
 */
export function findLatestYaml(
    dirPath: string,
    strategy: string,
    market?: string
): string | null {
    if (!existsSync(dirPath)) {
        return null;
    }

    const strategyLower = strategy.toLowerCase();
    const files = readdirSync(dirPath)
        .filter((f) => f.endsWith('.yaml') && f.toLowerCase().includes(strategyLower))
        .map((f) => ({
            name: f,
            path: `${dirPath}/${f}`,
        }));

    if (files.length === 0) {
        return null;
    }

    // Filter by market if specified
    let candidates = files;
    if (market) {
        candidates = files.filter((f) => {
            try {
                const yaml = loadSimulatorYaml(f.path);
                return yaml.market === market;
            } catch {
                return false;
            }
        });
    }

    if (candidates.length === 0) {
        return null;
    }

    // Sort by filename (which includes timestamp) descending
    candidates.sort((a, b) => b.name.localeCompare(a.name));

    return candidates[0].path;
}

/**
 * Loads the most recent bot for a given strategy and market
 *
 * @example
 * const bot = loadLatestBot('./logs/simulator', 'QuarterlyFirstCandleMSPEQ', 'btc-quarterly', config);
 */
export function loadLatestBot(
    dirPath: string,
    strategy: string,
    market: string,
    config: CommonBotConfig
): QuantBotRun | null {
    const yamlPath = findLatestYaml(dirPath, strategy, market);

    if (!yamlPath) {
        console.warn(
            `[SimulatorParamsAdapter] No YAML found for strategy="${strategy}", market="${market}"`
        );
        return null;
    }

    console.log(`[SimulatorParamsAdapter] Loading latest params from: ${yamlPath}`);

    // Determine bot type based on strategy using registry
    const baseType = getBaseType(strategy);

    if (baseType === 'EarlyBuyerMSPEQ') {
        return loadEarlyBuyerMSPEQFromYaml(yamlPath, config);
    }
    if (baseType === 'NCandleMSPEQ') {
        return loadNCandleMSPEQFromYaml(yamlPath, config);
    }
    if (baseType === 'CrossPeriodMomentumMSPEQ') {
        return loadCrossPeriodMomentumMSPEQFromYaml(yamlPath, config);
    }
    if (baseType === 'MarketMakerMSPEQ') {
        return loadMarketMakerMSPEQFromYaml(yamlPath, config);
    }
    // Default to FirstCandleMSPEQ
    return loadFirstCandleMSPEQFromYaml(yamlPath, config);
}

// ============================================================================
// Export all signal names for reference
// ============================================================================

export { SIGNAL_NAMES, STANDARD_NORMALIZATIONS };
