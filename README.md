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
Run  historical simulator (need to manage and  make bots yourself)
```bash
# Regular Param Sweep
npm run histSim -- --days 14`

# Genetic optimization (all strategies) (Preferred)
npm run histSim -- --genetic --days 7
npm run histSim -- -g -s FirstCandle -p 100 -m 100
  ┌──────────────────┬─────────────────────────────┬─────────┐
  │       Flag       │         Description         │ Default │
  ├──────────────────┼─────────────────────────────┼─────────┤
  │ -g, --genetic    │ Enable genetic optimization │ off     │
  ├──────────────────┼─────────────────────────────┼─────────┤
  │ -d, --days       │ Lookback days               │ 7       │
  ├──────────────────┼─────────────────────────────┼─────────┤
  │ -m, --max-gen    │ Max generations (M)         │ 50      │
  ├──────────────────┼─────────────────────────────┼─────────┤
  │ -t, --threshold  │ Convergence threshold (N)   │ 1.0     │
  ├──────────────────┼─────────────────────────────┼─────────┤
  │ -p, --population │ Population size             │ 15      │
  ├──────────────────┼─────────────────────────────┼─────────┤
  │ -s, --strategy   │ Filter to specific strategy │ all     │
  └──────────────────┴─────────────────────────────┴─────────┘
```
