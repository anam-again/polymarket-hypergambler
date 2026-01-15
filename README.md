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
# Regular Param Sweep
npm run histSim -- --days 14

# Genetic optimization (all strategies) (Preferred)
npm run histSim -- --genetic --days 7
npm run histSim -- -g -s FirstCandle -p 200 -m 100 -c sol

# Quarterly market strategies
npm run histSim -- -g -s QuarterlyFirstCandle -p 200 -m 100 -c btc -d 1
```

### CLI Options
| Flag               | Description                    | Default |
|--------------------|--------------------------------|---------|
| `-g, --genetic`    | Enable genetic optimization    | off     |
| `-d, --days`       | Lookback days                  | 7       |
| `-m, --max-gen`    | Max generations                | 50      |
| `-t, --threshold`  | Convergence threshold ($)      | 1.0     |
| `-p, --population` | Population size                | 15      |
| `-s, --strategy`   | Filter to specific strategy    | all     |
| `-c, --coin`       | Coin type (btc, eth, sol, xrp) | btc     |

### Available Strategies

**Hourly Markets (60-min periods):**
- Contrarian, TrendFollowing, FirstCandle, FirstCandleV2
- EveningStar, MorningStar, MeanReversion, NCandle

**Quarterly Markets (15-min periods):**
- QuarterlyFirstCandle, QuarterlyMeanReversion, QuarterlyTrendFollowing, QuarterlyNCandle

### Output
Simulation logs are saved to `./logs/simulator/` with timestamped filenames.
