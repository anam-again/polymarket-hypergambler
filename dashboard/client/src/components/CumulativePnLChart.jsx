import { useMemo, useState, useEffect, useRef, useCallback } from 'react';
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

// Custom tooltip that displays in multiple columns when there are many items
const MultiColumnTooltip = ({ active, payload, label, strategies }) => {
  if (!active || !payload || payload.length === 0) return null;

  const ITEMS_PER_COLUMN = 6;
  const items = payload.filter(p => p.value !== undefined);
  const numColumns = Math.ceil(items.length / ITEMS_PER_COLUMN);

  return (
    <div style={{
      backgroundColor: '#1c2128',
      border: '1px solid #30363d',
      borderRadius: '8px',
      padding: '12px',
      zIndex: 1000,
    }}>
      <div style={{ color: '#e7e9ea', marginBottom: '8px', fontWeight: 500 }}>
        {new Date(label).toLocaleString()}
      </div>
      <div style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${Math.min(numColumns, 3)}, minmax(140px, auto))`,
        gap: '4px 16px',
      }}>
        {items.map((entry, index) => (
          <div key={index} style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: '12px',
          }}>
            <span style={{ color: entry.color, fontSize: '13px' }}>
              {entry.name}
            </span>
            <span style={{
              color: entry.value >= 0 ? '#3fb950' : '#f85149',
              fontWeight: 500,
              fontSize: '13px',
            }}>
              ${entry.value.toFixed(2)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
};

// Extract tags from strategy name by splitting on '-'
// e.g., "gen-fcandlev2-3" -> ["gen", "fcandlev2", "3"]
// e.g., "FirstCandle-ETH" -> ["firstcandle", "eth"]
const getStrategyTags = (strategy) => {
  if (!strategy) return [];
  return strategy
    .toLowerCase()
    .split('-')
    .map(s => s.trim())
    .filter(s => s.length > 0);
};

// Check if strategy matches a tag filter
const strategyMatchesTag = (strategy, tag) => {
  if (tag === 'all') return true;
  const tags = getStrategyTags(strategy);
  return tags.includes(tag.toLowerCase());
};

function CumulativePnLChart({ data, precomputedData, startTime, endTime }) {
  // Applied state (what the chart shows)
  const [visibleStrategies, setVisibleStrategies] = useState(new Set());
  const [showTotal, setShowTotal] = useState(false);
  const [selectedTags, setSelectedTags] = useState([]);

  // Pending state stored in refs to avoid re-renders while selecting
  const pendingVisibleRef = useRef(new Set());
  const pendingShowTotalRef = useRef(false);
  const pendingSelectedTagsRef = useRef([]);

  // Refs for uncontrolled checkboxes
  const totalCheckboxRef = useRef(null);
  const strategyCheckboxRefs = useRef({});

  // Strategy search filter (use ref to avoid re-renders while typing)
  const [strategySearch, setStrategySearch] = useState('');
  const searchInputRef = useRef(null);

  // Resizable chart height
  const [chartHeight, setChartHeight] = useState(400);
  const [isResizing, setIsResizing] = useState(false);
  const resizeRef = useRef(null);

  // Format timestamp for display
  const formatXAxis = (timestamp) => {
    const date = new Date(timestamp);
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  };

  // Extract all unique tags from strategy names - use precomputed if available
  const allTags = useMemo(() => {
    // Use precomputed tags if available
    if (precomputedData && precomputedData.tags) {
      return precomputedData.tags;
    }

    if (!data || data.length === 0) return [];

    const tagSet = new Set();
    data.forEach(d => {
      getStrategyTags(d.strategy).forEach(tag => tagSet.add(tag));
    });

    return [...tagSet].sort();
  }, [data, precomputedData]);

  // Filter data based on selected tags (strategy must match ALL selected tags)
  const filteredData = useMemo(() => {
    if (!data || data.length === 0) return [];
    if (selectedTags.length === 0) return data;

    return data.filter(d => {
      if (!d.strategy) return false;
      return selectedTags.every(tag => strategyMatchesTag(d.strategy, tag));
    });
  }, [data, selectedTags]);

  // Toggle tag in pending ref (still need state for visual feedback on tag chips)
  const [pendingSelectedTags, setPendingSelectedTags] = useState([]);

  const toggleTag = (tag) => {
    setPendingSelectedTags(prev => {
      const newTags = prev.includes(tag) ? prev.filter(t => t !== tag) : [...prev, tag];
      pendingSelectedTagsRef.current = newTags;
      return newTags;
    });
  };

  const clearTags = () => {
    setPendingSelectedTags([]);
    pendingSelectedTagsRef.current = [];
  };

  // Get unique strategies and build chart data with per-strategy cumulative values
  // Uses precomputed data from backend when available (much faster)
  const { chartData, strategies } = useMemo(() => {
    // Use precomputed data if available and no tag filters applied
    if (precomputedData && precomputedData.points && selectedTags.length === 0) {
      const uniqueStrategies = precomputedData.strategies || [];

      // Transform precomputed points to chart format
      const points = precomputedData.points.map(point => {
        const chartPoint = {
          timestamp: point.timestamp,
          totalCumulative: point.total,
        };
        // Add each strategy's value
        uniqueStrategies.forEach(s => {
          chartPoint[s] = point.strategies[s] || 0;
        });
        return chartPoint;
      });

      return { chartData: points, strategies: uniqueStrategies };
    }

    // Fallback: compute from raw data (when tags are applied or precomputed not available)
    if (!filteredData || filteredData.length === 0) {
      return { chartData: [], strategies: [] };
    }

    // Get unique strategies (filter out undefined/null)
    const uniqueStrategies = [...new Set(filteredData.map(d => d.strategy).filter(Boolean))].sort();

    // Track cumulative PnL per strategy
    const cumulativeByStrategy = {};
    uniqueStrategies.forEach(s => { cumulativeByStrategy[s] = 0; });

    // Sort data by timestamp
    const sortedData = [...filteredData].sort((a, b) => a.timestamp - b.timestamp);

    // Build chart data points
    const points = sortedData.filter(trade => trade.strategy).map(trade => {
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
  }, [filteredData, startTime, precomputedData, selectedTags.length]);

  // Filter strategies based on search term
  const filteredStrategies = useMemo(() => {
    if (!strategySearch.trim()) return strategies;
    const searchLower = strategySearch.toLowerCase();
    return strategies.filter(s => s.toLowerCase().includes(searchLower));
  }, [strategies, strategySearch]);

  // Select all/none only affects filtered (visible) strategies (updates DOM directly)
  const selectAll = () => {
    filteredStrategies.forEach(s => {
      const checkbox = strategyCheckboxRefs.current[s];
      if (checkbox) checkbox.checked = true;
    });
  };

  const selectNone = () => {
    filteredStrategies.forEach(s => {
      const checkbox = strategyCheckboxRefs.current[s];
      if (checkbox) checkbox.checked = false;
    });
  };

  // Apply search filter (reads from uncontrolled input ref)
  const applySearch = () => {
    const value = searchInputRef.current?.value || '';
    setStrategySearch(value);
  };

  // Handle Enter key in search input
  const handleSearchKeyDown = (e) => {
    if (e.key === 'Enter') {
      applySearch();
    }
  };

  // Apply pending state to chart (reads from uncontrolled checkboxes)
  const applyFilters = () => {
    // Read Total checkbox
    const newShowTotal = totalCheckboxRef.current?.checked || false;
    setShowTotal(newShowTotal);

    // Read all strategy checkboxes
    const newVisible = new Set();
    strategies.forEach(s => {
      const checkbox = strategyCheckboxRefs.current[s];
      if (checkbox?.checked) {
        newVisible.add(s);
      }
    });
    setVisibleStrategies(newVisible);

    // Apply tags from ref
    setSelectedTags([...pendingSelectedTagsRef.current]);
  };

  // Resize handlers
  const handleMouseDown = useCallback((e) => {
    e.preventDefault();
    setIsResizing(true);
  }, []);

  const handleMouseMove = useCallback((e) => {
    if (!isResizing || !resizeRef.current) return;
    const rect = resizeRef.current.getBoundingClientRect();
    const newHeight = e.clientY - rect.top;
    setChartHeight(Math.max(200, Math.min(800, newHeight)));
  }, [isResizing]);

  const handleMouseUp = useCallback(() => {
    setIsResizing(false);
  }, []);

  useEffect(() => {
    if (isResizing) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      return () => {
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
      };
    }
  }, [isResizing, handleMouseMove, handleMouseUp]);

  // Calculate domain - use startTime if set, auto for endTime if null
  const domain = [startTime || 'auto', endTime || 'auto'];

  return (
    <div className="cumulative-pnl-chart">
      <div className="chart-filters">
        <span className="filter-label">Filter by tag:</span>
        <div className="tag-chips">
          {allTags.map(tag => (
            <button
              key={tag}
              className={`tag-chip ${pendingSelectedTags.includes(tag) ? 'active' : ''}`}
              onClick={() => toggleTag(tag)}
            >
              {tag}
            </button>
          ))}
        </div>
        {pendingSelectedTags.length > 0 && (
          <button className="clear-filters-btn" onClick={clearTags}>
            Clear ({pendingSelectedTags.length})
          </button>
        )}
      </div>
      <div className="strategy-toggles">
        <div className="toggle-controls">
          <button onClick={selectAll}>All</button>
          <button onClick={selectNone}>None</button>
          <label className="strategy-toggle total-toggle">
            <input
              ref={totalCheckboxRef}
              type="checkbox"
              defaultChecked={false}
            />
            <span style={{ color: '#e7e9ea' }}>Total</span>
          </label>
          <div className="search-container">
            <input
              ref={searchInputRef}
              type="text"
              className="strategy-search"
              placeholder="Search strategies..."
              defaultValue=""
              onKeyDown={handleSearchKeyDown}
            />
            <button
              className="search-clear-btn"
              onClick={() => {
                if (searchInputRef.current) {
                  searchInputRef.current.value = '';
                }
                setStrategySearch('');
              }}
              title="Clear search"
            >
              ×
            </button>
            <button
              className="search-btn"
              onClick={applySearch}
            >
              Search
            </button>
          </div>
          <button
            className="update-filters-btn"
            onClick={applyFilters}
          >
            Update
          </button>
        </div>
        <div className="strategy-checkboxes">
          {filteredStrategies.map((strategy) => {
            const originalIndex = strategies.indexOf(strategy);
            return (
              <label key={strategy} className="strategy-toggle">
                <input
                  ref={el => { strategyCheckboxRefs.current[strategy] = el; }}
                  type="checkbox"
                  defaultChecked={false}
                />
                <span style={{ color: STRATEGY_COLORS[originalIndex % STRATEGY_COLORS.length] }}>
                  {strategy}
                </span>
              </label>
            );
          })}
        </div>
      </div>
      <div className="chart-container-resizable" ref={resizeRef}>
        <ResponsiveContainer width="100%" height={chartHeight}>
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
            wrapperStyle={{ zIndex: 1000 }}
            content={<MultiColumnTooltip strategies={strategies} />}
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
        <div
          className={`resize-handle ${isResizing ? 'active' : ''}`}
          onMouseDown={handleMouseDown}
        >
          <div className="resize-handle-bar" />
        </div>
      </div>
    </div>
  );
}

export default CumulativePnLChart;
