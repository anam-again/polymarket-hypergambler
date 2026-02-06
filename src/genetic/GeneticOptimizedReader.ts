import * as fs from 'fs';
import * as path from 'path';
import * as YAML from 'yaml';
import { ClobClient } from '@polymarket/clob-client';
import { MarketInfo } from '../nonBots/MarketInfo.js';
import { QuantBotRun } from '../bots/QuantBot.js';
import { TargetedMarket, BtcDirection } from '../types/interfaces.js';
import {
    GeneticYamlConfig,
    validateGeneticYamlConfig,
    BotStyle,
    generateYamlFilename,
    resolveMarketName,
} from './YamlBotSchema.js';
import { targetMarketToShortname } from '../utils/utils.js';

// ============================================================================
// Bot Overrides Interface
// ============================================================================

export interface BotOverrides {
    name?: string;
    PROD_MODE?: boolean;
    hourlyDollarLimit?: number;
    targetDollars?: number;
    targetBuyPrice?: number;
    targetSellPrice?: number;
    cutoffMinute?: number;
}

// Import all bot classes
import { TrendFollowing } from '../bots/TrendFollowing.js';
import { FirstCandle } from '../bots/FirstCandle.js';
import { FirstCandleV2 } from '../bots/FirstCandleV2.js';
import { MeanReversion } from '../bots/MeanReversion.js';
import { MarketMaker } from '../bots/MarketMaker.js';
import { Contrarian } from '../bots/Contrarian.js';
import { EveningStar } from '../bots/EveningStar.js';
import { MorningStar } from '../bots/MorningStar.js';
import { NCandle } from '../bots/NCandle.js';
import { EarlyBuyerV2 } from '../bots/EarlyBuyerV2.js';
import { EsotericNormalization } from '../bots/EsotericNormalization.js';

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_YAML_DIR = './geneticBotYamls';

// ============================================================================
// Types
// ============================================================================

export interface LoadedBots {
    testBots: QuantBotRun[];
    prodBots: QuantBotRun[];
}

export interface ReaderOptions {
    yamlDir?: string;
    client: ClobClient;
    marketInfo: MarketInfo;
}

// ============================================================================
// GeneticOptimizedReader Class
// ============================================================================

export class GeneticOptimizedReader {
    private yamlDir: string;
    private client: ClobClient;
    private marketInfo: MarketInfo;

    constructor(options: ReaderOptions) {
        this.yamlDir = options.yamlDir ?? DEFAULT_YAML_DIR;
        this.client = options.client;
        this.marketInfo = options.marketInfo;
    }

    // -------------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------------

