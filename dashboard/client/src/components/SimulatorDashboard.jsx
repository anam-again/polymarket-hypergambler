import { useState, useEffect, useCallback } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  BarChart,
  Bar,
  Cell
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

function SimulatorDashboard() {
  const [files, setFiles] = useState([]);
  const [selectedFile, setSelectedFile] = useState(null);
  const [stats, setStats] = useState(null);
  const [cumulativePnl, setCumulativePnl] = useState([]);
  const [pnlDistribution, setPnlDistribution] = useState([]);
  const [trades, setTrades] = useState([]);
  const [loading, setLoading] = useState(true);
  const [strategiesFilter, setStrategiesFilter] = useState('all');
  const [strategies, setStrategies] = useState([]);
  const [extendedData, setExtendedData] = useState(null);

  // Fetch list of simulator files
  const fetchFiles = useCallback(async () => {
    try {
      const res = await fetch('/api/simulator/files');
      const data = await res.json();
      setFiles(data);

      // Also fetch available strategies
      const stratRes = await fetch('/api/simulator/strategies');
      const stratData = await stratRes.json();
      setStrategies(stratData);
    } catch (error) {
      console.error('Failed to fetch simulator files:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch data for selected file
  const fetchFileData = useCallback(async (filename) => {
    if (!filename) return;

    setLoading(true);
    try {
      const [statsRes, cumulativeRes, distRes, tradesRes, extendedRes] = await Promise.all([
        fetch(`/api/simulator/file/${filename}/stats`),
        fetch(`/api/simulator/file/${filename}/cumulative-pnl`),
        fetch(`/api/simulator/file/${filename}/pnl-distribution`),
        fetch(`/api/simulator/file/${filename}/trades`),
        fetch(`/api/simulator/file/${filename}/extended`)
      ]);

      setStats(await statsRes.json());
      setCumulativePnl(await cumulativeRes.json());
      setPnlDistribution(await distRes.json());
      setTrades(await tradesRes.json());
      setExtendedData(await extendedRes.json());
    } catch (error) {
      console.error('Failed to fetch file data:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchFiles();
  }, [fetchFiles]);

  useEffect(() => {
    if (selectedFile) {
      fetchFileData(selectedFile);
    }
  }, [selectedFile, fetchFileData]);

  // Format timestamp for display
  const formatXAxis = (timestamp) => {
    const date = new Date(timestamp);
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit' });
  };

  // Filter files by strategy
  const filteredFiles = strategiesFilter === 'all'
    ? files
    : files.filter(f => f.strategy === strategiesFilter);

  // Format file display name
  const formatFileName = (file) => {
    const genText = file.generation ? ` (Gen ${file.generation})` : '';
    const date = new Date(file.modified);
    return `${file.strategy}${genText} - ${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
  };

  if (loading && files.length === 0) {
    return <div className="loading">Loading simulator data...</div>;
  }

  return (
    <div className="simulator-dashboard">
      <div className="simulator-header">
        <h2>Simulation Results</h2>
        <p className="simulator-description">
          View and analyze backtesting results from genetic optimization runs
        </p>
      </div>

      <div className="simulator-controls">
        <div className="filter-group">
          <label>Strategy:</label>
          <select
            value={strategiesFilter}
            onChange={(e) => setStrategiesFilter(e.target.value)}
          >
            <option value="all">All Strategies</option>
            {strategies.map(s => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>

        <div className="filter-group">
          <label>Simulation Run:</label>
          <select
            value={selectedFile || ''}
            onChange={(e) => setSelectedFile(e.target.value || null)}
          >
            <option value="">Select a simulation...</option>
            {filteredFiles.map(f => (
              <option key={f.filename} value={f.filename}>
                {formatFileName(f)}
              </option>
            ))}
          </select>
        </div>

        <button
          className="refresh-btn"
          onClick={fetchFiles}
          disabled={loading}
        >
          Refresh
        </button>
      </div>

      {!selectedFile && (
        <div className="simulator-file-list">
          <h3>Recent Simulations</h3>
          <table className="simulator-files-table">
            <thead>
              <tr>
                <th>Strategy</th>
                <th>Optimizer</th>
                <th>PnL</th>
                <th>Trades</th>
                <th>Date</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredFiles.slice(0, 20).map(file => (
                <tr key={file.filename}>
                  <td>{file.strategy}</td>
                  <td>{file.optimizer || file.generation ? `Gen ${file.generation}` : '-'}</td>
                  <td className={file.bestPnl >= 0 ? 'positive' : file.bestPnl < 0 ? 'negative' : ''}>
                    {file.bestPnl !== null && file.bestPnl !== undefined ? `$${file.bestPnl.toFixed(2)}` : '-'}
                  </td>
                  <td>{file.totalTrades || '-'}</td>
                  <td>{new Date(file.modified).toLocaleString()}</td>
                  <td>
                    <button
                      className="sim-view-btn"
                      onClick={() => setSelectedFile(file.filename)}
                    >
                      View
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {filteredFiles.length === 0 && (
            <p className="no-data">No simulation files found. Run a simulation first.</p>
          )}
        </div>
      )}

      {selectedFile && stats && (
        <>
          <div className="simulator-back">
            <button onClick={() => setSelectedFile(null)}>&larr; Back to list</button>
          </div>

          <div className="simulator-stats-grid">
            <div className="stat-card">
              <span className="stat-label">Strategy</span>
              <span className="stat-value">{stats.strategy}</span>
            </div>
            {(stats.generation || stats.optimizer) && (
              <div className="stat-card">
                <span className="stat-label">{stats.optimizer ? 'Optimizer' : 'Generation'}</span>
                <span className="stat-value">{stats.optimizer || stats.generation}</span>
              </div>
            )}
            <div className="stat-card">
              <span className="stat-label">Total PnL</span>
              <span className={`stat-value ${parseFloat(stats.totalPnl) >= 0 ? 'positive' : 'negative'}`}>
                ${stats.totalPnl}
              </span>
            </div>
            <div className="stat-card">
              <span className="stat-label">Win Rate</span>
              <span className="stat-value">{stats.winRate}%</span>
            </div>
            <div className="stat-card">
              <span className="stat-label">Total Trades</span>
              <span className="stat-value">{stats.completedTrades}</span>
            </div>
            <div className="stat-card">
              <span className="stat-label">Avg PnL</span>
              <span className={`stat-value ${parseFloat(stats.avgPnl) >= 0 ? 'positive' : 'negative'}`}>
                ${stats.avgPnl}
              </span>
            </div>
            <div className="stat-card">
              <span className="stat-label">Max Drawdown</span>
              <span className="stat-value negative">${stats.maxDrawdown}</span>
            </div>
            <div className="stat-card">
              <span className="stat-label">Sharpe Ratio</span>
              <span className="stat-value">{stats.sharpeRatio}</span>
            </div>
            <div className="stat-card">
              <span className="stat-label">Wins / Losses</span>
              <span className="stat-value">
                <span className="positive">{stats.winningTrades}</span>
                {' / '}
                <span className="negative">{stats.losingTrades}</span>
              </span>
            </div>
            <div className="stat-card">
              <span className="stat-label">Avg Win / Loss</span>
              <span className="stat-value">
                <span className="positive">${stats.avgWin}</span>
                {' / '}
                <span className="negative">${stats.avgLoss}</span>
              </span>
            </div>
          </div>

          {/* Bot Parameters Section */}
          {extendedData && extendedData.hasAvgStats && extendedData.avgStats?.params && (
            <div className="simulator-params">
              <h3>Bot Parameters</h3>
              <div className="params-grid">
                {Object.entries(extendedData.avgStats.params).map(([key, value]) => (
                  <div key={key} className="param-item">
                    <span className="param-name">{key}</span>
                    <span className="param-value">
                      {typeof value === 'number' ? value.toFixed(4) : String(value)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Top Trades Section */}
          {extendedData && extendedData.hasTopTrades && extendedData.topTrades && (
            <div className="simulator-top-trades">
              <h3>Top {extendedData.topTrades.count} Trades by PnL</h3>
              <div className="trades-table-container">
                <table className="trades-table">
                  <thead>
                    <tr>
                      <th>Rank</th>
                      <th>Time</th>
                      <th>Side</th>
                      <th>Price</th>
                      <th>Amount</th>
                      <th>Status</th>
                      <th>PnL</th>
                    </tr>
                  </thead>
                  <tbody>
                    {extendedData.topTrades.trades.map((trade) => (
                      <tr key={trade.rank}>
                        <td>#{trade.rank}</td>
                        <td>{new Date(trade.timestamp).toLocaleString()}</td>
                        <td>{trade.side}</td>
                        <td>${trade.price.toFixed(4)}</td>
                        <td>{trade.amount}</td>
                        <td>
                          <span className={`status-badge ${trade.status.toLowerCase()}`}>
                            {trade.status}
                          </span>
                        </td>
                        <td className={trade.pnl >= 0 ? 'positive' : 'negative'}>
                          ${trade.pnl.toFixed(2)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="simulator-charts">
            <div className="chart-card full-width">
              <h3>Cumulative PnL Over Simulation</h3>
              <ResponsiveContainer width="100%" height={350}>
                <LineChart data={cumulativePnl} margin={{ top: 20, right: 30, left: 20, bottom: 60 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#30363d" />
                  <XAxis
                    dataKey="timestamp"
                    stroke="#8b949e"
                    tick={{ fontSize: 11 }}
                    tickFormatter={formatXAxis}
                    angle={-45}
                    textAnchor="end"
                    height={80}
                  />
                  <YAxis stroke="#8b949e" />
                  <Tooltip
                    contentStyle={{ backgroundColor: '#1c2128', border: '1px solid #30363d' }}
                    labelFormatter={(ts) => new Date(ts).toLocaleString()}
                    formatter={(value) => [`$${value.toFixed(2)}`, 'Cumulative PnL']}
                  />
                  <ReferenceLine y={0} stroke="#8b949e" strokeDasharray="3 3" />
                  <Line
                    type="monotone"
                    dataKey="cumulative"
                    stroke="#1da1f2"
                    strokeWidth={2}
                    dot={false}
                    name="Cumulative PnL"
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>

            <div className="chart-card">
              <h3>PnL Distribution</h3>
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={pnlDistribution} margin={{ top: 20, right: 30, left: 20, bottom: 20 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#30363d" />
                  <XAxis
                    dataKey="pnl"
                    stroke="#8b949e"
                    tick={{ fontSize: 12 }}
                    label={{ value: 'PnL ($)', position: 'bottom', fill: '#8b949e' }}
                  />
                  <YAxis
                    stroke="#8b949e"
                    label={{ value: 'Count', angle: -90, position: 'insideLeft', fill: '#8b949e' }}
                  />
                  <Tooltip
                    contentStyle={{ backgroundColor: '#1c2128', border: '1px solid #30363d' }}
                    formatter={(value) => [value, 'Trades']}
                  />
                  <Bar dataKey="count" name="Trades">
                    {pnlDistribution.map((entry, index) => (
                      <Cell
                        key={`cell-${index}`}
                        fill={entry.pnl >= 0 ? '#3fb950' : '#f85149'}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="simulator-trades">
            <h3>Trade History ({trades.length} trades)</h3>
            <div className="trades-table-container">
              <table className="trades-table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Status</th>
                    <th>Side</th>
                    <th>Size</th>
                    <th>Price</th>
                    <th>PnL</th>
                  </tr>
                </thead>
                <tbody>
                  {trades.slice(0, 100).map((trade, i) => (
                    <tr key={i}>
                      <td>{new Date(trade.entryTimestamp).toLocaleString()}</td>
                      <td>
                        <span className={`status-badge ${trade.status.toLowerCase()}`}>
                          {trade.status}
                        </span>
                      </td>
                      <td>{trade.side}</td>
                      <td>{trade.size}</td>
                      <td>
                        {trade.buyPrice > 0 ? `$${trade.buyPrice.toFixed(2)}` : '-'}
                        {trade.sellPrice > 0 ? ` / $${trade.sellPrice.toFixed(2)}` : ''}
                      </td>
                      <td className={trade.pnl >= 0 ? 'positive' : 'negative'}>
                        ${trade.pnl.toFixed(2)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {trades.length > 100 && (
                <p className="trades-truncated">Showing first 100 of {trades.length} trades</p>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export default SimulatorDashboard;
