#!/usr/bin/env tsx
/**
 * Feature Analysis CLI
 *
 * Analyzes feature importance across ML models and generates reports.
 *
 * Usage:
 *   npx tsx scripts/analyze-features.ts [options]
 *   npm run analyze-features -- [options]
 *
 * Options:
 *   --model-id <id>     Model ID to analyze (default: "default")
 *   --model-path <path> Direct path to models directory
 *   --output <path>     Save report to file
 *   --format <type>     Output format: text, json, csv (default: text)
 *   --top <n>           Show only top N features (default: all)
 *   --group             Show importance by feature group
 *   --problems          Show only potential problems
 *   --compare <id>      Compare with another model
 *   --help              Show this help message
 *
 * Examples:
 *   npx tsx scripts/analyze-features.ts --model-id btc
 *   npx tsx scripts/analyze-features.ts --model-id btc --top 10 --format json
 *   npx tsx scripts/analyze-features.ts --model-id btc --output report.txt
 *   npx tsx scripts/analyze-features.ts --model-id btc --group
 *   npx tsx scripts/analyze-features.ts --model-id btc --problems
 */

import { FairValueModel } from '../src/ml/FairValueModel.js';
import { MLPFairValueModel } from '../src/ml/MLPFairValueModel.js';
import { ExperienceReplayBuffer } from '../src/ml/ExperienceReplayBuffer.js';
import { FeatureAnalyzer, FeatureImportanceResult, FeatureStatistics } from '../src/ml/FeatureAnalyzer.js';
import { existsSync, writeFileSync } from 'fs';

// Parse command line arguments
function parseArgs(): {
    modelId: string;
    modelPath: string | null;
    output: string | null;
    format: 'text' | 'json' | 'csv';
    top: number | null;
    group: boolean;
    problems: boolean;
    compare: string | null;
    help: boolean;
} {
    const args = process.argv.slice(2);
    const result = {
        modelId: 'default',
        modelPath: null as string | null,
        output: null as string | null,
        format: 'text' as 'text' | 'json' | 'csv',
        top: null as number | null,
        group: false,
        problems: false,
        compare: null as string | null,
        help: false,
    };

    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case '--model-id':
                result.modelId = args[++i];
                break;
            case '--model-path':
                result.modelPath = args[++i];
                break;
            case '--output':
            case '-o':
                result.output = args[++i];
                break;
            case '--format':
            case '-f':
                result.format = args[++i] as 'text' | 'json' | 'csv';
                break;
            case '--top':
            case '-n':
                result.top = parseInt(args[++i], 10);
                break;
            case '--group':
            case '-g':
                result.group = true;
                break;
            case '--problems':
            case '-p':
                result.problems = true;
                break;
            case '--compare':
            case '-c':
                result.compare = args[++i];
                break;
            case '--help':
            case '-h':
                result.help = true;
                break;
        }
    }

    return result;
}

function showHelp(): void {
    console.log(`
Feature Analysis CLI - Analyze ML model feature importance

Usage:
  npx tsx scripts/analyze-features.ts [options]
  npm run analyze-features -- [options]

Options:
  --model-id <id>     Model ID to analyze (default: "default")
  --model-path <path> Direct path to models directory
  --output, -o <path> Save report to file
  --format, -f <type> Output format: text, json, csv (default: text)
  --top, -n <n>       Show only top N features
  --group, -g         Show importance by feature group
  --problems, -p      Show only potential problems
  --compare, -c <id>  Compare with another model
  --help, -h          Show this help message

Examples:
  npx tsx scripts/analyze-features.ts --model-id btc
  npx tsx scripts/analyze-features.ts --model-id btc --top 10
  npx tsx scripts/analyze-features.ts --model-id btc --format json --output features.json
  npx tsx scripts/analyze-features.ts --model-id btc --group
  npx tsx scripts/analyze-features.ts --model-id btc --problems
  npx tsx scripts/analyze-features.ts --model-id btc --compare eth
`);
}

function loadModels(modelPath: string): {
    linearModel: FairValueModel | null;
    mlpModel: MLPFairValueModel | null;
    replayBuffer: ExperienceReplayBuffer | null;
} {
    let linearModel: FairValueModel | null = null;
    let mlpModel: MLPFairValueModel | null = null;
    let replayBuffer: ExperienceReplayBuffer | null = null;

    // Load linear model
    const linearPath = `${modelPath}/fairvalue.json`;
    if (existsSync(linearPath)) {
        linearModel = new FairValueModel(0.01, linearPath);
        linearModel.loadIfExists();
    }

    // Load MLP model
    const mlpPath = `${modelPath}/mlp_fairvalue.json`;
    if (existsSync(mlpPath)) {
        mlpModel = new MLPFairValueModel({}, mlpPath);
        mlpModel.loadIfExists();
    }

    // Load replay buffer
    const replayPath = `${modelPath}/replay_buffer.json`;
    if (existsSync(replayPath)) {
        replayBuffer = new ExperienceReplayBuffer(1000, 32, replayPath);
        replayBuffer.loadIfExists();
    }

    return { linearModel, mlpModel, replayBuffer };
}

