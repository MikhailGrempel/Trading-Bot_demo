# Trading Bot Console — Live Demo

A compact, end-to-end demo of the exact stack in your brief: a **React** dashboard
streaming live **positions, P&L, and market depth** over **WebSocket**, backed by a
**Node.js order engine** with a real order state machine and a pluggable
**exchange adapter**. Strategies can be **toggled on/off from the UI**.

It runs with **zero dependencies and zero build step** — clone and `node server/index.js`.
That mirrors the "clone the repo, spin up the containers, get going without ceremony"
workflow you described.

## Deploy (one click)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/MikhailGrempel/Trading-Bot)

The repo ships a `render.yaml` blueprint (Docker, free plan, `/api/health` check),
so Render builds and hosts it with no configuration.

## Run it

```bash
# Option A — bare Node (no install needed)
node server/index.js
# then open http://localhost:4000

# Option B — Docker
docker compose up --build
# then open http://localhost:4000
```

Requires Node 16+. No `npm install`: there are no third-party packages.

## What it demonstrates

| Roadmap item in your brief | Where it lives |
| --- | --- |
| Strategies toggled on/off from the UI | `server/strategies.js` + `StrategyPanel` in `public/app.js` |
| Real-time positions, P&L, market depth | `server/portfolio.js`, `server/marketData.js`, WebSocket push in `server/index.js` |
| Predictive analytics seam (ML entry scoring) | confidence score per strategy signal — the hook where an ML model plugs in |
| Exchange integration / swapping endpoints | `server/exchange/binanceAdapter.js` (reference Binance adapter behind the same event contract) |

## Architecture

```
Browser (React + htm, no build)
   │  REST: place / cancel orders, toggle strategies
   │  WebSocket: live snapshots (prices, depth, positions, P&L, orders, strategies)
   ▼
Node HTTP server  (server/index.js)
   ├── ws.js            hand-rolled RFC 6455 WebSocket hub (Node core only)
   ├── marketData.js    simulated feed → same event shape as a live exchange
   ├── orderEngine.js   NEW → PARTIALLY_FILLED → FILLED / CANCELLED / REJECTED
   ├── portfolio.js     avg-cost positions, realized/unrealized P&L, fees
   ├── strategies.js    registry + on/off toggles, signal + confidence
   └── exchange/binanceAdapter.js   seam to swap the sim for a real venue
```

### Design choices worth noting
- **Order state machine** exercises partial fills (limit orders fill in slices),
  not just a fill/no-fill flag.
- **P&L is auditable**: taker fees are accrued explicitly and shown, because a
  dashboard that hides fees is the first thing a trader stops trusting.
- **Exchange boundary**: the whole app depends only on a `tick` event shape, so
  going live against Binance is a one-file change (`binanceAdapter.js`), not a
  rewrite.
- **Transport parity**: WebSockets are implemented from Node primitives to match
  your stack while keeping the project dependency-free; in production this is
  where `ws`/`uWebSockets.js` would drop in for backpressure and compression.

## Safety

Everything here is **simulated market data with paper fills** — there are **no
live exchange keys** and no real orders. On a production codebase I keep live
trading behind an explicit paper/live switch, per-order and per-day limits, and a
kill switch before any strategy touches real order flow.
