/**
 * Diagnostic Script: Analyze and clean raw price data from pmarket-price logs
 *
 * This script scans pmarket-price log files (btc.log, ethereum.log, etc.)
 * for anomalous prices at period boundaries, and optionally deletes them.
 *
 * Usage:
 *   npx tsx scripts/diagnose-pmarket-prices.ts <log-file> [--period hourly|quarterly] [--fix]
 *   npx tsx scripts/diagnose-pmarket-prices.ts logs/pmarket-price/btc.log
 *   npx tsx scripts/diagnose-pmarket-prices.ts logs/pmarket-price/btc.log --fix
 *   npx tsx scripts/diagnose-pmarket-prices.ts logs/pmarket-price/btc.log --period quarterly --fix
 */

import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';

interface PriceEntry {
    timestamp: Date;
    upPrice: number;
    downPrice: number;
    lineNumber: number;
    rawLine: string;
    isBad: boolean;
}

interface PeriodData {
    periodKey: string;
    startTime: Date;
    endTime: Date;
    entries: PriceEntry[];
    firstEntry: PriceEntry | null;
    lastEntry: PriceEntry | null;
}

interface DiagnosticResult {
    totalEntries: number;
    totalPeriods: number;
    periodData: Map<string, PeriodData>;
    badEntries: PriceEntry[];
    extremePricesAtStart: PriceEntry[];
    extremePricesCarryOver: { previous: PriceEntry; current: PriceEntry }[];
    anomalies: string[];
    priceDistribution: { up: Map<string, number>; down: Map<string, number> };
}

// Price thresholds
const EXTREME_PRICE_LOW = 0.2;   // Prices <= 0.05 are extreme (end of period losers)
const EXTREME_PRICE_HIGH = 0.8;  // Prices >= 0.95 are extreme (end of period winners)
const NEUTRAL_PRICE_LOW = 0.40;   // Expected range for period start
const NEUTRAL_PRICE_HIGH = 0.60;  // Expected range for period start
const PERIOD_START_SECONDS = 60;  // First 60 seconds of period to check

const DEFAULT_DB_PATH = './data/trading.db';

function parseTimestamp(ts: string): Date | null {
    try {
        return new Date(ts);
    } catch {
        return null;
    }
}

function getPeriodKey(date: Date, isQuarterly: boolean): string {
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    const hour = String(date.getUTCHours()).padStart(2, '0');

    if (isQuarterly) {
        const quarter = Math.floor(date.getUTCMinutes() / 15);
        return `${year}-${month}-${day}T${hour}:Q${quarter}`;
    }
    return `${year}-${month}-${day}T${hour}`;
}

function getSecondsIntoPeriod(date: Date, isQuarterly: boolean): number {
    const minutes = date.getUTCMinutes();
    const seconds = date.getUTCSeconds();

    if (isQuarterly) {
        const minuteInQuarter = minutes % 15;
        return minuteInQuarter * 60 + seconds;
    }
    return minutes * 60 + seconds;
}

function parseLine(line: string, lineNumber: number): PriceEntry | null {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return null;

    // Format: timestamp,upPrice,downPrice
    const parts = trimmed.split(',');
    if (parts.length < 3) return null;

    const timestamp = parseTimestamp(parts[0]);
    if (!timestamp) return null;

    const upPrice = parseFloat(parts[1]);
    const downPrice = parseFloat(parts[2]);

    if (isNaN(upPrice) || isNaN(downPrice)) return null;

    return {
        timestamp,
        upPrice,
        downPrice,
        lineNumber,
        rawLine: trimmed,
        isBad: false,
    };
}

function isExtremePrice(price: number): boolean {
    return price <= EXTREME_PRICE_LOW || price >= EXTREME_PRICE_HIGH;
}

function isNeutralPrice(price: number): boolean {
    return price >= NEUTRAL_PRICE_LOW && price <= NEUTRAL_PRICE_HIGH;
}

