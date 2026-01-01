function TradesTable({ trades }) {
  const executedTrades = trades.filter(t => t.status === 'EXECUTED');

  if (executedTrades.length === 0) {
    return <div className="no-data">No trades found</div>;
  }

  return (
    <div className="trades-table-container">
      <table className="trades-table">
        <thead>
          <tr>
            <th>Date</th>
            <th>Trade ID</th>
            <th>Side</th>
            <th>Size</th>
            <th>Buy Price</th>
            <th>Sell Price</th>
            <th>PnL</th>
          </tr>
        </thead>
        <tbody>
          {executedTrades.map((trade, index) => (
            <tr key={`${trade.tradeId}-${index}`}>
              <td>{new Date(trade.timestamp).toLocaleString()}</td>
              <td className="trade-id">{trade.tradeId}</td>
              <td className={trade.side === 'BUY' ? 'buy' : 'sell'}>{trade.side}</td>
              <td>{trade.size}</td>
              <td>{trade.buyPrice === -1 ? '-' : trade.buyPrice.toFixed(2)}</td>
              <td>{trade.sellPrice === -1 ? '-' : trade.sellPrice.toFixed(2)}</td>
              <td className={trade.pnl >= 0 ? 'positive' : 'negative'}>
                ${trade.pnl.toFixed(2)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default TradesTable;
