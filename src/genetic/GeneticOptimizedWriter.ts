import * as fs from 'fs';
import * as path from 'path';
import * as YAML from 'yaml';
import { HistoricalSimulator, CoinType } from '../simulation/HistoricalSimulator.js';
import { geneticStrategies } from '../simulation/index.js';
import {
    GeneticYamlConfig,
    WriterConfigSchema,
    WriterConfigTarget,
    SCHEMA_VERSION,
    validateWriterConfig,
    resolveMarketName,
    getCoinTypeFromMarket,
    generateYamlFilename,
    BotStyle,
} from './YamlBotSchema.js';

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_CONFIG_PATH = './geneticWriterConfig.yaml';
const DEFAULT_OUTPUT_DIR = './geneticBotYamls';

/**
 * Rounds all numeric values in an object to the nearest 0.01.
 * Recursively processes nested objects.
 */
function roundParams(obj: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
        if (typeof value === 'number') {
            result[key] = Math.round(value * 100) / 100;
        } else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
            result[key] = roundParams(value as Record<string, unknown>);
        } else {
            result[key] = value;
        }
    }
    return result;
}

// ============================================================================
// GeneticOptimizedWriter Class
// ============================================================================

export class GeneticOptimizedWriter {
    private configPath: string;
    private outputDir: string;
    private config: WriterConfigSchema | null = null;
    private isRunning: boolean = false;
    private intervalTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(options?: { configPath?: string; outputDir?: string }) {
        this.configPath = options?.configPath ?? DEFAULT_CONFIG_PATH;
        this.outputDir = options?.outputDir ?? DEFAULT_OUTPUT_DIR;
    }

    // -------------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------------

    /**
     * Starts the genetic optimizer writer.
     * Runs optimization immediately, then schedules periodic runs.
     */
    public async start(): Promise<void> {
        if (this.isRunning) {
            console.log('[GeneticWriter] Already running');
            return;
        }

        console.log('[GeneticWriter] Starting...');

        // Load and validate config
        this.config = this.loadConfig();
        if (!this.config) {
            throw new Error('Failed to load configuration');
        }

        // Ensure output directory exists
        this.ensureOutputDirectory();

        this.isRunning = true;

        // Run immediately
        await this.runAllOptimizations();

        // Schedule periodic runs
        this.scheduleNextRun();
    }

    /**
     * Stops the genetic optimizer writer.
     */
    public stop(): void {
        if (!this.isRunning) {
            return;
        }

        console.log('[GeneticWriter] Stopping...');

        if (this.intervalTimer) {
            clearTimeout(this.intervalTimer);
            this.intervalTimer = null;
        }

        this.isRunning = false;
        console.log('[GeneticWriter] Stopped');
    }

    // -------------------------------------------------------------------------
    // Configuration
    // -------------------------------------------------------------------------

    private loadConfig(): WriterConfigSchema | null {
        try {
            if (!fs.existsSync(this.configPath)) {
                console.error(`[GeneticWriter] Config file not found: ${this.configPath}`);
                return null;
            }

            const content = fs.readFileSync(this.configPath, 'utf-8');
            const config = YAML.parse(content);

            const validation = validateWriterConfig(config);
            if (!validation.valid) {
                console.error('[GeneticWriter] Invalid configuration:');
                validation.errors.forEach(e => console.error(`  - ${e}`));
                return null;
            }

            console.log('[GeneticWriter] Configuration loaded:');
            console.log(`  Lookback Days: ${config.settings.lookbackDays}`);
            console.log(`  Max Generations: ${config.settings.maxGenerations}`);
            console.log(`  Population Size: ${config.settings.populationSize}`);
            console.log(`  Interval Hours: ${config.settings.intervalHours}`);
            console.log(`  Concurrent Simulations: ${config.settings.concurrentSimulations}`);
            console.log(`  Targets: ${config.targets.length}`);

            return config as WriterConfigSchema;
        } catch (error) {
            console.error(`[GeneticWriter] Error loading config: ${error}`);
            return null;
        }
    }

    private ensureOutputDirectory(): void {
        if (!fs.existsSync(this.outputDir)) {
            fs.mkdirSync(this.outputDir, { recursive: true });
            console.log(`[GeneticWriter] Created output directory: ${this.outputDir}`);
        }
    }

    // -------------------------------------------------------------------------
    // Scheduling
    // -------------------------------------------------------------------------

    private scheduleNextRun(): void {
        if (!this.isRunning || !this.config) {
            return;
        }

        const intervalMs = this.config.settings.intervalHours * 60 * 60 * 1000;
        console.log(`[GeneticWriter] Next optimization run in ${this.config.settings.intervalHours} hours`);

        this.intervalTimer = setTimeout(async () => {
            if (this.isRunning) {
                await this.runAllOptimizations();
                throw Error('skipped?')
                this.scheduleNextRun();
            }
        }, intervalMs);
    }

    // -------------------------------------------------------------------------
    // Optimization
    // -------------------------------------------------------------------------

