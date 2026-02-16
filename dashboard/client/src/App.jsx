import { useState, useEffect, useCallback, useRef } from 'react';
import StatsCards from './components/StatsCards';
import CumulativePnLChart from './components/CumulativePnLChart';
import StrategyPnLChart from './components/StrategyPnLChart';
import SideDistributionChart from './components/SideDistributionChart';
import StrategyWinRateChart from './components/StrategyWinRateChart';
import StrategySelector from './components/StrategySelector';
import StrategyDetail from './components/StrategyDetail';
import TimeRangeSelector from './components/TimeRangeSelector';
import LiveLogs from './components/LiveLogs';
import LiveTrades from './components/LiveTrades';
import SimulatorDashboard from './components/SimulatorDashboard';
import DancingStickFigure from './components/DancingStickFigure';

const WS_URL = 'ws://localhost:3001/ws';
const ONE_WEEK = 7 * 24 * 60 * 60 * 1000;

function App() {
  const [stats, setStats] = useState(null);
  const [cumulativePnl, setCumulativePnl] = useState([]);
  const [cumulativePnlByStrategy, setCumulativePnlByStrategy] = useState(null);
  const [strategyPnl, setStrategyPnl] = useState([]);
  const [sideData, setSideData] = useState([]);
  const [strategies, setStrategies] = useState([]);
  const [selectedStrategy, setSelectedStrategy] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdate, setLastUpdate] = useState(null);
  const [wsConnected, setWsConnected] = useState(false);

  // Running state - controls data fetching
  const [isRunning, setIsRunning] = useState(false);

  // View state - 'live' or 'simulator'
  const [activeView, setActiveView] = useState('live');

  // Time range state - default to past week, no end cap so new trades are always included
  const [startTime, setStartTime] = useState(() => Date.now() - ONE_WEEK);
  const [endTime, setEndTime] = useState(null);

  // Mode filter state - 'all', 'TEST', or 'PROD'
  const [mode, setMode] = useState('all');

  const wsRef = useRef(null);
  const reconnectTimeoutRef = useRef(null);
  const debounceTimeoutRef = useRef(null);
  const startTimeRef = useRef(startTime);
  const endTimeRef = useRef(endTime);
  const modeRef = useRef(mode);
  const isRunningRef = useRef(isRunning);

  // Keep refs in sync
  useEffect(() => {
    startTimeRef.current = startTime;
    endTimeRef.current = endTime;
  }, [startTime, endTime]);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  useEffect(() => {
    isRunningRef.current = isRunning;
  }, [isRunning]);

  const buildUrl = useCallback((endpoint) => {
    const params = new URLSearchParams();
    if (startTime) params.append('startTime', startTime);
    if (endTime) params.append('endTime', endTime);
    if (mode && mode !== 'all') params.append('mode', mode);
    const query = params.toString();
    return query ? `${endpoint}?${query}` : endpoint;
  }, [startTime, endTime, mode]);

  // Fetch data function - can be called for initial load, refresh, or WebSocket update
  const fetchData = useCallback(async (isRefresh = false) => {
    if (isRefresh) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }

    try {
      const buildUrlWithCurrentTime = (endpoint) => {
        const params = new URLSearchParams();
        if (startTimeRef.current) params.append('startTime', startTimeRef.current);
        if (endTimeRef.current) params.append('endTime', endTimeRef.current);
        if (modeRef.current && modeRef.current !== 'all') params.append('mode', modeRef.current);
        const query = params.toString();
        return query ? `${endpoint}?${query}` : endpoint;
      };

      const [statsRes, cumulativeRes, cumulativeByStrategyRes, strategyRes, sideRes, strategiesRes] = await Promise.all([
        fetch(buildUrlWithCurrentTime('/api/stats')),
        fetch(buildUrlWithCurrentTime('/api/cumulative-pnl')),
        fetch(buildUrlWithCurrentTime('/api/cumulative-pnl-by-strategy')),
        fetch(buildUrlWithCurrentTime('/api/pnl-by-strategy')),
        fetch(buildUrlWithCurrentTime('/api/trades-by-side')),
        fetch(buildUrlWithCurrentTime('/api/strategies'))
      ]);

      setStats(await statsRes.json());
      setCumulativePnl(await cumulativeRes.json());
      setCumulativePnlByStrategy(await cumulativeByStrategyRes.json());
      setStrategyPnl(await strategyRes.json());
      setSideData(await sideRes.json());
      const strategiesData = await strategiesRes.json();
      // Handle both old format (array) and new format (object with strategies/tags)
      setStrategies(Array.isArray(strategiesData) ? strategiesData : strategiesData.strategies);
      setLastUpdate(new Date());
    } catch (error) {
      console.error('Failed to fetch data:', error);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // Debounced version of fetchData for WebSocket updates (fallback when incremental update not possible)
  const debouncedFetchData = useCallback((isRefresh = false) => {
    if (debounceTimeoutRef.current) {
      clearTimeout(debounceTimeoutRef.current);
    }
    debounceTimeoutRef.current = setTimeout(() => {
      fetchData(isRefresh);
    }, 500);
  }, [fetchData]);

  // Handle incremental trade update from WebSocket
  const handleIncrementalUpdate = useCallback((data) => {
    const { trades: newTrades, stats: newStats } = data;

    if (!newTrades || newTrades.length === 0) return;

    // Filter trades by current time range and mode
    const filteredTrades = newTrades.filter(trade => {
      if (startTimeRef.current && trade.timestamp < startTimeRef.current) return false;
      if (endTimeRef.current && trade.timestamp > endTimeRef.current) return false;
      if (modeRef.current && modeRef.current !== 'all') {
        if (modeRef.current === 'PROD') {
          if (trade.mode !== 'PROD' && trade.mode !== 'ORDER') return false;
        } else if (trade.mode !== modeRef.current) {
          return false;
        }
      }
      return true;
    });

    if (filteredTrades.length === 0) return;

    // Update stats if provided
    if (newStats) {
      setStats(newStats);
    }

    // Append new trades to cumulative PnL data
    setCumulativePnl(prev => {
      const completedTrades = filteredTrades.filter(t => t.status === 'MATCHED' || t.status === 'EXPIRED');
      if (completedTrades.length === 0) return prev;

      let lastCumulative = prev.length > 0 ? prev[prev.length - 1].cumulative : 0;
      const newPoints = completedTrades.map(trade => {
        lastCumulative += trade.pnl;
        return {
          timestamp: trade.timestamp,
          date: new Date(trade.timestamp).toLocaleString(),
          pnl: trade.pnl,
          cumulative: parseFloat(lastCumulative.toFixed(2)),
          strategy: trade.strategy,
          status: trade.status
        };
      });

      return [...prev, ...newPoints];
    });

    // Update cumulative PnL by strategy (precomputed format for chart)
    setCumulativePnlByStrategy(prev => {
      if (!prev) return prev;
      const completedTrades = filteredTrades.filter(t => t.status === 'MATCHED' || t.status === 'EXPIRED');
      if (completedTrades.length === 0) return prev;

      // Clone the previous state
      const updated = {
        strategies: [...(prev.strategies || [])],
        points: [...(prev.points || [])],
        tags: prev.tags ? [...prev.tags] : []
      };

      // Get last cumulative values per strategy
      const lastPoint = updated.points.length > 0 ? updated.points[updated.points.length - 1] : null;
      const cumulativeByStrategy = lastPoint ? { ...lastPoint.strategies } : {};
      let totalCumulative = lastPoint ? lastPoint.total : 0;

      // Process each new trade
      completedTrades.forEach(trade => {
        if (!trade.strategy) return;

        // Add new strategy if not seen before
        if (!updated.strategies.includes(trade.strategy)) {
          updated.strategies.push(trade.strategy);
          updated.strategies.sort();
        }

        // Update cumulative values
        cumulativeByStrategy[trade.strategy] = (cumulativeByStrategy[trade.strategy] || 0) + trade.pnl;
        totalCumulative += trade.pnl;

        // Add new point
        updated.points.push({
          timestamp: trade.timestamp,
          total: parseFloat(totalCumulative.toFixed(2)),
          strategies: { ...cumulativeByStrategy }
        });
      });

      return updated;
    });

    // Update strategy PnL
    setStrategyPnl(prev => {
      const completedTrades = filteredTrades.filter(t => t.status === 'MATCHED' || t.status === 'EXPIRED');
      if (completedTrades.length === 0) return prev;

      const updated = [...prev];
      completedTrades.forEach(trade => {
        const existing = updated.find(s => s.strategy === trade.strategy);
        if (existing) {
          existing.pnl = parseFloat((existing.pnl + trade.pnl).toFixed(2));
          existing.trades++;
          if (trade.pnl > 0) existing.wins++;
          else existing.losses++;
          existing.winRate = ((existing.wins / existing.trades) * 100).toFixed(1);
        } else {
          updated.push({
            strategy: trade.strategy,
            pnl: parseFloat(trade.pnl.toFixed(2)),
            trades: 1,
            wins: trade.pnl > 0 ? 1 : 0,
            losses: trade.pnl <= 0 ? 1 : 0,
            winRate: trade.pnl > 0 ? '100.0' : '0.0'
          });
        }
      });
      return updated;
    });

    // Update side distribution
    setSideData(prev => {
      const completedTrades = filteredTrades.filter(t => t.status === 'MATCHED' || t.status === 'EXPIRED');
      if (completedTrades.length === 0) return prev;

      const updated = prev.map(s => ({ ...s }));
      completedTrades.forEach(trade => {
        const sideEntry = updated.find(s => s.side === trade.side);
        if (sideEntry) {
          sideEntry.count++;
          sideEntry.pnl = parseFloat((sideEntry.pnl + trade.pnl).toFixed(2));
        }
      });
      return updated;
    });

    // Update strategies list if new strategy appears
    setStrategies(prev => {
      const newStrategies = filteredTrades
        .map(t => t.strategy)
        .filter(s => s && !prev.includes(s));
      if (newStrategies.length === 0) return prev;
      return [...prev, ...newStrategies].sort();
    });

    setLastUpdate(new Date());
  }, []);

  // Data fetch when isRunning transitions to true or time range/mode changes while running
  useEffect(() => {
    if (isRunning) {
      fetchData();
    }
  }, [isRunning, buildUrl, fetchData]);

  // WebSocket connection for real-time trade updates
  useEffect(() => {
    function connect() {
      try {
        const ws = new WebSocket(WS_URL);
        wsRef.current = ws;

        ws.onopen = () => {
          console.log('Trade WebSocket connected');
          setWsConnected(true);
        };

        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            if (data.type === 'trade-update' && isRunningRef.current) {
              // Use incremental update if trade data is included
              if (data.trades && data.trades.length > 0) {
                console.log(`Trade update received: ${data.trades.length} new trade(s), applying incrementally`);
                handleIncrementalUpdate(data);
              } else {
                // Fallback to full refresh with debounce
                console.log('Trade update received, debouncing refresh...');
                debouncedFetchData(true);
              }
            }
          } catch (err) {
            // Ignore non-trade messages
          }
        };

        ws.onclose = () => {
          console.log('Trade WebSocket disconnected');
          setWsConnected(false);
          wsRef.current = null;
          reconnectTimeoutRef.current = setTimeout(connect, 3000);
        };

        ws.onerror = (error) => {
          console.error('Trade WebSocket error:', error);
          ws.close();
        };
      } catch (err) {
        console.error('Failed to create WebSocket:', err);
        reconnectTimeoutRef.current = setTimeout(connect, 3000);
      }
    }

    connect();

    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (debounceTimeoutRef.current) {
        clearTimeout(debounceTimeoutRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [debouncedFetchData, handleIncrementalUpdate]);

  const handleTimeRangeChange = (newStart, newEnd) => {
    setStartTime(newStart);
    setEndTime(newEnd);
    setSelectedStrategy(null);
  };

  const handleRefresh = () => {
    fetchData(true);
  };

  if (loading && isRunning) {
    return <div className="loading">Loading dashboard...</div>;
  }

  return (
    <div className="dashboard">
      <div className="dashboard-header">
        <DancingStickFigure />
        <h1>Dashboard</h1>
        <div className="dashboard-controls">
          <div className="view-toggle">
            <button
              className={`view-btn ${activeView === 'live' ? 'active' : ''}`}
              onClick={() => setActiveView('live')}
            >
              Live Trading
            </button>
            <button
              className={`view-btn ${activeView === 'simulator' ? 'active' : ''}`}
              onClick={() => setActiveView('simulator')}
            >
              Simulator
            </button>
          </div>
          {activeView === 'live' && (
            <>
              <div className="mode-toggle">
                <button
                  className={`mode-btn ${mode === 'all' ? 'active' : ''}`}
                  onClick={() => setMode('all')}
                >
                  All
                </button>
                <button
                  className={`mode-btn ${mode === 'TEST' ? 'active' : ''}`}
                  onClick={() => setMode('TEST')}
                >
                  Test
                </button>
                <button
                  className={`mode-btn ${mode === 'PROD' ? 'active' : ''}`}
                  onClick={() => setMode('PROD')}
                >
                  Prod
                </button>
              </div>
              <span className={`live-indicator ${wsConnected ? 'connected' : 'disconnected'}`}>
                {wsConnected ? 'Live' : 'Offline'}
              </span>
              {lastUpdate && (
                <span className="last-update">
                  Updated: {lastUpdate.toLocaleTimeString()}
                </span>
              )}
              <button
                className={`refresh-btn ${isRunning ? 'running' : 'stopped'}`}
                onClick={() => setIsRunning(!isRunning)}
              >
                {isRunning ? 'Stop' : 'Start'}
              </button>
              {isRunning && (
                <button
                  className={`refresh-btn ${refreshing ? 'refreshing' : ''}`}
                  onClick={handleRefresh}
                  disabled={refreshing}
                >
                  {refreshing ? 'Refreshing...' : 'Refresh'}
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {activeView === 'simulator' ? (
        <SimulatorDashboard />
      ) : (
        <>
          <TimeRangeSelector
            startTime={startTime}
            endTime={endTime}
            onRangeChange={handleTimeRangeChange}
          />

          {!isRunning && !stats ? (
            <div className="dashboard-stopped">
              <p>Dashboard is stopped. Click "Start" to load data.</p>
            </div>
          ) : (
            <>
              {stats && <StatsCards stats={stats} />}

              <LiveTrades mode={mode} />

              <LiveLogs mode={mode} />

              <div className="charts-grid">
                <div className="chart-card full-width">
                  <h2>Cumulative PnL Over Time</h2>
                  <CumulativePnLChart
                    data={cumulativePnl}
                    precomputedData={cumulativePnlByStrategy}
                    startTime={startTime}
                    endTime={endTime}
                  />
                </div>

                <div className="chart-card">
                  <h2>PnL by Strategy</h2>
                  <StrategyPnLChart data={strategyPnl} />
                </div>

                <div className="chart-card">
                  <h2>Strategy Win Rates</h2>
                  <StrategyWinRateChart data={strategyPnl} />
                </div>

                <div className="chart-card">
                  <h2>Trades by Side</h2>
                  <SideDistributionChart data={sideData} />
                </div>
              </div>

              <div className="strategy-section">
                <StrategySelector
                  strategies={strategies}
                  selected={selectedStrategy}
                  onSelect={setSelectedStrategy}
                />
                <StrategyDetail
                  strategy={selectedStrategy}
                  startTime={startTime}
                  endTime={endTime}
                  mode={mode}
                />
              </div>
            </>
          )}
        </>
      )}

      <div className="happen-image-container">
        <img src="/happen.jpg" alt="Happen" className="happen-image" />
      </div>
    </div>
  );
}

export default App;
