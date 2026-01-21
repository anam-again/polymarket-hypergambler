import { useState, useEffect, useRef } from 'react';

const WS_URL = 'ws://localhost:3001/ws';
const MAX_LOGS = 200;

function LiveLogs({ mode = 'all' }) {
  const [logs, setLogs] = useState([]);
  const [logFiles, setLogFiles] = useState([]);
  const [selectedSource, setSelectedSource] = useState('all');
  const [levelFilter, setLevelFilter] = useState('all');
  const [connected, setConnected] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [loading, setLoading] = useState(false);
  const wsRef = useRef(null);
  const logsContainerRef = useRef(null);
  const reconnectTimeoutRef = useRef(null);
  const isRunningRef = useRef(isRunning);
  const selectedSourceRef = useRef(selectedSource);
  const modeRef = useRef(mode);

  // Keep refs in sync
  useEffect(() => {
    isRunningRef.current = isRunning;
  }, [isRunning]);

  useEffect(() => {
    selectedSourceRef.current = selectedSource;
  }, [selectedSource]);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  // Fetch log files list - refetch when mode changes
  useEffect(() => {
    const modeParam = mode && mode !== 'all' ? `?mode=${mode}` : '';
    fetch(`/api/log-files${modeParam}`)
      .then(res => res.json())
      .then(files => {
        setLogFiles(files);
        // Reset source selection if current source is not in new list
        if (selectedSource !== 'all' && !files.includes(selectedSource)) {
          setSelectedSource('all');
        }
      })
      .catch(console.error);
  }, [mode]);

  // Fetch initial logs - only when running and source/mode changes
  useEffect(() => {
    if (!isRunning) return;

    async function fetchInitialLogs() {
      setLoading(true);
      try {
        const modeParam = mode && mode !== 'all' ? `&mode=${mode}` : '';
        const url = selectedSource === 'all'
          ? `/api/live-logs?limit=100${modeParam}`
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
  }, [selectedSource, mode, isRunning]);

  // WebSocket connection - only connect when running
  useEffect(() => {
    if (!isRunning) {
      // Disconnect when stopped
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      setConnected(false);
      return;
    }

    function connect() {
      // Don't connect if not running
      if (!isRunningRef.current) return;

      try {
        const ws = new WebSocket(WS_URL);
        wsRef.current = ws;

        ws.onopen = () => {
          console.log('WebSocket connected');
          setConnected(true);
        };

        ws.onmessage = (event) => {
          if (!isRunningRef.current) return;

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

                // Filter by mode based on source name (PROD = 'prod' in name, TEST = no 'prod')
                if (currentMode === 'PROD') {
                  filteredEntries = filteredEntries.filter(e =>
                    e.source.toLowerCase().includes('prod')
                  );
                } else if (currentMode === 'TEST') {
                  filteredEntries = filteredEntries.filter(e =>
                    !e.source.toLowerCase().includes('prod')
                  );
                }

                // Also filter out TEST level logs when in PROD mode
                if (currentMode === 'PROD') {
                  filteredEntries = filteredEntries.filter(e => e.level !== 'TEST');
                }

                if (filteredEntries.length === 0) return prevLogs;

                // Deduplicate - create a set of existing log keys
                const existingKeys = new Set(
                  prevLogs.map(log => `${log.timestamp}-${log.source}-${log.message}`)
                );

                // Filter out entries that already exist
                const newEntries = filteredEntries.filter(
                  entry => !existingKeys.has(`${entry.timestamp}-${entry.source}-${entry.message}`)
                );

                if (newEntries.length === 0) return prevLogs;

                const updated = [...newEntries, ...prevLogs].slice(0, MAX_LOGS);
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
          // Only attempt reconnect if still running
          if (isRunningRef.current) {
            reconnectTimeoutRef.current = setTimeout(connect, 3000);
          }
        };

        ws.onerror = (error) => {
          console.error('WebSocket error:', error);
          ws.close();
        };
      } catch (err) {
        console.error('Failed to create WebSocket:', err);
        // Only attempt reconnect if still running
        if (isRunningRef.current) {
          reconnectTimeoutRef.current = setTimeout(connect, 3000);
        }
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
  }, [isRunning]);

  // Filter logs by level, mode, and source
  const filteredLogs = logs.filter(log => {
    // Filter by mode based on source name (PROD = 'prod' in name, TEST = no 'prod')
    if (mode === 'PROD' && !log.source.toLowerCase().includes('prod')) {
      return false;
    }
    if (mode === 'TEST' && log.source.toLowerCase().includes('prod')) {
      return false;
    }
    // Also exclude TEST level logs when in PROD mode
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
      case 'UPDATE': return 'log-update';
      case 'ORDER': return 'log-order';
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
          <span className={`connection-status ${!isRunning ? 'stopped' : connected ? 'connected' : 'disconnected'}`}>
            {!isRunning ? 'Stopped' : connected ? 'Live' : 'Connecting...'}
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
            <option value="UPDATE">Update</option>
            <option value="ORDER">Order</option>
          </select>

          <button
            className={`control-btn ${isRunning ? 'running' : 'stopped'}`}
            onClick={() => setIsRunning(!isRunning)}
          >
            {isRunning ? 'Stop' : 'Start'}
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
