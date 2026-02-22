# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Build & Development
npm run build          # Compile TypeScript
npm run dev            # Run with tsx (development)
npm run start          # Run compiled version (production)

# Testing
npm test               # Vitest watch mode
npm run test:run       # Single test run (CI)
npm run test:coverage  # Generate coverage report
npx vitest run tests/MyTest.test.ts  # Run single test file

# Linting
npm run lint           # Check src/ with ESLint
npm run lint:fix       # Auto-fix ESLint issues

# Simulation & Optimization
npm run histSim        # Historical backtesting
npm run mspeq          # Two-stage MSPEQ optimization
npm run goptimizer     # Genetic algorithm optimizer
```

## Architecture Overview

This is a Polymarket trading bot system with ML-powered strategies.

### Core Layers

**Bots** (`src/bots/`)
- Base class: `QuantBot.ts` - handles order execution, batching, and lifecycle
- Strategies inherit from QuantBot: FirstCandle, EarlyBuyer, MarketMaker, Contrarian, TrendFollowing, MeanReversion, SuddenArb, etc.
- MSPEQ variants (e.g., `EarlyBuyerMSPEQ`) use multi-signal polynomial equations for dynamic parameters
- `OrderBatcher` batches API calls with 200ms window for efficiency

**ML Models** (`src/ml/`)
- `FairValueModel` - Linear model predicting fair UP/DOWN token prices (56 features)
- `MLPFairValueModel` - Neural network ensemble with FairValueModel
- `ExitModel` - Predicts optimal exit prices using expected value optimization (57 features). Also provides integrated timeout prediction.
- `MarketRegimeDetector` - Classifies market conditions (trending, volatile, ranging)
- `ExperienceReplayBuffer` - Stores training samples for stable online learning

**Market Data** (`src/nonBots/`, `src/signals/`)
- `MarketInfo.ts` - Polymarket order books with caching
- `CDMarketData.ts` - External price data (Binance)
- WebSockets: `PolymarketWebSocket`, `BinanceWebSocket` with shared managers
- `OrderBookDepthAnalyzer` - Computes depth features for ML

**Simulation** (`src/simulation/`)
- `HistoricalSimulator` - Backtesting engine with genetic optimization
- `SimulationClock` - Simulates hourly/quarterly market periods
- Mock implementations: `MockMarketInfo`, `MockCDMarketData`, `MockSignalProvider`

**Optimization** (`src/optimization/`)
- Bayesian, CMA-ES, and Genetic Algorithm optimizers
- `IterativeRefinement` - Two-stage MSPEQ parameter optimization

### Key Abstractions (`src/types/interfaces.ts`)

- `IClock` - Abstract clock with hourly/quarterly period events
- `IMarketData` - Abstract external market data (Binance)
- `IMarketInfo` - Abstract Polymarket data provider
- `IOrderExecutor` - Abstract order execution

### Signal System

Bots use signals for dynamic parameter adjustment:
- `candleSize` - Price movement in current period
- `volatility` - Recent price volatility
- `momentum` - Directional price momentum
- `timeLeft` - Time remaining in period
- `priceImbalance` - Order book imbalance

MultiSignalPEQ combines signals via polynomial equations to adjust parameters like position size, entry/exit thresholds.

### Database (`src/db/`)

SQLite with WAL mode. Core tables:
- `trade_audits` - Execution records with PnL
- `bot_logs` - Activity logs
- `pmarket_prices`, `binance_prices_hourly` - Price history

## Entry Points

- `src/index.ts` - Main production entry, orchestrates all services
- `src/simulation/index.ts` - CLI for backtesting
- `src/genetic/runGeneticWriter.ts` - Genetic optimization runner

## Code Patterns

**Bot naming:**
- Base strategy: `FirstCandle`, `EarlyBuyer`
- MSPEQ variant: `FirstCandleMSPEQ`
- Version 2: `EarlyBuyerV2`
- Quarterly: `QuarterlyFirstCandle`

**ML Features:**
- FairValueModel uses 56 features (price + depth + time + order flow + cross-token)
- ExitModel uses 57 features (56 + targetOffset)
- Feature extraction in `computeAllFeatures()` must stay consistent across models

**Order execution:**
- All orders go through `OrderBatcher` for batching
- `QuantBot.makeOrder()` handles order creation and tracking
- Orders have states: LIVE → MATCHED/EXPIRED/CANCELED

## Testing

Tests in `tests/` directory use Vitest:
- Unit tests: `QuantBot.test.ts`, `MLFeatureConsistency.test.ts`
- Integration tests: `HistoricalSimulationFlow.test.ts`, `MultiBotSimulation.test.ts`
- Test helpers in `tests/utils/testHelpers.ts`

```bash
# Focused test commands
npx vitest run tests/MLFeatureConsistency.test.ts     # ML models only
npx vitest run tests/QuantBot.test.ts                 # Bot base class
npx vitest run tests/Contrarian.test.ts               # Contrarian strategy
npx vitest run tests/integration/                      # All integration tests
npx vitest run tests/integration/HistoricalSimulationFlow.test.ts  # Backtesting
```

## Configuration

- `tsconfig.json` - ES2022, strict mode, Node.js modules
- `eslint.config.js` - TypeScript-ESLint with strict rules
- Bot configs loaded from YAML via `GeneticBotManager`
- Environment: `.env` file for API keys and credentials

## Live Trading Rules & Lessons Learned

### Genetic Optimization Anti-Overfitting

The single biggest source of live PnL losses is overfitting in genetic optimization.
**Critical rules:**

1. **Always use >= 7 days lookback** (`geneticWriterConfig.yaml` → `lookbackDays: 7`).
   Using 1-3 days produced parameters that worked great in simulation but failed badly live.
   Example: MarketMaker sim=$11,484, live=-$1,795 with `lookbackDays: 1`.

2. **A bot MUST pass validation gating before being enabled** (`GeneticOptimizedWriter` now
   enforces `!overfit && isStable`). A strategy that says "OVERFIT" or "UNSTABLE" in the
   sim log should never be deployed.

3. **Stability score < 30% is a hard disqualifier.** The EarlyBuyerMSPEQ sim showed a 12.5%
   stability score and was flagged UNSTABLE — params where tiny perturbations cause large
   PnL swings are not robust in live trading.

4. **Out-of-sample holdout PnL < 30% of training PnL is a red flag.** 13.4% holdout ratio
   means the strategy barely generalizes beyond its training window.

### Strategy Parameter Rules

#### MeanReversion
- **entryThreshold must be >= 2.5** for Quarterly markets. 1.45 sigma fires on noise.
  XRP is the only profitable live MeanReversion bot and uses threshold=3.0.
- **lookbackPeriods should be >= 8**. Using 4 produces unreliable z-scores.
- The z-score is computed on Binance spot prices; orders are placed on Polymarket tokens.

#### TrendFollowing
- **adxThreshold should be >= 20.0**. Values < 20 (like 7.96 for ETH) enter trend-following
  trades in ranging/flat markets where the strategy doesn't work.
- **shortMaPeriod and longMaPeriod must differ by at least 5+**. A 5/6 spread is meaningless.
- **adxPeriod should be >= 10**. adxPeriod=2 produces an unusable ADX reading.

#### SuddenArb
- **mispricingThreshold should be >= 0.15** (15%). The FairValueModel can be miscalibrated,
  generating false 50%+ divergence. A threshold of 5% allows the model to trade on noise.
- **maxConcurrentTrades should be capped** (default: 5). Without a cap, the bot opens
  hundreds of concurrent positions when the model is miscalibrated, compounding losses.
- **MAX_SANE_DIVERGENCE = 35%** is enforced in code. Divergences above 35% indicate a
  miscalibrated model — real arbitrage opportunities are typically 3-10%.
- The FairValueModel performance can be checked at:
  `./models/suddenarb_<id>/fairvalue_performance.json` — look at absoluteError values.
  If predictions consistently show >0.3 absolute error, the model is broken.

### Re-Optimization Commands

```bash
# Re-run all genetic bots (uses geneticWriterConfig.yaml settings):
npm run goptimizer

# Manual histSim with proper lookback (7 days minimum):
npm run histSim -- --days 7 -s QuarterlyMeanReversion -c xrp -p 75 -m 20

# Check live PnL by bot from audit log (PowerShell):
$lines = Get-Content ./logs/audits/tradeAudit.log -Tail 10000
$pnl = @{}; $trades = @{}
foreach ($line in $lines) {
    $p = $line -split ','; if ($p.Count -ge 10) {
        $b = $p[1].Trim(); $v = [double]$p[9]
        if (-not $pnl[$b]) { $pnl[$b] = 0.0; $trades[$b] = 0 }
        $pnl[$b] += $v; $trades[$b] += 1
    }
}
$pnl.GetEnumerator() | Sort-Object Value | % { "$($_.Key): $([math]::Round($_.Value,2)) ($($trades[$_.Key]) trades)" }
```

### Currently Profitable Live Strategy

Only `mrev-xrp15-gen1` (QuarterlyMeanReversion on XRP) has been consistently profitable (+$450
on 47 trades). Its key params: `entryThreshold: 3.0, lookbackPeriods: 18, targetBuyPrice: 0.02,
targetSellPrice: 0.97`. This is the reference for what "conservative enough to generalize" looks like.
