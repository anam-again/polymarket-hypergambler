import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync } from 'fs';
import { MarketInfo, MarketInfoSimple } from './MarketInfo.js';

interface RedemptionEntry {
    timestamp: string;
    clobTokenId: string;
    claimedResult: 'win' | 'loss';
    amount: number;
    finalValue: number;
    lineNumber: number;
    logFile: string;
    marketUrl: string | null;
}

interface VerificationResult {
    correct: boolean;
    actualResult: 'win' | 'loss' | null;
}

export class RedemptionSolver {
    private intervalId?: ReturnType<typeof setInterval>;
    private readonly INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
    private readonly LOOKBACK_MS = 12 * 60 * 60 * 1000; // 12 hours
    private marketInfo: MarketInfo;
    private logDirectory: string;
    private marketCache: Map<string, MarketInfoSimple> = new Map();
    private readonly LOG_FILE = './logs/bots/redemption-solver.log';

    constructor(marketInfo: MarketInfo, logDirectory: string = './logs/bots') {
        this.marketInfo = marketInfo;
        this.logDirectory = logDirectory;
    }

    /**
     * Starts the automatic redemption verification process
     */
    public run(): void {
        if (this.intervalId) {
            this.log('Already running');
            return;
        }

        this.log('Starting automatic redemption verification every 6 hours');

        // Run immediately on start
        this.solveRedemptions().catch(err => {
            this.log(`Error during initial verification: ${err}`);
        });

        // Schedule 6-hourly runs
        this.intervalId = setInterval(() => {
            this.solveRedemptions().catch(err => {
                this.log(`Error during scheduled verification: ${err}`);
            });
        }, this.INTERVAL_MS);
    }

