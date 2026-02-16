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
