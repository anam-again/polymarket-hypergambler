#!/usr/bin/env npx tsx
/**
 * ML Model Training Script
 *
 * Usage:
 *   npx tsx src/ml/train.ts [options]
 *
 * Options:
 *   --coin=btc|eth|sol|xrp     Coin to train on (default: btc)
 *   --schedule=hourly|quarterly Schedule type (default: hourly)
 *   --style=<PredictionStyle>  Prediction style (e.g., Hourly30m-EOP, Hourly10m-20m)
 *   --train-ratio=0.8          Train/test split ratio (default: 0.8)
 *   --epochs=1000              Training epochs (default: 1000)
 *   --save                     Save model after training
 *   --backtest                 Run backtest after training
 *
 * Prediction Styles:
 *   Hourly EOP Styles (predict end-of-period winner for 60-min periods):
 *     Hourly10m-EOP, Hourly20m-EOP, Hourly30m-EOP, Hourly40m-EOP, Hourly50m-EOP
 *
 *   Hourly Interval Styles (predict price direction at next checkpoint):
 *     Hourly10m-20m, Hourly20m-30m, Hourly30m-40m, Hourly40m-50m
 *
 *   Hourly Extended Interval Styles (longer intervals):
 *     Hourly10m-30m, Hourly10m-40m, Hourly10m-50m
 *     Hourly20m-40m, Hourly20m-50m
 *     Hourly30m-50m
 *
 *   Quarterly EOP Styles (predict end-of-period winner for 15-min periods):
 *     Quarterly3m-EOP, Quarterly5m-EOP, Quarterly8m-EOP, Quarterly10m-EOP
 *
 *   Quarterly Interval Styles:
 *     Quarterly3m-5m, Quarterly5m-8m, Quarterly5m-10m, Quarterly3m-8m
 *
 * NOTE: Style must match schedule! Hourly* styles require --schedule=hourly,
 *       Quarterly* styles require --schedule=quarterly.
 */

import { mkdirSync, existsSync } from 'fs';
import { CoinType } from '../simulation/GeneticOptimizer.js';
import { MarketSchedule } from '../types/interfaces.js';
import { DataPreparation, splitByTime } from './DataPreparation.js';
import { FeatureEngineering } from './FeatureEngineering.js';
import { MarketPredictor, printModelSummary } from './MarketPredictor.js';
import {
    PredictionStyle,
    parsePredictionStyle,
    getPredictionStyleConfig,
    evaluatePnL,
    isQuarterlyStyle,
} from './types.js';

// ============================================================================
// Configuration
// ============================================================================

interface TrainConfig {
    coinType: CoinType;
    schedule: MarketSchedule;
    predictionStyle: PredictionStyle | null;
    trainRatio: number;
    epochs: number;
    saveModel: boolean;
    runBacktest: boolean;
}

function parseArgs(): TrainConfig {
    const args = process.argv.slice(2);

    const config: TrainConfig = {
        coinType: CoinType.BTC,
        schedule: MarketSchedule.HOURLY,
        predictionStyle: null,
        trainRatio: 0.8,
        epochs: 1000,
        saveModel: false,
        runBacktest: false,
    };

    for (const arg of args) {
        if (arg.startsWith('--coin=')) {
            const coin = arg.split('=')[1].toLowerCase();
            if (coin in CoinType) {
                config.coinType = coin as CoinType;
            }
        } else if (arg.startsWith('--schedule=')) {
            const schedule = arg.split('=')[1].toLowerCase();
            if (schedule === 'quarterly') {
                config.schedule = MarketSchedule.QUARTERLY;
            }
        } else if (arg.startsWith('--style=')) {
            const styleStr = arg.split('=')[1];
            const style = parsePredictionStyle(styleStr);
            if (style) {
                config.predictionStyle = style;
            } else {
                console.warn(`Warning: Unknown prediction style "${styleStr}". Using default.`);
                console.warn('  Available styles:');
                console.warn('    Hourly EOP: Hourly10m-EOP, Hourly20m-EOP, Hourly30m-EOP, Hourly40m-EOP, Hourly50m-EOP');
                console.warn('    Hourly INTERVAL: Hourly10m-20m, Hourly20m-30m, Hourly30m-40m, Hourly40m-50m');
                console.warn('    Hourly EXTENDED: Hourly10m-30m, Hourly10m-40m, Hourly10m-50m, Hourly20m-40m, Hourly20m-50m, Hourly30m-50m');
                console.warn('    Quarterly EOP: Quarterly3m-EOP, Quarterly5m-EOP, Quarterly8m-EOP, Quarterly10m-EOP');
                console.warn('    Quarterly INTERVAL: Quarterly3m-5m, Quarterly5m-8m, Quarterly5m-10m, Quarterly3m-8m');
            }
        } else if (arg.startsWith('--train-ratio=')) {
            config.trainRatio = parseFloat(arg.split('=')[1]);
        } else if (arg.startsWith('--epochs=')) {
            config.epochs = parseInt(arg.split('=')[1]);
        } else if (arg === '--save') {
            config.saveModel = true;
        } else if (arg === '--backtest') {
            config.runBacktest = true;
        }
    }

    return config;
}

