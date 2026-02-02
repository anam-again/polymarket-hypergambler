import { GeneticOptimizedWriter } from './GeneticOptimizedWriter.js';

// ============================================================================
// CLI Entry Point for Genetic Optimized Writer
// ============================================================================

const DEFAULT_CONFIG_PATH = './geneticWriterConfig.yaml';
const DEFAULT_OUTPUT_DIR = './geneticBotYamls';

async function main() {
    console.log('');
    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║         GENETIC OPTIMIZED WRITER - Periodic Bot Optimizer  ║');
    console.log('╚════════════════════════════════════════════════════════════╝');
    console.log('');

    // Parse command line arguments
    const args = process.argv.slice(2);
    let configPath = DEFAULT_CONFIG_PATH;
    let outputDir = DEFAULT_OUTPUT_DIR;

    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case '--config':
            case '-c':
                configPath = args[i + 1] || DEFAULT_CONFIG_PATH;
                break;
            case '--output':
            case '-o':
                outputDir = args[i + 1] || DEFAULT_OUTPUT_DIR;
                break;
            case '--help':
            case '-h':
                printHelp();
                process.exit(0);
        }
    }

    console.log(`Config: ${configPath}`);
    console.log(`Output: ${outputDir}`);
    console.log('');

    // Create and start the writer
    const writer = new GeneticOptimizedWriter({
        configPath,
        outputDir,
    });

    // Handle graceful shutdown
    const shutdown = () => {
        console.log('\n[SHUTDOWN] Received signal, stopping...');
        writer.stop();
        process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    try {
        await writer.start();
    } catch (error) {
        console.error(`[ERROR] Failed to start writer: ${error}`);
        process.exit(1);
    }

    // Keep the process running
    console.log('[INFO] Writer is running. Press Ctrl+C to stop.');
}

function printHelp(): void {
    console.log(`
Genetic Optimized Writer - Periodic Bot Parameter Optimizer

Usage: npm run goptimized-writer -- [options]

Options:
  -c, --config <path>   Path to config file (default: ./geneticWriterConfig.yaml)
  -o, --output <dir>    Output directory for YAML files (default: ./geneticBotYamls)
  -h, --help            Show this help message

Description:
  Reads configuration from geneticWriterConfig.yaml, runs genetic optimization
  for each bot/market combination, and writes results to YAML files in the
  output directory. The process runs periodically based on intervalHours setting.

  Bots are enabled in the output YAML only if BOTH best PnL AND average PnL > 0.

Configuration File Format (geneticWriterConfig.yaml):
  settings:
    lookbackDays: 7       # Days of historical data
    maxGenerations: 50    # Max optimization generations
    populationSize: 15    # Population size per generation
    intervalHours: 1      # Hours between optimization runs

  targets:
    - botStyle: MarketMaker
      market: btc-hourly
    - botStyle: TrendFollowing
      market: btc-quarterly

Examples:
  npm run goptimized-writer
  npm run goptimized-writer -- --config custom-config.yaml
  npm run goptimized-writer -- -o ./custom-output-dir
`);
}

main();
