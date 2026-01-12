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

function PnLDistributionChart({ data }) {
  if (!data || data.length === 0) {
    return <div className="no-data">No distribution data</div>;
  }

  return (
    <ResponsiveContainer width="100%" height={300}>
      <BarChart data={data} margin={{ top: 20, right: 30, left: 20, bottom: 20 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#30363d" />
        <XAxis
          dataKey="pnl"
          stroke="#8b949e"
          tickFormatter={(v) => `$${v}`}
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
          formatter={(value) => [value, 'Trades']}
          labelFormatter={(label) => `PnL: $${label}`}
        />
        <ReferenceLine x={0} stroke="#8b949e" />
        <Bar dataKey="count" name="Trades">
          {data.map((entry, index) => (
            <Cell
              key={`cell-${index}`}
              fill={entry.pnl >= 0 ? '#3fb950' : '#f85149'}
            />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

export default PnLDistributionChart;
