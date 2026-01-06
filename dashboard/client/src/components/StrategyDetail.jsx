import { useState, useEffect, useCallback } from 'react';
import CumulativePnLChart from './CumulativePnLChart';
import TradesTable from './TradesTable';
import PnLDistributionChart from './PnLDistributionChart';

function StrategyDetail({ strategy, startTime, endTime, mode }) {
  const [stats, setStats] = useState(null);
  const [cumulativePnl, setCumulativePnl] = useState([]);
  const [trades, setTrades] = useState([]);
  const [distribution, setDistribution] = useState([]);
  const [loading, setLoading] = useState(true);

  const buildUrl = useCallback((endpoint) => {
    const params = new URLSearchParams();
    if (startTime) params.append('startTime', startTime);
    if (endTime) params.append('endTime', endTime);
    if (mode && mode !== 'all') params.append('mode', mode);
    const query = params.toString();
    return query ? `${endpoint}?${query}` : endpoint;
  }, [startTime, endTime, mode]);

  useEffect(() => {
    if (!strategy) return;

    async function fetchStrategyData() {
      setLoading(true);
      try {
        const [statsRes, cumulativeRes, tradesRes, distRes] = await Promise.all([
          fetch(buildUrl(`/api/strategy/${encodeURIComponent(strategy)}/stats`)),
          fetch(buildUrl(`/api/strategy/${encodeURIComponent(strategy)}/cumulative-pnl`)),
          fetch(buildUrl(`/api/strategy/${encodeURIComponent(strategy)}/trades`)),
          fetch(buildUrl(`/api/strategy/${encodeURIComponent(strategy)}/pnl-distribution`))
        ]);

        setStats(await statsRes.json());
        setCumulativePnl(await cumulativeRes.json());
        setTrades(await tradesRes.json());
        setDistribution(await distRes.json());
      } catch (error) {
        console.error('Failed to fetch strategy data:', error);
      } finally {
        setLoading(false);
      }
    }

    fetchStrategyData();
  }, [strategy, buildUrl]);

  if (!strategy) {
    return null;
  }

  if (loading) {
    return <div className="loading">Loading strategy data...</div>;
  }

  return (
    <div className="strategy-detail">
      <h2 className="strategy-title">{strategy}</h2>

      {stats && (
        <div className="strategy-stats-grid">
          <div className="stat-card small">
            <h3>Total PnL</h3>
            <div className={`value ${parseFloat(stats.totalPnl) >= 0 ? 'positive' : 'negative'}`}>
              ${stats.totalPnl}
            </div>
          </div>
          <div className="stat-card small">
            <h3>Win Rate</h3>
            <div className="value">{stats.winRate}%</div>
          </div>
          <div className="stat-card small">
            <h3>Avg PnL</h3>
            <div className={`value ${parseFloat(stats.avgPnl) >= 0 ? 'positive' : 'negative'}`}>
              ${stats.avgPnl}
            </div>
          </div>
          <div className="stat-card small">
            <h3>Avg Win</h3>
            <div className="value positive">${stats.avgWin}</div>
          </div>
          <div className="stat-card small">
            <h3>Avg Loss</h3>
            <div className="value negative">${stats.avgLoss}</div>
          </div>
          <div className="stat-card small">
            <h3>Largest Win</h3>
            <div className="value positive">${stats.largestWin}</div>
          </div>
          <div className="stat-card small">
            <h3>Largest Loss</h3>
            <div className="value negative">${stats.largestLoss}</div>
          </div>
          <div className="stat-card small">
            <h3>W/L</h3>
            <div className="value">{stats.winningTrades}/{stats.losingTrades}</div>
          </div>
          <div className="stat-card small">
            <h3>Expired</h3>
            <div className="value">{stats.expiredTrades}</div>
          </div>
        </div>
      )}

      <div className="strategy-charts">
        <div className="chart-card">
          <h3>Cumulative PnL</h3>
          <CumulativePnLChart data={cumulativePnl} startTime={startTime} endTime={endTime} />
        </div>

        <div className="chart-card">
          <h3>PnL Distribution</h3>
          <PnLDistributionChart data={distribution} />
        </div>
      </div>

      <div className="chart-card full-width">
        <h3>Trade History</h3>
        <TradesTable trades={trades} />
      </div>
    </div>
  );
}

export default StrategyDetail;
