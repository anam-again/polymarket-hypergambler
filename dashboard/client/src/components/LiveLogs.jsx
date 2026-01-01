import { useState, useEffect, useRef } from 'react';

const WS_URL = 'ws://localhost:3001/ws';
const MAX_LOGS = 200;

function LiveLogs({ mode = 'all' }) {
  const [logs, setLogs] = useState([]);
  const [logFiles, setLogFiles] = useState([]);
  const [selectedSource, setSelectedSource] = useState('all');
  const [levelFilter, setLevelFilter] = useState('all');
  const [connected, setConnected] = useState(false);
  const [paused, setPaused] = useState(false);
  const [loading, setLoading] = useState(true);
  const wsRef = useRef(null);
  const logsContainerRef = useRef(null);
  const reconnectTimeoutRef = useRef(null);
  const pausedRef = useRef(paused);
  const selectedSourceRef = useRef(selectedSource);
  const modeRef = useRef(mode);

  // Keep refs in sync
  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  useEffect(() => {
    selectedSourceRef.current = selectedSource;
  }, [selectedSource]);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  // Fetch log files list
  useEffect(() => {
    fetch('/api/log-files')
      .then(res => res.json())
      .then(setLogFiles)
      .catch(console.error);
  }, []);

  // Fetch initial logs
  useEffect(() => {
    async function fetchInitialLogs() {
      setLoading(true);
      try {
        const url = selectedSource === 'all'
          ? '/api/live-logs?limit=100'
          : `/api/logs/${encodeURIComponent(selectedSource)}?limit=100`;

        const res = await fetch(url);
        const data = await res.json();
        setLogs(data);
      } catch (error) {
        console.error('Failed to fetch logs:', error);
      } finally {
        setLoading(false);
      }
    }

    fetchInitialLogs();
  }, [selectedSource]);

  // WebSocket connection - only run once on mount
  useEffect(() => {
    function connect() {
      try {
        const ws = new WebSocket(WS_URL);
        wsRef.current = ws;

        ws.onopen = () => {
          console.log('WebSocket connected');
          setConnected(true);
        };

        ws.onmessage = (event) => {
          if (pausedRef.current) return;

          try {
            const data = JSON.parse(event.data);
            if (data.type === 'log-update' && data.entries) {
              setLogs(prevLogs => {
                const source = selectedSourceRef.current;
                const currentMode = modeRef.current;

                let filteredEntries = data.entries;

                // Filter by source
                if (source !== 'all') {
                  filteredEntries = filteredEntries.filter(e => e.source === source);
                }

                // Filter out TEST logs when in PROD mode
                if (currentMode === 'PROD') {
                  filteredEntries = filteredEntries.filter(e => e.level !== 'TEST');
                }

                if (filteredEntries.length === 0) return prevLogs;

                const updated = [...filteredEntries, ...prevLogs].slice(0, MAX_LOGS);
                return updated;
              });
            }
          } catch (err) {
            console.error('Failed to parse WebSocket message:', err);
          }
        };

        ws.onclose = () => {
          console.log('WebSocket disconnected');
          setConnected(false);
          wsRef.current = null;
          // Attempt reconnect after 3 seconds
          reconnectTimeoutRef.current = setTimeout(connect, 3000);
        };

        ws.onerror = (error) => {
          console.error('WebSocket error:', error);
          ws.close();
        };
      } catch (err) {
        console.error('Failed to create WebSocket:', err);
        reconnectTimeoutRef.current = setTimeout(connect, 3000);
      }
    }

    connect();

    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, []);

  // Filter logs by level and mode
  // When mode is PROD, exclude TEST level logs
  const filteredLogs = logs.filter(log => {
    // Apply mode filter - exclude TEST logs when in PROD mode
    if (mode === 'PROD' && log.level === 'TEST') {
      return false;
    }
    // Apply level filter
    if (levelFilter !== 'all' && log.level !== levelFilter) {
      return false;
    }
    return true;
  });

  const getLevelClass = (level) => {
    switch (level) {
      case 'ERROR': return 'log-error';
      case 'WARN': return 'log-warn';
      case 'INFO': return 'log-info';
      case 'TEST': return 'log-test';
      default: return '';
    }
  };

  const formatTime = (timestamp) => {
    return new Date(timestamp).toLocaleTimeString();
  };

  const clearLogs = () => {
    setLogs([]);
  };

  return (
    <div className="live-logs">
      <div className="live-logs-header">
        <div className="live-logs-title">
          <h2>Live Trading Logs</h2>
          <span className={`connection-status ${connected ? 'connected' : 'disconnected'}`}>
            {connected ? 'Live' : 'Reconnecting...'}
          </span>
        </div>
        <div className="live-logs-controls">
          <select
            value={selectedSource}
            onChange={(e) => setSelectedSource(e.target.value)}
          >
            <option value="all">All Bots</option>
            {logFiles.map(file => (
              <option key={file} value={file}>{file}</option>
            ))}
          </select>

          <select
            value={levelFilter}
            onChange={(e) => setLevelFilter(e.target.value)}
          >
            <option value="all">All Levels</option>
            <option value="ERROR">Errors</option>
            <option value="WARN">Warnings</option>
            <option value="INFO">Info</option>
            <option value="TEST">Test</option>
          </select>

          <button
            className={`control-btn ${paused ? 'paused' : ''}`}
            onClick={() => setPaused(!paused)}
          >
            {paused ? 'Resume' : 'Pause'}
          </button>

          <button className="control-btn clear-btn" onClick={clearLogs}>
            Clear
          </button>
        </div>
      </div>

      <div className="live-logs-container" ref={logsContainerRef}>
        {loading ? (
          <div className="loading">Loading logs...</div>
        ) : filteredLogs.length === 0 ? (
          <div className="no-data">No logs found</div>
        ) : (
          <table className="logs-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Level</th>
                <th>Source</th>
                <th>Message</th>
              </tr>
            </thead>
            <tbody>
              {filteredLogs.map((log, index) => (
                <tr key={`${log.timestamp}-${index}`} className={getLevelClass(log.level)}>
                  <td className="log-time">{formatTime(log.timestamp)}</td>
                  <td className="log-level">{log.level}</td>
                  <td className="log-source">{log.source}</td>
                  <td className="log-message">{log.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

export default LiveLogs;
