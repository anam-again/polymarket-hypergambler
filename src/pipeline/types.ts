/**
 * Bot Pipeline - Shared Types & Interfaces
 *
 * Defines the bot lifecycle state machine, database record types,
 * and configuration interfaces for the pipeline stages.
 */

// ============================================================================
// Bot Lifecycle States
// ============================================================================

/**
 * States in the bot lifecycle state machine:
 *
 * SIMULATED --> TEST_RUNNING --> TEST_EVALUATED --> PROD_CANDIDATE --> [USER APPROVES] --> PROD_RUNNING
 *                                     |                                                        |
 *                                     +--> RETIRED                                             +--> RETIRED
 */
export enum BotLifecycleState {
    /** Bot passed simulation criteria, awaiting promotion to test */
    SIMULATED = 'SIMULATED',
    /** Bot is running live in test mode (PROD_MODE=false) */
    TEST_RUNNING = 'TEST_RUNNING',
    /** Bot has been evaluated after 48h+ of test data */
    TEST_EVALUATED = 'TEST_EVALUATED',
    /** Bot passed test evaluation, awaiting user approval for production */
    PROD_CANDIDATE = 'PROD_CANDIDATE',
    /** Bot is running live in production mode (PROD_MODE=true) */
    PROD_RUNNING = 'PROD_RUNNING',
    /** Bot has been retired (failed evaluation or manual removal) */
    RETIRED = 'RETIRED',
}

// ============================================================================
// Database Record Types
// ============================================================================

export interface BotLifecycleRecord {
    id?: number;
    botId: string;
    strategy: string;
    market: string;
    state: BotLifecycleState;
    yamlPath?: string | null;
    paramsJson?: string | null;

    // Simulation metrics
    simPnl?: number | null;
    simSharpe?: number | null;
    simSortino?: number | null;
    simCalmar?: number | null;
    simWinRate?: number | null;
    simMaxDrawdown?: number | null;
    simTotalTrades?: number | null;
    simTimestamp?: number | null;

    // Test metrics (populated after 48h evaluation)
    testStartTimestamp?: number | null;
    testPnl?: number | null;
    testWinRate?: number | null;
    testTradeCount?: number | null;
    testSharpe?: number | null;
    testEvaluatedAt?: number | null;

    // Prod metrics
    prodStartTimestamp?: number | null;
    prodPnl?: number | null;
    prodWinRate?: number | null;
    prodTradeCount?: number | null;
    prodLastChecked?: number | null;

    // Lifecycle timestamps
    createdAt: number;
    updatedAt: number;
    retiredAt?: number | null;
    retireReason?: string | null;

    // Promotion metadata
    promotedBy?: string | null;
    demotedFrom?: string | null;
}

export interface PipelineStateRecord {
    id?: number;
    stageName: string;
    lastRunTimestamp?: number | null;
    nextScheduledRun?: number | null;
    status: 'IDLE' | 'RUNNING' | 'ERROR';
    lastError?: string | null;
    runCount: number;
    lastRunDurationMs?: number | null;
    configJson?: string | null;
}

export interface PipelineEventRecord {
    id?: number;
    timestamp: number;
    stageName: string;
    eventType: PipelineEventType;
    botId?: string | null;
    detailsJson?: string | null;
    severity: 'INFO' | 'WARN' | 'ERROR';
}

export type PipelineEventType =
    | 'SIMULATION_COMPLETE'
    | 'SIMULATION_FAILED'
    | 'BOT_PROMOTED_TO_TEST'
    | 'BOT_EVALUATED'
    | 'BOT_PROMOTED_TO_PROD_CANDIDATE'
    | 'BOT_APPROVED_FOR_PROD'
    | 'BOT_REJECTED'
    | 'BOT_RETIRED'
    | 'STAGE_ERROR'
    | 'STAGE_RUN_COMPLETE';

// ============================================================================
// Pipeline Stage Interface
// ============================================================================

export interface IPipelineStage {
    readonly name: string;
    start(): void;
    stop(): void;
    runOnce(): Promise<void>;
    isRunning(): boolean;
}

// ============================================================================
// Configuration Types
// ============================================================================

export interface PipelineStageConfig {
    enabled: boolean;
    intervalMs: number;
}