function formatText(
    importance: FeatureImportanceResult[],
    statistics: FeatureStatistics[],
    options: { top: number | null; group: boolean; problems: boolean }
): string {
    const lines: string[] = [];

    if (options.group) {
        // Group view
        const groups = FeatureAnalyzer.analyzeByGroup(importance);
        lines.push('');
        lines.push('FEATURE IMPORTANCE BY GROUP');
        lines.push('=' .repeat(50));

        const sorted = Array.from(groups.entries()).sort((a, b) => b[1] - a[1]);
        for (const [group, score] of sorted) {
            const bar = '█'.repeat(Math.round(score * 30));
            lines.push(`${group.padEnd(20)} ${score.toFixed(4)} ${bar}`);
        }
    } else if (options.problems) {
        // Problems view
        const problems = FeatureAnalyzer.identifyProblems(importance, statistics);
        lines.push('');
        lines.push('POTENTIAL FEATURE ISSUES');
        lines.push('=' .repeat(70));

        if (problems.length === 0) {
            lines.push('No issues detected!');
        } else {
            for (const p of problems) {
                const icon = p.severity === 'high' ? '🔴' : p.severity === 'medium' ? '🟡' : '🟢';
                lines.push(`${icon} [${p.severity.toUpperCase()}] ${p.featureName}`);
                lines.push(`   ${p.problem}`);
                lines.push('');
            }
        }
    } else {
        // Default ranked view
        const toShow = options.top ? importance.slice(0, options.top) : importance;

        lines.push('');
        lines.push('FEATURE IMPORTANCE RANKING');
        lines.push('=' .repeat(85));
        lines.push(
            'Rank'.padEnd(6) +
            'Feature'.padEnd(25) +
            'Linear'.padEnd(10) +
            'MLP'.padEnd(10) +
            'ErrCorr'.padEnd(10) +
            'Score'.padEnd(10) +
            'Bar'
        );
        lines.push('-'.repeat(85));

        for (const imp of toShow) {
            const mlpStr = imp.mlpImportance !== null ? imp.mlpImportance.toFixed(4) : 'N/A';
            const errStr = imp.errorCorrelation !== null ? imp.errorCorrelation.toFixed(3) : 'N/A';
            const bar = '█'.repeat(Math.round(imp.combinedScore * 20));

            lines.push(
                `#${imp.rank}`.padEnd(6) +
                imp.featureName.padEnd(25) +
                imp.linearWeightAvg.toFixed(4).padEnd(10) +
                mlpStr.padEnd(10) +
                errStr.padEnd(10) +
                imp.combinedScore.toFixed(4).padEnd(10) +
                bar
            );
        }

        if (options.top && options.top < importance.length) {
            lines.push('');
            lines.push(`(Showing top ${options.top} of ${importance.length} features)`);
        }
    }

    return lines.join('\n');
}

function formatJson(
    importance: FeatureImportanceResult[],
    statistics: FeatureStatistics[],
    options: { top: number | null; group: boolean; problems: boolean }
): string {
    if (options.group) {
        const groups = FeatureAnalyzer.analyzeByGroup(importance);
        return JSON.stringify(Object.fromEntries(groups), null, 2);
    } else if (options.problems) {
        const problems = FeatureAnalyzer.identifyProblems(importance, statistics);
        return JSON.stringify(problems, null, 2);
    } else {
        const toShow = options.top ? importance.slice(0, options.top) : importance;
        return JSON.stringify(toShow, null, 2);
    }
}

function formatCsv(
    importance: FeatureImportanceResult[],
    options: { top: number | null }
): string {
    const lines: string[] = [];
    lines.push('rank,feature,linear_weight_up,linear_weight_down,linear_weight_avg,mlp_importance,error_correlation,combined_score');

    const toShow = options.top ? importance.slice(0, options.top) : importance;

    for (const imp of toShow) {
        lines.push([
            imp.rank,
            imp.featureName,
            imp.linearWeightUp.toFixed(6),
            imp.linearWeightDown.toFixed(6),
            imp.linearWeightAvg.toFixed(6),
            imp.mlpImportance?.toFixed(6) ?? '',
            imp.errorCorrelation?.toFixed(6) ?? '',
            imp.combinedScore.toFixed(6),
        ].join(','));
    }

    return lines.join('\n');
}

