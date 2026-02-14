import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync } from 'fs';
import { MarketInfo, MarketInfoSimple } from './MarketInfo.js';
import { TradingDatabase } from '../db/TradingDatabase.js';
import type { ConfirmedWinnerRecord, HistoricalRevision, PmarketPriceRecord, BinancePriceHourlyRecord } from '../db/types.js';

interface RedemptionEntry {
    timestamp: string;
    clobTokenId: string;
    claimedResult: 'win' | 'loss';
    amount: number;
    finalValue: number;
    buyPrice: number;
    lineNumber: number;
    logFile: string;
    marketUrl: string | null;
    periodId: string | null;
    market: string | null;
}

interface VerificationResult {
    correct: boolean;
    actualResult: 'win' | 'loss' | null;
    winningSide: 'UP' | 'DOWN' | null;
    source: 'polymarket_api' | 'coin_price' | 'pmarket_convergence' | null;
}

interface WinnerDetectionResult {
    winningSide: 'UP' | 'DOWN' | null;
    coinOpenPrice?: number;
    coinClosePrice?: number;
    confidence: number;
}

interface ConfirmedWinnersJson {
    lastUpdated: string;
    winners: Record<string, {
        periodId: string;
        market: string;
        winningSide: 'UP' | 'DOWN';
        verifiedAt: string;
        sources: {
            coinPrice: boolean;
            pmarketConvergence: boolean;
            polymarketApi: boolean;
        };
    }>;
}

export class RedemptionSolver {
    private intervalId?: ReturnType<typeof setInterval>;
    private readonly INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
    private marketInfo: MarketInfo;
    private logDirectory: string;
    private marketCache: Map<string, MarketInfoSimple> = new Map();
    private confirmedWinners: Map<string, ConfirmedWinnerRecord> = new Map();
    private db: TradingDatabase;

    private readonly LOG_FILE = './logs/bots/redemption-solver.log';
    private readonly CONFIRMED_WINNERS_JSON = './logs/audits/confirmed-winners.json';
    private readonly REVISIONS_LOG = './logs/audits/historical-revisions.jsonl';

    // Convergence thresholds for p-market price detection
    private readonly CONVERGENCE_THRESHOLD = 0.95; // Price must be >= 0.95 to be considered "converged to 1"
    private readonly DIVERGENCE_THRESHOLD = 0.05;  // Price must be <= 0.05 to be considered "converged to 0"

