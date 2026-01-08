import cron from 'node-cron';
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'fs';
import path from 'path';

// ============================================================================
// Types & Interfaces
// ============================================================================

interface LogCleanerProps {
    logsDirectory: string;
    retentionDays: number;
}

type LogFormat = 'ISO_CSV' | 'UNIX_CSV' | 'BRACKETED_ISO' | 'UNKNOWN';

interface CleanupResult {
    file: string;
    originalLines: number;
    remainingLines: number;
    deletedLines: number;
}

// ============================================================================
// LogCleaner Class
// ============================================================================

export class LogCleaner {

    // -------------------------------------------------------------------------
    // Constants
    // -------------------------------------------------------------------------

    private static readonly MS_PER_DAY = 24 * 60 * 60 * 1000;

    // -------------------------------------------------------------------------
    // Properties
    // -------------------------------------------------------------------------

    private logsDirectory: string;
    private retentionDays: number;
    private cronJob: cron.ScheduledTask | null = null;

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    constructor(props: LogCleanerProps) {
        this.logsDirectory = props.logsDirectory;
        this.retentionDays = props.retentionDays;

        console.log(`[LogCleaner] Initialized with ${this.retentionDays} day retention for ${this.logsDirectory}`);
    }

    // -------------------------------------------------------------------------
    // Lifecycle
    // -------------------------------------------------------------------------

    public run(): void {
        // Run daily at 3:00 AM
        this.cronJob = cron.schedule('0 3 * * *', () => {
            console.log(`[LogCleaner] Starting scheduled cleanup...`);
            this.cleanAllLogs();
        });

        // Also run immediately on startup
        console.log(`[LogCleaner] Running initial cleanup...`);
        this.cleanAllLogs();
    }

    public stop(): void {
        if (this.cronJob) {
            this.cronJob.stop();
            this.cronJob = null;
        }
    }

    // -------------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------------

    public cleanAllLogs(): CleanupResult[] {
        const results: CleanupResult[] = [];

        if (!existsSync(this.logsDirectory)) {
            console.log(`[LogCleaner] Logs directory does not exist: ${this.logsDirectory}`);
            return results;
        }

        this.cleanDirectory(this.logsDirectory, results);

        this.logSummary(results);
        return results;
    }

    private cleanDirectory(directory: string, results: CleanupResult[]): void {
        const entries = readdirSync(directory);

        for (const entry of entries) {
            const entryPath = path.join(directory, entry);
            const stat = statSync(entryPath);

            if (stat.isDirectory()) {
                // Recursively clean subdirectories
                this.cleanDirectory(entryPath, results);
            } else if (entry.endsWith('.log')) {
                const result = this.cleanLogFile(entryPath);
                if (result) {
                    results.push(result);
                }
            }
        }
    }

    // -------------------------------------------------------------------------
    // File Processing
    // -------------------------------------------------------------------------

    private cleanLogFile(filePath: string): CleanupResult | null {
        try {
            const content = readFileSync(filePath, 'utf-8');
            const lines = content.split('\n').filter(line => line.trim());

            if (lines.length === 0) {
                return null;
            }

            const format = this.detectLogFormat(lines[0]);
            const cutoffDate = Date.now() - (this.retentionDays * LogCleaner.MS_PER_DAY);

            const remainingLines = lines.filter(line => {
                const timestamp = this.extractTimestamp(line, format);
                if (timestamp === null) {
                    // Keep lines we can't parse (be conservative)
                    return true;
                }
                return timestamp >= cutoffDate;
            });

            const deletedCount = lines.length - remainingLines.length;

            // Only write if we actually deleted something
            if (deletedCount > 0) {
                writeFileSync(filePath, remainingLines.join('\n') + '\n');
            }

            return {
                file: path.relative(this.logsDirectory, filePath),
                originalLines: lines.length,
                remainingLines: remainingLines.length,
                deletedLines: deletedCount,
            };
        } catch (error) {
            console.error(`[LogCleaner] Error processing ${filePath}: ${error}`);
            return null;
        }
    }

    // -------------------------------------------------------------------------
    // Format Detection & Parsing
    // -------------------------------------------------------------------------

    private detectLogFormat(line: string): LogFormat {
        // Check for bracketed ISO format: [INFO] 2026-01-07T15:01:09.151Z
        if (/^\[[\w]+\]\s+\d{4}-\d{2}-\d{2}T/.test(line)) {
            return 'BRACKETED_ISO';
        }

        // Check for ISO CSV format: 2026-01-06T02:00:00.000Z,
        if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(line)) {
            return 'ISO_CSV';
        }

        // Check for Unix timestamp CSV format: 1767668400728,
        if (/^\d{13,}[,\s]/.test(line)) {
            return 'UNIX_CSV';
        }

        return 'UNKNOWN';
    }

    private extractTimestamp(line: string, format: LogFormat): number | null {
        try {
            switch (format) {
                case 'ISO_CSV': {
                    // Format: 2026-01-06T02:00:00.000Z,data...
                    const match = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)/);
                    if (match) {
                        return new Date(match[1]).getTime();
                    }
                    break;
                }

                case 'UNIX_CSV': {
                    // Format: 1767668400728, name, ...
                    const match = line.match(/^(\d{13,})/);
                    if (match) {
                        return parseInt(match[1], 10);
                    }
                    break;
                }

                case 'BRACKETED_ISO': {
                    // Format: [INFO] 2026-01-07T15:01:09.151Z\t message
                    const match = line.match(/\]\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)/);
                    if (match) {
                        return new Date(match[1]).getTime();
                    }
                    break;
                }

                case 'UNKNOWN':
                default:
                    return null;
            }
        } catch {
            return null;
        }

        return null;
    }

    // -------------------------------------------------------------------------
    // Logging
    // -------------------------------------------------------------------------

    private logSummary(results: CleanupResult[]): void {
        const totalDeleted = results.reduce((sum, r) => sum + r.deletedLines, 0);
        const filesModified = results.filter(r => r.deletedLines > 0).length;

        console.log(`[LogCleaner] Cleanup complete: ${totalDeleted} lines deleted from ${filesModified} files`);

        for (const result of results) {
            if (result.deletedLines > 0) {
                console.log(`  - ${result.file}: ${result.deletedLines} lines deleted (${result.remainingLines} remaining)`);
            }
        }
    }
}