async function main(): Promise<void> {
    const args = parseArgs();

    if (args.help) {
        showHelp();
        process.exit(0);
    }

    // Determine model path
    const modelPath = args.modelPath ?? `./models/suddenarb_${args.modelId}`;

    if (!existsSync(modelPath)) {
        console.error(`Error: Model path does not exist: ${modelPath}`);
        console.error('');
        console.error('Available model directories:');

        const modelsDir = './models';
        if (existsSync(modelsDir)) {
            const { readdirSync } = await import('fs');
            const dirs = readdirSync(modelsDir, { withFileTypes: true })
                .filter(d => d.isDirectory() && d.name.startsWith('suddenarb_'))
                .map(d => d.name.replace('suddenarb_', ''));

            if (dirs.length > 0) {
                dirs.forEach(d => console.error(`  --model-id ${d}`));
            } else {
                console.error('  (none found)');
            }
        }
        process.exit(1);
    }

    console.log(`Loading models from: ${modelPath}`);

    const { linearModel, mlpModel, replayBuffer } = loadModels(modelPath);

    if (!linearModel) {
        console.error('Error: Could not load linear model (fairvalue.json not found)');
        process.exit(1);
    }

    console.log(`Linear model: ${linearModel.getTrainingSamples()} training samples`);
    if (mlpModel) {
        const stats = mlpModel.getStats();
        console.log(`MLP model: ${stats.trainingEpochs} epochs, ${stats.parameterCount} parameters`);
    } else {
        console.log('MLP model: not found');
    }
    if (replayBuffer) {
        console.log(`Replay buffer: ${replayBuffer.size()} samples`);
    } else {
        console.log('Replay buffer: not found');
    }

    // Analyze importance
    const importance = FeatureAnalyzer.analyzeImportance(
        linearModel,
        mlpModel,
        linearModel.getPerformanceTracker(),
        replayBuffer
    );

    const statistics = replayBuffer
        ? FeatureAnalyzer.computeStatistics(replayBuffer)
        : [];

    // Compare mode
    if (args.compare) {
        const comparePath = `./models/suddenarb_${args.compare}`;
        if (!existsSync(comparePath)) {
            console.error(`Error: Comparison model not found: ${comparePath}`);
            process.exit(1);
        }

        const compare = loadModels(comparePath);
        if (!compare.linearModel) {
            console.error('Error: Could not load comparison model');
            process.exit(1);
        }

        const compareImportance = FeatureAnalyzer.analyzeImportance(
            compare.linearModel,
            compare.mlpModel,
            compare.linearModel.getPerformanceTracker(),
            compare.replayBuffer
        );

        console.log('');
        console.log('FEATURE IMPORTANCE COMPARISON');
        console.log('=' .repeat(70));
        console.log(
            'Feature'.padEnd(25) +
            `${args.modelId}`.padEnd(15) +
            `${args.compare}`.padEnd(15) +
            'Diff'
        );
        console.log('-'.repeat(70));

        const compareMap = new Map(compareImportance.map(i => [i.featureName, i.combinedScore]));

        for (const imp of importance) {
            const compareScore = compareMap.get(imp.featureName) ?? 0;
            const diff = imp.combinedScore - compareScore;
            const diffStr = diff > 0 ? `+${diff.toFixed(4)}` : diff.toFixed(4);
            const arrow = diff > 0.05 ? '↑' : diff < -0.05 ? '↓' : '→';

            console.log(
                imp.featureName.padEnd(25) +
                imp.combinedScore.toFixed(4).padEnd(15) +
                compareScore.toFixed(4).padEnd(15) +
                `${diffStr} ${arrow}`
            );
        }

        process.exit(0);
    }

    // Format output
    let output: string;
    switch (args.format) {
        case 'json':
            output = formatJson(importance, statistics, {
                top: args.top,
                group: args.group,
                problems: args.problems,
            });
            break;
        case 'csv':
            output = formatCsv(importance, { top: args.top });
            break;
        default:
            output = formatText(importance, statistics, {
                top: args.top,
                group: args.group,
                problems: args.problems,
            });
    }

    // Output results
    if (args.output) {
        writeFileSync(args.output, output);
        console.log(`\nReport saved to: ${args.output}`);
    } else {
        console.log(output);
    }

    // Show summary
    if (!args.group && !args.problems && !args.output) {
        console.log('');
        console.log('Quick commands:');
        console.log(`  --top 10          Show only top 10 features`);
        console.log(`  --group           Show by feature group`);
        console.log(`  --problems        Show potential issues`);
        console.log(`  --format json     Output as JSON`);
        console.log(`  --output file.txt Save to file`);
    }
}

main().catch(err => {
    console.error('Error:', err);
    process.exit(1);
});
