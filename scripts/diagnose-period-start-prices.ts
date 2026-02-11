/**
 * Diagnostic Script: Analyze period start prices in simulation logs
 *
 * This script scans simulation logs for unrealistic prices at period start.
 *
 * Usage:
 *   npx ts-node scripts/diagnose-period-start-prices.ts <log-file>
 *   npx ts-node scripts/diagnose-period-start-prices.ts logs/simulator/test-run1-EarlyBuyerMSPEQ-Stage2Only.log
 */

import * as fs from 'fs';
import * as path from 'path';

interface PeriodStartTrade {
    timestamp: string;
    price: number;
    mspeqOut: number;
    volatility: number;
    momentum: number;
    periodId?: string;
    minuteInPeriod: number;
    lineNumber: number;
    rawLine: string;
}

interface DiagnosticResult {
    totalPeriods: number;
    unrealisticTrades: PeriodStartTrade[];
    lowMspeqOutputTrades: PeriodStartTrade[];
    priceDistribution: Map<string, number>;
    issues: string[];
}

const UNREALISTIC_BUY_PRICE_THRESHOLD = 0.05;  // Prices below 0.05 are suspicious
const LOW_MSPEQ_OUTPUT_THRESHOLD = 0.1;         // MSPEQ output below 0.1 is suspicious
const PERIOD_START_MINUTES = 5;                  // First 5 minutes of period

function parseTimestamp(ts: string): Date | null {
    try {
        return new Date(ts);
    } catch {
        return null;
    }
}

function getMinuteInPeriod(date: Date, isQuarterly: boolean): number {
    const minute = date.getMinutes();
    if (isQuarterly) {
        return minute % 15;
    }
    return minute;
}

function analyzeLine(line: string, lineNumber: number, isQuarterly: boolean): PeriodStartTrade | null {
    // Look for createBuyOrder lines with price and mspeqOut
    const buyOrderMatch = line.match(
        /\[INFO\]\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z)\s+createBuyOrder.*price=([0-9.]+).*mspeqOut=([0-9.]+).*vol=([0-9.-]+).*mom=([0-9.-]+)/
    );

    if (buyOrderMatch) {
        const [, timestamp, price, mspeqOut, vol, mom] = buyOrderMatch;
        const date = parseTimestamp(timestamp);
        if (!date) return null;

        const minuteInPeriod = getMinuteInPeriod(date, isQuarterly);

        return {
            timestamp,
            price: parseFloat(price),
            mspeqOut: parseFloat(mspeqOut),
            volatility: parseFloat(vol),
            momentum: parseFloat(mom),
            minuteInPeriod,
            lineNumber,
            rawLine: line.substring(0, 200),
        };
    }

    // Also look for ORDER lines with very low prices
    const orderMatch = line.match(
        /\[ORDER\]\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z)\s+[^,]+,\s*[^,]+,\s*BUY,\s*[^,]+,\s*[^,]+,\s*[^,]+,\s*([0-9.]+)/
    );

    if (orderMatch) {
        const [, timestamp, price] = orderMatch;
        const date = parseTimestamp(timestamp);
        if (!date) return null;

        const minuteInPeriod = getMinuteInPeriod(date, isQuarterly);

        return {
            timestamp,
            price: parseFloat(price),
            mspeqOut: -1, // Not available in ORDER lines
            volatility: -1,
            momentum: -1,
            minuteInPeriod,
            lineNumber,
            rawLine: line.substring(0, 200),
        };
    }

    return null;
}

