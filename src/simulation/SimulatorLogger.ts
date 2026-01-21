import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { Side } from '@polymarket/clob-client';

// ============================================================================
// SimulatorLogger
// ============================================================================

const LOG_DIRECTORY = './logs/simulator';

/**
 * Trade audit data matching the format used by production bots.
 */
export interface TradeAuditEntry {
    timestamp: number;
    botName: string;
    orderId: string;
    status: string;
    createdAt: number;
    amount: number;
    targetBuyPrice: number;
    targetSellPrice: number;
    totalCost: number;
    finalValue: number;
    mode: 'PROD' | 'TEST' | 'SIM';
    clobTokenId: string;
    side: Side;
    pnl?: number;
}

/**
 * Logger for simulation runs that writes to both console and file.
 * Creates timestamped log files for each simulation session.
 */
export class SimulatorLogger {
    private logFilePath: string;
    private auditFilePath: string | null = null;
    private sessionTimestamp: string;
    private static instance: SimulatorLogger | null = null;

    constructor(sessionName?: string) {
        // Ensure log directory exists
        if (!existsSync(LOG_DIRECTORY)) {
            mkdirSync(LOG_DIRECTORY, { recursive: true });
        }

        // Create timestamped log file name
        this.sessionTimestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const name = sessionName ? `${sessionName}-${this.sessionTimestamp}` : this.sessionTimestamp;
        this.logFilePath = `${LOG_DIRECTORY}/${name}.log`;
    }

    /**
     * Gets or creates a singleton logger instance.
     */
    public static getInstance(sessionName?: string): SimulatorLogger {
        if (!SimulatorLogger.instance) {
            SimulatorLogger.instance = new SimulatorLogger(sessionName);
        }
        return SimulatorLogger.instance;
    }

    /**
     * Resets the singleton instance (for new simulation runs).
     */
    public static resetInstance(): void {
        SimulatorLogger.instance = null;
    }

    /**
     * Logs a message to both console and file.
     */
    public log(message: string): void {
        console.log(message);
        this.writeToFile(message);
    }

    /**
     * Logs a message only to file (for verbose data).
     */
    public logToFile(message: string): void {
        this.writeToFile(message);
    }

    /**
     * Writes a progress update (overwrites line in console, appends to file).
     */
    public progress(message: string): void {
        process.stdout.write(`\r${message}`);
        // Don't write progress updates to file to avoid spam
    }

    /**
     * Clears the current progress line.
     */
    public clearProgress(width: number = 50): void {
        process.stdout.write('\r' + ' '.repeat(width) + '\r');
    }

    /**
     * Logs an error message.
     */
    public error(message: string): void {
        const errorMsg = `[ERROR] ${message}`;
        console.error(errorMsg);
        this.writeToFile(errorMsg);
    }

    /**
     * Logs a warning message.
     */
    public warn(message: string): void {
        const warnMsg = `[WARN] ${message}`;
        console.warn(warnMsg);
        this.writeToFile(warnMsg);
    }

    /**
     * Gets the path to the current log file.
     */
    public getLogFilePath(): string {
        return this.logFilePath;
    }

    /**
     * Gets the path to the current audit file, if one has been created.
     */
    public getAuditFilePath(): string | null {
        return this.auditFilePath;
    }

    /**
     * Creates a new audit file for a specific strategy/generation.
     * Returns the path to the created file.
     */
    public createAuditFile(strategyName: string, generation?: number): string {
        const genSuffix = generation !== undefined ? `-gen${generation}` : '';
        const auditFileName = `${strategyName}${genSuffix}-${this.sessionTimestamp}.audit.log`;
        this.auditFilePath = `${LOG_DIRECTORY}/${auditFileName}`;

        // Write header
        const header = 'timestamp,botName,orderId,status,createdAt,amount,targetBuyPrice,targetSellPrice,totalCost,finalValue,mode,clobTokenId,side,pnl\n';
        writeFileSync(this.auditFilePath, header);

        return this.auditFilePath;
    }

