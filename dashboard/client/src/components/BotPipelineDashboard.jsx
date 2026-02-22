import { useState, useEffect, useCallback } from 'react';

const STATE_COLORS = {
  SIMULATED: '#79c0ff',
  TEST_RUNNING: '#1da1f2',
  TEST_EVALUATED: '#d29922',
  PROD_CANDIDATE: '#ffa657',
  PROD_RUNNING: '#3fb950',
  RETIRED: '#8b949e',
};

const STATE_LABELS = {
  SIMULATED: 'Simulated',
  TEST_RUNNING: 'Testing',
  TEST_EVALUATED: 'Evaluated',
  PROD_CANDIDATE: 'Prod Candidate',
  PROD_RUNNING: 'Production',
  RETIRED: 'Retired',
};

function formatTimestamp(ts) {
  if (!ts) return '-';
  return new Date(ts).toLocaleString();
}

function formatNumber(n, decimals = 2) {
  if (n === null || n === undefined) return '-';
  return Number(n).toFixed(decimals);
}

const SEVERITY_COLORS = {
  INFO: '#3fb950',
  WARN: '#d29922',
  ERROR: '#f85149',
};

const EVENT_TYPE_COLORS = {
  SIMULATION_COMPLETE: '#3fb950',
  SIMULATION_FAILED: '#f85149',
  BOT_PROMOTED_TO_TEST: '#1da1f2',
  BOT_EVALUATED: '#d29922',
  BOT_PROMOTED_TO_PROD_CANDIDATE: '#ffa657',
  BOT_APPROVED_FOR_PROD: '#3fb950',
  BOT_REJECTED: '#f85149',
  BOT_RETIRED: '#8b949e',
  STAGE_ERROR: '#f85149',
  STAGE_RUN_COMPLETE: '#79c0ff',
};

const COIN_COLORS = {
  BTC: '#f7931a',
  ETH: '#627eea',
  SOL: '#00ffa3',
  XRP: '#23292f',
};

const COIN_LABELS = {
  BTC: 'BTC',
  ETH: 'ETH',
  SOL: 'SOL',
  XRP: 'XRP',
};

function extractCoinFromMarket(market) {
  if (!market) return null;
  const m = market.toLowerCase();
  if (m.includes('bitcoin') || m.includes('btc')) return 'BTC';
  if (m.includes('ethereum') || m.includes('eth')) return 'ETH';
  if (m.includes('solana') || m.includes('sol')) return 'SOL';
  if (m.includes('xrp')) return 'XRP';
  return null;
}

function extractMarketType(market) {
  if (!market) return null;
  const m = market.toLowerCase();
  if (m.includes('hourly')) return 'Hourly';
  if (m.includes('quarterly')) return 'Quarterly';
  return null;
}

function CoinBadge({ coin }) {
  if (!coin) return null;
  return (
    <span
      style={{
        backgroundColor: COIN_COLORS[coin] || '#8b949e',
        color: coin === 'XRP' ? '#fff' : '#0d1117',
        padding: '1px 6px',
        borderRadius: '4px',
        fontSize: '0.7rem',
        fontWeight: 700,
        marginRight: '4px',
      }}
    >
      {COIN_LABELS[coin] || coin}
    </span>
  );
}

function formatDetailsJson(detailsJson) {
  if (!detailsJson) return null;
  try {
    const parsed = JSON.parse(detailsJson);
    return parsed;
  } catch {
    return { raw: detailsJson };
  }
}

function StateBadge({ state }) {
  return (
    <span
      className="pipeline-state-badge"
      style={{
        backgroundColor: STATE_COLORS[state] || '#8b949e',
        color: '#0d1117',
        padding: '2px 8px',
        borderRadius: '12px',
        fontSize: '0.75rem',
        fontWeight: 600,
      }}
    >
      {STATE_LABELS[state] || state}
    </span>
  );
}

