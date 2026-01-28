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
const botsLogsDir = path.join(logsDir, 'bots');
const auditsLogsDir = path.join(logsDir, 'audits');
const simulatorLogsDir = path.join(logsDir, 'simulator');

// Watch bot logs
if (fs.existsSync(botsLogsDir)) {
  const botsWatcher = chokidar.watch(path.join(botsLogsDir, '*.log'), {
    persistent: true,
    ignoreInitial: true,
    usePolling: true,
    interval: 500
  });

  botsWatcher.on('change', (filePath) => {
    const fileName = path.basename(filePath, '.log');

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

  console.log(`Watching bot logs directory: ${botsLogsDir}`);
}

// Watch audit logs
if (fs.existsSync(auditsLogsDir)) {
  const auditsWatcher = chokidar.watch(path.join(auditsLogsDir, 'tradeAudit.log'), {
    persistent: true,
    ignoreInitial: true,
    usePolling: true,
    interval: 500
  });

  auditsWatcher.on('change', () => {
    broadcast({
      type: 'trade-update',
      timestamp: Date.now()
    });
  });

  console.log(`Watching audits directory: ${auditsLogsDir}`);
}

// Note: WebSocket connection handler is defined below with live trades support

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
  const logPath = path.join(__dirname, '../../logs/audits/tradeAudit.log');

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
  const losingTrades = completedTrades.filter(t => t.pnl <= 0);

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
    if (trade.pnl <= 0) strategyPnl[trade.strategy].losses++;
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
  const losingTrades = completedTrades.filter(t => t.pnl <= 0);

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
      strategy: trade.strategy,
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
  const botsDir = path.join(__dirname, '../../logs/bots');
  const limit = parseInt(req.query.limit) || 50;
  const mode = req.query.mode || 'all';

  if (!fs.existsSync(botsDir)) {
    return res.json([]);
  }

  let logFiles = fs.readdirSync(botsDir)
    .filter(f => f.endsWith('.log') && !f.includes('tradeAudit') && !f.includes('Errors'));

  // Filter by mode
  logFiles = filterLogFilesByMode(logFiles, mode);

  logFiles = logFiles.map(f => path.join(botsDir, f));

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
  const botsDir = path.join(__dirname, '../../logs/bots');
  const mode = req.query.mode || 'all';

  if (!fs.existsSync(botsDir)) {
    return res.json([]);
  }

  let logFiles = fs.readdirSync(botsDir)
    .filter(f => f.endsWith('.log') && !f.includes('tradeAudit') && !f.includes('Errors'));

  // Filter by mode
  logFiles = filterLogFilesByMode(logFiles, mode);

  logFiles = logFiles.map(f => f.replace('.log', ''));

  res.json(logFiles);
});