    /**
     * Writes a trade audit entry in the same format as production bots.
     * Format matches QuantBot.writeCompletedTrade() output.
     */
    public writeTradeAudit(entry: TradeAuditEntry): void {
        if (!this.auditFilePath) {
            return;
        }

        const message = [
            entry.timestamp,
            entry.botName,
            entry.orderId,
            entry.status,
            entry.createdAt,
            entry.amount,
            entry.targetBuyPrice,
            entry.targetSellPrice,
            entry.totalCost,
            entry.finalValue,
            entry.mode,
            entry.clobTokenId,
            entry.side,
            entry.pnl ?? 0,
        ].join(', ') + '\n';

        try {
            appendFileSync(this.auditFilePath, message);
        } catch (e) {
            console.error(`Failed to write to audit file: ${e}`);
        }
    }

    /**
     * Writes multiple trade audits from a simulated trades array.
     * Converts SimulatedTrade format to TradeAuditEntry format.
     * Uses real current time for audit timestamp (matching prod behavior),
     * while preserving simulation time in createdAt for analysis.
     */
    public writeSimulatedTradeAudits(
        botName: string,
        trades: Array<{
            timestamp: number;
            botName: string;
            side: Side;
            tokenId: string;
            price: number;
            amount: number;
            status: string;
            pnl?: number;
        }>
    ): void {
        const auditWriteTime = Date.now(); // Use real current time for audit timestamp

        for (const trade of trades) {
            // Only write completed trades (matched or expired)
            if (trade.status !== 'MATCHED' && trade.status !== 'EXPIRED') {
                continue;
            }

            this.writeTradeAudit({
                timestamp: auditWriteTime,  // When audit was written (real time)
                botName: botName,
                orderId: `sim-${trade.timestamp}-${Math.random().toString(36).substring(2, 10)}`,
                status: trade.status,
                createdAt: trade.timestamp,  // When trade occurred in simulation (historical)
                amount: trade.amount,
                targetBuyPrice: trade.side === Side.BUY ? trade.price : -1,
                targetSellPrice: trade.side === Side.SELL ? trade.price : -1,
                totalCost: trade.price * trade.amount,
                finalValue: trade.pnl ?? 0,
                mode: 'SIM',
                clobTokenId: trade.tokenId,
                side: trade.side,
                pnl: trade.pnl,
            });
        }
    }

    private writeToFile(message: string): void {
        try {
            appendFileSync(this.logFilePath, message + '\n');
        } catch (e) {
            console.error(`Failed to write to log file: ${e}`);
        }
    }

    /**
     * Writes a summary section for top trades with their associated parameters.
     * Appends to the current audit file.
     */
    public writeTopTradesWithParams(
        trades: Array<{
            timestamp: number;
            botName: string;
            side: Side;
            tokenId: string;
            price: number;
            amount: number;
            status: string;
            pnl?: number;
        }>,
        params: Record<string, unknown>,
        topN: number
    ): void {
        if (!this.auditFilePath) {
            return;
        }

        // Filter completed trades and sort by PnL descending
        const completedTrades = trades.filter(t => t.status === 'MATCHED' || t.status === 'EXPIRED');
        const sortedByPnl = [...completedTrades].sort((a, b) => (b.pnl ?? 0) - (a.pnl ?? 0));
        const topTrades = sortedByPnl.slice(0, topN);

        try {
            // Write section header
            appendFileSync(this.auditFilePath, '\n# TOP TRADES BY PNL\n');
            appendFileSync(this.auditFilePath, `# Parameters: ${JSON.stringify(params)}\n`);
            appendFileSync(this.auditFilePath, `# Count: ${topN} (of ${completedTrades.length} completed trades)\n`);
            appendFileSync(this.auditFilePath, '# rank,timestamp,side,tokenId,price,amount,status,pnl\n');

            for (let i = 0; i < topTrades.length; i++) {
                const trade = topTrades[i];
                const line = [
                    i + 1,
                    new Date(trade.timestamp).toISOString(),
                    trade.side,
                    trade.tokenId,
                    trade.price.toFixed(4),
                    trade.amount,
                    trade.status,
                    (trade.pnl ?? 0).toFixed(2),
                ].join(',') + '\n';
                appendFileSync(this.auditFilePath, line);
            }
        } catch (e) {
            console.error(`Failed to write top trades to audit file: ${e}`);
        }
    }