function analyzeLogFile(filePath: string, isQuarterly: boolean): DiagnosticResult {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');

    const result: DiagnosticResult = {
        totalEntries: 0,
        totalPeriods: 0,
        periodData: new Map(),
        badEntries: [],
        extremePricesAtStart: [],
        extremePricesCarryOver: [],
        anomalies: [],
        priceDistribution: { up: new Map(), down: new Map() },
    };

    // Parse all entries and group by period
    for (let i = 0; i < lines.length; i++) {
        const entry = parseLine(lines[i], i + 1);
        if (!entry) continue;

        result.totalEntries++;

        // Track price distribution
        const upBucket = (Math.floor(entry.upPrice * 10) / 10).toFixed(1);
        const downBucket = (Math.floor(entry.downPrice * 10) / 10).toFixed(1);
        result.priceDistribution.up.set(upBucket, (result.priceDistribution.up.get(upBucket) || 0) + 1);
        result.priceDistribution.down.set(downBucket, (result.priceDistribution.down.get(downBucket) || 0) + 1);

        // Group by period
        const periodKey = getPeriodKey(entry.timestamp, isQuarterly);
        if (!result.periodData.has(periodKey)) {
            result.periodData.set(periodKey, {
                periodKey,
                startTime: entry.timestamp,
                endTime: entry.timestamp,
                entries: [],
                firstEntry: null,
                lastEntry: null,
            });
        }

        const period = result.periodData.get(periodKey)!;
        period.entries.push(entry);
        period.endTime = entry.timestamp;

        if (!period.firstEntry) {
            period.firstEntry = entry;
        }
        period.lastEntry = entry;

        // Check for extreme prices at period start - mark as bad
        const secondsIntoPeriod = getSecondsIntoPeriod(entry.timestamp, isQuarterly);
        if (secondsIntoPeriod <= PERIOD_START_SECONDS) {
            if (isExtremePrice(entry.upPrice) || isExtremePrice(entry.downPrice)) {
                entry.isBad = true;
                result.extremePricesAtStart.push(entry);
                result.badEntries.push(entry);
            }
        }
    }

    result.totalPeriods = result.periodData.size;

    // Check for carry-over between periods (extreme price at end of period N, similar at start of N+1)
    const sortedPeriods = Array.from(result.periodData.values())
        .sort((a, b) => a.startTime.getTime() - b.startTime.getTime());

    for (let i = 1; i < sortedPeriods.length; i++) {
        const prevPeriod = sortedPeriods[i - 1];
        const currPeriod = sortedPeriods[i];

        if (!prevPeriod.lastEntry || !currPeriod.firstEntry) continue;

        const prevLast = prevPeriod.lastEntry;
        const currFirst = currPeriod.firstEntry;

        // Check if extreme end-of-period prices are carried over (not reset to neutral)
        const upCarryOver = isExtremePrice(prevLast.upPrice) && !isNeutralPrice(currFirst.upPrice);
        const downCarryOver = isExtremePrice(prevLast.downPrice) && !isNeutralPrice(currFirst.downPrice);

        if (upCarryOver || downCarryOver) {
            result.extremePricesCarryOver.push({
                previous: prevLast,
                current: currFirst,
            });
        }
    }

    // Identify issues
    if (result.extremePricesAtStart.length > 0) {
        result.anomalies.push(
            `Found ${result.extremePricesAtStart.length} entries with extreme prices (<=${EXTREME_PRICE_LOW} or >=${EXTREME_PRICE_HIGH}) ` +
            `in the first ${PERIOD_START_SECONDS} seconds of their period`
        );
    }

    if (result.extremePricesCarryOver.length > 0) {
        result.anomalies.push(
            `Found ${result.extremePricesCarryOver.length} period boundaries where extreme end-of-period prices ` +
            `were NOT reset to neutral at the start of the next period`
        );
    }

    return result;
}

function formatTimestamp(date: Date): string {
    return date.toISOString();
}

function extractMarketFromPath(filePath: string): string {
    const basename = path.basename(filePath, '.log');
    // Handle cases like "btc-minutely" -> "btc"
    const parts = basename.split('-');
    return parts[0].toLowerCase();
}

function cleanLogFile(filePath: string, badEntries: PriceEntry[]): number {
    if (badEntries.length === 0) {
        console.log('  No bad entries to remove from log file.');
        return 0;
    }

    const badLineNumbers = new Set(badEntries.map(e => e.lineNumber));
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');

    const cleanedLines: string[] = [];
    let removedCount = 0;

    for (let i = 0; i < lines.length; i++) {
        const lineNumber = i + 1;
        if (badLineNumbers.has(lineNumber)) {
            removedCount++;
        } else {
            cleanedLines.push(lines[i]);
        }
    }

    // Create backup
    const backupPath = filePath + '.backup';
    fs.copyFileSync(filePath, backupPath);
    console.log(`  Created backup: ${backupPath}`);

    // Write cleaned file
    fs.writeFileSync(filePath, cleanedLines.join('\n'));
    console.log(`  Removed ${removedCount} bad entries from log file.`);

    return removedCount;
}

