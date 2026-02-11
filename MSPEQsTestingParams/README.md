# MSPEQ Testing Parameters

This folder contains base parameter templates for Stage 2 MSPEQ optimization.

## Available Templates

| Template | Description |
|----------|-------------|
| `FirstCandleMSPEQ-template.yaml` | First candle breakout with pullback confirmation |
| `EarlyBuyerMSPEQ-template.yaml` | Early period direction betting with dynamic cutoff |
| `NCandleMSPEQ-template.yaml` | Multi-candle trading with stop-loss management |

## Usage

### Step 1: Optimize Base Parameters (Optional)

Run the base strategy to find good starting parameters:

```bash
# For FirstCandleMSPEQ (uses FirstCandle base)
npm run histSim -- -s FirstCandle -p 100 -m 50 -c btc

# For EarlyBuyerMSPEQ (uses EarlyBuyer base)
npm run histSim -- -s EarlyBuyer -p 100 -m 50 -c btc

# For NCandleMSPEQ (uses NCandle base)
npm run histSim -- -s NCandle -p 100 -m 50 -c btc
```

### Step 2: Update Template with Best Params

Copy the best parameters from Step 1 into the appropriate template file.

### Step 3: Run Stage 2 Optimization

Use the template with the `-b` flag to run Stage 2 (MSPEQ coefficient optimization only):

```bash
# FirstCandleMSPEQ
npm run histSim -- -b MSPEQsTestingParams/FirstCandleMSPEQ-template.yaml -p 150 -m 75 -c btc

# EarlyBuyerMSPEQ
npm run histSim -- -b MSPEQsTestingParams/EarlyBuyerMSPEQ-template.yaml -s EarlyBuyerMSPEQ -p 150 -m 75 -c btc

# NCandleMSPEQ
npm run histSim -- -b MSPEQsTestingParams/NCandleMSPEQ-template.yaml -s NCandleMSPEQ -p 150 -m 75 -c btc
```

### Market Targeting

Add `-M` flag for specific markets:

```bash
# Quarterly markets
npm run histSim -- -b MSPEQsTestingParams/FirstCandleMSPEQ-template.yaml -M btc-quarterly -p 100 -m 50

# Hourly markets
npm run histSim -- -b MSPEQsTestingParams/NCandleMSPEQ-template.yaml -M btc-hourly -p 100 -m 50
```

## Creating Your Own Parameter Files

1. Copy a template: `cp FirstCandleMSPEQ-template.yaml my-btc-quarterly-params.yaml`
2. Adjust the parameters
3. Run Stage 2 with your file: `npm run histSim -- -b MSPEQsTestingParams/my-btc-quarterly-params.yaml ...`

## Parameter Reference

### FirstCandleMSPEQ

| Parameter | Description | Typical Range |
|-----------|-------------|---------------|
| `targetDollars` | Position size in USD | 5-20 |
| `candleMinutes` | First candle duration | 5-15 (quarterly), 10-30 (hourly) |
| `breakoutBuffer` | Breakout confirmation threshold | 20-200 |
| `pullbackBuffer` | Pullback confirmation threshold | 5-100 |
| `cutoffMinute` | Trading cutoff minute | 8-12 (quarterly), 30-50 (hourly) |
| `baseBuyPrice` | Base buy price | 0.30-0.70 |
| `minProfitMargin` | Minimum profit margin | 0.10-0.40 |

### EarlyBuyerMSPEQ

| Parameter | Description | Typical Range |
|-----------|-------------|---------------|
| `targetDollars` | Position size in USD | 5-20 |
| `baseBuyPrice` | Base buy price | 0.40-0.60 |
| `baseSellPrice` | Base sell price | 0.70-0.90 |
| `baseCutoffMinute` | Base cutoff minute | 5-15 |
| `minProfitMargin` | Minimum profit margin | 0.03-0.10 |
| `directionThreshold` | UP/DOWN threshold | 0.4-0.6 |

### NCandleMSPEQ

| Parameter | Description | Typical Range |
|-----------|-------------|---------------|
| `targetDollars` | Position size in USD | 5-20 |
| `candleMinutes` | Candle duration | 3-10 (quarterly), 5-20 (hourly) |
| `buyPriceBuffer` | Buffer above ask | 0.01-0.05 |
| `sellPriceBuffer` | Buffer below bid | 0.01-0.05 |
| `minProfitMargin` | Minimum profit margin | 0.03-0.15 |
| `stopLossMultiplier` | Stop-loss multiplier | 0.5-2.0 |
| `stoplossTimeout` | Stoploss trigger delay (sec) | 15-60 |
| `sellTimeout` | Force sell timeout (sec) | 120-600 |
| `stoplossFailureTimeout` | Repricing timeout (sec) | 10-30 |
| `earlySellScalar` | Early sell aggressiveness | 0.1-0.5 |
| `cutoffMinute` | Trading cutoff minute | 10-20 |
| `maxTradesPerHour` | Max trades per period | 3-10 |