// Get logs for a specific bot/file
app.get('/api/logs/:source', (req, res) => {
  const botsDir = path.join(__dirname, '../../logs/bots');
  const limit = parseInt(req.query.limit) || 100;
  const filePath = path.join(botsDir, `${req.params.source}.log`);

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

// ============================================================================
// Simulator Audit Endpoints
// ============================================================================

// Parse a simulator audit file
function parseSimulatorAuditFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.trim().split('\n').filter(line => line.trim());

  // Skip header line and comment lines (lines starting with #)
  const dataLines = lines.slice(1).filter(line => !line.startsWith('#'));

  return dataLines.map(line => {
    const parts = line.split(', ').map(p => p.trim());

    // Skip lines that don't have enough parts (might be from new format sections)
    if (parts.length < 13) return null;

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
  }).filter(Boolean);
}

// Parse the extended audit file format (includes top trades and avg stats sections)
function parseSimulatorAuditFileExtended(filePath) {
  if (!fs.existsSync(filePath)) {
    return { trades: [], topTrades: null, avgStats: null };
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.trim().split('\n');

  const result = {
    trades: [],
    topTrades: null,
    avgStats: null
  };

  let currentSection = 'trades';
  let topTradesParams = null;
  let avgStatsParams = null;
  let topTradesCount = null;
  const topTradesList = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // Detect section changes
    if (line === '# TOP TRADES BY PNL') {
      currentSection = 'topTrades';
      continue;
    }
    if (line === '# AVERAGE TRADE STATISTICS') {
      currentSection = 'avgStats';
      continue;
    }

    // Parse parameters line
    if (line.startsWith('# Parameters:')) {
      const paramsJson = line.substring('# Parameters:'.length).trim();
      try {
        const params = JSON.parse(paramsJson);
        if (currentSection === 'topTrades') {
          topTradesParams = params;
        } else if (currentSection === 'avgStats') {
          avgStatsParams = params;
        }
      } catch (e) {
        // Invalid JSON, skip
      }
      continue;
    }

    // Parse count line for top trades
    if (line.startsWith('# Count:') && currentSection === 'topTrades') {
      const match = line.match(/# Count: (\d+)/);
      if (match) {
        topTradesCount = parseInt(match[1]);
      }
      continue;
    }

    // Skip other comment/header lines
    if (line.startsWith('#')) continue;

    // Parse data based on current section
    if (currentSection === 'trades') {
      // Skip the CSV header
      if (line.startsWith('timestamp,')) continue;

      const parts = line.split(', ').map(p => p.trim());
      if (parts.length >= 13) {
        result.trades.push({
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
        });
      }
    } else if (currentSection === 'topTrades') {
      const parts = line.split(',').map(p => p.trim());
      if (parts.length >= 8) {
        topTradesList.push({
          rank: parseInt(parts[0]),
          timestamp: parts[1],
          side: parts[2],
          tokenId: parts[3],
          price: parseFloat(parts[4]),
          amount: parseFloat(parts[5]),
          status: parts[6],
          pnl: parseFloat(parts[7])
        });
      }
    } else if (currentSection === 'avgStats') {
      const parts = line.split(',').map(p => p.trim());
      if (parts.length >= 11) {
        result.avgStats = {
          params: avgStatsParams,
          totalTrades: parseInt(parts[0]),
          matchedTrades: parseInt(parts[1]),
          expiredTrades: parseInt(parts[2]),
          totalPnl: parseFloat(parts[3]),
          avgPnl: parseFloat(parts[4]),
          winRate: parseFloat(parts[5]),
          avgWin: parseFloat(parts[6]),
          avgLoss: parseFloat(parts[7]),
          maxPnl: parseFloat(parts[8]),
          minPnl: parseFloat(parts[9]),
          stdDev: parseFloat(parts[10])
        };
      }
    }
  }

  // Assemble top trades result
  if (topTradesList.length > 0) {
    result.topTrades = {
      params: topTradesParams,
      count: topTradesCount,
      trades: topTradesList
    };
  }

  return result;
}

// Extract strategy name and metadata from filename
function parseSimulatorFilename(filename) {
  // Format: StrategyName-genN-TIMESTAMP.audit.log or StrategyName-TIMESTAMP.audit.log
  const match = filename.match(/^(.+?)(?:-gen(\d+))?-(\d{4}-\d{2}-\d{2}T[\d-]+Z)\.audit\.log$/);
  if (match) {
    return {
      strategy: match[1],
      generation: match[2] ? parseInt(match[2]) : null,
      timestamp: match[3].replace(/-/g, (m, offset) => {
        // Convert back: 2026-01-15T22-40-41-422Z -> 2026-01-15T22:40:41.422Z
        if (offset > 9) return offset === 13 || offset === 16 ? ':' : '.';
        return m;
      }),
      filename
    };
  }
  return { strategy: filename, generation: null, timestamp: null, filename };
}

// Get list of simulator audit files
app.get('/api/simulator/files', (req, res) => {
  if (!fs.existsSync(simulatorLogsDir)) {
    return res.json([]);
  }

  const files = fs.readdirSync(simulatorLogsDir)
    .filter(f => f.endsWith('.audit.log'))
    .map(f => {
      const parsed = parseSimulatorFilename(f);
      const filePath = path.join(simulatorLogsDir, f);
      const stats = fs.statSync(filePath);
      return {
        ...parsed,
        size: stats.size,
        modified: stats.mtime.getTime()
      };
    })
    .sort((a, b) => b.modified - a.modified);

  res.json(files);
});

// Get trades from a specific simulator audit file
app.get('/api/simulator/file/:filename/trades', (req, res) => {
  const filePath = path.join(simulatorLogsDir, req.params.filename);
  const trades = parseSimulatorAuditFile(filePath);
  res.json(trades);
});

// Get stats from a specific simulator audit file
app.get('/api/simulator/file/:filename/stats', (req, res) => {
  const filePath = path.join(simulatorLogsDir, req.params.filename);
  const trades = parseSimulatorAuditFile(filePath);

  const completedTrades = trades.filter(t => t.status === 'MATCHED' || t.status === 'EXPIRED');
  const totalPnl = completedTrades.reduce((sum, t) => sum + t.pnl, 0);
  const winningTrades = completedTrades.filter(t => t.pnl > 0);
  const losingTrades = completedTrades.filter(t => t.pnl <= 0);

  // Calculate max drawdown
  let peak = 0;
  let maxDrawdown = 0;
  let cumulative = 0;
  completedTrades.sort((a, b) => a.entryTimestamp - b.entryTimestamp);
  for (const trade of completedTrades) {
    cumulative += trade.pnl;
    peak = Math.max(peak, cumulative);
    maxDrawdown = Math.min(maxDrawdown, cumulative - peak);
  }

  // Calculate Sharpe ratio
  const pnls = completedTrades.map(t => t.pnl);
  const avgPnl = pnls.length > 0 ? totalPnl / pnls.length : 0;
  const variance = pnls.length > 1
    ? pnls.reduce((sum, pnl) => sum + Math.pow(pnl - avgPnl, 2), 0) / (pnls.length - 1)
    : 0;
  const stdDev = Math.sqrt(variance);
  const sharpeRatio = stdDev > 0 ? avgPnl / stdDev : 0;

  const parsed = parseSimulatorFilename(req.params.filename);

  res.json({
    filename: req.params.filename,
    strategy: parsed.strategy,
    generation: parsed.generation,
    totalTrades: trades.length,
    completedTrades: completedTrades.length,
    matchedTrades: trades.filter(t => t.status === 'MATCHED').length,
    expiredTrades: trades.filter(t => t.status === 'EXPIRED').length,
    totalPnl: totalPnl.toFixed(2),
    winRate: completedTrades.length > 0 ? ((winningTrades.length / completedTrades.length) * 100).toFixed(1) : 0,
    avgPnl: avgPnl.toFixed(2),
    maxDrawdown: maxDrawdown.toFixed(2),
    sharpeRatio: sharpeRatio.toFixed(3),
    winningTrades: winningTrades.length,
    losingTrades: losingTrades.length,
    avgWin: winningTrades.length > 0 ? (winningTrades.reduce((s, t) => s + t.pnl, 0) / winningTrades.length).toFixed(2) : 0,
    avgLoss: losingTrades.length > 0 ? (losingTrades.reduce((s, t) => s + t.pnl, 0) / losingTrades.length).toFixed(2) : 0
  });
});

// Get cumulative PnL for a simulator audit file
app.get('/api/simulator/file/:filename/cumulative-pnl', (req, res) => {
  const filePath = path.join(simulatorLogsDir, req.params.filename);
  const trades = parseSimulatorAuditFile(filePath);

  const completedTrades = trades
    .filter(t => t.status === 'MATCHED' || t.status === 'EXPIRED')
    .sort((a, b) => a.entryTimestamp - b.entryTimestamp);

  let cumulative = 0;
  const result = completedTrades.map(trade => {
    cumulative += trade.pnl;
    return {
      timestamp: trade.entryTimestamp,
      date: new Date(trade.entryTimestamp).toLocaleString(),
      pnl: trade.pnl,
      cumulative: parseFloat(cumulative.toFixed(2)),
      strategy: trade.strategy,
      status: trade.status,
      side: trade.side
    };
  });

  res.json(result);
});

// Get PnL distribution for a simulator audit file
app.get('/api/simulator/file/:filename/pnl-distribution', (req, res) => {
  const filePath = path.join(simulatorLogsDir, req.params.filename);
  const trades = parseSimulatorAuditFile(filePath);

  const completedTrades = trades.filter(t => t.status === 'MATCHED' || t.status === 'EXPIRED');

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

// Get top trades and parameters from a simulator audit file
app.get('/api/simulator/file/:filename/top-trades', (req, res) => {
  const filePath = path.join(simulatorLogsDir, req.params.filename);
  const parsed = parseSimulatorAuditFileExtended(filePath);

  if (!parsed.topTrades) {
    return res.json({ available: false, message: 'No top trades data in this audit file' });
  }

  res.json({
    available: true,
    params: parsed.topTrades.params,
    count: parsed.topTrades.count,
    trades: parsed.topTrades.trades
  });
});

// Get average trade statistics and parameters from a simulator audit file
app.get('/api/simulator/file/:filename/avg-stats', (req, res) => {
  const filePath = path.join(simulatorLogsDir, req.params.filename);
  const parsed = parseSimulatorAuditFileExtended(filePath);

  if (!parsed.avgStats) {
    return res.json({ available: false, message: 'No average stats data in this audit file' });
  }

  res.json({
    available: true,
    ...parsed.avgStats
  });
});

// Get full extended data from a simulator audit file (includes all sections)
app.get('/api/simulator/file/:filename/extended', (req, res) => {
  const filePath = path.join(simulatorLogsDir, req.params.filename);
  const parsed = parseSimulatorAuditFileExtended(filePath);

  res.json({
    tradesCount: parsed.trades.length,
    hasTopTrades: !!parsed.topTrades,
    hasAvgStats: !!parsed.avgStats,
    topTrades: parsed.topTrades,
    avgStats: parsed.avgStats
  });
});

// Get unique strategies from simulator files
app.get('/api/simulator/strategies', (req, res) => {
  if (!fs.existsSync(simulatorLogsDir)) {
    return res.json([]);
  }

  const files = fs.readdirSync(simulatorLogsDir)
    .filter(f => f.endsWith('.audit.log'));

  const strategies = [...new Set(files.map(f => parseSimulatorFilename(f).strategy))].sort();
  res.json(strategies);
});

// ============================================================================
// Live Trades Endpoints
// ============================================================================

// Get the current period start timestamp based on period type
function getCurrentPeriodStart(is15MinPeriod) {
  const now = new Date();
  if (is15MinPeriod) {
    // 15-minute periods: round down to nearest 15 minutes
    const minutes = now.getMinutes();
    const periodMinutes = Math.floor(minutes / 15) * 15;
    return new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), periodMinutes, 0, 0).getTime();
  } else {
    // Hourly periods: round down to current hour
    return new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), 0, 0, 0).getTime();
  }
}