function diagnoseLogFile(filePath: string): DiagnosticResult {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');

    const isQuarterly = filePath.toLowerCase().includes('quarterly') ||
                        content.includes('MarketSchedule.QUARTERLY') ||
                        content.includes('15-minute');

    const result: DiagnosticResult = {
        totalPeriods: 0,
        unrealisticTrades: [],
        lowMspeqOutputTrades: [],
        priceDistribution: new Map(),
        issues: [],
    };

    // Count periods
    const periodResets = lines.filter(l => l.includes('Doing reset at time'));
    result.totalPeriods = periodResets.length;

    // Analyze each line
    for (let i = 0; i < lines.length; i++) {
        const trade = analyzeLine(lines[i], i + 1, isQuarterly);
        if (!trade) continue;

        // Track price distribution
        const priceBucket = (Math.floor(trade.price * 10) / 10).toFixed(1);
        result.priceDistribution.set(
            priceBucket,
            (result.priceDistribution.get(priceBucket) || 0) + 1
        );

        // Check for unrealistic prices at period start
        if (trade.minuteInPeriod <= PERIOD_START_MINUTES) {
            if (trade.price < UNREALISTIC_BUY_PRICE_THRESHOLD) {
                result.unrealisticTrades.push(trade);
            }
        }

        // Check for low MSPEQ output
        if (trade.mspeqOut >= 0 && trade.mspeqOut < LOW_MSPEQ_OUTPUT_THRESHOLD) {
            result.lowMspeqOutputTrades.push(trade);
        }
    }

    // Identify issues
    if (result.unrealisticTrades.length > 0) {
        result.issues.push(
            `Found ${result.unrealisticTrades.length} trades with unrealistic prices (< ${UNREALISTIC_BUY_PRICE_THRESHOLD}) at period start`
        );
    }

    if (result.lowMspeqOutputTrades.length > 0) {
        result.issues.push(
            `Found ${result.lowMspeqOutputTrades.length} trades with very low MSPEQ output (< ${LOW_MSPEQ_OUTPUT_THRESHOLD})`
        );
    }

    // Check for correlation between low MSPEQ and period start
    const periodStartLowMspeq = result.lowMspeqOutputTrades.filter(
        t => t.minuteInPeriod <= PERIOD_START_MINUTES
    );
    if (periodStartLowMspeq.length > 0) {
        result.issues.push(
            `Found ${periodStartLowMspeq.length} trades with low MSPEQ output occurring at period start - this suggests signal initialization issues`
        );
    }

    return result;
}

