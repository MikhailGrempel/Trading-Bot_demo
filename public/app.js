/* global React, ReactDOM, htm */
'use strict';

// React dashboard for the demo trading engine. No build step: React + htm are
// loaded as UMD globals, so this file runs straight in the browser.
const html = htm.bind(React.createElement);
const { useState, useEffect, useRef, useCallback } = React;

// ---- helpers ------------------------------------------------------------------
const fmt = (n, d = 2) =>
  n == null || Number.isNaN(n)
    ? '—'
    : Number(n).toLocaleString('en-US', {
        minimumFractionDigits: d,
        maximumFractionDigits: d,
      });

const signClass = (n) => (n > 0 ? 'pos' : n < 0 ? 'neg' : 'flat');

async function postJSON(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json().catch(() => ({}));
}

// ---- live socket hook ---------------------------------------------------------
function useLiveState() {
  const [snap, setSnap] = useState(null);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef(null);

  useEffect(() => {
    let closed = false;
    let retry;

    function connect() {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/ws`);
      wsRef.current = ws;
      ws.onopen = () => setConnected(true);
      ws.onclose = () => {
        setConnected(false);
        if (!closed) retry = setTimeout(connect, 1000);
      };
      ws.onmessage = (ev) => {
        try {
          setSnap(JSON.parse(ev.data));
        } catch (_) {
          /* ignore malformed frame */
        }
      };
    }

    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      if (wsRef.current) wsRef.current.close();
    };
  }, []);

  return { snap, connected };
}

// ---- presentational components ------------------------------------------------
function Stat({ label, value, cls }) {
  return html`
    <div class="stat">
      <div class="stat-label">${label}</div>
      <div class=${`stat-value ${cls || ''}`}>${value}</div>
    </div>
  `;
}

function Header({ portfolio, connected, connections }) {
  const p = portfolio || {};
  return html`
    <header class="topbar">
      <div class="brand">
        <span class="logo">◈</span>
        <div>
          <div class="brand-title">Trading Bot Console</div>
          <div class="brand-sub">React · WebSocket · Node order engine — live demo</div>
        </div>
      </div>
      <div class="stats">
        <${Stat} label="Equity" value=${`$${fmt(p.equity)}`} />
        <${Stat}
          label="Realized P&L"
          value=${`$${fmt(p.realizedPnl)}`}
          cls=${signClass(p.realizedPnl)}
        />
        <${Stat}
          label="Unrealized P&L"
          value=${`$${fmt(p.unrealizedPnl)}`}
          cls=${signClass(p.unrealizedPnl)}
        />
        <${Stat} label="Fees" value=${`$${fmt(p.feesPaid)}`} />
        <div class=${`conn ${connected ? 'on' : 'off'}`}>
          <span class="dot"></span>${connected ? `LIVE · ${connections || 0}` : 'reconnecting'}
        </div>
      </div>
    </header>
  `;
}

function StrategyPanel({ strategies }) {
  const [busy, setBusy] = useState(null);
  const toggle = async (s) => {
    setBusy(s.id);
    await postJSON(`/api/strategies/${s.id}`, { enabled: !s.enabled });
    setBusy(null);
  };
  return html`
    <section class="card">
      <div class="card-head">
        <h2>Strategies</h2>
        <span class="muted">toggle on/off — live</span>
      </div>
      <div class="strategy-list">
        ${(strategies || []).map(
          (s) => html`
            <div key=${s.id} class=${`strategy ${s.enabled ? 'active' : ''}`}>
              <div class="strategy-main">
                <div class="strategy-name">${s.name}</div>
                <div class="strategy-desc">${s.description}</div>
                <div class="signal-row">
                  ${(s.lastSignal || []).map(
                    (sig) => html`
                      <span key=${sig.symbol} class=${`sig ${sig.signal.toLowerCase()}`}>
                        ${sig.symbol.replace('USDT', '')} ${sig.signal}
                        <em>${Math.round((sig.confidence || 0) * 100)}%</em>
                      </span>
                    `
                  )}
                </div>
              </div>
              <button
                class=${`switch ${s.enabled ? 'on' : ''}`}
                disabled=${busy === s.id}
                onClick=${() => toggle(s)}
              >
                <span class="knob"></span>
              </button>
            </div>
          `
        )}
      </div>
    </section>
  `;
}

function EquityChart({ history }) {
  const data = history || [];
  const w = 640;
  const h = 140;
  const pad = 6;
  if (data.length < 2) {
    return html`<section class="card"><div class="card-head"><h2>Equity</h2></div>
      <div class="muted center">collecting ticks…</div></section>`;
  }
  const values = data.map((d) => d.equity);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const stepX = (w - pad * 2) / (data.length - 1);
  const points = data
    .map((d, i) => {
      const x = pad + i * stepX;
      const y = pad + (h - pad * 2) * (1 - (d.equity - min) / range);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  const last = values[values.length - 1];
  const first = values[0];
  const up = last >= first;
  return html`
    <section class="card">
      <div class="card-head">
        <h2>Account Equity</h2>
        <span class=${`muted ${up ? 'pos' : 'neg'}`}>
          ${up ? '▲' : '▼'} $${fmt(last)}
        </span>
      </div>
      <svg class="spark" viewBox=${`0 0 ${w} ${h}`} preserveAspectRatio="none">
        <polyline
          points=${points}
          fill="none"
          stroke=${up ? '#22c55e' : '#ef4444'}
          stroke-width="2"
        />
      </svg>
      <div class="axis">
        <span>$${fmt(min)}</span>
        <span class="muted">last ${data.length} snapshots</span>
        <span>$${fmt(max)}</span>
      </div>
    </section>
  `;
}

function DepthLadder({ depth, symbols, selected, onSelect }) {
  const book = (depth || []).find((d) => d && d.symbol === selected);
  const asks = book ? book.asks.slice(0, 8) : [];
  const bids = book ? book.bids.slice(0, 8) : [];
  const maxSize = Math.max(
    1e-9,
    ...asks.map((a) => a.size),
    ...bids.map((b) => b.size)
  );
  const spread = book && asks[0] && bids[0] ? asks[0].price - bids[0].price : null;
  return html`
    <section class="card">
      <div class="card-head">
        <h2>Order Book Depth</h2>
        <div class="symbol-tabs">
          ${(symbols || []).map(
            (s) => html`
              <button
                key=${s}
                class=${`tab ${s === selected ? 'active' : ''}`}
                onClick=${() => onSelect(s)}
              >
                ${s.replace('USDT', '')}
              </button>
            `
          )}
        </div>
      </div>
      <div class="ladder">
        ${asks
          .slice()
          .reverse()
          .map(
            (a, i) => html`
              <div key=${`a${i}`} class="ladder-row ask">
                <div class="depth-bar ask" style=${{ width: `${(a.size / maxSize) * 100}%` }}></div>
                <span class="lp">${fmt(a.price, 2)}</span>
                <span class="ls">${fmt(a.size, 3)}</span>
              </div>
            `
          )}
        <div class="ladder-mid">
          spread ${spread != null ? fmt(spread, 2) : '—'}
        </div>
        ${bids.map(
          (b, i) => html`
            <div key=${`b${i}`} class="ladder-row bid">
              <div class="depth-bar bid" style=${{ width: `${(b.size / maxSize) * 100}%` }}></div>
              <span class="lp">${fmt(b.price, 2)}</span>
              <span class="ls">${fmt(b.size, 3)}</span>
            </div>
          `
        )}
      </div>
    </section>
  `;
}

function Positions({ positions }) {
  const rows = positions || [];
  return html`
    <section class="card">
      <div class="card-head"><h2>Positions</h2></div>
      <table class="grid">
        <thead>
          <tr><th>Symbol</th><th>Qty</th><th>Avg</th><th>Mark</th><th>uPnL</th></tr>
        </thead>
        <tbody>
          ${rows.length === 0
            ? html`<tr><td colspan="5" class="muted center">flat — no open positions</td></tr>`
            : rows.map(
                (p) => html`
                  <tr key=${p.symbol}>
                    <td>${p.symbol}</td>
                    <td class=${signClass(p.qty)}>${fmt(p.qty, 4)}</td>
                    <td>${fmt(p.avgPrice)}</td>
                    <td>${fmt(p.markPrice)}</td>
                    <td class=${signClass(p.unrealizedPnl)}>${fmt(p.unrealizedPnl)}</td>
                  </tr>
                `
              )}
        </tbody>
      </table>
    </section>
  `;
}

function OrderTicket({ symbols, prices }) {
  const [symbol, setSymbol] = useState(symbols[0] || 'BTCUSDT');
  const [side, setSide] = useState('BUY');
  const [type, setType] = useState('MARKET');
  const [qty, setQty] = useState('0.05');
  const [price, setPrice] = useState('');
  const [msg, setMsg] = useState(null);

  useEffect(() => {
    if (symbols.length && !symbols.includes(symbol)) setSymbol(symbols[0]);
  }, [symbols]);

  const submit = async (e) => {
    e.preventDefault();
    const px = prices.find((p) => p.symbol === symbol);
    const body = {
      symbol,
      side,
      type,
      qty: Number(qty),
      price: type === 'LIMIT' ? Number(price || (px && px.price)) : undefined,
    };
    const res = await postJSON('/api/orders', body);
    setMsg(
      res.status === 'REJECTED'
        ? `rejected: ${res.reject}`
        : `${res.status} ${res.side} ${res.qty} ${res.symbol}`
    );
    setTimeout(() => setMsg(null), 2500);
  };

  return html`
    <section class="card">
      <div class="card-head"><h2>Order Ticket</h2></div>
      <form class="ticket" onSubmit=${submit}>
        <label>Symbol
          <select value=${symbol} onChange=${(e) => setSymbol(e.target.value)}>
            ${symbols.map((s) => html`<option key=${s} value=${s}>${s}</option>`)}
          </select>
        </label>
        <div class="seg">
          <button
            type="button"
            class=${`seg-btn buy ${side === 'BUY' ? 'active' : ''}`}
            onClick=${() => setSide('BUY')}
          >Buy</button>
          <button
            type="button"
            class=${`seg-btn sell ${side === 'SELL' ? 'active' : ''}`}
            onClick=${() => setSide('SELL')}
          >Sell</button>
        </div>
        <label>Type
          <select value=${type} onChange=${(e) => setType(e.target.value)}>
            <option value="MARKET">Market</option>
            <option value="LIMIT">Limit</option>
          </select>
        </label>
        <label>Qty
          <input value=${qty} onChange=${(e) => setQty(e.target.value)} inputmode="decimal" />
        </label>
        ${type === 'LIMIT'
          ? html`<label>Limit Price
              <input value=${price} onChange=${(e) => setPrice(e.target.value)} inputmode="decimal" placeholder="mid" />
            </label>`
          : null}
        <button type="submit" class=${`submit ${side.toLowerCase()}`}>
          ${side} ${symbol.replace('USDT', '')}
        </button>
        ${msg ? html`<div class="ticket-msg">${msg}</div>` : null}
      </form>
    </section>
  `;
}

const STATUS_TONE = {
  NEW: 'info',
  PARTIALLY_FILLED: 'warn',
  FILLED: 'pos',
  CANCELLED: 'muted',
  REJECTED: 'neg',
};

function Blotter({ orders }) {
  const rows = orders || [];
  const cancel = (id) => postJSON(`/api/orders/${id}/cancel`);
  const isOpen = (s) => s === 'NEW' || s === 'PARTIALLY_FILLED';
  return html`
    <section class="card grow">
      <div class="card-head"><h2>Order Blotter</h2><span class="muted">latest 40</span></div>
      <table class="grid">
        <thead>
          <tr><th>ID</th><th>Symbol</th><th>Side</th><th>Type</th><th>Qty</th><th>Filled</th><th>Status</th><th>Src</th><th></th></tr>
        </thead>
        <tbody>
          ${rows.length === 0
            ? html`<tr><td colspan="9" class="muted center">no orders yet — place one or enable a strategy</td></tr>`
            : rows.map(
                (o) => html`
                  <tr key=${o.id}>
                    <td class="mono">${o.id}</td>
                    <td>${o.symbol.replace('USDT', '')}</td>
                    <td class=${o.side === 'BUY' ? 'pos' : 'neg'}>${o.side}</td>
                    <td>${o.type}</td>
                    <td>${fmt(o.qty, 4)}</td>
                    <td>${fmt(o.filled, 4)}</td>
                    <td><span class=${`badge ${STATUS_TONE[o.status] || ''}`}>${o.status}</span></td>
                    <td class="muted">${o.source}</td>
                    <td>
                      ${isOpen(o.status)
                        ? html`<button class="mini" onClick=${() => cancel(o.id)}>✕</button>`
                        : null}
                    </td>
                  </tr>
                `
              )}
        </tbody>
      </table>
    </section>
  `;
}

// ---- app root -----------------------------------------------------------------
function App() {
  const { snap, connected } = useLiveState();
  const [selected, setSelected] = useState('BTCUSDT');

  const symbols = snap ? snap.prices.map((p) => p.symbol) : [];
  useEffect(() => {
    if (symbols.length && !symbols.includes(selected)) setSelected(symbols[0]);
  }, [symbols.join(',')]);

  if (!snap) {
    return html`<div class="loading">Connecting to trade engine…</div>`;
  }

  return html`
    <div class="app">
      <${Header}
        portfolio=${snap.portfolio}
        connected=${connected}
        connections=${snap.connections}
      />
      <div class="ticker-strip">
        ${snap.prices.map(
          (p) => html`
            <div key=${p.symbol} class="ticker">
              <span class="tk-sym">${p.symbol.replace('USDT', '')}</span>
              <span class="tk-px">$${fmt(p.price)}</span>
            </div>
          `
        )}
      </div>
      <main class="layout">
        <div class="col">
          <${StrategyPanel} strategies=${snap.strategies} />
          <${OrderTicket} symbols=${symbols} prices=${snap.prices} />
          <${Positions} positions=${snap.portfolio.positions} />
        </div>
        <div class="col wide">
          <${EquityChart} history=${snap.equityHistory} />
          <${DepthLadder}
            depth=${snap.depth}
            symbols=${symbols}
            selected=${selected}
            onSelect=${setSelected}
          />
          <${Blotter} orders=${snap.orders} />
        </div>
      </main>
      <footer class="foot">
        Simulated market data · paper fills only · no live exchange keys.
        Swap <code>server/exchange/binanceAdapter.js</code> to stream a real venue.
      </footer>
    </div>
  `;
}

ReactDOM.createRoot(document.getElementById('root')).render(html`<${App} />`);
