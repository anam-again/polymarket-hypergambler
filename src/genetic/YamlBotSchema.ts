import { TargetedMarket } from '../types/interfaces.js';

// ============================================================================
// Schema Version
// ============================================================================

export const SCHEMA_VERSION = 1;

// ============================================================================
// Bot Styles (matches geneticStrategies names)
// ============================================================================

export type BotStyle =
    | 'Contrarian'
    | 'TrendFollowing'
    | 'FirstCandle'
    | 'FirstCandleV2'
    | 'FirstCandleMSPEQ'
    | 'EarlyBuyerMSPEQ'
    | 'MarketMakerMSPEQ'
    | 'NCandleMSPEQ'
    | 'CrossPeriodMomentumMSPEQ'
    | 'EveningStar'
    | 'MorningStar'
    | 'MeanReversion'
    | 'NCandle'
    | 'EarlyBuyerV2'
    | 'EsotericNormalization'
    | 'MarketMaker'
    | 'QuarterlyFirstCandle'
    | 'QuarterlyFirstCandleMSPEQ'
    | 'QuarterlyEarlyBuyerMSPEQ'
    | 'QuarterlyMarketMakerMSPEQ'
    | 'QuarterlyNCandleMSPEQ'
    | 'QuarterlyCrossPeriodMomentumMSPEQ'
    | 'QuarterlyMeanReversion'
    | 'QuarterlyTrendFollowing'
    | 'QuarterlyNCandle'
    | 'QuarterlyEarlyBuyerV2'
    | 'QuarterlyEsotericNormalization'
    | 'QuarterlyMarketMaker';

// ============================================================================
// Output YAML Schema (written by GeneticOptimizedWriter)
// ============================================================================

export interface GeneticYamlOptimization {
    bestPnl: number;
    avgPnl: number;
    generations: number;
    converged: boolean;
    convergenceReason: string;
    timestamp: string;  // ISO 8601 format
    lookbackDays: number;
    populationSize: number;
    maxGenerations: number;
}

export interface GeneticYamlRuntime {
    enabled: boolean;
    prodMode: boolean;
    hourlyDollarLimit: number;
}

export interface GeneticYamlConfig {
    schemaVersion: number;
    botStyle: BotStyle;
    targetedMarket: string;  // TargetedMarket enum value as string

    optimization: GeneticYamlOptimization;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    params: Record<string, any>;  // Supports numbers and nested objects (e.g., PEQ coefficients)
    runtime: GeneticYamlRuntime;
}

// ============================================================================
// Input Config Schema (read by GeneticOptimizedWriter)
// ============================================================================

export interface WriterConfigTarget {
    botStyle: BotStyle;
    market: string;  // Short form like 'btc-hourly', 'eth-quarterly'
}

export interface WriterConfigSettings {
    lookbackDays: number;
    maxGenerations: number;
    populationSize: number;
    intervalHours: number;  // How often to re-run optimization
    concurrentSimulations: number;  // How many simulations to run in parallel
}

export interface WriterConfigSchema {
    settings: WriterConfigSettings;
    targets: WriterConfigTarget[];
}

// ============================================================================
// Market Name Mapping
// ============================================================================

/**
 * Maps short market names to TargetedMarket enum values
 */
export const marketNameMap: Record<string, TargetedMarket> = {
    'btc-hourly': TargetedMarket.BITCOIN_HOURLY,
    'bitcoin-hourly': TargetedMarket.BITCOIN_HOURLY,
    'eth-hourly': TargetedMarket.ETHEREUM_HOURLY,
    'ethereum-hourly': TargetedMarket.ETHEREUM_HOURLY,
    'sol-hourly': TargetedMarket.SOLANA_HOURLY,
    'solana-hourly': TargetedMarket.SOLANA_HOURLY,
    'xrp-hourly': TargetedMarket.XRP_HOURLY,
    'btc-quarterly': TargetedMarket.BITCOIN_QUARTERLY,
    'bitcoin-quarterly': TargetedMarket.BITCOIN_QUARTERLY,
    'eth-quarterly': TargetedMarket.ETHEREUM_QUARTERLY,
    'ethereum-quarterly': TargetedMarket.ETHEREUM_QUARTERLY,
    'sol-quarterly': TargetedMarket.SOLANA_QUARTERLY,
    'solana-quarterly': TargetedMarket.SOLANA_QUARTERLY,
    'xrp-quarterly': TargetedMarket.XRP_QUARTERLY,
};

/**
 * Resolves a short market name to TargetedMarket enum
 */
export function resolveMarketName(market: string): TargetedMarket | null {
    const normalized = market.toLowerCase().trim();
    return marketNameMap[normalized] ?? null;
}

/**
 * Gets the coin type from a TargetedMarket enum value
 */
export function getCoinTypeFromMarket(market: TargetedMarket): 'btc' | 'eth' | 'sol' | 'xrp' {
    const marketStr = market.toString().toLowerCase();
    if (marketStr.includes('bitcoin')) return 'btc';
    if (marketStr.includes('ethereum')) return 'eth';
    if (marketStr.includes('solana')) return 'sol';
    if (marketStr.includes('xrp')) return 'xrp';
    return 'btc';  // Default fallback
}

/**
 * Checks if a market is quarterly (15-minute periods)
 */
export function isQuarterlyMarket(market: TargetedMarket): boolean {
    return market.toString().includes('Quarterly');
}

// ============================================================================
// Valid Bot Styles
// ============================================================================

