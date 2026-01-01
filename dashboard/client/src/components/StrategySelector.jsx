function StrategySelector({ strategies, selected, onSelect }) {
  return (
    <div className="strategy-selector">
      <label htmlFor="strategy-select">Inspect Strategy:</label>
      <select
        id="strategy-select"
        value={selected || ''}
        onChange={(e) => onSelect(e.target.value || null)}
      >
        <option value="">-- Select a strategy --</option>
        {strategies.map((strategy) => (
          <option key={strategy} value={strategy}>
            {strategy}
          </option>
        ))}
      </select>
    </div>
  );
}

export default StrategySelector;
