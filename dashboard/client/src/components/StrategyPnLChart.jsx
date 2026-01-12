import { useState } from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
  ReferenceLine
} from 'recharts';

const ITEMS_PER_PAGE = 8;

function StrategyPnLChart({ data }) {
  const [page, setPage] = useState(0);

  const totalPages = Math.ceil(data.length / ITEMS_PER_PAGE);
  const needsPagination = data.length > ITEMS_PER_PAGE;

  const paginatedData = needsPagination
    ? data.slice(page * ITEMS_PER_PAGE, (page + 1) * ITEMS_PER_PAGE)
    : data;

  const handlePrev = () => setPage(p => Math.max(0, p - 1));
  const handleNext = () => setPage(p => Math.min(totalPages - 1, p + 1));

  return (
    <div className="paginated-chart">
      <ResponsiveContainer width="100%" height={350}>
        <BarChart data={paginatedData} margin={{ top: 20, right: 30, left: 20, bottom: 80 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#30363d" />
          <XAxis
            dataKey="strategy"
            stroke="#8b949e"
            tick={{ fontSize: 11 }}
            angle={-45}
            textAnchor="end"
            interval={0}
          />
          <YAxis stroke="#8b949e" />
          <Tooltip
            wrapperStyle={{ zIndex: 1000 }}
            contentStyle={{
              backgroundColor: '#1c2128',
              border: '1px solid #30363d',
              borderRadius: '8px'
            }}
            labelStyle={{ color: '#e7e9ea' }}
            formatter={(value) => [`$${value}`, 'PnL']}
          />
          <ReferenceLine y={0} stroke="#8b949e" />
          <Bar dataKey="pnl" name="PnL">
            {paginatedData.map((entry, index) => (
              <Cell
                key={`cell-${index}`}
                fill={entry.pnl >= 0 ? '#3fb950' : '#f85149'}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      {needsPagination && (
        <div className="chart-pagination">
          <button onClick={handlePrev} disabled={page === 0}>Prev</button>
          <span>{page + 1} / {totalPages}</span>
          <button onClick={handleNext} disabled={page === totalPages - 1}>Next</button>
        </div>
      )}
    </div>
  );
}

export default StrategyPnLChart;