// Parse ORDER entries from bot logs to find placed orders
function parseOrdersFromBotLogs() {
  if (!fs.existsSync(botsLogsDir)) {
    return [];
  }

  const orders = [];
  const matchedOrCancelledOrderIds = new Set(); // Track orders that have been MATCHED via UPDATE logs

  const logFiles = fs.readdirSync(botsLogsDir)
    .filter(f => f.endsWith('.log') && !f.includes('Errors'));

  logFiles.forEach(file => {
    const filePath = path.join(botsLogsDir, file);
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.trim().split('\n');

      // First pass: collect all UPDATE entries that show MATCHED status
      lines.forEach(line => {
        // Parse UPDATE log entries: [UPDATE] TIMESTAMP orderId, name, oldStatus -> newStatus
        const updateMatch = line.match(/^\[UPDATE\]\s+(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s+(.*)$/);
        if (updateMatch) {
          const [, , data] = updateMatch;
          const parts = data.split(', ').map(p => p.trim());
          if (parts.length >= 3) {
            const orderId = parts[0];
            const statusChange = parts[2]; // e.g., "LIVE -> MATCHED"
            if (statusChange && statusChange.includes('-> MATCHED') || statusChange.includes('-> CANCELED')) {
              matchedOrCancelledOrderIds.add(orderId);
            }
          }
        }
      });

      // Second pass: collect ORDER entries
      lines.forEach(line => {
        // Parse ORDER log entries: [ORDER] TIMESTAMP orderId, name, side, clobTokenId, orderID, amount, price, marketUrl
        const match = line.match(/^\[ORDER\]\s+(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s+(.*)$/);
        if (match) {
          const [, timestamp, data] = match;
          const parts = data.split(', ').map(p => p.trim());
          if (parts.length >= 7) {
            const marketUrl = parts[7] || null;

            // Determine if this is a 15-minute period based on URL
            const is15MinPeriod = marketUrl && marketUrl.includes('15m');
            const periodStart = getCurrentPeriodStart(is15MinPeriod);
            const orderTimestamp = new Date(timestamp).getTime();

            // Only include orders from the current period
            if (orderTimestamp >= periodStart) {
              orders.push({
                orderId: parts[0],
                name: parts[1],
                side: parts[2],
                tokenId: parts[3],
                orderIdAlt: parts[4],
                amount: parseFloat(parts[5]),
                price: parseFloat(parts[6]),
                marketUrl,
                timestamp: orderTimestamp,
                source: file.replace('.log', ''),
                is15MinPeriod
              });
            }
          }
        }
      });
    } catch (err) {
      // Skip files that can't be read
    }
  });

  // Filter out orders that have been MATCHED according to UPDATE logs
  return orders.filter(o => !matchedOrCancelledOrderIds.has(o.orderId) && !matchedOrCancelledOrderIds.has(o.orderIdAlt));
}

// Get live trades (orders not yet in audit log as completed)
app.get('/api/live-trades', (req, res) => {
  const mode = req.query.mode || 'all';

  // Get all orders from bot logs
  let orders = parseOrdersFromBotLogs();

  // Filter by mode
  if (mode === 'PROD') {
    orders = orders.filter(o => o.source.toLowerCase().includes('prod'));
  } else if (mode === 'TEST') {
    orders = orders.filter(o => !o.source.toLowerCase().includes('prod'));
  }

  // Get completed trades from audit log as additional check
  const completedTrades = parseTradeLog();
  const completedOrderIds = new Set(completedTrades.map(t => t.tradeId));

  // Filter to only orders not in audit log (still live)
  // Note: Period-based filtering and MATCHED status filtering is already done in parseOrdersFromBotLogs
  const liveOrders = orders.filter(o =>
    !completedOrderIds.has(o.orderId) &&
    !completedOrderIds.has(o.orderIdAlt)
  );

  // Group by token to aggregate positions
  const positions = {};
  liveOrders.forEach(order => {
    const key = `${order.tokenId}-${order.side}`;
    if (!positions[key]) {
      positions[key] = {
        tokenId: order.tokenId,
        side: order.side,
        orders: [],
        totalAmount: 0,
        avgPrice: 0,
        totalCost: 0,
        marketUrl: order.marketUrl || null
      };
    }
    positions[key].orders.push(order);
    positions[key].totalAmount += order.amount;
    positions[key].totalCost += order.price * order.amount;
    // Use marketUrl from any order that has it
    if (!positions[key].marketUrl && order.marketUrl) {
      positions[key].marketUrl = order.marketUrl;
    }
  });

  // Calculate average price for each position
  Object.values(positions).forEach(pos => {
    pos.avgPrice = pos.totalAmount > 0 ? pos.totalCost / pos.totalAmount : 0;
  });

  res.json({
    orders: liveOrders,
    positions: Object.values(positions),
    lastUpdated: Date.now()
  });
});

// WebSocket handler for live trades price streaming
// Clients send: { type: 'subscribe-live-trades' } to start, { type: 'unsubscribe-live-trades' } to stop
const liveTradesSubscribers = new Set();

wss.on('connection', (ws) => {
  console.log('WebSocket client connected');

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      if (data.type === 'subscribe-live-trades') {
        liveTradesSubscribers.add(ws);
        console.log('Client subscribed to live trades');
        // Send initial data
        ws.send(JSON.stringify({ type: 'live-trades-subscribed' }));
      } else if (data.type === 'unsubscribe-live-trades') {
        liveTradesSubscribers.delete(ws);
        console.log('Client unsubscribed from live trades');
      }
    } catch (err) {
      // Ignore invalid messages
    }
  });

  ws.on('close', () => {
    liveTradesSubscribers.delete(ws);
    console.log('WebSocket client disconnected');
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
    liveTradesSubscribers.delete(ws);
  });
});

// Remove duplicate connection handler (the original one)
// Note: keeping original handler's logic above

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`WebSocket available at ws://localhost:${PORT}/ws`);
});
