'use strict';

/**
 * Demo trading-bot server — zero dependencies, pure Node core.
 *
 * Responsibilities:
 *   - serve the React dashboard from /public
 *   - expose a small REST API (place/cancel orders, toggle strategies)
 *   - push live state over a hand-rolled WebSocket (see ws.js)
 *
 * The moving parts (market feed, order engine, portfolio, strategies) are split
 * into their own modules so each is independently testable and swappable — the
 * exchange adapter boundary in exchange/binanceAdapter.js shows how the
 * simulated feed is replaced by a live venue without touching the rest.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const { WebSocketHub } = require('./ws');
const { MarketData } = require('./marketData');
const { Portfolio } = require('./portfolio');
const { OrderEngine } = require('./orderEngine');
const { StrategyManager } = require('./strategies');

const PORT = process.env.PORT || 4000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// ---- wire up the trading core -------------------------------------------------
const market = new MarketData();
const portfolio = new Portfolio({ startingCash: 100000 });
const engine = new OrderEngine(market, portfolio);
const strategies = new StrategyManager(market, engine);

// Seed one resting limit order so the book/blotter isn't empty on first paint.
engine.place({ symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', price: market.getPrice('BTCUSDT') - 50, qty: 0.1 });

const equityHistory = [];
function recordEquity() {
  const snap = portfolio.snapshot((s) => market.getPrice(s));
  equityHistory.push({ ts: Date.now(), equity: snap.equity });
  if (equityHistory.length > 120) equityHistory.shift();
}
recordEquity();

// ---- snapshot assembly --------------------------------------------------------
function buildSnapshot() {
  const prices = market.symbols.map((symbol) => ({
    symbol,
    price: market.getPrice(symbol),
  }));
  const depth = market.symbols.map((symbol) => market.getDepth(symbol));
  return {
    type: 'snapshot',
    ts: Date.now(),
    prices,
    depth,
    portfolio: portfolio.snapshot((s) => market.getPrice(s)),
    orders: engine.recent(40),
    strategies: strategies.list(),
    equityHistory,
    connections: hub ? hub.size : 0,
  };
}

// ---- static file serving ------------------------------------------------------
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  // Prevent path traversal outside PUBLIC_DIR.
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': CONTENT_TYPES[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// ---- REST helpers -------------------------------------------------------------
function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1e6) req.destroy(); // basic guard
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (_) {
        resolve(null);
      }
    });
  });
}

async function handleApi(req, res, url) {
  const { pathname } = url;
  const method = req.method;

  if (method === 'GET' && pathname === '/api/health') {
    return sendJSON(res, 200, { ok: true, uptime: process.uptime() });
  }

  if (method === 'GET' && pathname === '/api/state') {
    return sendJSON(res, 200, buildSnapshot());
  }

  if (method === 'POST' && pathname === '/api/orders') {
    const body = await readBody(req);
    if (!body) return sendJSON(res, 400, { error: 'invalid JSON' });
    const order = engine.place({
      symbol: body.symbol,
      side: body.side,
      type: body.type || 'MARKET',
      price: body.price,
      qty: body.qty,
      source: 'manual',
    });
    const status = order.status === 'REJECTED' ? 422 : 201;
    return sendJSON(res, status, order);
  }

  const cancelMatch = pathname.match(/^\/api\/orders\/([^/]+)\/cancel$/);
  if (method === 'POST' && cancelMatch) {
    const order = engine.cancel(decodeURIComponent(cancelMatch[1]));
    if (!order) return sendJSON(res, 404, { error: 'not cancellable' });
    return sendJSON(res, 200, order);
  }

  const stratMatch = pathname.match(/^\/api\/strategies\/([^/]+)$/);
  if (method === 'POST' && stratMatch) {
    const body = await readBody(req);
    const s = strategies.setEnabled(decodeURIComponent(stratMatch[1]), body && body.enabled);
    if (!s) return sendJSON(res, 404, { error: 'unknown strategy' });
    return sendJSON(res, 200, { id: s.id, enabled: s.enabled });
  }

  return sendJSON(res, 404, { error: 'no such route' });
}

// ---- HTTP server --------------------------------------------------------------
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch((err) => {
      sendJSON(res, 500, { error: String(err && err.message) });
    });
    return;
  }
  serveStatic(req, res, url.pathname);
});

// ---- WebSocket hub ------------------------------------------------------------
const hub = new WebSocketHub(server, { path: '/ws' });
hub.on('connection', (socket) => {
  hub.sendJSON(socket, buildSnapshot());
});

// Push a fresh snapshot to everyone whenever something meaningful changes,
// plus a steady heartbeat so P&L marks stay live even without user action.
let pushScheduled = false;
function schedulePush() {
  if (pushScheduled) return;
  pushScheduled = true;
  setImmediate(() => {
    pushScheduled = false;
    hub.broadcast(buildSnapshot());
  });
}
engine.on('orderUpdate', schedulePush);
strategies.on('strategyUpdate', schedulePush);

market.start();
setInterval(() => {
  recordEquity();
  hub.broadcast(buildSnapshot());
}, 800);

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Trading demo running at http://localhost:${PORT}`);
});