function BotPipelineDashboard() {
  const [bots, setBots] = useState([]);
  const [summary, setSummary] = useState({ total: 0, byState: {} });
  const [stages, setStages] = useState([]);
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedBot, setSelectedBot] = useState(null);
  const [stateFilter, setStateFilter] = useState('all');
  const [actionLoading, setActionLoading] = useState(null);
  const [selectedEvent, setSelectedEvent] = useState(null);
  const [eventTypeFilter, setEventTypeFilter] = useState('all');
  const [eventLimit, setEventLimit] = useState(50);
  const [liveMetrics, setLiveMetrics] = useState({});

  const fetchData = useCallback(async (limit = eventLimit) => {
    try {
      const [botsRes, summaryRes, stagesRes, eventsRes, liveMetricsRes] = await Promise.all([
        fetch('/api/pipeline/bots'),
        fetch('/api/pipeline/summary'),
        fetch('/api/pipeline/stages'),
        fetch(`/api/pipeline/events?limit=${limit}`),
        fetch('/api/pipeline/live-metrics'),
      ]);

      setBots(await botsRes.json());
      setSummary(await summaryRes.json());
      setStages(await stagesRes.json());
      setEvents(await eventsRes.json());
      setLiveMetrics(await liveMetricsRes.json());
    } catch (error) {
      console.error('Failed to fetch pipeline data:', error);
    } finally {
      setLoading(false);
    }
  }, [eventLimit]);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const handleApprove = async (botId) => {
    setActionLoading(botId);
    try {
      const res = await fetch(`/api/pipeline/bot/${botId}/approve`, { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        await fetchData();
      } else {
        alert(data.error || 'Failed to approve bot');
      }
    } catch (err) {
      alert('Failed to approve bot: ' + err.message);
    } finally {
      setActionLoading(null);
    }
  };

  const handleReject = async (botId) => {
    const reason = prompt('Rejection reason (optional):');
    setActionLoading(botId);
    try {
      const res = await fetch(`/api/pipeline/bot/${botId}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: reason || 'Rejected via dashboard' }),
      });
      const data = await res.json();
      if (data.success) {
        await fetchData();
      } else {
        alert(data.error || 'Failed to reject bot');
      }
    } catch (err) {
      alert('Failed to reject bot: ' + err.message);
    } finally {
      setActionLoading(null);
    }
  };

  const handleRetire = async (botId) => {
    if (!confirm(`Retire bot ${botId}?`)) return;
    setActionLoading(botId);
    try {
      const res = await fetch(`/api/pipeline/bot/${botId}/retire`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'Force retired via dashboard' }),
      });
      const data = await res.json();
      if (data.success) {
        await fetchData();
      } else {
        alert(data.error || 'Failed to retire bot');
      }
    } catch (err) {
      alert('Failed to retire bot: ' + err.message);
    } finally {
      setActionLoading(null);
    }
  };

  const handleDelete = async (botId) => {
    if (!confirm(`Permanently delete bot ${botId}? This cannot be undone.`)) return;
    setActionLoading(botId);
    try {
      const res = await fetch(`/api/pipeline/bot/${botId}`, {
        method: 'DELETE',
      });
      const data = await res.json();
      if (data.success) {
        await fetchData();
      } else {
        alert(data.error || 'Failed to delete bot');
      }
    } catch (err) {
      alert('Failed to delete bot: ' + err.message);
    } finally {
      setActionLoading(null);
    }
  };

  const filteredBots = stateFilter === 'all'
    ? bots
    : bots.filter(b => b.state === stateFilter);

  const prodCandidates = bots.filter(b => b.state === 'PROD_CANDIDATE');

  if (loading) {
    return <div className="pipeline-loading">Loading pipeline data...</div>;
  }

  return (
    <div className="pipeline-dashboard">
      {/* Summary Cards */}
      <div className="stats-grid">
        <div className="stat-card">
          <h3>Total Bots</h3>
          <div className="value">{summary.total}</div>
        </div>
        {Object.entries(STATE_LABELS).map(([state, label]) => (
          <div key={state} className="stat-card" style={{ borderTop: `3px solid ${STATE_COLORS[state]}` }}>
            <h3>{label}</h3>
            <div className="value">{summary.byState[state] || 0}</div>
          </div>
        ))}
      </div>

      {/* Prod Approval Panel */}
      {prodCandidates.length > 0 && (
        <div className="pipeline-approval-panel">
          <h2 style={{ color: '#ffa657', marginBottom: '12px' }}>
            Awaiting Approval ({prodCandidates.length})
          </h2>
          <div className="pipeline-candidates">
            {prodCandidates.map(bot => (
              <div key={bot.botId} className="pipeline-candidate-card">
                <div className="candidate-header">
                  <strong>{bot.botId}</strong>
                  <span style={{ color: '#8b949e', fontSize: '0.85rem' }}>
                    <CoinBadge coin={extractCoinFromMarket(bot.market)} />
                    {bot.strategy} / {extractMarketType(bot.market)}
                  </span>
                </div>
                <div className="candidate-metrics">
                  <span>Sim PnL: <strong style={{ color: Number(bot.simPnl) >= 0 ? '#3fb950' : '#f85149' }}>${formatNumber(bot.simPnl)}</strong></span>
                  <span>Test PnL: <strong style={{ color: Number(bot.testPnl) >= 0 ? '#3fb950' : '#f85149' }}>${formatNumber(bot.testPnl)}</strong></span>
                  <span>Win Rate: <strong>{formatNumber(bot.testWinRate)}%</strong></span>
                  <span>Trades: <strong>{bot.testTradeCount || 0}</strong></span>
                </div>
                <div className="candidate-actions">
                  <button
                    className="approve-btn"
                    onClick={() => handleApprove(bot.botId)}
                    disabled={actionLoading === bot.botId}
                  >
                    {actionLoading === bot.botId ? '...' : 'Approve for Prod'}
                  </button>
                  <button
                    className="reject-btn"
                    onClick={() => handleReject(bot.botId)}
                    disabled={actionLoading === bot.botId}
                  >
                    Reject
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Pipeline Stages */}
      <div className="pipeline-section">
        <h2>Pipeline Stages</h2>
        <div className="pipeline-stages-grid">
          {stages.length === 0 ? (
            <p style={{ color: '#8b949e' }}>No pipeline stage data yet. Pipeline may not have run.</p>
          ) : (
            stages.map(stage => (
              <div key={stage.stageName} className="pipeline-stage-card">
                <h3>{stage.stageName}</h3>
                <div className="stage-info">
                  <span>Status: <strong style={{ color: stage.status === 'IDLE' ? '#3fb950' : stage.status === 'RUNNING' ? '#1da1f2' : '#f85149' }}>{stage.status}</strong></span>
                  <span>Runs: {stage.runCount}</span>
                  <span>Last: {formatTimestamp(stage.lastRunTimestamp)}</span>
                  {stage.lastError && <span style={{ color: '#f85149', fontSize: '0.8rem' }}>Error: {stage.lastError}</span>}
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Bot Lifecycle Table */}
      <div className="pipeline-section">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
          <h2>Bot Lifecycle</h2>
          <div className="pipeline-filter">
            <select
              value={stateFilter}
              onChange={e => setStateFilter(e.target.value)}
              style={{ background: '#21262d', color: '#c9d1d9', border: '1px solid #30363d', borderRadius: '6px', padding: '4px 8px' }}
            >
              <option value="all">All States</option>
              {Object.entries(STATE_LABELS).map(([state, label]) => (
                <option key={state} value={state}>{label}</option>
              ))}
            </select>
            <button onClick={fetchData} style={{ marginLeft: '8px', padding: '4px 12px', background: '#21262d', color: '#c9d1d9', border: '1px solid #30363d', borderRadius: '6px', cursor: 'pointer' }}>
              Refresh
            </button>
          </div>
        </div>

        {filteredBots.length === 0 ? (
          <p style={{ color: '#8b949e' }}>No bots found. The pipeline will populate this as it runs simulations.</p>
        ) : (
          <div className="pipeline-table-container">
            <table className="pipeline-table">
              <thead>
                <tr>
                  <th>Bot ID</th>
                  <th>Strategy</th>
                  <th>Market</th>
                  <th>State</th>
                  <th>Sim PnL</th>
                  <th>Test PnL</th>
                  <th>Prod PnL</th>
                  <th>Updated</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredBots.map(bot => (
                  <tr
                    key={bot.botId}
                    className={selectedBot === bot.botId ? 'selected' : ''}
                    onClick={() => setSelectedBot(selectedBot === bot.botId ? null : bot.botId)}
                    style={{ cursor: 'pointer' }}
                  >
                    <td style={{ fontFamily: 'monospace', fontSize: '0.8rem' }}>{bot.botId}</td>
                    <td>{bot.strategy}</td>
                    <td>
                      <CoinBadge coin={extractCoinFromMarket(bot.market)} />
                      <span style={{ fontSize: '0.8rem' }}>{extractMarketType(bot.market)}</span>
                    </td>
                    <td><StateBadge state={bot.state} /></td>
                    <td style={{ color: Number(bot.simPnl) >= 0 ? '#3fb950' : '#f85149' }}>${formatNumber(bot.simPnl)}</td>
                    <td style={{ color: (liveMetrics[bot.botId]?.pnl ?? bot.testPnl ?? 0) >= 0 ? '#3fb950' : '#f85149' }}>
                      {bot.state === 'TEST_RUNNING' && liveMetrics[bot.botId] ? (
                        <span title="Live metrics from trade_audits">
                          ${formatNumber(liveMetrics[bot.botId].pnl)}
                          <span style={{ fontSize: '0.65rem', color: '#1da1f2', marginLeft: '3px' }}>LIVE</span>
                        </span>
                      ) : bot.testPnl != null ? `$${formatNumber(bot.testPnl)}` : '-'}
                    </td>
                    <td style={{ color: (liveMetrics[bot.botId]?.pnl ?? bot.prodPnl ?? 0) >= 0 ? '#3fb950' : '#f85149' }}>
                      {bot.state === 'PROD_RUNNING' && liveMetrics[bot.botId] ? (
                        <span title="Live metrics from trade_audits">
                          ${formatNumber(liveMetrics[bot.botId].pnl)}
                          <span style={{ fontSize: '0.65rem', color: '#3fb950', marginLeft: '3px' }}>LIVE</span>
                        </span>
                      ) : bot.prodPnl != null ? `$${formatNumber(bot.prodPnl)}` : '-'}
                    </td>
                    <td style={{ fontSize: '0.8rem', color: '#8b949e' }}>{formatTimestamp(bot.updatedAt)}</td>
                    <td>
                      {(bot.state === 'TEST_RUNNING' || bot.state === 'PROD_RUNNING') && (
                        <button
                          className="retire-btn"
                          onClick={(e) => { e.stopPropagation(); handleRetire(bot.botId); }}
                          disabled={actionLoading === bot.botId}
                          style={{ fontSize: '0.75rem', padding: '2px 8px' }}
                        >
                          Retire
                        </button>
                      )}
                      {bot.state === 'PROD_CANDIDATE' && (
                        <>
                          <button
                            className="approve-btn"
                            onClick={(e) => { e.stopPropagation(); handleApprove(bot.botId); }}
                            disabled={actionLoading === bot.botId}
                            style={{ fontSize: '0.75rem', padding: '2px 8px', marginRight: '4px' }}
                          >
                            Approve
                          </button>
                          <button
                            className="reject-btn"
                            onClick={(e) => { e.stopPropagation(); handleReject(bot.botId); }}
                            disabled={actionLoading === bot.botId}
                            style={{ fontSize: '0.75rem', padding: '2px 8px' }}
                          >
                            Reject
                          </button>
                        </>
                      )}
                      {bot.state === 'RETIRED' && (
                        <button
                          className="delete-btn"
                          onClick={(e) => { e.stopPropagation(); handleDelete(bot.botId); }}
                          disabled={actionLoading === bot.botId}
                          style={{
                            fontSize: '0.75rem',
                            padding: '2px 8px',
                            background: '#21262d',
                            color: '#f85149',
                            border: '1px solid #f85149',
                            borderRadius: '4px',
                            cursor: 'pointer',
                          }}
                        >
                          {actionLoading === bot.botId ? '...' : 'Delete'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Expanded bot detail */}
        {selectedBot && (() => {
          const bot = bots.find(b => b.botId === selectedBot);
          if (!bot) return null;
          return (
            <div className="pipeline-bot-detail">
              <h3>Bot Details: {bot.botId}</h3>
              <div className="bot-detail-grid">
                <div><strong>Strategy:</strong> {bot.strategy}</div>
                <div><strong>Market:</strong> <CoinBadge coin={extractCoinFromMarket(bot.market)} /> {extractMarketType(bot.market)}</div>
                <div><strong>State:</strong> <StateBadge state={bot.state} /></div>
                <div><strong>Created:</strong> {formatTimestamp(bot.createdAt)}</div>
                <div><strong>Updated:</strong> {formatTimestamp(bot.updatedAt)}</div>
                <div><strong>Sim PnL:</strong> ${formatNumber(bot.simPnl)}</div>
                <div><strong>Sim Sharpe:</strong> {formatNumber(bot.simSharpe)}</div>
                <div><strong>Sim Win Rate:</strong> {formatNumber(bot.simWinRate)}%</div>
                <div><strong>Test PnL:</strong> {bot.state === 'TEST_RUNNING' && liveMetrics[bot.botId] ? (
                  <span style={{ color: liveMetrics[bot.botId].pnl >= 0 ? '#3fb950' : '#f85149' }}>
                    ${formatNumber(liveMetrics[bot.botId].pnl)} <span style={{ fontSize: '0.7rem', color: '#1da1f2' }}>LIVE</span>
                  </span>
                ) : bot.testPnl != null ? `$${formatNumber(bot.testPnl)}` : '-'}</div>
                <div><strong>Test Win Rate:</strong> {bot.state === 'TEST_RUNNING' && liveMetrics[bot.botId] ? (
                  <span>{formatNumber(liveMetrics[bot.botId].winRate)}% <span style={{ fontSize: '0.7rem', color: '#1da1f2' }}>LIVE</span></span>
                ) : bot.testWinRate != null ? `${formatNumber(bot.testWinRate)}%` : '-'}</div>
                <div><strong>Test Trade Count:</strong> {bot.state === 'TEST_RUNNING' && liveMetrics[bot.botId] ? (
                  <span>{liveMetrics[bot.botId].tradeCount} <span style={{ fontSize: '0.7rem', color: '#1da1f2' }}>LIVE</span></span>
                ) : bot.testTradeCount || '-'}</div>
                <div><strong>Prod PnL:</strong> {bot.state === 'PROD_RUNNING' && liveMetrics[bot.botId] ? (
                  <span style={{ color: liveMetrics[bot.botId].pnl >= 0 ? '#3fb950' : '#f85149' }}>
                    ${formatNumber(liveMetrics[bot.botId].pnl)} <span style={{ fontSize: '0.7rem', color: '#3fb950' }}>LIVE</span>
                  </span>
                ) : bot.prodPnl != null ? `$${formatNumber(bot.prodPnl)}` : '-'}</div>
                <div><strong>Prod Win Rate:</strong> {bot.state === 'PROD_RUNNING' && liveMetrics[bot.botId] ? (
                  <span>{formatNumber(liveMetrics[bot.botId].winRate)}% <span style={{ fontSize: '0.7rem', color: '#3fb950' }}>LIVE</span></span>
                ) : bot.prodWinRate != null ? `${formatNumber(bot.prodWinRate)}%` : '-'}</div>
                {bot.retirementReason && <div style={{ gridColumn: '1 / -1', color: '#f85149' }}><strong>Retirement Reason:</strong> {bot.retirementReason}</div>}
              </div>
            </div>
          );
        })()}
      </div>

      {/* Events Timeline */}
      <div className="pipeline-section">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px', flexWrap: 'wrap', gap: '8px' }}>
          <h2 style={{ margin: 0 }}>Recent Events ({events.length})</h2>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <select
              value={eventTypeFilter}
              onChange={e => setEventTypeFilter(e.target.value)}
              style={{ background: '#21262d', color: '#c9d1d9', border: '1px solid #30363d', borderRadius: '6px', padding: '4px 8px' }}
            >
              <option value="all">All Event Types</option>
              {Object.keys(EVENT_TYPE_COLORS).map(type => (
                <option key={type} value={type}>{type}</option>
              ))}
            </select>
            <select
              value={eventLimit}
              onChange={e => { setEventLimit(Number(e.target.value)); fetchData(Number(e.target.value)); }}
              style={{ background: '#21262d', color: '#c9d1d9', border: '1px solid #30363d', borderRadius: '6px', padding: '4px 8px' }}
            >
              <option value={50}>Last 50</option>
              <option value={100}>Last 100</option>
              <option value={200}>Last 200</option>
              <option value={500}>Last 500</option>
            </select>
          </div>
        </div>
        {events.length === 0 ? (
          <p style={{ color: '#8b949e' }}>No pipeline events yet.</p>
        ) : (
          <div className="pipeline-events">
            {events
              .filter(e => eventTypeFilter === 'all' || e.eventType === eventTypeFilter)
              .map((event, i) => {
                const isSelected = selectedEvent === i;
                const details = formatDetailsJson(event.detailsJson);
                const coin = details?.market ? extractCoinFromMarket(details.market) : null;
                const marketType = details?.market ? extractMarketType(details.market) : null;
                const strategy = details?.strategy || null;
                return (
                  <div key={i}>
                    <div
                      className={`pipeline-event ${isSelected ? 'selected' : ''}`}
                      onClick={() => setSelectedEvent(isSelected ? null : i)}
                      style={{
                        cursor: 'pointer',
                        borderLeft: `3px solid ${SEVERITY_COLORS[event.severity] || '#8b949e'}`,
                        paddingLeft: '8px',
                        background: isSelected ? '#21262d' : 'transparent',
                        borderRadius: '4px',
                        marginBottom: '2px',
                      }}
                    >
                      <span className="event-time" style={{ color: '#8b949e', fontSize: '0.8rem', marginRight: '8px' }}>
                        {formatTimestamp(event.timestamp)}
                      </span>
                      <span className="event-stage" style={{ color: '#79c0ff', marginRight: '8px' }}>
                        [{event.stageName}]
                      </span>
                      <span
                        className="event-type"
                        style={{
                          color: EVENT_TYPE_COLORS[event.eventType] || '#c9d1d9',
                          fontWeight: 600,
                          marginRight: '8px',
                        }}
                      >
                        {event.eventType}
                      </span>
                      {coin && (
                        <span style={{ marginRight: '6px' }}>
                          <CoinBadge coin={coin} />
                          {marketType && (
                            <span style={{ color: '#8b949e', fontSize: '0.7rem' }}>{marketType}</span>
                          )}
                        </span>
                      )}
                      {strategy && (
                        <span style={{ color: '#a5d6ff', fontSize: '0.8rem', marginRight: '8px' }}>
                          {strategy}
                        </span>
                      )}
                      {event.botId && (
                        <span className="event-bot" style={{ color: '#d29922', fontFamily: 'monospace', fontSize: '0.75rem' }}>
                          {event.botId}
                        </span>
                      )}
                      {event.detailsJson && !isSelected && (
                        <span style={{ color: '#6e7681', marginLeft: '8px', fontSize: '0.75rem' }}>
                          (click to expand)
                        </span>
                      )}
                    </div>
                    {isSelected && details && (
                      <div
                        className="event-details-expanded"
                        style={{
                          background: '#161b22',
                          border: '1px solid #30363d',
                          borderRadius: '6px',
                          padding: '12px',
                          marginTop: '4px',
                          marginBottom: '8px',
                          marginLeft: '11px',
                        }}
                      >
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '8px' }}>
                          {Object.entries(details).map(([key, value]) => (
                            <div key={key} style={{ fontSize: '0.85rem' }}>
                              <span style={{ color: '#79c0ff' }}>{key}: </span>
                              <span style={{
                                color: typeof value === 'number'
                                  ? (key.toLowerCase().includes('pnl') && value >= 0 ? '#3fb950' : key.toLowerCase().includes('pnl') && value < 0 ? '#f85149' : '#c9d1d9')
                                  : '#c9d1d9',
                                fontFamily: typeof value === 'number' ? 'monospace' : 'inherit',
                              }}>
                                {typeof value === 'number'
                                  ? (key.toLowerCase().includes('pnl') ? `$${value.toFixed(2)}` :
                                     key.toLowerCase().includes('rate') || key.toLowerCase().includes('sharpe') ? value.toFixed(2) : value)
                                  : String(value)}
                              </span>
                            </div>
                          ))}
                        </div>
                        <div style={{ marginTop: '8px', paddingTop: '8px', borderTop: '1px solid #30363d' }}>
                          <details>
                            <summary style={{ cursor: 'pointer', color: '#8b949e', fontSize: '0.75rem' }}>Raw JSON</summary>
                            <pre style={{ fontSize: '0.75rem', color: '#8b949e', margin: '8px 0 0 0', overflow: 'auto' }}>
                              {JSON.stringify(details, null, 2)}
                            </pre>
                          </details>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
          </div>
        )}
      </div>
    </div>
  );
}

export default BotPipelineDashboard;
