import {
  PieChart,
  Pie,
  Cell,
  Tooltip,
  ResponsiveContainer,
  Legend
} from 'recharts';

const COLORS = ['#1da1f2', '#9333ea'];

function SideDistributionChart({ data }) {
  return (
    <ResponsiveContainer width="100%" height={350}>
      <PieChart>
        <Pie
          data={data}
          cx="50%"
          cy="50%"
          innerRadius={60}
          outerRadius={100}
          dataKey="count"
          nameKey="side"
          label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
        >
          {data.map((entry, index) => (
            <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
          ))}
        </Pie>
        <Tooltip
          wrapperStyle={{ zIndex: 1000 }}
          contentStyle={{
            backgroundColor: '#1c2128',
            border: '1px solid #30363d',
            borderRadius: '8px'
          }}
          formatter={(value, name, props) => [
            `${value} trades ($${props.payload.pnl} PnL)`,
            props.payload.side
          ]}
        />
        <Legend />
      </PieChart>
    </ResponsiveContainer>
  );
}

export default SideDistributionChart;
