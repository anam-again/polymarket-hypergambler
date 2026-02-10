import { useState, useEffect, useRef, useCallback } from 'react';

const WS_URL = 'ws://localhost:3001/ws';

function LiveTrades({ mode }) {
  const [isActive, setIsActive] = useState(false);
  const [trades, setTrades] = useState({ orders: [], positions: [], lastUpdated: null });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [wsConnected, setWsConnected] = useState(false);
  const wsRef = useRef(null);
  const pollIntervalRef = useRef(null);
  const wsConnectedRef = useRef(false);

  const fetchLiveTrades = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (mode && mode !== 'all') params.append('mode', mode);
      const query = params.toString();
      const url = query ? `/api/live-trades?${query}` : '/api/live-trades';

      const res = await fetch(url);
      const data = await res.json();
      setTrades(data);
      setError(null);
    } catch (err) {
      setError('Failed to fetch live trades');
      console.error('Failed to fetch live trades:', err);
    }
  }, [mode]);

  // Start/stop polling based on WebSocket connection status
  const updatePolling = useCallback(() => {
    if (wsConnectedRef.current) {
      // WebSocket connected - stop polling
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    } else {
      // WebSocket disconnected - start polling as fallback
      if (!pollIntervalRef.current) {
        pollIntervalRef.current = setInterval(fetchLiveTrades, 5000);
      }
    }
  }, [fetchLiveTrades]);

  const startTracking = useCallback(() => {
    setLoading(true);
    setIsActive(true);

    // Initial fetch
    fetchLiveTrades().finally(() => setLoading(false));

    // Connect WebSocket for real-time updates
    try {
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'subscribe-live-trades' }));
        wsConnectedRef.current = true;
        setWsConnected(true);
        updatePolling();
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'trade-update' || data.type === 'log-update') {
            // Refresh data on trade updates
            fetchLiveTrades();
          }
        } catch (err) {
          // Ignore
        }
      };

      ws.onclose = () => {
        wsRef.current = null;
        wsConnectedRef.current = false;
        setWsConnected(false);
        updatePolling();
      };

      ws.onerror = () => {
        ws.close();
      };
    } catch (err) {
      console.error('WebSocket connection failed:', err);
      // Start polling as fallback when WS fails
      updatePolling();
    }
  }, [fetchLiveTrades, updatePolling]);

  const stopTracking = useCallback(() => {
    setIsActive(false);

    // Clear polling interval
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }

    // Disconnect WebSocket
    if (wsRef.current) {
      wsRef.current.send(JSON.stringify({ type: 'unsubscribe-live-trades' }));
      wsRef.current.close();
      wsRef.current = null;
    }
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, []);

  // Refetch when mode changes if active
  useEffect(() => {
    if (isActive) {
      fetchLiveTrades();
    }
  }, [mode, isActive, fetchLiveTrades]);

  const formatPrice = (price) => {
    return price.toFixed(2);
  };

  const formatAmount = (amount) => {
    return amount.toFixed(2);
  };

  const formatTime = (timestamp) => {
    return new Date(timestamp).toLocaleTimeString();
  };

  const calculatePnL = (order) => {
    // PnL calculation: For now, just show unrealized based on purchase price
    // In a real scenario, you'd need current market price
    // For BUY orders: pnl = (currentPrice - buyPrice) * amount
    // For SELL orders: pnl = (sellPrice - currentPrice) * amount
    // Since we don't have real-time prices yet, we'll show the cost basis
    return -(order.price * order.amount); // Shows as negative (money spent)
  };

  return (
    <div className="live-trades-container">
      <div className="live-trades-header">
        <h3>Live Trades</h3>
        <div className="live-trades-controls">
          {!isActive ? (
            <button
              className="start-btn"
              onClick={startTracking}
              disabled={loading}
            >
              {loading ? 'Starting...' : 'Start Tracking'}
            </button>
          ) : (
            <button
              className="stop-btn"
              onClick={stopTracking}
            >
              Stop Tracking
            </button>
          )}
          {isActive && trades.lastUpdated && (
            <span className="last-updated">
              Updated: {formatTime(trades.lastUpdated)}
            </span>
          )}
        </div>
      </div>

      {error && <div className="error-message">{error}</div>}

      {!isActive ? (
        <div className="live-trades-inactive">
          <p>Click "Start Tracking" to view current open positions</p>
        </div>
      ) : loading ? (
        <div className="loading">Loading live trades...</div>
      ) : trades.orders.length === 0 ? (
        <div className="no-trades">No open positions</div>
      ) : (
        <>
          {/* Positions Summary */}
          {trades.positions.length > 0 && (
            <div className="positions-summary">
              <h4>Position Summary</h4>
              <table className="positions-table">
                <thead>
                  <tr>
                    <th>Token</th>
                    <th>Side</th>
                    <th>Total Amount</th>
                    <th>Avg Price</th>
                    <th>Total Cost</th>
                    <th>Market</th>
                  </tr>
                </thead>
                <tbody>
                  {trades.positions.map((pos, idx) => (
                    <tr key={idx}>
                      <td className="token-cell" title={pos.tokenId}>
                        {pos.tokenId.length > 20 ? pos.tokenId.substring(0, 20) + '...' : pos.tokenId}
                      </td>
                      <td className={`side-cell ${pos.side.toLowerCase()}`}>{pos.side}</td>
                      <td>{formatAmount(pos.totalAmount)}</td>
                      <td>${formatPrice(pos.avgPrice)}</td>
                      <td>${formatPrice(pos.totalCost)}</td>
                      <td>
                        {pos.marketUrl ? (
                          <a
                            href={pos.marketUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="market-link"
                          >
                            View
                          </a>
                        ) : (
                          <span className="no-link">-</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Individual Orders */}
          <div className="orders-detail">
            <h4>Open Orders ({trades.orders.length})</h4>
            <table className="orders-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Strategy</th>
                  <th>Side</th>
                  <th>Amount</th>
                  <th>Buy Price</th>
                  <th>Cost Basis</th>
                  <th>Market</th>
                </tr>
              </thead>
              <tbody>
                {trades.orders.map((order, idx) => (
                  <tr key={idx}>
                    <td>{formatTime(order.timestamp)}</td>
                    <td>{order.source}</td>
                    <td className={`side-cell ${order.side.toLowerCase()}`}>{order.side}</td>
                    <td>{formatAmount(order.amount)}</td>
                    <td>${formatPrice(order.price)}</td>
                    <td className="cost-basis">${formatPrice(order.price * order.amount)}</td>
                    <td>
                      {order.marketUrl ? (
                        <a
                          href={order.marketUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="market-link"
                        >
                          View
                        </a>
                      ) : (
                        <span className="no-link">-</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

export default LiveTrades;