function cleanDatabase(market: string, badEntries: PriceEntry[]): number {
    if (badEntries.length === 0) {
        console.log('  No bad entries to remove from database.');
        return 0;
    }

    if (!fs.existsSync(DEFAULT_DB_PATH)) {
        console.log(`  Database not found at ${DEFAULT_DB_PATH}, skipping database cleanup.`);
        return 0;
    }

    const db = new Database(DEFAULT_DB_PATH);

    // Get timestamps to delete (within 1 second tolerance)
    const badTimestamps = badEntries.map(e => e.timestamp.getTime());

    let totalDeleted = 0;

    // Delete entries matching market and timestamp (with tolerance)
    const deleteStmt = db.prepare(`
        DELETE FROM pmarket_prices
        WHERE market = ?
        AND timestamp >= ?
        AND timestamp <= ?
    `);

    for (const ts of badTimestamps) {
        // Allow 1 second tolerance for timestamp matching
        const result = deleteStmt.run(market, ts - 1000, ts + 1000);
        totalDeleted += result.changes;
    }

    db.close();

    console.log(`  Deleted ${totalDeleted} entries from database for market '${market}'.`);
    return totalDeleted;
}

function printReport(result: DiagnosticResult, filePath: string, isQuarterly: boolean): void {
    const periodType = isQuarterly ? '15-minute' : 'hourly';

    console.log('');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('  PMARKET-PRICE LOG DIAGNOSTIC REPORT');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log(`  File: ${filePath}`);
    console.log(`  Period type: ${periodType}`);
    console.log(`  Total price entries: ${result.totalEntries}`);
    console.log(`  Total periods analyzed: ${result.totalPeriods}`);
    console.log(`  Bad entries to clean: ${result.badEntries.length}`);
    console.log('');

    // Anomalies summary
    if (result.anomalies.length > 0) {
        console.log('ANOMALIES FOUND:');
        result.anomalies.forEach((issue, i) => {
            console.log(`  ${i + 1}. ${issue}`);
        });
        console.log('');
    } else {
        console.log('No anomalies found - price data appears healthy.');
        console.log('');
    }

    // Extreme prices at period start
    if (result.extremePricesAtStart.length > 0) {
        console.log('EXTREME PRICES AT PERIOD START (will be deleted with --fix):');
        console.log('─────────────────────────────────────────────────────────────');
        console.log('  These entries have extreme prices in the first 60 seconds of a period.');
        console.log('  At period start, prices should typically be near 0.50.');
        console.log('');

        result.extremePricesAtStart.slice(0, 15).forEach(entry => {
            const secondsInto = getSecondsIntoPeriod(entry.timestamp, isQuarterly);
            console.log(`  Line ${entry.lineNumber}: ${formatTimestamp(entry.timestamp)}`);
            console.log(`    UP: ${entry.upPrice.toFixed(3)}, DOWN: ${entry.downPrice.toFixed(3)}`);
            console.log(`    Seconds into period: ${secondsInto}`);
            console.log('');
        });

        if (result.extremePricesAtStart.length > 15) {
            console.log(`  ... and ${result.extremePricesAtStart.length - 15} more`);
        }
        console.log('');
    }

    // Price carry-over between periods
    if (result.extremePricesCarryOver.length > 0) {
        console.log('EXTREME PRICE CARRY-OVER BETWEEN PERIODS:');
        console.log('─────────────────────────────────────────────────────────────');
        console.log('  These show period boundaries where extreme end-of-period prices');
        console.log('  were not reset to neutral at the start of the new period.');
        console.log('');

        result.extremePricesCarryOver.slice(0, 10).forEach(pair => {
            console.log(`  Previous period end (line ${pair.previous.lineNumber}):`);
            console.log(`    ${formatTimestamp(pair.previous.timestamp)}`);
            console.log(`    UP: ${pair.previous.upPrice.toFixed(3)}, DOWN: ${pair.previous.downPrice.toFixed(3)}`);
            console.log('');
            console.log(`  Next period start (line ${pair.current.lineNumber}):`);
            console.log(`    ${formatTimestamp(pair.current.timestamp)}`);
            console.log(`    UP: ${pair.current.upPrice.toFixed(3)}, DOWN: ${pair.current.downPrice.toFixed(3)}`);
            console.log('');
            console.log('  ─────');
            console.log('');
        });

        if (result.extremePricesCarryOver.length > 10) {
            console.log(`  ... and ${result.extremePricesCarryOver.length - 10} more`);
        }
        console.log('');
    }

    // Price distribution
    console.log('UP PRICE DISTRIBUTION:');
    console.log('─────────────────────────────────────────────────────────────');
    const sortedUpPrices = Array.from(result.priceDistribution.up.entries())
        .sort((a, b) => parseFloat(a[0]) - parseFloat(b[0]));

    const maxUpCount = Math.max(...sortedUpPrices.map(p => p[1]));
    sortedUpPrices.forEach(([bucket, count]) => {
        const barLength = Math.ceil((count / maxUpCount) * 40);
        const bar = '█'.repeat(barLength);
        const marker = parseFloat(bucket) <= EXTREME_PRICE_LOW || parseFloat(bucket) >= EXTREME_PRICE_HIGH ? ' ⚠' : '';
        console.log(`  ${bucket.padStart(4)}: ${count.toString().padStart(6)} ${bar}${marker}`);
    });
    console.log('');

    console.log('DOWN PRICE DISTRIBUTION:');
    console.log('─────────────────────────────────────────────────────────────');
    const sortedDownPrices = Array.from(result.priceDistribution.down.entries())
        .sort((a, b) => parseFloat(a[0]) - parseFloat(b[0]));

    const maxDownCount = Math.max(...sortedDownPrices.map(p => p[1]));
    sortedDownPrices.forEach(([bucket, count]) => {
        const barLength = Math.ceil((count / maxDownCount) * 40);
        const bar = '█'.repeat(barLength);
        const marker = parseFloat(bucket) <= EXTREME_PRICE_LOW || parseFloat(bucket) >= EXTREME_PRICE_HIGH ? ' ⚠' : '';
        console.log(`  ${bucket.padStart(4)}: ${count.toString().padStart(6)} ${bar}${marker}`);
    });
    console.log('');

    // Period boundary analysis
    console.log('PERIOD BOUNDARY SUMMARY:');
    console.log('─────────────────────────────────────────────────────────────');

    const sortedPeriods = Array.from(result.periodData.values())
        .sort((a, b) => a.startTime.getTime() - b.startTime.getTime());

    console.log('  Showing first entry and last entry prices for each period:');
    console.log('');

    sortedPeriods.slice(0, 20).forEach(period => {
        const first = period.firstEntry;
        const last = period.lastEntry;
        if (!first || !last) return;

        const firstNeutral = isNeutralPrice(first.upPrice) && isNeutralPrice(first.downPrice);
        const lastExtreme = isExtremePrice(last.upPrice) || isExtremePrice(last.downPrice);

        const startStatus = firstNeutral ? '✓' : '⚠';
        const endStatus = lastExtreme ? '→' : '○';

        console.log(`  ${period.periodKey}:`);
        console.log(`    ${startStatus} Start: UP=${first.upPrice.toFixed(2)}, DOWN=${first.downPrice.toFixed(2)}`);
        console.log(`    ${endStatus} End:   UP=${last.upPrice.toFixed(2)}, DOWN=${last.downPrice.toFixed(2)}`);
    });

    if (sortedPeriods.length > 20) {
        console.log(`  ... and ${sortedPeriods.length - 20} more periods`);
    }
    console.log('');

    // Root cause analysis
    console.log('ROOT CAUSE ANALYSIS:');
    console.log('─────────────────────────────────────────────────────────────');

    if (result.extremePricesAtStart.length > 0 || result.extremePricesCarryOver.length > 0) {
        console.log('  POTENTIAL ISSUES DETECTED:');
        console.log('');

        if (result.extremePricesCarryOver.length > 0) {
            console.log('  1. End-of-period prices bleeding into next period');
            console.log('');
            console.log('     At period boundaries, the market should reset to ~0.50/0.50.');
            console.log('     If extreme prices (0.99/0.01) appear at the start of a new');
            console.log('     period, this indicates data from the previous period is being');
            console.log('     incorrectly used.');
            console.log('');
            console.log('     This can cause simulation issues where:');
            console.log('     - Buy orders at $0.01 match immediately (incorrect)');
            console.log('     - Sell orders at $0.99 fail to match (incorrect)');
            console.log('');
        }

        if (result.extremePricesAtStart.length > 0) {
            console.log('  2. Extreme prices appearing too early in period');
            console.log('');
            console.log('     Prices in the first ~60 seconds of a period should be');
            console.log('     relatively neutral (0.40-0.60). Extreme prices this early');
            console.log('     suggest either data issues or very unusual market activity.');
            console.log('');
        }

        console.log('  TO FIX: Run with --fix flag to delete bad entries:');
        console.log(`    npx tsx scripts/diagnose-pmarket-prices.ts ${filePath} --fix`);
        console.log('');
    } else {
        console.log('  Price data appears healthy. Period boundaries show expected');
        console.log('  behavior with neutral prices at start and progression to');
        console.log('  extreme prices near period end.');
        console.log('');
    }

    console.log('═══════════════════════════════════════════════════════════════');
}

