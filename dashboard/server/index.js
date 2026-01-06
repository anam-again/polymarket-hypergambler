import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import chokidar from 'chokidar';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

// Create HTTP server from Express app
const server = createServer(app);

// WebSocket server on the same HTTP server
const wss = new WebSocketServer({ server, path: '/ws' });

// Track file positions for tailing
const filePositions = new Map();

// Parse a single log line
function parseLogLine(line, source) {
  const match = line.match(/^\[(\w+)\]\s+(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s+(.*)$/);
  if (match) {
    const [, level, timestamp, message] = match;
    return {
      level,
      timestamp: new Date(timestamp).getTime(),
      timestampStr: timestamp,
      message: message.trim(),
      source
    };
  }
  return null;
}

// Read new lines from a file since last position
function readNewLines(filePath, source) {
  try {
    const stats = fs.statSync(filePath);
    const currentSize = stats.size;
    const lastPosition = filePositions.get(filePath) || 0;

    if (currentSize <= lastPosition) {
      // File was truncated or no new data
      filePositions.set(filePath, currentSize);
      return [];
    }

    // Read only the new portion
    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(currentSize - lastPosition);
    fs.readSync(fd, buffer, 0, buffer.length, lastPosition);
    fs.closeSync(fd);

    filePositions.set(filePath, currentSize);

    const newContent = buffer.toString('utf-8');
    const lines = newContent.split('\n').filter(line => line.trim());

    return lines.map(line => parseLogLine(line, source)).filter(Boolean);
  } catch (err) {
    return [];
  }
}

// Broadcast to all connected clients
function broadcast(data) {
  const message = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === 1) { // WebSocket.OPEN
      client.send(message);
    }
  });
}

// Watch log files for changes
const logsDir = path.join(__dirname, '../../logs');
if (fs.existsSync(logsDir)) {
  const watcher = chokidar.watch(path.join(logsDir, '*.log'), {
    persistent: true,
    ignoreInitial: true,
    usePolling: true,
    interval: 500
  });

  watcher.on('change', (filePath) => {
    const fileName = path.basename(filePath, '.log');

    // Handle tradeAudit.log changes - broadcast trade data update
    if (fileName === 'tradeAudit') {
      broadcast({
        type: 'trade-update',
        timestamp: Date.now()
      });
      return;
    }

    // Skip error logs for live log streaming
    if (fileName.includes('Errors')) {
      return;
    }

    // Stream bot logs
    const newEntries = readNewLines(filePath, fileName);
    if (newEntries.length > 0) {
      broadcast({
        type: 'log-update',
        entries: newEntries
      });
    }
  });

  console.log(`Watching logs directory: ${logsDir}`);
}

