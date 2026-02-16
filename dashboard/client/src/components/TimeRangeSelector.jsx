import { useState } from 'react';

const PRESETS = [
  { label: '3 Hours', value: 3 * 60 * 60 * 1000 },
  { label: '6 Hours', value: 6 * 60 * 60 * 1000 },
  { label: '12 Hours', value: 12 * 60 * 60 * 1000 },
  { label: '24 Hours', value: 24 * 60 * 60 * 1000 },
  { label: '3 Days', value: 3 * 24 * 60 * 60 * 1000 },
  { label: '1 Week', value: 7 * 24 * 60 * 60 * 1000 },
  { label: '2 Weeks', value: 14 * 24 * 60 * 60 * 1000 },
  { label: '1 Month', value: 30 * 24 * 60 * 60 * 1000 },
  { label: '±1 Hour', value: 1 * 60 * 60 * 1000, centered: true },
  { label: '±3 Hours', value: 3 * 60 * 60 * 1000, centered: true },
  { label: '±6 Hours', value: 6 * 60 * 60 * 1000, centered: true },
  { label: '-1h/+3h', startOffset: 1 * 60 * 60 * 1000, endOffset: 3 * 60 * 60 * 1000 },
  { label: 'All Time', value: null },
];

function TimeRangeSelector({ startTime, endTime, onRangeChange }) {
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');

  const handlePresetClick = (preset) => {
    if (preset.value === null) {
      onRangeChange(null, null);
    } else if (preset.startOffset !== undefined && preset.endOffset !== undefined) {
      // Asymmetric ranges: -startOffset to +endOffset from now
      const now = Date.now();
      onRangeChange(now - preset.startOffset, now + preset.endOffset);
    } else if (preset.centered) {
      // Centered ranges: -N hours to +N hours from now
      const now = Date.now();
      onRangeChange(now - preset.value, now + preset.value);
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
    const now = Date.now();
    const duration = now - startTime;

    // Check for centered or asymmetric presets (have both start and end time)
    if (endTime) {
      const endDuration = endTime - now;

      // Check asymmetric presets first
      const asymmetricPreset = PRESETS.find(p =>
        p.startOffset !== undefined && p.endOffset !== undefined &&
        Math.abs(p.startOffset - duration) < 60000 &&
        Math.abs(p.endOffset - endDuration) < 60000
      );
      if (asymmetricPreset) return asymmetricPreset.label;

      // Check centered presets
      const centeredPreset = PRESETS.find(p =>
        p.centered && p.value &&
        Math.abs(p.value - duration) < 60000 &&
        Math.abs(p.value - endDuration) < 60000
      );
      if (centeredPreset) return centeredPreset.label;
      return 'Custom';
    }

    // For regular presets, endTime is null and we check based on startTime offset from now
    const preset = PRESETS.find(p => p.value && !p.centered && Math.abs(p.value - duration) < 60000);
    return preset ? preset.label : 'Custom';
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
