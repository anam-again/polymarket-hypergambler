/**
 * Bot Factory - Instantiates bots from BotLifecycleRecords.
 *
 * Bridges the pipeline's database records with live QuantBotRun instances
 * by reusing the existing SimulatorParamsAdapter infrastructure.
 */
import { ClobClient } from '@polymarket/clob-client';
import { MarketInfo } from '../nonBots/MarketInfo.js';
import { QuantBotRun } from '../bots/QuantBot.js';
import { getBaseType } from '../strategies/index.js';
import {
    resolveMarket,
    extractFirstCandleMSPEQProps,
    extractEarlyBuyerMSPEQProps,
    extractNCandleMSPEQProps,
    extractCrossPeriodMomentumMSPEQProps,
    extractVWAPMSPEQProps,
    extractOrderFlowImbalanceMSPEQProps,
    extractBollingerBandBreakoutMSPEQProps,
    extractMarketMakerMSPEQProps,
    type CommonBotConfig,
    type SimulatorYamlOutput,
    type MLBotConfig,
} from '../adapters/SimulatorParamsAdapter.js';
import { FirstCandleMSPEQ } from '../bots/FirstCandleMSPEQ.js';
import { EarlyBuyerMSPEQ } from '../bots/EarlyBuyerMSPEQ.js';
import { NCandleMSPEQ } from '../bots/NCandleMSPEQ.js';
import { CrossPeriodMomentumMSPEQ } from '../bots/CrossPeriodMomentumMSPEQ.js';
import { VWAPMSPEQ } from '../bots/VWAPMSPEQ.js';
import { OrderFlowImbalanceMSPEQ } from '../bots/OrderFlowImbalanceMSPEQ.js';
import { BollingerBandBreakoutMSPEQ } from '../bots/BollingerBandBreakoutMSPEQ.js';
import { MarketMakerMSPEQ } from '../bots/MarketMakerMSPEQ.js';
import { targetMarketToShortname } from '../utils/utils.js';
import type { BotLifecycleRecord } from './types.js';

// ============================================================================
// Common Props Interface
// ============================================================================

export interface PipelineBotProps {
    client: ClobClient;
    marketInfo: MarketInfo;
    PROD_MODE: boolean;
    hourlyDollarLimit: number;
    targetDollars?: number;
    ml?: MLBotConfig;
}

// ============================================================================
// Bot Factory
// ============================================================================

/**
 * Extracts coin string from market name for YAML compatibility.
 */
function extractCoinFromMarket(market: string): string {
    const marketLower = market.toLowerCase();
    if (marketLower.includes('btc') || marketLower.includes('bitcoin')) return 'btc';
    if (marketLower.includes('eth') || marketLower.includes('ethereum')) return 'eth';
    if (marketLower.includes('sol') || marketLower.includes('solana')) return 'sol';
    if (marketLower.includes('xrp')) return 'xrp';
    return 'btc';
}

/**
 * Creates a live QuantBotRun instance from a BotLifecycleRecord.
 *
 * Routes to the appropriate factory based on getBaseType(strategy).
 * Reuses the SimulatorParamsAdapter extractXXXProps() functions.
 *
 * @param record - The bot lifecycle record with strategy, market, and params
 * @param commonProps - Common bot configuration (client, marketInfo, PROD_MODE, etc.)
 * @returns A configured bot instance, or null if the strategy is unsupported
 */
export function loadBotFromLifecycleRecord(
    record: BotLifecycleRecord,
    commonProps: PipelineBotProps,
): QuantBotRun | null {
    const params = JSON.parse(record.paramsJson ?? '{}') as Record<string, number>;
    const baseType = getBaseType(record.strategy);

    // Build a SimulatorYamlOutput for compatibility with existing adapters
    const yaml: SimulatorYamlOutput = {
        strategy: record.strategy,
        market: record.market,
        coin: extractCoinFromMarket(record.market),
        days: 14,
        params,
    };

    const config: CommonBotConfig = {
        client: commonProps.client,
        marketInfo: commonProps.marketInfo,
        PROD_MODE: commonProps.PROD_MODE,
        hourlyDollarLimit: commonProps.hourlyDollarLimit,
        targetDollars: commonProps.targetDollars ?? 20,
        ml: commonProps.ml,
    };

    try {
        switch (baseType) {
            case 'FirstCandleMSPEQ': {
                const props = extractFirstCandleMSPEQProps(yaml, config);
                // Override name to use botId for tracking in trade_audits
                props.name = record.botId;
                return new FirstCandleMSPEQ(props);
            }
            case 'EarlyBuyerMSPEQ': {
                const props = extractEarlyBuyerMSPEQProps(yaml, config);
                props.name = record.botId;
                return new EarlyBuyerMSPEQ(props);
            }
            case 'NCandleMSPEQ': {
                const props = extractNCandleMSPEQProps(yaml, config);
                props.name = record.botId;
                return new NCandleMSPEQ(props);
            }
            case 'CrossPeriodMomentumMSPEQ': {
                const props = extractCrossPeriodMomentumMSPEQProps(yaml, config);
                props.name = record.botId;
                return new CrossPeriodMomentumMSPEQ(props);
            }
            case 'VWAPMSPEQ': {
                const props = extractVWAPMSPEQProps(yaml, config);
                props.name = record.botId;
                return new VWAPMSPEQ(props);
            }
            case 'OrderFlowImbalanceMSPEQ': {
                const props = extractOrderFlowImbalanceMSPEQProps(yaml, config);
                props.name = record.botId;
                return new OrderFlowImbalanceMSPEQ(props);
            }
            case 'BollingerBandBreakoutMSPEQ': {
                const props = extractBollingerBandBreakoutMSPEQProps(yaml, config);
                props.name = record.botId;
                return new BollingerBandBreakoutMSPEQ(props);
            }
            case 'MarketMakerMSPEQ': {
                const props = extractMarketMakerMSPEQProps(yaml, config);
                props.name = record.botId;
                return new MarketMakerMSPEQ(props);
            }
            default: {
                console.warn(`[botFactory] Unsupported base type "${baseType}" for strategy "${record.strategy}"`);
                return null;
            }
        }
    } catch (error) {
        console.error(`[botFactory] Failed to create bot ${record.botId}:`, error);
        return null;
    }
}
