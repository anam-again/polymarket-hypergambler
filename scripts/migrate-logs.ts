#!/usr/bin/env npx tsx
/**
 * Historical log migration script.
 * Migrates existing log files to the SQLite database.
 *
 * Usage:
 *   npx tsx scripts/migrate-logs.ts [options]
 *
 * Options:
 *   --trades      Migrate trade audit logs
 *   --bots        Migrate bot logs
 *   --pmarket     Migrate Polymarket price logs
 *   --binance     Migrate Binance market data logs
 *   --all         Migrate all log types (default)
 *   --reset       Reset sync state and re-migrate from beginning
 *   --dry-run     Show what would be migrated without actually doing it
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { TradingDatabase } from '../src/db/TradingDatabase.js';
import type {
    TradeAuditRecord,
    BotLogRecord,
    PmarketPriceRecord,
    BinancePriceHourlyRecord,
    BinancePriceMinuteRecord,
} from '../src/db/types.js';

const BATCH_SIZE = 1000;

// Parse command line arguments
const args = process.argv.slice(2);
const options = {
    trades: args.includes('--trades') || args.includes('--all') || args.length === 0,
    bots: args.includes('--bots') || args.includes('--all') || args.length === 0,
    pmarket: args.includes('--pmarket') || args.includes('--all') || args.length === 0,
    binance: args.includes('--binance') || args.includes('--all') || args.length === 0,
    reset: args.includes('--reset'),
    dryRun: args.includes('--dry-run'),
};

console.log('='.repeat(60));
console.log('Log Migration Script');
console.log('='.repeat(60));
console.log(`Options: ${JSON.stringify(options, null, 2)}`);
console.log('');

const db = TradingDatabase.getInstance();

// ============================================================================
// Trade Audit Migration
// ============================================================================

function migrateTradeAudits(): void {
    const logPath = './logs/audits/tradeAudit.log';

    if (!existsSync(logPath)) {
        console.log('[TRADES] No trade audit log found, skipping');
        return;
    }

    console.log('[TRADES] Migrating trade audits...');

    // Check sync state
    let startByte = 0;
    if (!options.reset) {
        const syncState = db.getSyncState(logPath);
        if (syncState) {
            startByte = syncState.lastBytePosition;
            console.log(`[TRADES] Resuming from byte ${startByte}`);
        }
    }

    const fileSize = statSync(logPath).size;
    if (startByte >= fileSize) {
        console.log('[TRADES] Already up to date');
        return;
    }

    const content = readFileSync(logPath, 'utf-8');
    const lines = content.split('\n').filter(line => line.trim());

    console.log(`[TRADES] Found ${lines.length} lines total`);

    const records: TradeAuditRecord[] = [];
    let successCount = 0;
    let errorCount = 0;

    for (const line of lines) {
        const parts = line.split(', ').map(p => p.trim());
        if (parts.length < 13) {
            errorCount++;
            continue;
        }

        try {
            records.push({
                timestamp: parseInt(parts[0]),
                strategy: parts[1],
                tradeId: parts[2],
                status: parts[3],
                entryTimestamp: parseInt(parts[4]),
                size: parseFloat(parts[5]),
                buyPrice: parseFloat(parts[6]) === -1 ? null : parseFloat(parts[6]),
                sellPrice: parseFloat(parts[7]) === -1 ? null : parseFloat(parts[7]),
                gross: parseFloat(parts[8]),
                pnl: parseFloat(parts[9]),
                mode: parts[10],
                marketHash: parts[11],
                side: parts[12],
            });

            if (records.length >= BATCH_SIZE) {
                if (!options.dryRun) {
                    db.insertTradeAuditBatch(records);
                }
                successCount += records.length;
                console.log(`[TRADES] Migrated ${successCount} records...`);
                records.length = 0;
            }
        } catch (e) {
            errorCount++;
        }
    }

    // Insert remaining records
    if (records.length > 0 && !options.dryRun) {
        db.insertTradeAuditBatch(records);
        successCount += records.length;
    }

    // Update sync state
    if (!options.dryRun) {
        db.updateSyncState({
            filePath: logPath,
            lastBytePosition: fileSize,
            lastSyncTimestamp: Date.now(),
        });
    }

    console.log(`[TRADES] Completed: ${successCount} migrated, ${errorCount} errors`);
}

// ============================================================================
// Bot Log Migration
// ============================================================================

function migrateBotLogs(): void {
    const botsDir = './logs/bots';

    if (!existsSync(botsDir)) {
        console.log('[BOTS] No bot logs directory found, skipping');
        return;
    }

    console.log('[BOTS] Migrating bot logs...');

    const logFiles = readdirSync(botsDir)
        .filter(f => f.endsWith('.log') && !f.includes('Errors'));

    console.log(`[BOTS] Found ${logFiles.length} log files`);

    let totalSuccess = 0;
    let totalErrors = 0;

    for (const file of logFiles) {
        const filePath = `${botsDir}/${file}`;
        const source = file.replace('.log', '');

        // Check sync state
        let startByte = 0;
        if (!options.reset) {
            const syncState = db.getSyncState(filePath);
            if (syncState) {
                startByte = syncState.lastBytePosition;
            }
        }

        const fileSize = statSync(filePath).size;
        if (startByte >= fileSize) {
            continue;
        }

        const content = readFileSync(filePath, 'utf-8');
        const lines = content.split('\n').filter(line => line.trim());

        const records: BotLogRecord[] = [];

        for (const line of lines) {
            // Parse log format: [LEVEL] TIMESTAMP MESSAGE
            const match = line.match(/^\[(\w+)\]\s+(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s+(.*)$/);
            if (!match) continue;

            const [, level, timestamp, message] = match;
            const timestampMs = new Date(timestamp).getTime();

            // Parse ORDER entries for additional details
            let orderId: string | null = null;
            let orderSide: string | null = null;
            let orderAmount: number | null = null;
            let orderPrice: number | null = null;

            if (level === 'ORDER') {
                const parts = message.split(', ').map(p => p.trim());
                if (parts.length >= 7) {
                    orderId = parts[0];
                    orderSide = parts[2];
                    orderAmount = parseFloat(parts[5]) || null;
                    orderPrice = parseFloat(parts[6]) || null;
                }
            }

            records.push({
                timestamp: timestampMs,
                level,
                source,
                message: message.trim(),
                orderId,
                orderSide,
                orderAmount,
                orderPrice,
            });

            if (records.length >= BATCH_SIZE) {
                if (!options.dryRun) {
                    db.insertBotLogBatch(records);
                }
                totalSuccess += records.length;
                records.length = 0;
            }
        }

        // Insert remaining records
        if (records.length > 0 && !options.dryRun) {
            db.insertBotLogBatch(records);
            totalSuccess += records.length;
        }

        // Update sync state
        if (!options.dryRun) {
            db.updateSyncState({
                filePath,
                lastBytePosition: fileSize,
                lastSyncTimestamp: Date.now(),
            });
        }
    }

    console.log(`[BOTS] Completed: ${totalSuccess} migrated, ${totalErrors} errors`);
}

// ============================================================================
// Polymarket Price Migration
// ============================================================================

function migratePmarketPrices(): void {
    const priceDir = './logs/pmarket-price';

    if (!existsSync(priceDir)) {
        console.log('[PMARKET] No Polymarket price directory found, skipping');
        return;
    }

    console.log('[PMARKET] Migrating Polymarket prices...');

    const marketFiles: Record<string, string> = {
        'btc.log': 'btc',
        'ethereum.log': 'eth',
        'solana.log': 'sol',
        'xrp.log': 'xrp',
    };

    let totalSuccess = 0;

    for (const [file, market] of Object.entries(marketFiles)) {
        const filePath = `${priceDir}/${file}`;

        if (!existsSync(filePath)) {
            continue;
        }

        // Check sync state
        let startByte = 0;
        if (!options.reset) {
            const syncState = db.getSyncState(filePath);
            if (syncState) {
                startByte = syncState.lastBytePosition;
            }
        }

        const fileSize = statSync(filePath).size;
        if (startByte >= fileSize) {
            continue;
        }

        const content = readFileSync(filePath, 'utf-8');
        const lines = content.split('\n').filter(line => line.trim());

        console.log(`[PMARKET] Processing ${file}: ${lines.length} lines`);

        const records: PmarketPriceRecord[] = [];

        for (const line of lines) {
            const parts = line.split(',').map(p => p.trim());
            if (parts.length < 3) continue;

            try {
                const timestampMs = new Date(parts[0]).getTime();
                records.push({
                    timestamp: timestampMs,
                    market,
                    upBid: parseFloat(parts[1]),
                    upAsk: parseFloat(parts[2]),
                    downBid: parts.length > 3 ? parseFloat(parts[3]) : null,
                    downAsk: parts.length > 4 ? parseFloat(parts[4]) : null,
                });

                if (records.length >= BATCH_SIZE) {
                    if (!options.dryRun) {
                        db.insertPmarketPriceBatch(records);
                    }
                    totalSuccess += records.length;
                    records.length = 0;
                }
            } catch (e) {
                // Skip invalid lines
            }
        }

        // Insert remaining records
        if (records.length > 0 && !options.dryRun) {
            db.insertPmarketPriceBatch(records);
            totalSuccess += records.length;
        }

        // Update sync state
        if (!options.dryRun) {
            db.updateSyncState({
                filePath,
                lastBytePosition: fileSize,
                lastSyncTimestamp: Date.now(),
            });
        }
    }

    console.log(`[PMARKET] Completed: ${totalSuccess} migrated`);
}

// ============================================================================
// Binance Market Data Migration
// ============================================================================

function migrateBinancePrices(): void {
    const marketDir = './logs/market';

    if (!existsSync(marketDir)) {
        console.log('[BINANCE] No market data directory found, skipping');
        return;
    }

    console.log('[BINANCE] Migrating Binance market data...');

    const hourlyFiles: Record<string, string> = {
        'btc-hourly.log': 'BTCUSDT',
        'eth-hourly.log': 'ETHUSDT',
        'sol-hourly.log': 'SOLUSDT',
        'xrp-hourly.log': 'XRPUSDT',
    };

    const minuteFiles: Record<string, string> = {
        'btc-minute.log': 'BTCUSDT',
        'eth-minute.log': 'ETHUSDT',
        'sol-minute.log': 'SOLUSDT',
        'xrp-minute.log': 'XRPUSDT',
    };

    let totalSuccess = 0;

    // Migrate hourly files
    for (const [file, symbol] of Object.entries(hourlyFiles)) {
        const filePath = `${marketDir}/${file}`;

        if (!existsSync(filePath)) {
            continue;
        }

        // Check sync state
        let startByte = 0;
        if (!options.reset) {
            const syncState = db.getSyncState(filePath);
            if (syncState) {
                startByte = syncState.lastBytePosition;
            }
        }

        const fileSize = statSync(filePath).size;
        if (startByte >= fileSize) {
            continue;
        }

        const content = readFileSync(filePath, 'utf-8');
        const lines = content.split('\n').filter(line => line.trim());

        console.log(`[BINANCE] Processing ${file}: ${lines.length} lines`);

        const records: BinancePriceHourlyRecord[] = [];

        for (const line of lines) {
            const parts = line.split(',').map(p => p.trim());
            if (parts.length < 8) continue;

            try {
                const timestampMs = new Date(parts[0]).getTime();
                records.push({
                    timestamp: timestampMs,
                    symbol,
                    hourlyOpen: parseFloat(parts[1]),
                    averagePrice: parseFloat(parts[2]),
                    hourlyMin: parseFloat(parts[3]),
                    hourlyMax: parseFloat(parts[4]),
                    openFlops: parseInt(parts[5]) || null,
                    averageFlops: parseInt(parts[6]) || null,
                    totalChange: parseFloat(parts[7]) || null,
                });

                if (records.length >= BATCH_SIZE) {
                    if (!options.dryRun) {
                        db.insertBinanceHourlyBatch(records);
                    }
                    totalSuccess += records.length;
                    records.length = 0;
                }
            } catch (e) {
                // Skip invalid lines
            }
        }

        // Insert remaining records
        if (records.length > 0 && !options.dryRun) {
            db.insertBinanceHourlyBatch(records);
            totalSuccess += records.length;
        }

        // Update sync state
        if (!options.dryRun) {
            db.updateSyncState({
                filePath,
                lastBytePosition: fileSize,
                lastSyncTimestamp: Date.now(),
            });
        }
    }

    // Migrate minute files
    for (const [file, symbol] of Object.entries(minuteFiles)) {
        const filePath = `${marketDir}/${file}`;

        if (!existsSync(filePath)) {
            continue;
        }

        // Check sync state
        let startByte = 0;
        if (!options.reset) {
            const syncState = db.getSyncState(filePath);
            if (syncState) {
                startByte = syncState.lastBytePosition;
            }
        }

        const fileSize = statSync(filePath).size;
        if (startByte >= fileSize) {
            continue;
        }

        const content = readFileSync(filePath, 'utf-8');
        const lines = content.split('\n').filter(line => line.trim());

        console.log(`[BINANCE] Processing ${file}: ${lines.length} lines`);

        const records: BinancePriceMinuteRecord[] = [];

        for (const line of lines) {
            const parts = line.split(',').map(p => p.trim());
            if (parts.length < 2) continue;

            try {
                const timestampMs = new Date(parts[0]).getTime();
                records.push({
                    timestamp: timestampMs,
                    symbol,
                    price: parseFloat(parts[1]),
                });

                if (records.length >= BATCH_SIZE) {
                    if (!options.dryRun) {
                        db.insertBinanceMinuteBatch(records);
                    }
                    totalSuccess += records.length;
                    records.length = 0;
                }
            } catch (e) {
                // Skip invalid lines
            }
        }

        // Insert remaining records
        if (records.length > 0 && !options.dryRun) {
            db.insertBinanceMinuteBatch(records);
            totalSuccess += records.length;
        }

        // Update sync state
        if (!options.dryRun) {
            db.updateSyncState({
                filePath,
                lastBytePosition: fileSize,
                lastSyncTimestamp: Date.now(),
            });
        }
    }

    console.log(`[BINANCE] Completed: ${totalSuccess} migrated`);
}

// ============================================================================
// Main
// ============================================================================

console.log('Starting migration...\n');

if (options.trades) {
    migrateTradeAudits();
    console.log('');
}

if (options.bots) {
    migrateBotLogs();
    console.log('');
}

if (options.pmarket) {
    migratePmarketPrices();
    console.log('');
}

if (options.binance) {
    migrateBinancePrices();
    console.log('');
}

// Show final stats
console.log('='.repeat(60));
console.log('Migration complete!');
console.log(`Database location: ${process.env.DB_PATH || './data/trading.db'}`);

const tradeCount = db.getTradeCount();
console.log(`Total trade records in database: ${tradeCount}`);

db.close();