    /**
     * Loads all enabled bots from YAML files.
     * Returns separate arrays for test and prod bots.
     */
    public loadAllBots(): LoadedBots {
        const testBots: QuantBotRun[] = [];
        const prodBots: QuantBotRun[] = [];

        // Check if directory exists
        if (!fs.existsSync(this.yamlDir)) {
            console.log(`[GeneticReader] YAML directory not found: ${this.yamlDir}`);
            return { testBots, prodBots };
        }

        // Find all YAML files
        const files = fs.readdirSync(this.yamlDir)
            .filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));

        if (files.length === 0) {
            console.log('[GeneticReader] No YAML files found');
            return { testBots, prodBots };
        }

        console.log(`[GeneticReader] Found ${files.length} YAML files`);

        for (const file of files) {
            const filepath = path.join(this.yamlDir, file);
            try {
                const bot = this.loadBotFromFile(filepath);
                if (bot) {
                    if (bot.PROD_MODE) {
                        prodBots.push(bot);
                        console.log(`[GeneticReader] Loaded PROD bot: ${bot.name}`);
                    } else {
                        testBots.push(bot);
                        console.log(`[GeneticReader] Loaded TEST bot: ${bot.name}`);
                    }
                }
            } catch (error) {
                console.error(`[GeneticReader] Error loading ${file}: ${error}`);
            }
        }

        console.log(`[GeneticReader] Loaded ${testBots.length} test bots, ${prodBots.length} prod bots`);
        return { testBots, prodBots };
    }

    /**
     * Loads a single bot by botStyle and market with optional parameter overrides.
     * Returns null if the YAML file doesn't exist or the bot is disabled.
     *
     * @param botStyle - The bot style (e.g., 'TrendFollowing', 'MarketMaker')
     * @param market - Either a TargetedMarket enum or a short string like 'btc-quarterly'
     * @param overrides - Optional parameter overrides (name, PROD_MODE, hourlyDollarLimit, etc.)
     */
    public getBot(
        botStyle: BotStyle,
        market: TargetedMarket | string,
        overrides?: BotOverrides
    ): QuantBotRun | null {
        // Resolve market to TargetedMarket if it's a string
        let targetedMarket: TargetedMarket;
        if (typeof market === 'string') {
            // Check if it's already a valid TargetedMarket enum value
            if (Object.values(TargetedMarket).includes(market as TargetedMarket)) {
                targetedMarket = market as TargetedMarket;
            } else {
                // Try to resolve short name like 'btc-quarterly'
                const resolved = resolveMarketName(market);
                if (!resolved) {
                    throw Error(`[GeneticReader] Unknown market: ${market}`)
                }
                targetedMarket = resolved;
            }
        } else {
            targetedMarket = market;
        }

        // Build filename
        const filename = generateYamlFilename(botStyle, targetedMarket);
        const filepath = path.join(this.yamlDir, filename);

        // Check if file exists
        if (!fs.existsSync(filepath)) {
            throw Error(`[GeneticReader] YAML file not found: ${filepath}`)
        }

        try {
            const content = fs.readFileSync(filepath, 'utf-8');
            const config = YAML.parse(content) as GeneticYamlConfig;

            // Validate the config
            const validation = validateGeneticYamlConfig(config);
            if (!validation.valid) {
                console.error(`[GeneticReader] Invalid config in ${filepath}:`);
                validation.errors.forEach(e => console.error(`  - ${e}`));
                throw Error();
            }

            // Skip disabled bots (unless PROD_MODE override is explicitly set)
            if (!config.runtime.enabled && overrides?.PROD_MODE === undefined) {
                console.log(`[GeneticReader] Bot is disabled: ${botStyle}-${targetedMarket}`);
                return null;
            }

            // Create the bot with overrides
            const bot = this.createBot(config, overrides);
            if (bot) {
                console.log(`[GeneticReader] Loaded bot: ${bot.name} (PROD_MODE=${bot.PROD_MODE})`);
                return bot;
            }
            if (!bot) {
                throw Error(`[GeneticReader] not able to load bot: ${bot}`)
            }
        } catch (error) {
            throw Error(`[GeneticReader] Error loading ${filepath}: ${error}`)
        }
        throw Error("[GeneticReader encountered  unexpected error")
    }

    // -------------------------------------------------------------------------
    // File Loading
    // -------------------------------------------------------------------------

    private loadBotFromFile(filepath: string): QuantBotRun | null {
        const content = fs.readFileSync(filepath, 'utf-8');
        const config = YAML.parse(content) as GeneticYamlConfig;

        // Validate the config
        const validation = validateGeneticYamlConfig(config);
        if (!validation.valid) {
            console.error(`[GeneticReader] Invalid config in ${filepath}:`);
            validation.errors.forEach(e => console.error(`  - ${e}`));
            return null;
        }

        // Skip disabled bots
        if (!config.runtime.enabled) {
            console.log(`[GeneticReader] Skipping disabled bot: ${config.botStyle}-${config.targetedMarket}`);
            return null;
        }

        // Create the bot instance
        return this.createBot(config);
    }

    // -------------------------------------------------------------------------
    // Bot Creation
    // -------------------------------------------------------------------------

    private createBot(config: GeneticYamlConfig, overrides?: BotOverrides): QuantBotRun | null {
        const targetedMarket = config.targetedMarket as TargetedMarket;

        // Apply param overrides to a merged params object
        const mergedParams = { ...config.params };
        if (overrides?.targetDollars !== undefined) mergedParams.targetDollars = overrides.targetDollars;
        if (overrides?.targetBuyPrice !== undefined) mergedParams.targetBuyPrice = overrides.targetBuyPrice;
        if (overrides?.targetSellPrice !== undefined) mergedParams.targetSellPrice = overrides.targetSellPrice;
        if (overrides?.cutoffMinute !== undefined) mergedParams.cutoffMinute = overrides.cutoffMinute;

        // Use overridden name or generate from config
        const name = overrides?.name ?? this.generateBotName(config);

        const commonProps = {
            name,
            client: this.client,
            marketInfo: this.marketInfo,
            PROD_MODE: overrides?.PROD_MODE ?? config.runtime.prodMode,
            hourlyDollarLimit: overrides?.hourlyDollarLimit ?? config.runtime.hourlyDollarLimit,
            targetedMarket,
        };

        switch (config.botStyle) {
            case 'TrendFollowing':
            case 'QuarterlyTrendFollowing':
                return new TrendFollowing({
                    ...commonProps,
                    shortMaPeriod: mergedParams.shortMaPeriod ?? 5,
                    longMaPeriod: mergedParams.longMaPeriod ?? 20,
                    adxPeriod: mergedParams.adxPeriod ?? 14,
                    adxThreshold: mergedParams.adxThreshold ?? 25,
                    atrPeriod: mergedParams.atrPeriod ?? 14,
                    atrStopMultiple: mergedParams.atrStopMultiple ?? 2.0,
                    targetBuyPrice: mergedParams.targetBuyPrice ?? 0.50,
                    targetSellPrice: mergedParams.targetSellPrice ?? 0.60,
                    targetDollars: mergedParams.targetDollars ?? 10,
                    cutoffMinute: mergedParams.cutoffMinute ?? 45,
                });

            case 'FirstCandle':
            case 'QuarterlyFirstCandle':
                return new FirstCandle({
                    ...commonProps,
                    candleMinutes: mergedParams.candleMinutes ?? 15,
                    breakoutBuffer: mergedParams.breakoutBuffer ?? 50,
                    pullbackBuffer: mergedParams.pullbackBuffer ?? 100,
                    targetBuyPrice: mergedParams.targetBuyPrice ?? 0.50,
                    targetSellPrice: mergedParams.targetSellPrice ?? 0.60,
                    targetDollars: mergedParams.targetDollars ?? 10,
                    cutoffMinute: mergedParams.cutoffMinute ?? 45,
                });

            case 'FirstCandleV2':
                return new FirstCandleV2({
                    ...commonProps,
                    candleMinutes: mergedParams.candleMinutes ?? 15,
                    breakoutBuffer: mergedParams.breakoutBuffer ?? 50,
                    pullbackBuffer: mergedParams.pullbackBuffer ?? 100,
                    buyPriceBuffer: mergedParams.buyPriceBuffer ?? 0.02,
                    sellPriceBuffer: mergedParams.sellPriceBuffer ?? 0.02,
                    minProfitMargin: mergedParams.minProfitMargin ?? 0.05,
                    targetDollars: mergedParams.targetDollars ?? 10,
                    cutoffMinute: mergedParams.cutoffMinute ?? 45,
                });

            case 'MeanReversion':
            case 'QuarterlyMeanReversion':
                return new MeanReversion({
                    ...commonProps,
                    lookbackPeriods: mergedParams.lookbackPeriods ?? 20,
                    entryThreshold: mergedParams.entryThreshold ?? 2.0,
                    exitThreshold: mergedParams.exitThreshold ?? 0.5,
                    targetBuyPrice: mergedParams.targetBuyPrice ?? 0.50,
                    targetSellPrice: mergedParams.targetSellPrice ?? 0.60,
                    targetDollars: mergedParams.targetDollars ?? 10,
                    cutoffMinute: mergedParams.cutoffMinute ?? 45,
                });

            case 'MarketMaker':
            case 'QuarterlyMarketMaker':
                return new MarketMaker({
                    ...commonProps,
                    spreadSize: mergedParams.spreadSize ?? 5,
                    minSpreadDistance: mergedParams.minSpreadDistance ?? 0,
                    profitMargin: mergedParams.profitMargin ?? 0.10,
                    minPrice: mergedParams.minPrice ?? 0.40,
                    maxPrice: mergedParams.maxPrice ?? 0.60,
                    stopLossAmount: mergedParams.stopLossAmount ?? 0.10,
                    buyExpirySeconds: mergedParams.buyExpirySeconds ?? 120,
                    totalActiveTrades: mergedParams.totalActiveTrades ?? 10,
                    maxVolatility: mergedParams.maxVolatility ?? 1.0,
                    minVolatility: mergedParams.minVolatility ?? 0,
                    volatilityLookbackPeriods: mergedParams.volatilityLookbackPeriods ?? 15,
                    targetDollars: mergedParams.targetDollars ?? 10,
                    cutoffMinute: mergedParams.cutoffMinute ?? 45,
                });

            case 'Contrarian':
                return new Contrarian({
                    ...commonProps,
                    lookbackHours: mergedParams.lookbackHours ?? 3,
                    targetBuyPrice: mergedParams.targetBuyPrice ?? 0.48,
                    targetSellPrice: mergedParams.targetSellPrice ?? 0.60,
                    targetDollars: mergedParams.targetDollars ?? 10,
                    cutoffMinute: mergedParams.cutoffMinute ?? 30,
                });

            case 'EveningStar':
                return new EveningStar({
                    ...commonProps,
                    candleMinutes: mergedParams.candleMinutes ?? 10,
                    minBullishMove: mergedParams.minBullishMove ?? 50,
                    maxIndecisionRange: mergedParams.maxIndecisionRange ?? 30,
                    minBearishMove: mergedParams.minBearishMove ?? 50,
                    targetBuyPrice: mergedParams.targetBuyPrice ?? 0.50,
                    targetSellPrice: mergedParams.targetSellPrice ?? 0.60,
                    targetDollars: mergedParams.targetDollars ?? 10,
                    cutoffMinute: mergedParams.cutoffMinute ?? 45,
                });

            case 'MorningStar':
                return new MorningStar({
                    ...commonProps,
                    candleMinutes: mergedParams.candleMinutes ?? 10,
                    minBearishMove: mergedParams.minBearishMove ?? 50,
                    maxIndecisionRange: mergedParams.maxIndecisionRange ?? 30,
                    minBullishMove: mergedParams.minBullishMove ?? 50,
                    targetBuyPrice: mergedParams.targetBuyPrice ?? 0.50,
                    targetSellPrice: mergedParams.targetSellPrice ?? 0.60,
                    targetDollars: mergedParams.targetDollars ?? 10,
                    cutoffMinute: mergedParams.cutoffMinute ?? 45,
                });

            case 'NCandle':
            case 'QuarterlyNCandle':
                return new NCandle({
                    ...commonProps,
                    candleMinutes: mergedParams.candleMinutes ?? 10,
                    breakoutBuffer: mergedParams.breakoutBuffer ?? 50,
                    pullbackBuffer: mergedParams.pullbackBuffer ?? 100,
                    buyPriceBuffer: mergedParams.buyPriceBuffer ?? 0.02,
                    sellPriceBuffer: mergedParams.sellPriceBuffer ?? 0.02,
                    minProfitMargin: mergedParams.minProfitMargin ?? 0.05,
                    stopLossMultiplier: mergedParams.stopLossMultiplier ?? 1.5,
                    targetDollars: mergedParams.targetDollars ?? 10,
                    cutoffMinute: mergedParams.cutoffMinute ?? 45,
                    maxTradesPerHour: mergedParams.maxTradesPerHour ?? 2,
                });

            case 'EarlyBuyerV2':
            case 'QuarterlyEarlyBuyerV2': {
                const directionParam = mergedParams.btcDirection ?? 1;
                const btcDirection = directionParam === 1 ? BtcDirection.UP : BtcDirection.DOWN;
                return new EarlyBuyerV2({
                    ...commonProps,
                    targetBuyPrice: mergedParams.targetBuyPrice ?? 0.48,
                    targetSellPrice: mergedParams.targetSellPrice ?? 0.60,
                    targetDollars: mergedParams.targetDollars ?? 10,
                    cutoffMinute: mergedParams.cutoffMinute ?? 30,
                    minFlops: mergedParams.minFlops ?? 3,
                    flopsLookbackHours: mergedParams.flopsLookbackHours ?? 6,
                    btcDirection,
                });
            }

            case 'EsotericNormalization':
            case 'QuarterlyEsotericNormalization':
                return new EsotericNormalization({
                    ...commonProps,
                    baseStdDev: mergedParams.baseStdDev ?? 150,
                    minStdDevRatio: mergedParams.minStdDevRatio ?? 0.25,
                    timeDecayPower: mergedParams.timeDecayPower ?? 1.5,
                    priceScaleMultiplier: mergedParams.priceScaleMultiplier ?? 1.0,
                    priceScaleConstant: mergedParams.priceScaleConstant ?? 0,
                    purchaseThreshold: mergedParams.purchaseThreshold ?? 0.08,
                    sellPremium: mergedParams.sellPremium ?? 0.04,
                    targetDollars: mergedParams.targetDollars ?? 10,
                    cutoffMinute: mergedParams.cutoffMinute ?? 45,
                    maxTradesPerPeriod: mergedParams.maxTradesPerPeriod ?? 2,
                });

            default:
                console.error(`[GeneticReader] Unknown bot style: ${config.botStyle}`);
                return null;
        }
    }

    // -------------------------------------------------------------------------
    // Name Generation
    // -------------------------------------------------------------------------

    /**
     * Generates a bot name from the config parameters.
     * Format: gopt-{style}-{market}-{key_params}
     */
    private generateBotName(config: GeneticYamlConfig): string {
        const style = config.botStyle.toLowerCase();
        const market = targetMarketToShortname(config.targetedMarket as TargetedMarket);
        const params = config.params;

        // Generate a short param summary based on bot style
        let paramSummary = '';
        switch (config.botStyle) {
            case 'TrendFollowing':
            case 'QuarterlyTrendFollowing':
                paramSummary = `smp${params.shortMaPeriod?.toFixed(0) ?? '5'}-lmp${params.longMaPeriod?.toFixed(0) ?? '20'}`;
                break;
            case 'FirstCandle':
            case 'QuarterlyFirstCandle':
                paramSummary = `cm${params.candleMinutes?.toFixed(0) ?? '15'}-bb${params.breakoutBuffer?.toFixed(0) ?? '50'}`;
                break;
            case 'MarketMaker':
            case 'QuarterlyMarketMaker':
                paramSummary = `ss${params.spreadSize?.toFixed(0) ?? '5'}-pm${params.profitMargin?.toFixed(2) ?? '0.10'}`;
                break;
            case 'MeanReversion':
            case 'QuarterlyMeanReversion':
                paramSummary = `lp${params.lookbackPeriods?.toFixed(0) ?? '20'}-et${params.entryThreshold?.toFixed(1) ?? '2.0'}`;
                break;
            default:
                // Generic fallback
                paramSummary = `co${params.cutoffMinute?.toFixed(0) ?? '45'}`;
        }

        return `gopt-${style}-${market}-${paramSummary}`;
    }
}
