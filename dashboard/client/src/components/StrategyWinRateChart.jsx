import { useState } from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell
} from 'recharts';

const ITEMS_PER_PAGE = 8;

function StrategyWinRateChart({ data }) {
  const [page, setPage] = useState(0);

  const chartData = data.map(d => ({
    ...d,
    winRate: parseFloat(d.winRate)
  }));

  const totalPages = Math.ceil(chartData.length / ITEMS_PER_PAGE);
  const needsPagination = chartData.length > ITEMS_PER_PAGE;

  const paginatedData = needsPagination
    ? chartData.slice(page * ITEMS_PER_PAGE, (page + 1) * ITEMS_PER_PAGE)
    : chartData;

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
          <YAxis stroke="#8b949e" domain={[0, 100]} tickFormatter={(v) => `${v}%`} />
          <Tooltip
            wrapperStyle={{ zIndex: 1000 }}
            contentStyle={{
              backgroundColor: '#1c2128',
              border: '1px solid #30363d',
              borderRadius: '8px'
            }}
            labelStyle={{ color: '#e7e9ea' }}
            formatter={(value, name) => [`${value}%`, 'Win Rate']}
          />
          <Bar dataKey="winRate" name="Win Rate">
            {paginatedData.map((entry, index) => (
              <Cell
                key={`cell-${index}`}
                fill={entry.winRate >= 50 ? '#3fb950' : '#f85149'}
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

export default StrategyWinRateChart;
