import { useState } from 'react';

const PRESETS = [
  { label: '24 Hours', value: 24 * 60 * 60 * 1000 },
  { label: '3 Days', value: 3 * 24 * 60 * 60 * 1000 },
  { label: '1 Week', value: 7 * 24 * 60 * 60 * 1000 },
  { label: '2 Weeks', value: 14 * 24 * 60 * 60 * 1000 },
  { label: '1 Month', value: 30 * 24 * 60 * 60 * 1000 },
  { label: 'All Time', value: null },
];

function TimeRangeSelector({ startTime, endTime, onRangeChange }) {
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');

  const handlePresetClick = (preset) => {
    if (preset.value === null) {
      onRangeChange(null, null);
    } else {
      const now = Date.now();
      // Don't set endTime for presets - this ensures new trades are always included
      onRangeChange(now - preset.value, null);
    }
  };

  const handleCustomApply = () => {
    const start = customStart ? new Date(customStart).getTime() : null;
    const end = customEnd ? new Date(customEnd).getTime() : null;
    onRangeChange(start, end);
  };

  const formatDate = (timestamp) => {
    if (!timestamp) return 'Now';
    return new Date(timestamp).toLocaleDateString();
  };

  const getActivePreset = () => {
    if (!startTime && !endTime) return 'All Time';
    if (!startTime) return 'Custom';
    // For presets, endTime is null and we check based on startTime offset from now
    const now = Date.now();
    const duration = now - startTime;
    const preset = PRESETS.find(p => p.value && Math.abs(p.value - duration) < 60000);
    return preset && !endTime ? preset.label : 'Custom';
  };

  return (
    <div className="time-range-selector">
      <div className="time-range-header">
        <span className="time-range-label">Time Range:</span>
        <span className="time-range-current">
          {startTime ? `${formatDate(startTime)} - ${formatDate(endTime)}` : 'All Time'}
        </span>
      </div>

      <div className="time-range-presets">
        {PRESETS.map((preset) => (
          <button
            key={preset.label}
            className={`preset-btn ${getActivePreset() === preset.label ? 'active' : ''}`}
            onClick={() => handlePresetClick(preset)}
          >
            {preset.label}
          </button>
        ))}
      </div>

      <div className="time-range-custom">
        <input
          type="datetime-local"
          value={customStart}
          onChange={(e) => setCustomStart(e.target.value)}
          placeholder="Start"
        />
        <span>to</span>
        <input
          type="datetime-local"
          value={customEnd}
          onChange={(e) => setCustomEnd(e.target.value)}
          placeholder="End"
        />
        <button className="apply-btn" onClick={handleCustomApply}>
          Apply
        </button>
      </div>
    </div>
  );
}

export default TimeRangeSelector;