    /**
     * Writes average trade statistics with associated parameters.
     * Appends to the current audit file.
     */
    public writeAverageTradeStats(
        trades: Array<{
            timestamp: number;
            botName: string;
            side: Side;
            tokenId: string;
            price: number;
            amount: number;
            status: string;
            pnl?: number;
        }>,
        params: Record<string, unknown>
    ): void {
        if (!this.auditFilePath) {
            return;
        }

        // Filter completed trades
        const completedTrades = trades.filter(t => t.status === 'MATCHED' || t.status === 'EXPIRED');
        const matchedTrades = trades.filter(t => t.status === 'MATCHED');
        const expiredTrades = trades.filter(t => t.status === 'EXPIRED');

        // Calculate statistics
        const pnls = completedTrades.map(t => t.pnl ?? 0);
        const totalPnl = pnls.reduce((sum, pnl) => sum + pnl, 0);
        const avgPnl = pnls.length > 0 ? totalPnl / pnls.length : 0;
        const winningTrades = pnls.filter(pnl => pnl > 0);
        const losingTrades = pnls.filter(pnl => pnl < 0);
        const winRate = pnls.length > 0 ? (winningTrades.length / pnls.length) * 100 : 0;

        // Calculate avg winning and losing trade
        const avgWin = winningTrades.length > 0
            ? winningTrades.reduce((sum, pnl) => sum + pnl, 0) / winningTrades.length
            : 0;
        const avgLoss = losingTrades.length > 0
            ? losingTrades.reduce((sum, pnl) => sum + pnl, 0) / losingTrades.length
            : 0;

        // Calculate max and min PnL
        const maxPnl = pnls.length > 0 ? Math.max(...pnls) : 0;
        const minPnl = pnls.length > 0 ? Math.min(...pnls) : 0;

        // Calculate standard deviation
        const variance = pnls.length > 1
            ? pnls.reduce((sum, pnl) => sum + Math.pow(pnl - avgPnl, 2), 0) / (pnls.length - 1)
            : 0;
        const stdDev = Math.sqrt(variance);

        try {
            appendFileSync(this.auditFilePath, '\n# AVERAGE TRADE STATISTICS\n');
            appendFileSync(this.auditFilePath, `# Parameters: ${JSON.stringify(params)}\n`);
            appendFileSync(this.auditFilePath, `# totalTrades,matchedTrades,expiredTrades,totalPnl,avgPnl,winRate,avgWin,avgLoss,maxPnl,minPnl,stdDev\n`);

            const statsLine = [
                completedTrades.length,
                matchedTrades.length,
                expiredTrades.length,
                totalPnl.toFixed(2),
                avgPnl.toFixed(2),
                winRate.toFixed(2),
                avgWin.toFixed(2),
                avgLoss.toFixed(2),
                maxPnl.toFixed(2),
                minPnl.toFixed(2),
                stdDev.toFixed(2),
            ].join(',') + '\n';
            appendFileSync(this.auditFilePath, statsLine);
        } catch (e) {
            console.error(`Failed to write average trade stats to audit file: ${e}`);
        }
    }
}

/**
 * Global logger access for convenience.
 */
export function getSimulatorLogger(sessionName?: string): SimulatorLogger {
    return SimulatorLogger.getInstance(sessionName);
}