    /**
     * Runs optimization for all configured targets in parallel batches.
     */
    private async runAllOptimizations(): Promise<void> {
        if (!this.config) {
            return;
        }

        const concurrency = this.config.settings.concurrentSimulations;
        const totalTargets = this.config.targets.length;

        console.log('\n' + '='.repeat(60));
        console.log(`[GeneticWriter] Starting optimization run at ${new Date().toISOString()}`);
        console.log(`[GeneticWriter] Running ${concurrency} simulations in parallel`);
        console.log('='.repeat(60));

        // Process targets in batches
        for (let batchStart = 0; batchStart < totalTargets; batchStart += concurrency) {
            const batchEnd = Math.min(batchStart + concurrency, totalTargets);
            const batch = this.config.targets.slice(batchStart, batchEnd);

            console.log(`\n[Batch ${Math.floor(batchStart / concurrency) + 1}] Processing targets ${batchStart + 1}-${batchEnd} of ${totalTargets}`);

            // Run batch in parallel
            const promises = batch.map((target, idx) => {
                const globalIdx = batchStart + idx + 1;
                console.log(`  Starting: [${globalIdx}/${totalTargets}] ${target.botStyle} on ${target.market}`);
                return this.optimizeTarget(target)
                    .then(() => {
                        console.log(`  Completed: [${globalIdx}/${totalTargets}] ${target.botStyle} on ${target.market}`);
                    })
                    .catch((error) => {
                        console.error(`[GeneticWriter] Error optimizing ${target.botStyle}-${target.market}: ${error}`);
                    });
            });

            await Promise.all(promises);
        }

        console.log('\n' + '='.repeat(60));
        console.log(`[GeneticWriter] Optimization run completed at ${new Date().toISOString()}`);
        console.log('='.repeat(60) + '\n');
    }

    /**
     * Runs optimization for a single target and writes the result.
     */
    private async optimizeTarget(target: WriterConfigTarget): Promise<void> {
        if (!this.config) {
            return;
        }

        // Resolve market name to TargetedMarket enum
        const targetedMarket = resolveMarketName(target.market);
        if (!targetedMarket) {
            console.error(`[GeneticWriter] Invalid market: ${target.market}`);
            return;
        }


        // Find the strategy
        const strategy = geneticStrategies.find(
            s => s.name.toLowerCase() === target.botStyle.toLowerCase()
        );

        if (!strategy) {
            console.error(`[GeneticWriter] Unknown strategy: ${target.botStyle}`);
            return;
        }

        // Determine coin type from market
        const coinType = getCoinTypeFromMarket(targetedMarket) as CoinType;

        // Create simulator
        const simulator = new HistoricalSimulator({
            lookbackDays: this.config.settings.lookbackDays,
            tickIntervalMs: 5 * 1000,
            coinType,
            targetedMarket,
        });

        // Run genetic optimization
        const geneticConfig = {
            populationSize: this.config.settings.populationSize,
            maxGenerations: this.config.settings.maxGenerations,
            convergenceThreshold: 1.0,
            convergenceGenerations: 5,
            mutationRate: 0.25,
            mutationStrength: 0.3,
            eliteCount: 2,
            crossoverRate: 0.7,
        };

        const result = await simulator.runGeneticOptimization(
            strategy.name,
            strategy.factory,
            strategy.bounds,
            geneticConfig
        );

        // Calculate average PnL from final generation (rounded to 0.01)
        const lastGenStats = result.generationHistory[result.generationHistory.length - 1];
        const avgPnl = Math.round((lastGenStats?.avgFitness ?? 0) * 100) / 100;
        const bestPnl = Math.round(result.bestIndividual.fitness * 100) / 100;

        // Round all params to 0.01
        const roundedParams = roundParams(result.bestIndividual.params) as Record<string, number>;

        // Determine if enabled (both best and avg PnL must be > 0)
        const enabled = bestPnl > 0 && avgPnl > 0;

        // Build output config
        const yamlConfig: GeneticYamlConfig = {
            schemaVersion: SCHEMA_VERSION,
            botStyle: target.botStyle as BotStyle,
            targetedMarket: targetedMarket,

            optimization: {
                bestPnl,
                avgPnl,
                generations: result.totalGenerations,
                converged: result.converged,
                convergenceReason: result.convergenceReason,
                timestamp: new Date().toISOString(),
                lookbackDays: this.config.settings.lookbackDays,
                populationSize: this.config.settings.populationSize,
                maxGenerations: this.config.settings.maxGenerations,
            },

            params: roundedParams,

            runtime: {
                enabled,
                prodMode: false,  // Default to test mode; user can change manually
                hourlyDollarLimit: 100,
            },
        };

        // Write to file
        const filename = generateYamlFilename(target.botStyle, targetedMarket);
        const filepath = path.join(this.outputDir, filename);

        const yamlContent = YAML.stringify(yamlConfig, { indent: 2 });
        fs.writeFileSync(filepath, yamlContent, 'utf-8');

        console.log(`[GeneticWriter] Written: ${filepath}`);
        console.log(`  Best PnL: $${bestPnl.toFixed(2)}, Avg PnL: $${avgPnl.toFixed(2)}, Enabled: ${enabled}`);
    }
}