    /**
     * Stops the automatic redemption verification process
     */
    public stop(): void {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = undefined;
        }
        this.log('Stopped automatic redemption verification');
    }

    /**
     * Main verification logic - parses logs, verifies redemptions, and corrects mismatches
     */
    private async solveRedemptions(): Promise<void> {
        this.log('Starting redemption verification (past 12 hours)');

        // Clear market cache for fresh data
        this.marketCache.clear();

        const cutoffTime = Date.now() - this.LOOKBACK_MS;
        let totalEntries = 0;
        let correctedEntries = 0;

        // Get all bot log files (prod-*.log and test-*.log)
        const logFiles = this.getBotLogFiles();

        for (const logFile of logFiles) {
            try {
                this.log(`Checking ${logFile}...`);
                const entries = this.parseRedemptionEntries(logFile, cutoffTime);
                totalEntries += entries.length;

                for (const entry of entries) {
                    try {
                        if (!entry.marketUrl) {
                            continue; // Skip entries where we couldn't find the market URL
                        }

                        const result = await this.verifyRedemption(
                            entry.clobTokenId,
                            entry.claimedResult,
                            entry.marketUrl
                        );

                        if (!result.correct && result.actualResult !== null) {
                            // Mismatch found - correct it
                            await this.correctRedemption(entry, result.actualResult);
                            correctedEntries++;
                        }
                    } catch (err) {
                        this.log(`Error verifying entry ${entry.clobTokenId}: ${err}`);
                    }
                }
            } catch (err) {
                this.log(`Error processing ${logFile}: ${err}`);
            }
        }

        this.log(`Verification complete: ${correctedEntries}/${totalEntries} corrections made`);
    }

    /**
     * Gets all bot log files (prod-*.log and test-*.log)
     */
    private getBotLogFiles(): string[] {
        if (!existsSync(this.logDirectory)) {
            return [];
        }

        const files = readdirSync(this.logDirectory);
        return files
            .filter(f => (f.startsWith('prod-') || f.startsWith('test-')) && f.endsWith('.log'))
            .map(f => `${this.logDirectory}/${f}`);
    }

    /**
     * Parses redemption entries from a log file within the time window
     */
    private parseRedemptionEntries(logFile: string, cutoffTime: number): RedemptionEntry[] {
        if (!existsSync(logFile)) {
            return [];
        }

        const content = readFileSync(logFile, 'utf-8');
        const lines = content.split('\n');
        const entries: RedemptionEntry[] = [];

        // Pattern: [INFO] TIMESTAMP     {clobId} expired (win|loss) with {amount} units for ${finalValue}
        const redemptionPattern = /^\[INFO\]\s+(\S+)\s+(\d+)\s+expired\s+\((win|loss)\)\s+with\s+([\d.]+)\s+units\s+for\s+\$(\d+)/;
        // Pattern for reset: [INFO] TIMESTAMP     Doing reset at time HH:MM, periodId=N, usingUrl=https://...
        const resetPattern = /^\[INFO\]\s+(\S+)\s+Doing reset at time .+, periodId=\d+, usingUrl=(https:\/\/.+)/;

        // Build a map of timestamps to URLs from reset entries
        const urlsByTimestamp: Map<number, string> = new Map();
        for (const line of lines) {
            const resetMatch = line.match(resetPattern);
            if (resetMatch) {
                const timestamp = new Date(resetMatch[1]).getTime();
                const url = resetMatch[2];
                urlsByTimestamp.set(timestamp, url);
            }
        }

        // Parse redemption entries
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const match = line.match(redemptionPattern);
            if (match) {
                const timestamp = match[1];
                const entryTime = new Date(timestamp).getTime();

                // Skip entries outside our time window
                if (entryTime < cutoffTime) {
                    continue;
                }

                const clobTokenId = match[2];
                const claimedResult = match[3] as 'win' | 'loss';
                const amount = parseFloat(match[4]);
                const finalValue = parseInt(match[5], 10);

                // Find the most recent reset URL before this entry
                let marketUrl: string | null = null;
                let closestTime = 0;
                urlsByTimestamp.forEach((url, resetTime) => {
                    if (resetTime <= entryTime && resetTime > closestTime) {
                        closestTime = resetTime;
                        marketUrl = url;
                    }
                });

                entries.push({
                    timestamp,
                    clobTokenId,
                    claimedResult,
                    amount,
                    finalValue,
                    lineNumber: i,
                    logFile,
                    marketUrl,
                });
            }
        }

        return entries;
    }

    /**
     * Verifies a redemption against the actual closed market status
     */
    private async verifyRedemption(
        clobTokenId: string,
        claimedResult: 'win' | 'loss',
        marketUrl: string
    ): Promise<VerificationResult> {
        // Get cached or fetch market info
        let market = this.marketCache.get(marketUrl);
        if (!market) {
            try {
                market = await this.marketInfo.getMarketInfo(marketUrl);
                this.marketCache.set(marketUrl, market);
            } catch (err) {
                // Market fetch failed, can't verify
                return { correct: true, actualResult: null };
            }
        }

        // Only verify closed markets
        if (!market.closed) {
            return { correct: true, actualResult: null }; // Can't verify yet
        }

        // Handle error markets
        if (market.error || market.clobTokenIds.length === 0) {
            return { correct: true, actualResult: null };
        }

        // Determine actual winner from outcomePrices
        const upPrice = parseFloat(market.outcomePrices[0] || '0');
        const downPrice = parseFloat(market.outcomePrices[1] || '0');
        const winningClobId = upPrice >= downPrice
            ? market.clobTokenIds[0]  // UP won
            : market.clobTokenIds[1]; // DOWN won

        const actualResult = clobTokenId === winningClobId ? 'win' : 'loss';
        const correct = claimedResult === actualResult;

        return { correct, actualResult };
    }

    /**
     * Corrects a mismatched redemption in both bot log and audit log
     */
    private async correctRedemption(
        entry: RedemptionEntry,
        actualResult: 'win' | 'loss'
    ): Promise<void> {
        const newFinalValue = actualResult === 'win' ? entry.amount : 0;
        const oldFinalValue = entry.finalValue;

        this.logCorrection(
            entry.clobTokenId,
            entry.claimedResult,
            actualResult,
            oldFinalValue,
            newFinalValue
        );

        // Update bot log
        await this.updateBotLog(entry, actualResult, newFinalValue);

        // Update trade audit log
        await this.updateAuditLog(entry, newFinalValue);
    }

    /**
     * Updates the bot log file with the correction
     */
    private async updateBotLog(
        entry: RedemptionEntry,
        actualResult: 'win' | 'loss',
        newFinalValue: number
    ): Promise<void> {
        const content = readFileSync(entry.logFile, 'utf-8');
        const lines = content.split('\n');

        // Find and update the redemption line
        const oldPattern = new RegExp(
            `\\[INFO\\]\\s+${entry.timestamp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+${entry.clobTokenId}\\s+expired\\s+\\(${entry.claimedResult}\\)\\s+with\\s+${entry.amount}\\s+units\\s+for\\s+\\$${entry.finalValue}`
        );

        let found = false;
        for (let i = 0; i < lines.length; i++) {
            if (oldPattern.test(lines[i])) {
                // Update the line
                lines[i] = lines[i]
                    .replace(`(${entry.claimedResult})`, `(${actualResult})`)
                    .replace(`$${entry.finalValue}`, `$${newFinalValue}`);

                // Insert correction notice after this line
                const correctionTime = new Date().toISOString();
                const correctionLine = `[CORRECTED] ${correctionTime}\t Above line corrected by RedemptionSolver: was (${entry.claimedResult}) $${entry.finalValue}, now (${actualResult}) $${newFinalValue}`;
                lines.splice(i + 1, 0, correctionLine);
                found = true;
                break;
            }
        }

        if (found) {
            writeFileSync(entry.logFile, lines.join('\n'));
        }
    }

    /**
     * Updates the trade audit log with the correction
     */
    private async updateAuditLog(
        entry: RedemptionEntry,
        newFinalValue: number
    ): Promise<void> {
        const auditLogPath = './logs/audits/tradeAudit.log';
        if (!existsSync(auditLogPath)) {
            return;
        }

        const content = readFileSync(auditLogPath, 'utf-8');
        const lines = content.split('\n');

        // Find matching entry by clobTokenId and orderId="expiry"
        // Format: timestamp, botName, orderId, status, createTime, amount, buyPrice, sellPrice, pnl, finalValue, mode, clobTokenId, side
        let found = false;
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (line.includes('expiry') && line.includes(entry.clobTokenId)) {
                const parts = line.split(', ');
                if (parts.length >= 10) {
                    // Update finalValue (field index 9)
                    parts[9] = String(newFinalValue);
                    lines[i] = parts.join(', ');
                    found = true;
                    // Don't break - there might be multiple entries for the same clobTokenId
                }
            }
        }

        if (found) {
            writeFileSync(auditLogPath, lines.join('\n'));
        }
    }

    /**
     * Writes a message to the redemption-solver log
     */
    private log(message: string): void {
        // Ensure log directory exists
        const logDir = './logs/bots';
        if (!existsSync(logDir)) {
            mkdirSync(logDir, { recursive: true });
        }

        const timestamp = new Date().toISOString();
        const logLine = `[INFO] ${timestamp}\t ${message}\n`;
        appendFileSync(this.LOG_FILE, logLine);
    }

    /**
     * Writes a correction entry to the redemption-solver log
     */
    private logCorrection(
        clobTokenId: string,
        oldResult: 'win' | 'loss',
        newResult: 'win' | 'loss',
        oldFinalValue: number,
        newFinalValue: number
    ): void {
        const logDir = './logs/bots';
        if (!existsSync(logDir)) {
            mkdirSync(logDir, { recursive: true });
        }

        const timestamp = new Date().toISOString();
        const logLine = `[CORRECTION] ${timestamp}\t ${clobTokenId} was (${oldResult}) -> corrected to (${newResult}), finalValue: $${oldFinalValue} -> $${newFinalValue}\n`;
        appendFileSync(this.LOG_FILE, logLine);
    }
}