// Main
const args = process.argv.slice(2);
if (args.length === 0) {
    console.log('Usage: npx tsx scripts/diagnose-pmarket-prices.ts <log-file> [--period hourly|quarterly] [--fix]');
    console.log('');
    console.log('Options:');
    console.log('  --period hourly|quarterly  Specify period type (auto-detected from filename)');
    console.log('  --fix                      Delete bad entries from log file and database');
    console.log('');
    console.log('Examples:');
    console.log('  npx tsx scripts/diagnose-pmarket-prices.ts logs/pmarket-price/btc.log');
    console.log('  npx tsx scripts/diagnose-pmarket-prices.ts logs/pmarket-price/btc.log --fix');
    console.log('  npx tsx scripts/diagnose-pmarket-prices.ts logs/pmarket-price/btc-minutely.log --period quarterly --fix');
    process.exit(1);
}

const filePath = args[0];
let isQuarterly = false;
let shouldFix = args.includes('--fix');

// Check for period flag
const periodIndex = args.indexOf('--period');
if (periodIndex !== -1 && args[periodIndex + 1]) {
    isQuarterly = args[periodIndex + 1].toLowerCase() === 'quarterly';
}

// Auto-detect from filename if not specified
if (periodIndex === -1) {
    isQuarterly = filePath.toLowerCase().includes('minutely') ||
                  filePath.toLowerCase().includes('15m') ||
                  filePath.toLowerCase().includes('quarterly');
}