    constructor(marketInfo: MarketInfo, logDirectory: string = './logs/bots') {
        this.marketInfo = marketInfo;
        this.logDirectory = logDirectory;
        this.db = TradingDatabase.getInstance();
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

        // Load confirmed winners from database
        this.loadConfirmedWinners();

        // Run immediately on start - verify ALL unverified periods
        this.verifyAllUnverifiedPeriods().catch(err => {
            this.log(`Error during initial verification: ${err}`);
        });

        // Schedule 6-hourly runs
        this.intervalId = setInterval(() => {
            this.verifyAllUnverifiedPeriods().catch(err => {
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
     * Load confirmed winners from database into memory
     */
    private loadConfirmedWinners(): void {
        try {
            const winners = this.db.getAllConfirmedWinners();
            this.confirmedWinners.clear();
            for (const winner of winners) {
                this.confirmedWinners.set(winner.periodId, winner);
            }
            this.log(`Loaded ${winners.length} confirmed winners from database`);
        } catch (err) {
            this.log(`Error loading confirmed winners: ${err}`);
        }
    }

    /**
     * Save confirmed winners to JSON backup file
     */
    private saveConfirmedWinnersToJson(): void {
        try {
            const auditDir = './logs/audits';
            if (!existsSync(auditDir)) {
                mkdirSync(auditDir, { recursive: true });
            }

            const jsonData: ConfirmedWinnersJson = {
                lastUpdated: new Date().toISOString(),
                winners: {},
            };

            for (const [periodId, winner] of this.confirmedWinners) {
                jsonData.winners[periodId] = {
                    periodId: winner.periodId,
                    market: winner.market,
                    winningSide: winner.winningSide,
                    verifiedAt: new Date(winner.verifiedAt).toISOString(),
                    sources: {
                        coinPrice: winner.coinPriceConfirmed,
                        pmarketConvergence: winner.pmarketConvergenceConfirmed,
                        polymarketApi: winner.polymarketConfirmed,
                    },
                };
            }

            writeFileSync(this.CONFIRMED_WINNERS_JSON, JSON.stringify(jsonData, null, 2));
        } catch (err) {
            this.log(`Error saving confirmed winners to JSON: ${err}`);
        }
    }

    /**
     * Main verification logic - verifies ALL unverified periods
     */
    private async verifyAllUnverifiedPeriods(): Promise<void> {
        this.log('Starting verification of all unverified periods');

        // Clear market cache for fresh data
        this.marketCache.clear();

        let totalEntries = 0;
        let correctedEntries = 0;
        let verifiedEntries = 0;
        let skippedEntries = 0;

        // Get all bot log files (prod-*.log and test-*.log)
        const logFiles = this.getBotLogFiles();

        for (const logFile of logFiles) {
            try {
                this.log(`Checking ${logFile}...`);
                // Parse ALL entries, not just recent ones
                const entries = this.parseRedemptionEntries(logFile);
                totalEntries += entries.length;

                for (const entry of entries) {
                    try {
                        // Skip if no market URL or period ID
                        if (!entry.marketUrl || !entry.periodId) {
                            continue;
                        }

                        // Skip if already confirmed
                        if (this.confirmedWinners.has(entry.periodId)) {
                            skippedEntries++;
                            continue;
                        }

                        // Try multiple verification sources
                        const result = await this.verifyWithMultipleSources(entry);

                        if (result.actualResult !== null) {
                            // We got a verification result
                            if (!result.correct) {
                                // Mismatch found - correct it
                                await this.correctRedemption(entry, result.actualResult, result.source!);
                                correctedEntries++;
                            }

                            // Mark as confirmed if we have a winner
                            if (result.winningSide) {
                                await this.markAsConfirmed(entry, result);
                                verifiedEntries++;
                            }
                        }
                    } catch (err) {
                        this.log(`Error verifying entry ${entry.clobTokenId}: ${err}`);
                    }
                }
            } catch (err) {
                this.log(`Error processing ${logFile}: ${err}`);
            }
        }

        // Save confirmed winners to JSON backup
        this.saveConfirmedWinnersToJson();

        this.log(`Verification complete: ${correctedEntries} corrections, ${verifiedEntries} newly verified, ${skippedEntries} already confirmed, ${totalEntries} total entries`);
    }

    /**
     * Verify an entry using multiple sources
     */
    private async verifyWithMultipleSources(entry: RedemptionEntry): Promise<VerificationResult> {
        const results: VerificationResult[] = [];

        // 1. Try Polymarket API (existing logic)
        const polyResult = await this.verifyFromPolymarketApi(entry);
        if (polyResult.actualResult !== null) {
            results.push(polyResult);
        }

        // 2. Try coin price detection (binance data)
        const coinResult = await this.detectWinnerFromCoinPrice(entry);
        if (coinResult.actualResult !== null) {
            results.push(coinResult);
        }

        // 3. Try p-market convergence detection
        const convergenceResult = await this.detectWinnerFromPmarketConvergence(entry);
        if (convergenceResult.actualResult !== null) {
            results.push(convergenceResult);
        }

        // If no results, return inconclusive
        if (results.length === 0) {
            return { correct: true, actualResult: null, winningSide: null, source: null };
        }

        // Check for consensus
        const winningSides = results.map(r => r.winningSide).filter(Boolean);
        const uniqueSides = new Set(winningSides);

        if (uniqueSides.size > 1) {
            // Mismatch between sources - log it
            this.log(`MISMATCH DETECTED for ${entry.periodId}: sources disagree on winner`);
            for (const r of results) {
                this.log(`  ${r.source}: ${r.winningSide}`);
            }
        }

        // Prefer Polymarket API as authoritative, then coin price, then convergence
        return polyResult.actualResult !== null ? polyResult
            : coinResult.actualResult !== null ? coinResult
            : convergenceResult;
    }

    /**
     * Detect winner from coin price (Binance hourly data)
     * UP wins if coin closes higher than it opened
     */
    private async detectWinnerFromCoinPrice(entry: RedemptionEntry): Promise<VerificationResult> {
        if (!entry.market || !entry.periodId) {
            return { correct: true, actualResult: null, winningSide: null, source: null };
        }

        try {
            // Parse period ID to get timestamps
            // Period ID format is typically the market URL or a unique identifier
            // We need to extract the period start/end times from the entry
            const entryTime = new Date(entry.timestamp).getTime();

            // For hourly markets, the period is the previous hour
            const periodEnd = new Date(entryTime);
            periodEnd.setMinutes(0, 0, 0);
            const periodStart = new Date(periodEnd.getTime() - 60 * 60 * 1000);

            // Map market to Binance symbol
            const symbol = this.marketToSymbol(entry.market);
            if (!symbol) {
                return { correct: true, actualResult: null, winningSide: null, source: null };
            }

            // Query binance hourly prices
            const prices = this.db.queryBinanceHourly(
                symbol,
                periodStart.getTime(),
                periodEnd.getTime()
            );

            if (prices.length < 2) {
                // Not enough data
                return { correct: true, actualResult: null, winningSide: null, source: null };
            }

            // Get open price (first entry) and close price (last entry)
            const openPrice = prices[0].hourlyOpen;
            const closePrice = prices[prices.length - 1].hourlyOpen;

            // Determine winner
            const winningSide: 'UP' | 'DOWN' = closePrice > openPrice ? 'UP' : 'DOWN';
            const actualResult = this.determineResult(entry.clobTokenId, winningSide, entry);

            return {
                correct: entry.claimedResult === actualResult,
                actualResult,
                winningSide,
                source: 'coin_price',
            };
        } catch (err) {
            this.log(`Error detecting winner from coin price: ${err}`);
            return { correct: true, actualResult: null, winningSide: null, source: null };
        }
    }

    /**
     * Detect winner from p-market price convergence
     * If UP price converges to ~1.0, UP won. If DOWN price converges to ~1.0, DOWN won.
     */
    private async detectWinnerFromPmarketConvergence(entry: RedemptionEntry): Promise<VerificationResult> {
        if (!entry.market || !entry.periodId) {
            return { correct: true, actualResult: null, winningSide: null, source: null };
        }

        try {
            const entryTime = new Date(entry.timestamp).getTime();

            // Look for prices around the expiry time (within 30 minutes after)
            const startTime = entryTime - 5 * 60 * 1000; // 5 min before
            const endTime = entryTime + 30 * 60 * 1000;  // 30 min after

            // Query p-market prices
            const prices = this.db.queryPmarketPrices(
                entry.market,
                startTime,
                endTime
            );

            if (prices.length === 0) {
                return { correct: true, actualResult: null, winningSide: null, source: null };
            }

            // Get the most recent price (closest to or after expiry)
            const latestPrice = prices[prices.length - 1];

            // Check for convergence
            let winningSide: 'UP' | 'DOWN' | null = null;

            // UP converged to 1 (UP won)
            if (latestPrice.upBid >= this.CONVERGENCE_THRESHOLD && latestPrice.upAsk >= this.CONVERGENCE_THRESHOLD) {
                winningSide = 'UP';
            }
            // DOWN converged to 1 (DOWN won) - check downBid/downAsk if available
            else if (latestPrice.downBid !== null && latestPrice.downAsk !== null &&
                     latestPrice.downBid >= this.CONVERGENCE_THRESHOLD && latestPrice.downAsk >= this.CONVERGENCE_THRESHOLD) {
                winningSide = 'DOWN';
            }
            // UP converged to 0 (DOWN won)
            else if (latestPrice.upBid <= this.DIVERGENCE_THRESHOLD && latestPrice.upAsk <= this.DIVERGENCE_THRESHOLD) {
                winningSide = 'DOWN';
            }
            // DOWN converged to 0 (UP won)
            else if (latestPrice.downBid !== null && latestPrice.downAsk !== null &&
                     latestPrice.downBid <= this.DIVERGENCE_THRESHOLD && latestPrice.downAsk <= this.DIVERGENCE_THRESHOLD) {
                winningSide = 'UP';
            }

            if (!winningSide) {
                return { correct: true, actualResult: null, winningSide: null, source: null };
            }

            const actualResult = this.determineResult(entry.clobTokenId, winningSide, entry);

            return {
                correct: entry.claimedResult === actualResult,
                actualResult,
                winningSide,
                source: 'pmarket_convergence',
            };
        } catch (err) {
            this.log(`Error detecting winner from p-market convergence: ${err}`);
            return { correct: true, actualResult: null, winningSide: null, source: null };
        }
    }

    /**
     * Verify from Polymarket API (existing logic, refactored)
     */
    private async verifyFromPolymarketApi(entry: RedemptionEntry): Promise<VerificationResult> {
        if (!entry.marketUrl) {
            return { correct: true, actualResult: null, winningSide: null, source: null };
        }

        // Get cached or fetch market info
        let market = this.marketCache.get(entry.marketUrl);
        if (!market) {
            try {
                market = await this.marketInfo.getMarketInfo(entry.marketUrl);
                this.marketCache.set(entry.marketUrl, market);
            } catch (err) {
                return { correct: true, actualResult: null, winningSide: null, source: null };
            }
        }

        // Only verify closed markets
        if (!market.closed) {
            return { correct: true, actualResult: null, winningSide: null, source: null };
        }

        // Handle error markets
        if (market.error || market.clobTokenIds.length === 0) {
            return { correct: true, actualResult: null, winningSide: null, source: null };
        }

        // Determine actual winner from outcomePrices
        const upPrice = parseFloat(market.outcomePrices[0] || '0');
        const downPrice = parseFloat(market.outcomePrices[1] || '0');
        const winningSide: 'UP' | 'DOWN' = upPrice >= downPrice ? 'UP' : 'DOWN';
        const winningClobId = winningSide === 'UP' ? market.clobTokenIds[0] : market.clobTokenIds[1];

        const actualResult = entry.clobTokenId === winningClobId ? 'win' : 'loss';
        const correct = entry.claimedResult === actualResult;

        return { correct, actualResult, winningSide, source: 'polymarket_api' };
    }

    /**
     * Mark a period as confirmed in both database and memory
     */
    private async markAsConfirmed(entry: RedemptionEntry, result: VerificationResult): Promise<void> {
        if (!entry.periodId || !result.winningSide || !entry.market) {
            return;
        }

        const winner: ConfirmedWinnerRecord = {
            periodId: entry.periodId,
            market: entry.market,
            clobTokenIdUp: '', // Would need to be extracted from market info
            clobTokenIdDown: '',
            winningSide: result.winningSide,
            coinOpenPrice: null,
            coinClosePrice: null,
            polymarketConfirmed: result.source === 'polymarket_api',
            coinPriceConfirmed: result.source === 'coin_price',
            pmarketConvergenceConfirmed: result.source === 'pmarket_convergence',
            mismatchDetected: false,
            verifiedAt: Date.now(),
            notes: null,
        };

        // Save to database
        try {
            this.db.insertConfirmedWinner(winner);
            this.confirmedWinners.set(entry.periodId, winner);
        } catch (err) {
            this.log(`Error saving confirmed winner: ${err}`);
        }
    }

    /**
     * Determine if a clobTokenId results in a win or loss given the winning side
     */
    private determineResult(
        clobTokenId: string,
        winningSide: 'UP' | 'DOWN',
        entry: RedemptionEntry
    ): 'win' | 'loss' {
        // We need to know if the clobTokenId is for UP or DOWN
        // This would typically come from the market info
        // For now, we use a heuristic based on the market URL or cached market info

        if (entry.marketUrl) {
            const market = this.marketCache.get(entry.marketUrl);
            if (market && market.clobTokenIds.length >= 2) {
                const isUpToken = clobTokenId === market.clobTokenIds[0];
                if (isUpToken) {
                    return winningSide === 'UP' ? 'win' : 'loss';
                } else {
                    return winningSide === 'DOWN' ? 'win' : 'loss';
                }
            }
        }

        // Fallback: assume the claimed result is correct if we can't determine
        return entry.claimedResult;
    }

    /**
     * Map market name to Binance symbol
     */
    private marketToSymbol(market: string): string | null {
        const marketLower = market.toLowerCase();
        if (marketLower.includes('btc') || marketLower.includes('bitcoin')) {
            return 'BTCUSDT';
        } else if (marketLower.includes('eth') || marketLower.includes('ethereum')) {
            return 'ETHUSDT';
        } else if (marketLower.includes('sol') || marketLower.includes('solana')) {
            return 'SOLUSDT';
        } else if (marketLower.includes('xrp')) {
            return 'XRPUSDT';
        }
        return null;
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
     * Parses ALL redemption entries from a log file
     */
    private parseRedemptionEntries(logFile: string): RedemptionEntry[] {
        if (!existsSync(logFile)) {
            return [];
        }

        const content = readFileSync(logFile, 'utf-8');
        const lines = content.split('\n');
        const entries: RedemptionEntry[] = [];

        // Pattern: [INFO] TIMESTAMP     {clobId} expired (win|loss) with {amount} units for ${finalValue}
        const redemptionPattern = /^\[INFO\]\s+(\S+)\s+(\d+)\s+expired\s+\((win|loss)\)\s+with\s+([\d.]+)\s+units\s+for\s+\$(\d+)/;
        // Pattern for reset: [INFO] TIMESTAMP     Doing reset at time HH:MM, periodId=N, usingUrl=https://...
        const resetPattern = /^\[INFO\]\s+(\S+)\s+Doing reset at time .+, periodId=(\d+), usingUrl=(https:\/\/.+)/;
        // Pattern for buy price: [ORDER] TIMESTAMP     clobId BUY {amount} at {price}
        const buyPattern = /^\[ORDER\]\s+\S+\s+(\d+)\s+BUY\s+([\d.]+)\s+at\s+([\d.]+)/;

        // Build maps from parsed data
        const urlsByTimestamp: Map<number, { url: string; periodId: string }> = new Map();
        const buyPrices: Map<string, number> = new Map();

        for (const line of lines) {
            const resetMatch = line.match(resetPattern);
            if (resetMatch) {
                const timestamp = new Date(resetMatch[1]).getTime();
                urlsByTimestamp.set(timestamp, {
                    url: resetMatch[3],
                    periodId: resetMatch[2],
                });
            }

            const buyMatch = line.match(buyPattern);
            if (buyMatch) {
                buyPrices.set(buyMatch[1], parseFloat(buyMatch[3]));
            }
        }

        // Parse redemption entries
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const match = line.match(redemptionPattern);
            if (match) {
                const timestamp = match[1];
                const entryTime = new Date(timestamp).getTime();
                const clobTokenId = match[2];
                const claimedResult = match[3] as 'win' | 'loss';
                const amount = parseFloat(match[4]);
                const finalValue = parseInt(match[5], 10);

                // Find the most recent reset URL before this entry
                let marketUrl: string | null = null;
                let periodIdFromReset: string | null = null;
                let closestTime = 0;
                for (const [resetTime, data] of urlsByTimestamp.entries()) {
                    if (resetTime <= entryTime && resetTime > closestTime) {
                        closestTime = resetTime;
                        marketUrl = data.url;
                        periodIdFromReset = data.periodId;
                    }
                }

                // Extract market from URL
                let market: string | null = null;
                if (marketUrl) {
                    const urlLower = marketUrl.toLowerCase();
                    if (urlLower.includes('bitcoin') || urlLower.includes('btc')) {
                        market = 'btc';
                    } else if (urlLower.includes('ethereum') || urlLower.includes('eth')) {
                        market = 'eth';
                    } else if (urlLower.includes('solana') || urlLower.includes('sol')) {
                        market = 'sol';
                    } else if (urlLower.includes('xrp')) {
                        market = 'xrp';
                    }
                }

                // Get buy price for this token
                const buyPrice = buyPrices.get(clobTokenId) || 0.5;

                entries.push({
                    timestamp,
                    clobTokenId,
                    claimedResult,
                    amount,
                    finalValue,
                    buyPrice,
                    lineNumber: i,
                    logFile,
                    marketUrl,
                    periodId: periodIdFromReset ? `${market || 'unknown'}_${periodIdFromReset}` : null,
                    market,
                });
            }
        }

        return entries;
    }

    /**
     * Corrects a mismatched redemption in both bot log and audit log
     */
    private async correctRedemption(
        entry: RedemptionEntry,
        actualResult: 'win' | 'loss',
        source: 'polymarket_api' | 'coin_price' | 'pmarket_convergence'
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

        // Log revision entry
        this.logRevision({
            timestamp: new Date().toISOString(),
            periodId: entry.periodId || 'unknown',
            clobTokenId: entry.clobTokenId,
            field: 'result',
            oldValue: entry.claimedResult,
            newValue: actualResult,
            source,
        });

        // Update bot log
        await this.updateBotLog(entry, actualResult, newFinalValue);

        // Update trade audit log file
        await this.updateAuditLog(entry, newFinalValue);

        // Update trade_audits database table
        await this.updateTradeAuditDatabase(entry, actualResult, newFinalValue);
    }

    /**
     * Update trade_audits database table
     */
    private async updateTradeAuditDatabase(
        entry: RedemptionEntry,
        actualResult: 'win' | 'loss',
        newFinalValue: number
    ): Promise<void> {
        try {
            // Calculate new PnL based on actual result
            const newPnl = actualResult === 'win'
                ? entry.amount - (entry.amount * entry.buyPrice)
                : -(entry.amount * entry.buyPrice);

            const changes = this.db.updateTradeAuditByMarketHash(
                entry.clobTokenId,
                newPnl,
                newFinalValue
            );

            if (changes > 0) {
                this.log(`Updated ${changes} trade_audits records for ${entry.clobTokenId}`);
            }
        } catch (err) {
            this.log(`Error updating trade_audits database: ${err}`);
        }
    }

    /**
     * Log a historical revision entry
     */
    private logRevision(revision: HistoricalRevision): void {
        try {
            const auditDir = './logs/audits';
            if (!existsSync(auditDir)) {
                mkdirSync(auditDir, { recursive: true });
            }

            appendFileSync(this.REVISIONS_LOG, JSON.stringify(revision) + '\n');
        } catch (err) {
            this.log(`Error logging revision: ${err}`);
        }
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