export const validBotStyles: BotStyle[] = [
    'Contrarian',
    'TrendFollowing',
    'FirstCandle',
    'FirstCandleV2',
    'FirstCandleMSPEQ',
    'EveningStar',
    'MorningStar',
    'MeanReversion',
    'NCandle',
    'EarlyBuyerV2',
    'EsotericNormalization',
    'MarketMaker',
    'QuarterlyFirstCandle',
    'QuarterlyFirstCandleMSPEQ',
    'QuarterlyMeanReversion',
    'QuarterlyTrendFollowing',
    'QuarterlyNCandle',
    'QuarterlyEarlyBuyerV2',
    'QuarterlyEsotericNormalization',
    'QuarterlyMarketMaker',
];

// ============================================================================
// Validation Functions
// ============================================================================

export interface ValidationResult {
    valid: boolean;
    errors: string[];
}

/**
 * Validates a GeneticYamlConfig object
 */
export function validateGeneticYamlConfig(config: unknown): ValidationResult {
    const errors: string[] = [];

    if (!config || typeof config !== 'object') {
        return { valid: false, errors: ['Config must be an object'] };
    }

    const c = config as Record<string, unknown>;

    // Required fields
    if (c.schemaVersion !== SCHEMA_VERSION) {
        errors.push(`Invalid schemaVersion: expected ${SCHEMA_VERSION}, got ${c.schemaVersion}`);
    }

    if (!c.botStyle || typeof c.botStyle !== 'string') {
        errors.push('Missing or invalid botStyle');
    } else if (!validBotStyles.includes(c.botStyle as BotStyle)) {
        errors.push(`Invalid botStyle: ${c.botStyle}`);
    }

    if (!c.targetedMarket || typeof c.targetedMarket !== 'string') {
        errors.push('Missing or invalid targetedMarket');
    }

    // Optimization section
    if (!c.optimization || typeof c.optimization !== 'object') {
        errors.push('Missing or invalid optimization section');
    } else {
        const opt = c.optimization as Record<string, unknown>;
        if (typeof opt.bestPnl !== 'number') errors.push('optimization.bestPnl must be a number');
        if (typeof opt.avgPnl !== 'number') errors.push('optimization.avgPnl must be a number');
        if (typeof opt.generations !== 'number') errors.push('optimization.generations must be a number');
        if (typeof opt.converged !== 'boolean') errors.push('optimization.converged must be a boolean');
        if (typeof opt.convergenceReason !== 'string') errors.push('optimization.convergenceReason must be a string');
        if (typeof opt.timestamp !== 'string') errors.push('optimization.timestamp must be a string');
    }

    // Params section
    if (!c.params || typeof c.params !== 'object') {
        errors.push('Missing or invalid params section');
    } else {
        const params = c.params as Record<string, unknown>;
        for (const [key, value] of Object.entries(params)) {
            if (typeof value !== 'number') {
                errors.push(`params.${key} must be a number, got ${typeof value}`);
            }
        }
    }

    // Runtime section
    if (!c.runtime || typeof c.runtime !== 'object') {
        errors.push('Missing or invalid runtime section');
    } else {
        const rt = c.runtime as Record<string, unknown>;
        if (typeof rt.enabled !== 'boolean') errors.push('runtime.enabled must be a boolean');
        if (typeof rt.prodMode !== 'boolean') errors.push('runtime.prodMode must be a boolean');
        if (typeof rt.hourlyDollarLimit !== 'number') errors.push('runtime.hourlyDollarLimit must be a number');
    }

    return { valid: errors.length === 0, errors };
}

/**
 * Validates a WriterConfigSchema object
 */
export function validateWriterConfig(config: unknown): ValidationResult {
    const errors: string[] = [];

    if (!config || typeof config !== 'object') {
        return { valid: false, errors: ['Config must be an object'] };
    }

    const c = config as Record<string, unknown>;

    // Settings section
    if (!c.settings || typeof c.settings !== 'object') {
        errors.push('Missing or invalid settings section');
    } else {
        const s = c.settings as Record<string, unknown>;
        if (typeof s.lookbackDays !== 'number' || s.lookbackDays < 1) {
            errors.push('settings.lookbackDays must be a positive number');
        }
        if (typeof s.maxGenerations !== 'number' || s.maxGenerations < 1) {
            errors.push('settings.maxGenerations must be a positive number');
        }
        if (typeof s.populationSize !== 'number' || s.populationSize < 1) {
            errors.push('settings.populationSize must be a positive number');
        }
        if (typeof s.intervalHours !== 'number' || s.intervalHours < 0.1) {
            errors.push('settings.intervalHours must be a positive number (minimum 0.1)');
        }
        if (typeof s.concurrentSimulations !== 'number' || s.concurrentSimulations < 1) {
            errors.push('settings.concurrentSimulations must be a positive number (minimum 1)');
        }
    }

    // Targets section
    if (!c.targets || !Array.isArray(c.targets)) {
        errors.push('Missing or invalid targets section (must be an array)');
    } else {
        for (let i = 0; i < c.targets.length; i++) {
            const target = c.targets[i] as Record<string, unknown>;
            if (!target.botStyle || typeof target.botStyle !== 'string') {
                errors.push(`targets[${i}].botStyle must be a string`);
            } else if (!validBotStyles.includes(target.botStyle as BotStyle)) {
                errors.push(`targets[${i}].botStyle is invalid: ${target.botStyle}`);
            }
            if (!target.market || typeof target.market !== 'string') {
                errors.push(`targets[${i}].market must be a string`);
            } else if (!resolveMarketName(target.market)) {
                errors.push(`targets[${i}].market is invalid: ${target.market}`);
            }
        }
    }

    return { valid: errors.length === 0, errors };
}

/**
 * Generates a filename for a bot config YAML
 */
export function generateYamlFilename(botStyle: string, targetedMarket: string): string {
    // Convert to kebab-case friendly format
    return `${botStyle}-${targetedMarket}.yaml`;
}
