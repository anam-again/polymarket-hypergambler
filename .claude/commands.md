# Custom Claude Code Commands

## /test-ml

Run ML model consistency tests to verify feature counts and NaN handling.

```bash
npx vitest run tests/MLFeatureConsistency.test.ts
```

## /test-all

Run all tests once (CI mode).

```bash
npm run test:run
```

## /test-integration

Run all integration tests.

```bash
npx vitest run tests/integration/
```

## /lint

Check code for ESLint issues.

```bash
npm run lint
```

## /build

Compile TypeScript to JavaScript.

```bash
npm run build
```

## /simulate

Run a quick historical simulation (7 days, EarlyBuyer strategy).

```bash
npm run histSim -- --strategy=EarlyBuyer --days=7 --market=BitcoinHourly
```

## /simulate-full

Run a comprehensive backtest (30 days, all strategies).

```bash
npm run histSim -- --days=30 --market=BitcoinHourly
```

## /optimize

Run the two-stage MSPEQ optimization.

```bash
npm run mspeq
```

## /check-models

Verify saved ML models are valid (no NaN, correct feature counts).

```bash
npx tsx -e "
import { FairValueModel } from './src/ml/FairValueModel.js';
import { ExitModel } from './src/ml/ExitModel.js';
import { MLPFairValueModel } from './src/ml/MLPFairValueModel.js';

const fv = new FairValueModel(0.01, './models/suddenarb_default/fairvalue.json');
const exit = new ExitModel(0.01, './models/suddenarb_default/exit.json');
const mlp = new MLPFairValueModel({}, './models/suddenarb_default/mlp_fairvalue.json');

console.log('FairValue loaded:', fv.loadIfExists());
console.log('Exit loaded:', exit.loadIfExists());
console.log('MLP loaded:', mlp.loadIfExists());
console.log('MLP corrupted:', mlp.diagnoseNaN());
"
```

## /db-stats

Show database statistics (trade counts, recent activity).

```bash
sqlite3 ./db/trading.db "
SELECT
  'Total trades' as metric, COUNT(*) as value FROM trade_audits
UNION ALL
SELECT
  'Last 24h trades', COUNT(*) FROM trade_audits
  WHERE timestamp > datetime('now', '-24 hours')
UNION ALL
SELECT
  'Profitable trades', COUNT(*) FROM trade_audits WHERE pnl > 0
UNION ALL
SELECT
  'Total PnL', ROUND(SUM(pnl), 2) FROM trade_audits;
"
```
