# Always Gamba
![ALWAYS GAMBA](https://github.com/anam-again/polymarket-hypergambler/blob/main/src/assets/gamba.png?raw=true)

#
Crack open the goat
```bash
npx @anthropic-ai/claude-code
```

#
Setup
```
npm install
npm run build
```

#
Count lines of code
```bash
git ls-files | xargs wc -l
```

#
Start ALL bots including prod.
```bash
npm run start
```

#
Dashboards
```bash
cd dashboard
npm install
npm build
npm run dev
```

#
Run historical simulator
```bash
# Genetic optimization (all strategies) (Preferred)
npm run histSim -- --days 7
npm run histSim -- -s FirstCandle -p 200 -m 100 -c sol

# Quarterly market strategies
npm run histSim -- -s QuarterlyFirstCandle -p 200 -m 100 -d 10 -a 10 -c btc
npm run histSim -- -s QuarterlyFirstCandle -M eth-quarterly -c eth -p 75  -m 20 -d 20
```

### CLI Options
| Flag               | Description                              | Default   |
|--------------------|------------------------------------------|-----------|
| `-d, --days`       | Lookback days                            | 7         |
| `-m, --max-gen`    | Max generations                          | 50        |
| `-t, --threshold`  | Convergence threshold ($)                | 1.0       |
| `-p, --population` | Population size                          | 15        |
| `-s, --strategy`   | Filter to specific strategy              | all       |
| `-c, --coin`       | Coin type (btc, eth, sol, xrp)           | btc       |
| `-M, --market`     | Target market (btc-hourly, btc-quarterly)| btc-hourly|
| `-a, --audit-trades`| Avg/Best trades to audit                | 0/OFF     |
| `-2, --two-stage`  | Two-stage MSPEQ optimization             | false     |

### Available Strategies

**Hourly Markets (60-min periods):**
- Contrarian, TrendFollowing, FirstCandle, FirstCandleV2
- EveningStar, MorningStar, MeanReversion, NCandle, EsotericNormalization
- FirstCandleMSPEQ (multi-signal)

**Quarterly Markets (15-min periods):**
- QuarterlyFirstCandle, QuarterlyMeanReversion, QuarterlyTrendFollowing, QuarterlyNCandle, QuarterlyEsotericNormalization
- QuarterlyFirstCandleMSPEQ (multi-signal)

**Quarterly -m markets**
Probably need to   be set with your  coin
- btc-hourly, bitcoin-hourly
- btc-quarterly, bitcoin-quarterly
- eth-hourly, ethereum-hourly
- eth-quarterly, ethereum-quarterly

### Output
Simulation logs are saved to `./logs/simulator/` with timestamped filenames.

---

## Signal-Based Decision System

Multi-signal architecture for dynamic trading parameter adjustment.

### Signals

| Signal | Range | Description |
|--------|-------|-------------|
| `candleSize` | 0-2+ | (high - low) / reference price |
| `timeLeft` | 0-1 | Time remaining in period |
| `volatility` | 0-1 | Normalized std dev of recent prices |
| `momentum` | -1 to 1 | Price change % over window |
| `priceImbalance` | -0.5 to 0.5 | upMid - downMid from order book |

### Phase 1: Multi-Signal PEQ (MultiSignalPEQ)

Replaces single-input polynomial equations with multi-signal versions for decision-time parameters:
- `targetBuyPrice`, `targetSellPrice`, `earlySellTime`, `earlySellPrice`

**New Strategies:**
- `FirstCandleMSPEQ` - Hourly markets with multi-signal PEQs
- `QuarterlyFirstCandleMSPEQ` - Quarterly markets with multi-signal PEQs

**Two-Stage Optimization (Recommended):**

MSPEQ strategies have ~68 parameters which makes single-stage optimization slow. Two-stage optimization splits this into:
- **Stage 1**: Optimize base parameters using FirstCandle (~12 params, fast)
- **Stage 2**: Freeze base params, optimize only MSPEQ coefficients (~60 params)

```bash
# Two-stage optimization (runs both stages)
npm run mspeq -- -p 100 -m 50 -c btc
npm run histSim -- --two-stage -p 100 -m 50 -c btc

# Stage 2 only (with pre-optimized base params from YAML)
npm run mspeq:stage2 ./logs/simulator/firstcandle-params.yaml -- -p 150 -m 75
npm run histSim -- --base-params base-params.yaml -p 150 -m 75

# Single-stage (slower, only if needed)
npm run histSim -- -s FirstCandleMSPEQ -p 200 -m 100 -c btc
```

**Stage 2 Only Workflow:**
1. Run FirstCandle optimization to get base params
2. Save the best params to a YAML file
3. Run Stage 2 only with `--base-params <file>` to optimize MSPEQ coefficients

**Key Files:**
- `src/utils/MultiSignalPEQ.ts` - Core multi-signal class
- `src/signals/SignalProvider.ts` - Signal computation interface
- `src/signals/LiveSignalProvider.ts` - Real-time signals from market data
- `src/bots/FirstCandleMSPEQ.ts` - Bot using MultiSignalPEQ

### Phase 2: Conditional Parameters

Adjusts base parameters at period start based on market conditions (e.g., wider breakoutBuffer in high volatility).

**Key Files:**
- `src/utils/ConditionalParam.ts` - Period-start parameter adjustment

### Phase 3: ML Meta-Learner

Neural network that outputs trading parameters from market features.

**Training Pipeline:**
```typescript
import { DecisionModelTrainer, DEFAULT_TRAINING_CONFIG } from './ml';

const trainer = new DecisionModelTrainer({
    dataDirectory: './data/decision-samples',
    modelDirectory: './models/decision-networks',
});

trainer.loadData();
const results = await trainer.train(networkConfig, DEFAULT_TRAINING_CONFIG);
```

**Key Files:**
- `src/ml/DecisionNetwork.ts` - Neural network implementation
- `src/ml/DecisionDataCollector.ts` - Training data collection
- `src/ml/DecisionModelTrainer.ts` - Training pipeline with cross-validation