export interface PipelineConfig {
    /** Simulation runner settings */
    simulation: PipelineStageConfig & {
        lookbackDays: number;
        strategies: string[];
        markets: string[];
        populationSize: number;
        maxGenerations: number;
    };
    /** Bot promoter (sim -> test) settings */
    promoter: PipelineStageConfig & {
        maxTestBots: number;
    };
    /** Test evaluator settings */
    evaluator: PipelineStageConfig & {
        evaluationWindowMs: number;
    };
    /** Prod promotion settings */
    prodPromotion: PipelineStageConfig;
    /** Prod monitor settings */
    prodMonitor: PipelineStageConfig & {
        evaluationWindowMs: number;
    };
    /** Maximum concurrent bot limits */
    maxConcurrentBots: {
        test: number;
        prod: number;
    };
    /** Criteria for promoting from simulation to test */
    simPromotionCriteria: SimPromotionCriteria;
    /** Criteria for evaluating test bots */
    testEvaluationCriteria: TestEvaluationCriteria;
    /** Criteria for retiring prod bots */
    prodRetirementCriteria: ProdRetirementCriteria;
}

export interface SimPromotionCriteria {
    minSimPnl: number;
    minSimSharpe: number;
    minSimWinRate: number;
    minSimTrades: number;
    maxSimDrawdown: number;
}

export interface TestEvaluationCriteria {
    minTestPnl: number;
    minTestWinRate: number;
    minTestTrades: number;
    evaluationWindowMs: number;  // 48h = 172800000
}

export interface ProdRetirementCriteria {
    maxNegativePnl: number;
    minWinRate: number;
    evaluationWindowMs: number;
    minTradesForEvaluation: number;
}

// ============================================================================
// Metrics Types
// ============================================================================

export interface BotMetrics {
    pnl: number;
    winRate: number;
    tradeCount: number;
    sharpe: number;
}

// ============================================================================
// Default Configuration
// ============================================================================

const FORTY_EIGHT_HOURS = 48 * 60 * 60 * 1000;
const FOUR_DAYS = FORTY_EIGHT_HOURS * 2;

export const DEFAULT_PIPELINE_CONFIG: PipelineConfig = {
    simulation: {
        enabled: true,
        intervalMs: 2 * 60 * 60 * 1000,  // Every 2 hours
        lookbackDays: 14,
        strategies: [
            'FirstCandleMSPEQ',
            'EarlyBuyerMSPEQ',
            'NCandleMSPEQ',
            'MarketMakerMSPEQ',
            'CrossPeriodMomentumMSPEQ',
            'VWAPMSPEQ',
            'OrderFlowImbalanceMSPEQ',
            'BollingerBandBreakoutMSPEQ',
        ],
        markets: [
            'BitcoinHourly',
            'BitcoinQuarterly',
            'EthereumHourly',
            'EthereumQuarterly',
            'SolanaHourly',
            'SolanaQuarterly',
            'XrpHourly',
            'XrpQuarterly',
        ],
        populationSize: 30,
        maxGenerations: 20,
    },
    promoter: {
        enabled: true,
        intervalMs: 30 * 60 * 1000,  // Every 30 minutes
        maxTestBots: 10,
    },
    evaluator: {
        enabled: true,
        intervalMs: 60 * 60 * 1000,  // Every 1 hour
        evaluationWindowMs: FORTY_EIGHT_HOURS,
    },
    prodPromotion: {
        enabled: true,
        intervalMs: 2 * 60 * 60 * 1000,  // Every 2 hours
    },
    prodMonitor: {
        enabled: true,
        intervalMs: 30 * 60 * 1000,  // Every 30 minutes
        evaluationWindowMs: FORTY_EIGHT_HOURS,
    },
    maxConcurrentBots: {
        test: 10,
        prod: 5,
    },
    simPromotionCriteria: {
        minSimPnl: 20,           
        minSimSharpe: 0.01,      
        minSimWinRate: 5,      
        minSimTrades: 3,       
        maxSimDrawdown: -200,   
    },
    testEvaluationCriteria: {
        minTestPnl: 0,         
        minTestWinRate: 10,     
        minTestTrades: 5,      
        evaluationWindowMs: FOUR_DAYS,
    },
    prodRetirementCriteria: {
        maxNegativePnl: -20,  
        minWinRate: 10,      
        evaluationWindowMs: FOUR_DAYS,
        minTradesForEvaluation: 10,
    },
};
