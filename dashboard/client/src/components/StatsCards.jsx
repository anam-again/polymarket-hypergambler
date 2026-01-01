function StatsCards({ stats }) {
  return (
    <div className="stats-grid">
      <div className="stat-card">
        <h3>Total Trades</h3>
        <div className="value">{stats.totalTrades}</div>
      </div>

      <div className="stat-card">
        <h3>Sold Trades</h3>
        <div className="value">{stats.soldTrades}</div>
      </div>

      <div className="stat-card">
        <h3>Expired Trades</h3>
        <div className="value">{stats.expiredTrades}</div>
      </div>

      <div className="stat-card">
        <h3>Total PnL</h3>
        <div className={`value ${parseFloat(stats.totalPnl) >= 0 ? 'positive' : 'negative'}`}>
          ${stats.totalPnl}
        </div>
      </div>

      <div className="stat-card">
        <h3>Win Rate</h3>
        <div className="value">{stats.winRate}%</div>
      </div>

      <div className="stat-card">
        <h3>Avg PnL</h3>
        <div className={`value ${parseFloat(stats.avgPnl) >= 0 ? 'positive' : 'negative'}`}>
          ${stats.avgPnl}
        </div>
      </div>

      <div className="stat-card">
        <h3>Winning Trades</h3>
        <div className="value positive">{stats.winningTrades}</div>
      </div>

      <div className="stat-card">
        <h3>Losing Trades</h3>
        <div className="value negative">{stats.losingTrades}</div>
      </div>
    </div>
  );
}

export default StatsCards;