if (!fs.existsSync(filePath)) {
    console.error(`Error: File not found: ${filePath}`);
    process.exit(1);
}

console.log(`Analyzing: ${filePath}`);
console.log(`Period type: ${isQuarterly ? 'quarterly (15-min)' : 'hourly'}`);
if (shouldFix) {
    console.log(`Mode: FIX (will delete bad entries)`);
}

const result = analyzeLogFile(filePath, isQuarterly);
printReport(result, filePath, isQuarterly);

// Apply fixes if requested
if (shouldFix && result.badEntries.length > 0) {
    console.log('');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('  APPLYING FIXES');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('');

    const market = extractMarketFromPath(filePath);
    console.log(`  Market: ${market}`);
    console.log(`  Bad entries to remove: ${result.badEntries.length}`);
    console.log('');

    // Clean log file
    console.log('Cleaning log file...');
    const logRemoved = cleanLogFile(filePath, result.badEntries);

    // Clean database
    console.log('');
    console.log('Cleaning database...');
    const dbRemoved = cleanDatabase(market, result.badEntries);

    console.log('');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('  FIX COMPLETE');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log(`  Log entries removed: ${logRemoved}`);
    console.log(`  Database entries removed: ${dbRemoved}`);
    console.log(`  Backup created: ${filePath}.backup`);
    console.log('═══════════════════════════════════════════════════════════════');
} else if (shouldFix && result.badEntries.length === 0) {
    console.log('');
    console.log('No bad entries found - nothing to fix.');
}
