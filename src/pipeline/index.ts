/**
 * Pipeline Entry Point - Runs the BotPipeline as a separate process.
 *
 * Usage: npm run pipeline
 *
 * This runs the autonomous bot lifecycle system independently from the main
 * trading bot system (npm run start). The pipeline:
 * 1. Discovers profitable strategies via genetic optimization (SimulationRunner)
 * 2. Promotes promising bots to test mode (BotPromoter)
 * 3. Evaluates test bots after 48h+ (TestEvaluator)
 * 4. Monitors prod candidates awaiting user approval (ProdPromotion)
 * 5. Monitors prod bots and retires underperformers (ProdMonitor)
 *
 * PROD_CANDIDATE bots require explicit user approval via the dashboard API.
 */
import { Credentials } from '../nonBots/Credentials.js';
import { MarketInfo } from '../nonBots/MarketInfo.js';
import { OrderBatcher, QuantBotRun } from '../bots/QuantBot.js';
import { TradingDatabase } from '../db/TradingDatabase.js';
import { BotPipeline } from './BotPipeline.js';
import type { MLBotConfig } from '../adapters/SimulatorParamsAdapter.js';

// ============================================================================
// Initialize Core Dependencies
// ============================================================================

console.log('[PIPELINE] Starting Bot Pipeline...');
console.log('[PIPELINE] Initializing database...');
const tradingDb = TradingDatabase.getInstance();
console.log(`[PIPELINE] Database initialized at ${process.env.DB_PATH || './data/trading.db'}`);

console.log('[PIPELINE] Initializing API credentials...');
const credentials = new Credentials();
const clobClient = await credentials.initClobClient();

console.log('[PIPELINE] Initializing market info...');
const marketInfo = new MarketInfo({
    client: clobClient,
});

// Initialize order batcher (required for bot execution)
OrderBatcher.initialize(clobClient, 200);

// ============================================================================
// ML Configuration for Pipeline Bots
// ============================================================================

const mlConfig: MLBotConfig = {
    useMLGating: true,
    minMLConfidence: 0.5,
    mlPositionMultiplier: 1.0,
    mlModelBasePath: './models',
};

// ============================================================================
// Common Bot Props
// ============================================================================

const commonProps = {
    client: clobClient,
    marketInfo,
};

const commonTestProps = {
    ...commonProps,
    PROD_MODE: false,
    hourlyDollarLimit: 100000,
    targetDollars: 20,
    ml: mlConfig,
};

const commonProdProps = {
    ...commonProps,
    PROD_MODE: true,
    hourlyDollarLimit: 100000,
    ml: mlConfig,
};

// ============================================================================
// Pipeline-Managed Bot Arrays
// ============================================================================

// These arrays hold bots created and managed by the pipeline.
// Unlike index.ts, we don't manually populate these - the pipeline does.
const testBots: QuantBotRun[] = [];
const prodBots: QuantBotRun[] = [];

// ============================================================================
// Initialize Pipeline
// ============================================================================

const botPipeline = new BotPipeline({
    tradingDb,
    testBots,
    prodBots,
    commonTestProps,
    commonProdProps,
});

// Export for dashboard API access
export { botPipeline };

// ============================================================================
// Service Lifecycle
// ============================================================================

let isRunning = false;

function startPipeline(): void {
    if (isRunning) return;
    isRunning = true;

    console.log('[PIPELINE] Starting services...');

    // Start market info for price data
    try {
        marketInfo.run();
    } catch (e) {
        console.error('[PIPELINE] marketInfo.run() failed:', e);
        throw e;
    }

    // Start the pipeline
    try {
        botPipeline.start();
        console.log('[PIPELINE] Bot Pipeline started successfully.');
    } catch (e) {
        console.error('[PIPELINE] botPipeline.start() failed:', e);
        throw e;
    }
}

function stopPipeline(): void {
    if (!isRunning) return;
    isRunning = false;

    console.log('[PIPELINE] Stopping services...');

    try {
        botPipeline.stop();
    } catch (e) {
        console.error('[PIPELINE] Error stopping botPipeline:', e);
    }

    try {
        marketInfo.stopPriceLogging();
    } catch (e) {
        console.error('[PIPELINE] Error stopping marketInfo:', e);
    }

    try {
        tradingDb.close();
        console.log('[PIPELINE] Database closed');
    } catch (e) {
        console.error('[PIPELINE] Error closing database:', e);
    }
}

// ============================================================================
// Graceful Shutdown
// ============================================================================

let isShuttingDown = false;

async function gracefulShutdown(signal: string): Promise<void> {
    if (isShuttingDown) {
        console.log('[PIPELINE] Shutdown already in progress...');
        return;
    }
    isShuttingDown = true;

    console.log(`\n[PIPELINE] Received ${signal}. Initiating graceful shutdown...`);

    stopPipeline();

    // Give some time for cleanup
    await new Promise(resolve => setTimeout(resolve, 2000));

    console.log('[PIPELINE] Shutdown complete. Exiting.');
    process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// Handle uncaught errors
process.on('uncaughtException', (error) => {
    console.error('[PIPELINE] Uncaught exception:', error);
    gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason) => {
    console.error('[PIPELINE] Unhandled rejection:', reason);
    gracefulShutdown('unhandledRejection');
});

// ============================================================================
// Start
// ============================================================================

startPipeline();
