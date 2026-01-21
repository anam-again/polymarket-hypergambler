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

const WS_URL = 'ws://localhost:3001/ws';
const ONE_WEEK = 7 * 24 * 60 * 60 * 1000;

function App() {
  const [stats, setStats] = useState(null);
  const [cumulativePnl, setCumulativePnl] = useState([]);
  const [strategyPnl, setStrategyPnl] = useState([]);
  const [sideData, setSideData] = useState([]);
  const [strategies, setStrategies] = useState([]);
  const [selectedStrategy, setSelectedStrategy] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdate, setLastUpdate] = useState(null);
  const [wsConnected, setWsConnected] = useState(false);

  // View state - 'live' or 'simulator'
  const [activeView, setActiveView] = useState('live');

  // Time range state - default to past week, no end cap so new trades are always included
  const [startTime, setStartTime] = useState(() => Date.now() - ONE_WEEK);
  const [endTime, setEndTime] = useState(null);

  // Mode filter state - 'all', 'TEST', or 'PROD'
  const [mode, setMode] = useState('all');

  const wsRef = useRef(null);
  const reconnectTimeoutRef = useRef(null);
  const startTimeRef = useRef(startTime);
  const endTimeRef = useRef(endTime);
  const modeRef = useRef(mode);

  // Keep refs in sync
  useEffect(() => {
    startTimeRef.current = startTime;
    endTimeRef.current = endTime;
  }, [startTime, endTime]);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

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

      const [statsRes, cumulativeRes, strategyRes, sideRes, strategiesRes] = await Promise.all([
        fetch(buildUrlWithCurrentTime('/api/stats')),
        fetch(buildUrlWithCurrentTime('/api/cumulative-pnl')),
        fetch(buildUrlWithCurrentTime('/api/pnl-by-strategy')),
        fetch(buildUrlWithCurrentTime('/api/trades-by-side')),
        fetch(buildUrlWithCurrentTime('/api/strategies'))
      ]);

      setStats(await statsRes.json());
      setCumulativePnl(await cumulativeRes.json());
      setStrategyPnl(await strategyRes.json());
      setSideData(await sideRes.json());
      setStrategies(await strategiesRes.json());
      setLastUpdate(new Date());
    } catch (error) {
      console.error('Failed to fetch data:', error);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // Initial data fetch and refetch on time range change
  useEffect(() => {
    fetchData();
  }, [buildUrl, fetchData]);

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
            if (data.type === 'trade-update') {
              console.log('Trade update received, refreshing data...');
              fetchData(true);
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
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [fetchData]);

  const handleTimeRangeChange = (newStart, newEnd) => {
    setStartTime(newStart);
    setEndTime(newEnd);
    setSelectedStrategy(null);
  };

  const handleRefresh = () => {
    fetchData(true);
  };

  if (loading) {
    return <div className="loading">Loading dashboard...</div>;
  }

  return (
    <div className="dashboard">
      <div className="dashboard-header">
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
                className={`refresh-btn ${refreshing ? 'refreshing' : ''}`}
                onClick={handleRefresh}
                disabled={refreshing}
              >
                {refreshing ? 'Refreshing...' : 'Refresh'}
              </button>
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

          {stats && <StatsCards stats={stats} />}

          <LiveTrades mode={mode} />

          <LiveLogs mode={mode} />

          <div className="charts-grid">
            <div className="chart-card full-width">
              <h2>Cumulative PnL Over Time</h2>
              <CumulativePnLChart data={cumulativePnl} startTime={startTime} endTime={endTime} />
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
    </div>
  );
}

export default App;
