import { useMemo, useState, useEffect } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  Legend
} from 'recharts';

// Color palette for different strategies
const STRATEGY_COLORS = [
  '#1da1f2', // blue
  '#3fb950', // green
  '#f85149', // red
  '#a371f7', // purple
  '#d29922', // yellow/orange
  '#ff7b72', // light red
  '#7ee787', // light green
  '#79c0ff', // light blue
  '#ffa657', // orange
  '#d2a8ff', // light purple
];

function CumulativePnLChart({ data, startTime, endTime }) {
  const [visibleStrategies, setVisibleStrategies] = useState(new Set());
  const [showTotal, setShowTotal] = useState(true);

  // Format timestamp for display
  const formatXAxis = (timestamp) => {
    const date = new Date(timestamp);
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  };

  // Get unique strategies and build chart data with per-strategy cumulative values
  const { chartData, strategies } = useMemo(() => {
    if (!data || data.length === 0) {
      return { chartData: [], strategies: [] };
    }

    // Get unique strategies
    const uniqueStrategies = [...new Set(data.map(d => d.strategy))].sort();

    // Track cumulative PnL per strategy
    const cumulativeByStrategy = {};
    uniqueStrategies.forEach(s => { cumulativeByStrategy[s] = 0; });

    // Sort data by timestamp
    const sortedData = [...data].sort((a, b) => a.timestamp - b.timestamp);

    // Build chart data points
    const points = sortedData.map(trade => {
      cumulativeByStrategy[trade.strategy] += trade.pnl;

      // Create point with all strategy values at this timestamp
      const total = Object.values(cumulativeByStrategy).reduce((a, b) => a + b, 0);
      const point = {
        timestamp: trade.timestamp,
        totalCumulative: parseFloat(total.toFixed(2)),
      };

      // Add each strategy's current cumulative value
      uniqueStrategies.forEach(s => {
        point[s] = parseFloat(cumulativeByStrategy[s].toFixed(2));
      });

      return point;
    });

    // Add starting point at 0 if we have a time range
    if (startTime && points.length > 0) {
      const startPoint = { timestamp: startTime, totalCumulative: 0 };
      uniqueStrategies.forEach(s => { startPoint[s] = 0; });
      return { chartData: [startPoint, ...points], strategies: uniqueStrategies };
    }

    return { chartData: points, strategies: uniqueStrategies };
  }, [data, startTime]);

  // Initialize visible strategies when strategies change
  useEffect(() => {
    setVisibleStrategies(new Set(strategies));
  }, [strategies]);

  const toggleStrategy = (strategy) => {
    setVisibleStrategies(prev => {
      const next = new Set(prev);
      if (next.has(strategy)) {
        next.delete(strategy);
      } else {
        next.add(strategy);
      }
      return next;
    });
  };

  const selectAll = () => setVisibleStrategies(new Set(strategies));
  const selectNone = () => setVisibleStrategies(new Set());

  // Calculate domain - use startTime if set, auto for endTime if null
  const domain = [startTime || 'auto', endTime || 'auto'];

  return (
    <div className="cumulative-pnl-chart">
      <div className="strategy-toggles">
        <div className="toggle-controls">
          <button onClick={selectAll}>All</button>
          <button onClick={selectNone}>None</button>
          <label className="strategy-toggle total-toggle">
            <input
              type="checkbox"
              checked={showTotal}
              onChange={() => setShowTotal(!showTotal)}
            />
            <span style={{ color: '#e7e9ea' }}>Total</span>
          </label>
        </div>
        <div className="strategy-checkboxes">
          {strategies.map((strategy, index) => (
            <label key={strategy} className="strategy-toggle">
              <input
                type="checkbox"
                checked={visibleStrategies.has(strategy)}
                onChange={() => toggleStrategy(strategy)}
              />
              <span style={{ color: STRATEGY_COLORS[index % STRATEGY_COLORS.length] }}>
                {strategy}
              </span>
            </label>
          ))}
        </div>
      </div>
      <ResponsiveContainer width="100%" height={400}>
        <LineChart data={chartData} margin={{ top: 20, right: 30, left: 20, bottom: 20 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#30363d" />
          <XAxis
            dataKey="timestamp"
            type="number"
            domain={domain}
            scale="time"
            stroke="#8b949e"
            tick={{ fontSize: 12 }}
            tickFormatter={formatXAxis}
            angle={-45}
            textAnchor="end"
            height={80}
          />
          <YAxis stroke="#8b949e" />
          <Tooltip
            contentStyle={{
              backgroundColor: '#1c2128',
              border: '1px solid #30363d',
              borderRadius: '8px'
            }}
            labelStyle={{ color: '#e7e9ea' }}
            labelFormatter={(timestamp) => new Date(timestamp).toLocaleString()}
            formatter={(value, name) => [`$${value.toFixed(2)}`, name]}
          />
          <Legend
            wrapperStyle={{ paddingTop: '10px' }}
            iconType="line"
          />
          <ReferenceLine y={0} stroke="#8b949e" strokeDasharray="3 3" />
          {showTotal && (
            <Line
              type="monotone"
              dataKey="totalCumulative"
              stroke="#e7e9ea"
              strokeWidth={3}
              dot={false}
              name="Total"
              connectNulls
            />
          )}
          {strategies.map((strategy, index) => (
            visibleStrategies.has(strategy) && (
              <Line
                key={strategy}
                type="monotone"
                dataKey={strategy}
                stroke={STRATEGY_COLORS[index % STRATEGY_COLORS.length]}
                strokeWidth={2}
                dot={false}
                name={strategy}
                connectNulls
              />
            )
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export default CumulativePnLChart;