function printReport(result: DiagnosticResult, filePath: string): void {
    console.log('');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('  PERIOD START PRICE DIAGNOSTIC REPORT');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log(`  File: ${filePath}`);
    console.log(`  Total periods analyzed: ${result.totalPeriods}`);
    console.log('');

    // Issues summary
    if (result.issues.length > 0) {
        console.log('ISSUES FOUND:');
        result.issues.forEach((issue, i) => {
            console.log(`  ${i + 1}. ${issue}`);
        });
        console.log('');
    } else {
        console.log('No issues found.');
        console.log('');
    }

    // Unrealistic trades at period start
    if (result.unrealisticTrades.length > 0) {
        console.log('UNREALISTIC PRICES AT PERIOD START:');
        console.log('─────────────────────────────────────────────────────────────');
        result.unrealisticTrades.slice(0, 10).forEach(trade => {
            console.log(`  Line ${trade.lineNumber}: ${trade.timestamp}`);
            console.log(`    Price: ${trade.price.toFixed(4)}, MSPEQ: ${trade.mspeqOut.toFixed(4)}`);
            console.log(`    Minute in period: ${trade.minuteInPeriod}`);
            console.log(`    Vol: ${trade.volatility.toFixed(4)}, Mom: ${trade.momentum.toFixed(4)}`);
            console.log('');
        });
        if (result.unrealisticTrades.length > 10) {
            console.log(`  ... and ${result.unrealisticTrades.length - 10} more`);
        }
        console.log('');
    }

    // Low MSPEQ output trades
    if (result.lowMspeqOutputTrades.length > 0) {
        console.log('LOW MSPEQ OUTPUT TRADES:');
        console.log('─────────────────────────────────────────────────────────────');
        result.lowMspeqOutputTrades.slice(0, 10).forEach(trade => {
            console.log(`  Line ${trade.lineNumber}: ${trade.timestamp}`);
            console.log(`    Price: ${trade.price.toFixed(4)}, MSPEQ: ${trade.mspeqOut.toFixed(4)}`);
            console.log(`    Minute in period: ${trade.minuteInPeriod}`);
            console.log(`    Vol: ${trade.volatility.toFixed(4)}, Mom: ${trade.momentum.toFixed(4)}`);
            console.log('');
        });
        if (result.lowMspeqOutputTrades.length > 10) {
            console.log(`  ... and ${result.lowMspeqOutputTrades.length - 10} more`);
        }
        console.log('');
    }

    // Price distribution
    console.log('PRICE DISTRIBUTION:');
    console.log('─────────────────────────────────────────────────────────────');
    const sortedPrices = Array.from(result.priceDistribution.entries())
        .sort((a, b) => parseFloat(a[0]) - parseFloat(b[0]));

    sortedPrices.forEach(([bucket, count]) => {
        const bar = '█'.repeat(Math.min(50, Math.ceil(count / 2)));
        console.log(`  ${bucket.padStart(4)}: ${count.toString().padStart(5)} ${bar}`);
    });
    console.log('');

    // Root cause analysis
    console.log('ROOT CAUSE ANALYSIS:');
    console.log('─────────────────────────────────────────────────────────────');

    const hasLowMspeqAtStart = result.lowMspeqOutputTrades.some(t => t.minuteInPeriod <= PERIOD_START_MINUTES);
    const hasVeryLowPrices = result.unrealisticTrades.length > 0;

    if (hasLowMspeqAtStart && hasVeryLowPrices) {
        console.log('  LIKELY CAUSE: MSPEQ coefficients producing near-zero output');
        console.log('');
        console.log('  The genetic optimizer may have converged on MSPEQ coefficients');
        console.log('  that produce extremely low output values. When mspeqOut ≈ 0:');
        console.log('    dynamicBuyPrice = baseBuyPrice * 0 = 0');
        console.log('    targetBuyPrice = Math.max(0.01, 0) = 0.01');
        console.log('');
        console.log('  RECOMMENDED FIXES:');
        console.log('  1. Add minimum MSPEQ output validation in bot code');
        console.log('  2. Constrain genetic optimizer weight bounds (e.g., min: 0.1 instead of 0)');
        console.log('  3. Add output clamping to MSPEQ configuration');
        console.log('');
    }

    // Check for signal initialization issues
    const avgVolAtStart = result.unrealisticTrades.length > 0
        ? result.unrealisticTrades.reduce((sum, t) => sum + t.volatility, 0) / result.unrealisticTrades.length
        : 0;

    if (avgVolAtStart >= 0 && avgVolAtStart < 0.1) {
        console.log('  ADDITIONAL ISSUE: Very low volatility at period start');
        console.log('');
        console.log('  The HistoricalSignalProvider may not be clearing price history');
        console.log('  on period reset, causing stale/insufficient data for signal calculation.');
        console.log('');
        console.log('  RECOMMENDED FIX:');
        console.log('  Add clearHistory() call in resetTradeState() for signal providers');
        console.log('');
    }

    console.log('═══════════════════════════════════════════════════════════════');
}

// Main
const args = process.argv.slice(2);
if (args.length === 0) {
    console.log('Usage: npx ts-node scripts/diagnose-period-start-prices.ts <log-file>');
    console.log('');
    console.log('Example:');
    console.log('  npx ts-node scripts/diagnose-period-start-prices.ts logs/simulator/test-run1-EarlyBuyerMSPEQ-Stage2Only.log');
    process.exit(1);
}

const filePath = args[0];
if (!fs.existsSync(filePath)) {
    console.error(`Error: File not found: ${filePath}`);
    process.exit(1);
}

console.log(`Analyzing: ${filePath}`);
const result = diagnoseLogFile(filePath);
printReport(result, filePath);