// WebSocket connection handler
wss.on('connection', (ws) => {
  console.log('WebSocket client connected');

  ws.on('close', () => {
    console.log('WebSocket client disconnected');
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
});

// Filter trades by time range
function filterByTimeRange(trades, startTime, endTime) {
  return trades.filter(t => {
    if (startTime && t.timestamp < startTime) return false;
    if (endTime && t.timestamp > endTime) return false;
    return true;
  });
}

// Filter trades by mode (TEST/PROD)
// ORDER mode is treated as PROD data
function filterByMode(trades, mode) {
  if (!mode || mode === 'all') return trades;
  if (mode === 'PROD') {
    return trades.filter(t => t.mode === 'PROD' || t.mode === 'ORDER');
  }
  return trades.filter(t => t.mode === mode);
}

// Parse query params for time range and mode
function getFilters(req) {
  const startTime = req.query.startTime ? parseInt(req.query.startTime) : null;
  const endTime = req.query.endTime ? parseInt(req.query.endTime) : null;
  const mode = req.query.mode || 'all';
  return { startTime, endTime, mode };
}

// Parse the trade audit log
function parseTradeLog() {
  const logPath = path.join(__dirname, '../../logs/tradeAudit.log');

  if (!fs.existsSync(logPath)) {
    return [];
  }

  const content = fs.readFileSync(logPath, 'utf-8');
  const lines = content.trim().split('\n').filter(line => line.trim());

  return lines.map(line => {
    const parts = line.split(', ').map(p => p.trim());

    return {
      timestamp: parseInt(parts[0]),
      strategy: parts[1],
      tradeId: parts[2],
      status: parts[3],
      entryTimestamp: parseInt(parts[4]),
      size: parseFloat(parts[5]),
      buyPrice: parseFloat(parts[6]),
      sellPrice: parseFloat(parts[7]),
      gross: parseFloat(parts[8]),
      pnl: parseFloat(parts[9]),
      mode: parts[10],
      marketHash: parts[11],
      side: parts[12]
    };
  });
}

// Get all trades
app.get('/api/trades', (req, res) => {
  const { startTime, endTime, mode } = getFilters(req);
  let trades = parseTradeLog();
  trades = filterByTimeRange(trades, startTime, endTime);
  trades = filterByMode(trades, mode);
  res.json(trades);
});

// Get summary stats
app.get('/api/stats', (req, res) => {
  const { startTime, endTime, mode } = getFilters(req);
  let trades = parseTradeLog();
  trades = filterByTimeRange(trades, startTime, endTime);
  trades = filterByMode(trades, mode);

  const executedTrades = trades.filter(t => t.status === 'MATCHED');
  const expiredTrades = trades.filter(t => t.status === 'EXPIRED');
  const completedTrades = trades.filter(t => t.status === 'MATCHED' || t.status === 'EXPIRED');

  const totalPnl = completedTrades.reduce((sum, t) => sum + t.pnl, 0);
  const winningTrades = completedTrades.filter(t => t.pnl > 0);
  const losingTrades = completedTrades.filter(t => t.pnl < 0);

  res.json({
    totalTrades: trades.length,
    soldTrades: executedTrades.length,
    expiredTrades: expiredTrades.length,
    totalPnl: totalPnl.toFixed(2),
    winRate: completedTrades.length > 0 ? ((winningTrades.length / completedTrades.length) * 100).toFixed(1) : 0,
    avgPnl: completedTrades.length > 0 ? (totalPnl / completedTrades.length).toFixed(2) : 0,
    winningTrades: winningTrades.length,
    losingTrades: losingTrades.length
  });
});

// Get PnL by strategy
app.get('/api/pnl-by-strategy', (req, res) => {
  const { startTime, endTime, mode } = getFilters(req);
  let trades = parseTradeLog();
  trades = filterByTimeRange(trades, startTime, endTime);
  trades = filterByMode(trades, mode);
  const completedTrades = trades.filter(t => t.status === 'MATCHED' || t.status === 'EXPIRED');

  const strategyPnl = {};
  completedTrades.forEach(trade => {
    if (!strategyPnl[trade.strategy]) {
      strategyPnl[trade.strategy] = { pnl: 0, trades: 0, wins: 0, losses: 0 };
    }
    strategyPnl[trade.strategy].pnl += trade.pnl;
    strategyPnl[trade.strategy].trades++;
    if (trade.pnl > 0) strategyPnl[trade.strategy].wins++;
    if (trade.pnl < 0) strategyPnl[trade.strategy].losses++;
  });

  const result = Object.entries(strategyPnl).map(([strategy, data]) => ({
    strategy,
    pnl: parseFloat(data.pnl.toFixed(2)),
    trades: data.trades,
    wins: data.wins,
    losses: data.losses,
    winRate: ((data.wins / data.trades) * 100).toFixed(1)
  }));

  res.json(result);
});

// Get cumulative PnL over time
app.get('/api/cumulative-pnl', (req, res) => {
  const { startTime, endTime, mode } = getFilters(req);
  let trades = parseTradeLog();
  trades = filterByTimeRange(trades, startTime, endTime);
  trades = filterByMode(trades, mode);
  const completedTrades = trades.filter(t => t.status === 'MATCHED' || t.status === 'EXPIRED').sort((a, b) => a.timestamp - b.timestamp);

  let cumulative = 0;
  const result = completedTrades.map(trade => {
    cumulative += trade.pnl;
    return {
      timestamp: trade.timestamp,
      date: new Date(trade.timestamp).toLocaleString(),
      pnl: trade.pnl,
      cumulative: parseFloat(cumulative.toFixed(2)),
      strategy: trade.strategy,
      status: trade.status
    };
  });

  res.json(result);
});

// Get trades by side (BUY/SELL)
app.get('/api/trades-by-side', (req, res) => {
  const { startTime, endTime, mode } = getFilters(req);
  let trades = parseTradeLog();
  trades = filterByTimeRange(trades, startTime, endTime);
  trades = filterByMode(trades, mode);
  const completedTrades = trades.filter(t => t.status === 'MATCHED' || t.status === 'EXPIRED');

  const buyTrades = completedTrades.filter(t => t.side === 'BUY');
  const sellTrades = completedTrades.filter(t => t.side === 'SELL');

  res.json([
    {
      side: 'BUY',
      count: buyTrades.length,
      pnl: parseFloat(buyTrades.reduce((sum, t) => sum + t.pnl, 0).toFixed(2))
    },
    {
      side: 'SELL',
      count: sellTrades.length,
      pnl: parseFloat(sellTrades.reduce((sum, t) => sum + t.pnl, 0).toFixed(2))
    }
  ]);
});

// Get list of all strategies
app.get('/api/strategies', (req, res) => {
  const { startTime, endTime, mode } = getFilters(req);
  let trades = parseTradeLog();
  trades = filterByTimeRange(trades, startTime, endTime);
  trades = filterByMode(trades, mode);
  const strategies = [...new Set(trades.map(t => t.strategy))].sort();
  res.json(strategies);
});

// Get trades for a specific strategy
app.get('/api/strategy/:name/trades', (req, res) => {
  const { startTime, endTime, mode } = getFilters(req);
  let trades = parseTradeLog();
  trades = filterByTimeRange(trades, startTime, endTime);
  trades = filterByMode(trades, mode);
  const strategyTrades = trades
    .filter(t => t.strategy === req.params.name)
    .sort((a, b) => b.timestamp - a.timestamp);
  res.json(strategyTrades);
});

// Get stats for a specific strategy
app.get('/api/strategy/:name/stats', (req, res) => {
  const { startTime, endTime, mode } = getFilters(req);
  let trades = parseTradeLog();
  trades = filterByTimeRange(trades, startTime, endTime);
  trades = filterByMode(trades, mode);
  const strategyTrades = trades.filter(t => t.strategy === req.params.name);
  const executedTrades = strategyTrades.filter(t => t.status === 'MATCHED');
  const expiredTrades = strategyTrades.filter(t => t.status === 'EXPIRED');
  const completedTrades = strategyTrades.filter(t => t.status === 'MATCHED' || t.status === 'EXPIRED');

  const totalPnl = completedTrades.reduce((sum, t) => sum + t.pnl, 0);
  const winningTrades = completedTrades.filter(t => t.pnl > 0);
  const losingTrades = completedTrades.filter(t => t.pnl < 0);

  const avgWin = winningTrades.length > 0
    ? winningTrades.reduce((sum, t) => sum + t.pnl, 0) / winningTrades.length
    : 0;
  const avgLoss = losingTrades.length > 0
    ? losingTrades.reduce((sum, t) => sum + t.pnl, 0) / losingTrades.length
    : 0;

  res.json({
    strategy: req.params.name,
    totalTrades: strategyTrades.length,
    soldTrades: executedTrades.length,
    expiredTrades: expiredTrades.length,
    totalPnl: totalPnl.toFixed(2),
    winRate: completedTrades.length > 0 ? ((winningTrades.length / completedTrades.length) * 100).toFixed(1) : 0,
    avgPnl: completedTrades.length > 0 ? (totalPnl / completedTrades.length).toFixed(2) : 0,
    avgWin: avgWin.toFixed(2),
    avgLoss: avgLoss.toFixed(2),
    winningTrades: winningTrades.length,
    losingTrades: losingTrades.length,
    largestWin: winningTrades.length > 0 ? Math.max(...winningTrades.map(t => t.pnl)).toFixed(2) : 0,
    largestLoss: losingTrades.length > 0 ? Math.min(...losingTrades.map(t => t.pnl)).toFixed(2) : 0
  });
});

// Get cumulative PnL for a specific strategy
app.get('/api/strategy/:name/cumulative-pnl', (req, res) => {
  const { startTime, endTime, mode } = getFilters(req);
  let trades = parseTradeLog();
  trades = filterByTimeRange(trades, startTime, endTime);
  trades = filterByMode(trades, mode);
  const completedTrades = trades
    .filter(t => t.strategy === req.params.name && (t.status === 'MATCHED' || t.status === 'EXPIRED'))
    .sort((a, b) => a.timestamp - b.timestamp);

  let cumulative = 0;
  const result = completedTrades.map(trade => {
    cumulative += trade.pnl;
    return {
      timestamp: trade.timestamp,
      date: new Date(trade.timestamp).toLocaleString(),
      pnl: trade.pnl,
      cumulative: parseFloat(cumulative.toFixed(2)),
      tradeId: trade.tradeId,
      side: trade.side,
      status: trade.status
    };
  });

  res.json(result);
});

// Get PnL distribution for a strategy
app.get('/api/strategy/:name/pnl-distribution', (req, res) => {
  const { startTime, endTime, mode } = getFilters(req);
  let trades = parseTradeLog();
  trades = filterByTimeRange(trades, startTime, endTime);
  trades = filterByMode(trades, mode);
  const completedTrades = trades
    .filter(t => t.strategy === req.params.name && (t.status === 'MATCHED' || t.status === 'EXPIRED'));

  // Group PnL into buckets
  const buckets = {};
  completedTrades.forEach(trade => {
    const bucket = Math.floor(trade.pnl);
    buckets[bucket] = (buckets[bucket] || 0) + 1;
  });

  const result = Object.entries(buckets)
    .map(([pnl, count]) => ({ pnl: parseFloat(pnl), count }))
    .sort((a, b) => a.pnl - b.pnl);

  res.json(result);
});

// Filter log files by mode (PROD = files with 'prod' in name, TEST = files without 'prod')
function filterLogFilesByMode(files, mode) {
  if (!mode || mode === 'all') return files;
  if (mode === 'PROD') {
    return files.filter(f => f.toLowerCase().includes('prod'));
  }
  // TEST mode - exclude files with 'prod' in name
  return files.filter(f => !f.toLowerCase().includes('prod'));
}

// Get live trading logs from all bot log files
app.get('/api/live-logs', (req, res) => {
  const logsDir = path.join(__dirname, '../../logs');
  const limit = parseInt(req.query.limit) || 50;
  const mode = req.query.mode || 'all';

  if (!fs.existsSync(logsDir)) {
    return res.json([]);
  }

  let logFiles = fs.readdirSync(logsDir)
    .filter(f => f.endsWith('.log') && !f.includes('tradeAudit') && !f.includes('Errors'));

  // Filter by mode
  logFiles = filterLogFilesByMode(logFiles, mode);

  logFiles = logFiles.map(f => path.join(logsDir, f));

  const allEntries = [];

  logFiles.forEach(filePath => {
    const fileName = path.basename(filePath, '.log');
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.trim().split('\n').filter(line => line.trim());

      lines.forEach(line => {
        // Parse log format: [LEVEL] TIMESTAMP MESSAGE
        const match = line.match(/^\[(\w+)\]\s+(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s+(.*)$/);
        if (match) {
          const [, level, timestamp, message] = match;
          allEntries.push({
            level,
            timestamp: new Date(timestamp).getTime(),
            timestampStr: timestamp,
            message: message.trim(),
            source: fileName
          });
        }
      });
    } catch (err) {
      // Skip files that can't be read
    }
  });

  // Sort by timestamp descending and take the most recent entries
  allEntries.sort((a, b) => b.timestamp - a.timestamp);
  const recentEntries = allEntries.slice(0, limit);

  res.json(recentEntries);
});

// Get list of available log files
app.get('/api/log-files', (req, res) => {
  const logsDir = path.join(__dirname, '../../logs');
  const mode = req.query.mode || 'all';

  if (!fs.existsSync(logsDir)) {
    return res.json([]);
  }

  let logFiles = fs.readdirSync(logsDir)
    .filter(f => f.endsWith('.log') && !f.includes('tradeAudit') && !f.includes('Errors'));

  // Filter by mode
  logFiles = filterLogFilesByMode(logFiles, mode);

  logFiles = logFiles.map(f => f.replace('.log', ''));

  res.json(logFiles);
});

// Get logs for a specific bot/file
app.get('/api/logs/:source', (req, res) => {
  const logsDir = path.join(__dirname, '../../logs');
  const limit = parseInt(req.query.limit) || 100;
  const filePath = path.join(logsDir, `${req.params.source}.log`);

  if (!fs.existsSync(filePath)) {
    return res.json([]);
  }

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.trim().split('\n').filter(line => line.trim());

    const entries = [];
    lines.forEach(line => {
      const match = line.match(/^\[(\w+)\]\s+(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s+(.*)$/);
      if (match) {
        const [, level, timestamp, message] = match;
        entries.push({
          level,
          timestamp: new Date(timestamp).getTime(),
          timestampStr: timestamp,
          message: message.trim(),
          source: req.params.source
        });
      }
    });

    // Return most recent entries
    entries.reverse();
    res.json(entries.slice(0, limit));
  } catch (err) {
    res.json([]);
  }
});

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`WebSocket available at ws://localhost:${PORT}/ws`);
});