// ============================================================================
// Main Training Function
// ============================================================================

async function main(): Promise<void> {
    const config = parseArgs();

    // Validate style/schedule compatibility
    if (config.predictionStyle) {
        const styleIsQuarterly = isQuarterlyStyle(config.predictionStyle);
        const scheduleIsQuarterly = config.schedule === MarketSchedule.QUARTERLY;

        if (styleIsQuarterly !== scheduleIsQuarterly) {
            console.error(`ERROR: Style ${config.predictionStyle} doesn't match schedule ${config.schedule}`);
            console.error(`  Quarterly styles (Quarterly*) require --schedule=quarterly`);
            console.error(`  Hourly styles (Hourly*) require --schedule=hourly`);
            process.exit(1);
        }
    }

    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║        ML MARKET OUTCOME PREDICTION - TRAINING               ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');

    // Get style configuration if provided
    const styleConfig = config.predictionStyle
        ? getPredictionStyleConfig(config.predictionStyle)
        : null;

    console.log('Configuration:');
    console.log(`  Coin:        ${config.coinType.toUpperCase()}`);
    console.log(`  Schedule:    ${config.schedule}`);
    if (config.predictionStyle && styleConfig) {
        console.log(`  Style:       ${config.predictionStyle}`);
        console.log(`    - Cutoff:  ${styleConfig.featureCutoffMinutes} minutes into period`);
        console.log(`    - Target:  ${styleConfig.targetType === 'EOP' ? 'End-of-Period winner' : `Price direction at ${styleConfig.targetMinutes}m`}`);
    } else {
        console.log(`  Style:       Default (30m cutoff, EOP target)`);
    }
    console.log(`  Train Ratio: ${config.trainRatio}`);
    console.log(`  Epochs:      ${config.epochs}`);
    console.log(`  Save Model:  ${config.saveModel}`);
    console.log(`  Backtest:    ${config.runBacktest}\n`);

    // -------------------------------------------------------------------------
    // Step 1: Data Preparation
    // -------------------------------------------------------------------------
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('STEP 1: Data Preparation');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    const dataPrep = new DataPreparation(config.coinType, config.schedule);
    const dataset = dataPrep.prepare();

    if (dataset.totalSamples < 100) {
        console.error('ERROR: Insufficient data for training. Need at least 100 samples.');
        process.exit(1);
    }

    console.log(`\nDataset Summary:`);
    console.log(`  Total Periods:  ${dataset.totalSamples}`);
    console.log(`  UP Outcomes:    ${dataset.upWins} (${(dataset.upWins / dataset.totalSamples * 100).toFixed(1)}%)`);
    console.log(`  DOWN Outcomes:  ${dataset.downWins} (${(dataset.downWins / dataset.totalSamples * 100).toFixed(1)}%)`);
    console.log(`  Date Range:     ${dataset.dateRange.start.toISOString().split('T')[0]} to ${dataset.dateRange.end.toISOString().split('T')[0]}`);

    // -------------------------------------------------------------------------
    // Step 2: Feature Engineering
    // -------------------------------------------------------------------------
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('STEP 2: Feature Engineering');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    // Create FeatureEngineering with prediction style if provided
    const featureEngineer = config.predictionStyle
        ? new FeatureEngineering(config.predictionStyle, dataPrep)
        : new FeatureEngineering();

    const allSamples = featureEngineer.prepareSamples(dataset.periods, true);

    console.log(`Features Extracted: ${featureEngineer.getFeatureNames().length}`);
    console.log(`Feature Cutoff: ${featureEngineer.getFeatureCutoffMinutes()} minutes`);
    console.log(`Feature Names: ${featureEngineer.getFeatureNames().slice(0, 5).join(', ')}...`);

    // Split into train/test
    const { train: trainSamples, test: testSamples } = splitByTime(allSamples, config.trainRatio);

    console.log(`\nTrain/Test Split:`);
    console.log(`  Training:   ${trainSamples.length} samples`);
    console.log(`  Testing:    ${testSamples.length} samples`);

    // Check class balance
    const trainUp = trainSamples.filter(s => s.label === 1).length;
    const testUp = testSamples.filter(s => s.label === 1).length;
    console.log(`  Train UP:   ${trainUp} (${(trainUp / trainSamples.length * 100).toFixed(1)}%)`);
    console.log(`  Test UP:    ${testUp} (${(testUp / testSamples.length * 100).toFixed(1)}%)`);

    // -------------------------------------------------------------------------
    // Step 3: Model Training
    // -------------------------------------------------------------------------
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('STEP 3: Model Training (Logistic Regression)');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    const model = new MarketPredictor(
        config.coinType,
        config.schedule,
        {
            epochs: config.epochs,
            learningRate: 0.01,
            l2Lambda: 0.001,
            batchSize: 32,
            earlyStopPatience: 100,
            validationSplit: 0.1,
            verbose: true,
        },
        config.predictionStyle ?? undefined
    );

    // Set normalization params
    model.setNormalizationParams(featureEngineer.getNormalizationParams()!);

    // Train
    model.train(trainSamples);

    // -------------------------------------------------------------------------
    // Step 4: Evaluation
    // -------------------------------------------------------------------------
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('STEP 4: Model Evaluation');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    const trainMetrics = model.evaluate(trainSamples);
    const testMetrics = model.evaluate(testSamples);

    printModelSummary(model, trainMetrics, testMetrics);

    // Analyze edge
    console.log('EDGE ANALYSIS:');
    const edge = testMetrics.accuracy - 0.5;
    const edgePct = (edge * 100).toFixed(2);

    if (edge > 0.02) {
        console.log(`  ✓ Strong Signal: ${edgePct}% edge over random`);
        console.log(`    Expected value per $100 trade: $${(edge * 85 - (1 - testMetrics.accuracy) * 100).toFixed(2)}`);
    } else if (edge > 0) {
        console.log(`  ○ Weak Signal: ${edgePct}% edge over random`);
        console.log(`    May not overcome transaction costs`);
    } else {
        console.log(`  ✗ No Signal: ${edgePct}% edge (worse than random)`);
    }

    // PnL Evaluation (if prediction style is provided)
    if (config.predictionStyle) {
        console.log('\nPnL ANALYSIS:');

        // Get predictions for test samples
        const testPredictions = model.predictBatch(testSamples);

        // Evaluate PnL
        const pnlResult = evaluatePnL(
            testSamples,
            testPredictions.map(p => ({ prediction: p.prediction, confidence: p.confidence })),
            config.predictionStyle,
            100  // $100 notional per trade
        );

        console.log(`  Style:           ${config.predictionStyle}`);
        console.log(`  Trades Eval'd:   ${pnlResult.tradesEvaluated} (${pnlResult.tradesSkipped} skipped)`);
        console.log(`  Total PnL:       $${pnlResult.totalPnL.toFixed(2)}`);
        console.log(`  Average PnL:     $${pnlResult.averagePnL.toFixed(2)} per trade`);
        console.log(`  Win Rate:        ${(pnlResult.winRate * 100).toFixed(1)}%`);
        console.log(`  Winning Trades:  ${pnlResult.winningTrades}`);
        console.log(`  Losing Trades:   ${pnlResult.losingTrades}`);
        console.log(`  Max Gain:        $${pnlResult.maxGain.toFixed(2)}`);
        console.log(`  Max Loss:        $${pnlResult.maxLoss.toFixed(2)}`);

        // Interpret results
        if (pnlResult.averagePnL > 0) {
            console.log(`  → Profitable strategy with avg gain of ${pnlResult.averagePnL.toFixed(2)}% per trade`);
        } else {
            console.log(`  → Unprofitable strategy with avg loss of ${Math.abs(pnlResult.averagePnL).toFixed(2)}% per trade`);
        }
    }

    // -------------------------------------------------------------------------
    // Step 5: Save Model (Optional)
    // -------------------------------------------------------------------------
    if (config.saveModel) {
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('STEP 5: Saving Model');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        const modelDir = './models';
        if (!existsSync(modelDir)) {
            mkdirSync(modelDir, { recursive: true });
        }

        // Include prediction style in filename if provided
        const styleSuffix = config.predictionStyle
            ? `-${config.predictionStyle.toLowerCase()}`
            : '';
        const modelPath = `${modelDir}/${config.coinType}-${config.schedule.toLowerCase()}${styleSuffix}.json`;
        model.save(modelPath);
    }


    console.log('\n╔══════════════════════════════════════════════════════════════╗');
    console.log('║                    TRAINING COMPLETE                         ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');
}

// Run
main().catch(err => {
    console.error('Training failed:', err);
    process.exit(1);
});
