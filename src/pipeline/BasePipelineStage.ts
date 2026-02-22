/**
 * BasePipelineStage - Abstract base class for pipeline stages.
 *
 * Follows the GeneticBotManager pattern:
 * - start()/stop() with setTimeout-based scheduling
 * - Wraps runOnce() in try/catch with state and event logging
 * - Configurable interval per stage
 */
import type { IPipelineStage, PipelineStageConfig } from './types.js';
import { PipelineDatabase } from './PipelineDatabase.js';

export abstract class BasePipelineStage implements IPipelineStage {
    abstract readonly name: string;

    private timer: ReturnType<typeof setTimeout> | null = null;
    private running = false;
    protected pipelineDb: PipelineDatabase;
    protected config: PipelineStageConfig;

    constructor(pipelineDb: PipelineDatabase, config: PipelineStageConfig) {
        this.pipelineDb = pipelineDb;
        this.config = config;
    }

    public start(): void {
        if (this.running || !this.config.enabled) {
            if (!this.config.enabled) {
                console.log(`[${this.name}] Disabled, skipping start`);
            }
            return;
        }

        this.running = true;
        console.log(`[${this.name}] Starting, interval=${this.config.intervalMs}ms`);

        // Initialize pipeline state record
        this.pipelineDb.upsertPipelineState({
            stageName: this.name,
            status: 'IDLE',
            runCount: 0,
        });

        // Run immediately on start, then schedule next
        this.executeAndSchedule();
    }

    public stop(): void {
        if (!this.running) return;

        this.running = false;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }

        console.log(`[${this.name}] Stopped`);
    }

    public isRunning(): boolean {
        return this.running;
    }

    public abstract runOnce(): Promise<void>;

    // -------------------------------------------------------------------------
    // Internal: Execution & Scheduling
    // -------------------------------------------------------------------------

    private executeAndSchedule(): void {
        if (!this.running) return;

        // Execute the stage
        this.executeStage().then(() => {
            // Schedule next run
            if (this.running) {
                this.timer = setTimeout(() => this.executeAndSchedule(), this.config.intervalMs);
            }
        });
    }

    private async executeStage(): Promise<void> {
        const startTime = Date.now();

        try {
            // Update state to RUNNING
            const currentState = this.pipelineDb.getPipelineState(this.name);
            const runCount = (currentState?.runCount ?? 0) + 1;

            this.pipelineDb.upsertPipelineState({
                stageName: this.name,
                status: 'RUNNING',
                lastRunTimestamp: startTime,
                nextScheduledRun: startTime + this.config.intervalMs,
                runCount,
            });

            // Execute the stage
            await this.runOnce();

            // Update state to IDLE
            const duration = Date.now() - startTime;
            this.pipelineDb.upsertPipelineState({
                stageName: this.name,
                status: 'IDLE',
                lastRunTimestamp: startTime,
                lastRunDurationMs: duration,
                nextScheduledRun: Date.now() + this.config.intervalMs,
                runCount,
            });

        } catch (error) {
            const duration = Date.now() - startTime;
            const errorMsg = error instanceof Error ? error.message : String(error);

            console.error(`[${this.name}] Error:`, errorMsg);

            // Update state to ERROR
            const currentState = this.pipelineDb.getPipelineState(this.name);
            this.pipelineDb.upsertPipelineState({
                stageName: this.name,
                status: 'ERROR',
                lastRunTimestamp: startTime,
                lastRunDurationMs: duration,
                lastError: errorMsg,
                nextScheduledRun: Date.now() + this.config.intervalMs,
                runCount: currentState?.runCount ?? 0,
            });

            // Log error event
            this.pipelineDb.insertPipelineEvent({
                timestamp: Date.now(),
                stageName: this.name,
                eventType: 'STAGE_ERROR',
                detailsJson: JSON.stringify({ error: errorMsg, duration }),
                severity: 'ERROR',
            });
        }
    }

    // -------------------------------------------------------------------------
    // Helpers for subclasses
    // -------------------------------------------------------------------------

    protected logEvent(
        eventType: Parameters<PipelineDatabase['insertPipelineEvent']>[0]['eventType'],
        botId?: string,
        details?: Record<string, unknown>,
    ): void {
        this.pipelineDb.insertPipelineEvent({
            timestamp: Date.now(),
            stageName: this.name,
            eventType,
            botId: botId ?? null,
            detailsJson: details ? JSON.stringify(details) : null,
            severity: 'INFO',
        });
    }
}
