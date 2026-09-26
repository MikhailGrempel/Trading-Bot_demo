'use strict';

/**
 * Simulated market-data feed.
 *
 * Emits `tick` ({ symbol, price, bestBid, bestAsk, ts }) and exposes an order
 * book (`getDepth`) for each symbol. The random-walk generator stands in for a
 * live exchange stream; `server/exchange/binanceAdapter.js` documents where a
 * real Binance WebSocket would replace it while keeping this same event shape.
 */

const { EventEmitter } = require('events');

const DEFAULT_SYMBOLS = [
  { symbol: 'BTCUSDT', price: 64000, vol: 0.0009, tick: 0.5 },
  { symbol: 'ETHUSDT', price: 3200, vol: 0.0012, tick: 0.05 },
  { symbol: 'SOLUSDT', price: 148, vol: 0.0018, tick: 0.01 },
];

const DEPTH_LEVELS = 12;

function round(value, step) {
  return Math.round(value / step) * step;
}

class MarketData extends EventEmitter {
  constructor(symbols = DEFAULT_SYMBOLS, { intervalMs = 700 } = {}) {
    super();
    this.intervalMs = intervalMs;
    /** @type {Map<string, {price:number, vol:number, tick:number, bestBid:number, bestAsk:number}>} */
    this.books = new Map();
    for (const s of symbols) {
      this.books.set(s.symbol, {
        price: s.price,
        vol: s.vol,
        tick: s.tick,
        bestBid: s.price - s.tick,
        bestAsk: s.price + s.tick,
      });
    }
    this._timer = null;
  }

  get symbols() {
    return [...this.books.keys()];
  }

  getPrice(symbol) {
    const b = this.books.get(symbol);
    return b ? b.price : null;
  }

  /** Build a synthetic order book around the current mid price. */
  getDepth(symbol) {
    const b = this.books.get(symbol);
    if (!b) return null;
    const bids = [];
    const asks = [];
    for (let i = 1; i <= DEPTH_LEVELS; i += 1) {
      const bidPrice = round(b.bestBid - (i - 1) * b.tick, b.tick);
      const askPrice = round(b.bestAsk + (i - 1) * b.tick, b.tick);
      // Sizes taper away from the touch, with a little noise for realism.
      const decay = Math.exp(-i / 6);
      const bidSize = +(decay * (1 + Math.random()) * 4).toFixed(4);
      const askSize = +(decay * (1 + Math.random()) * 4).toFixed(4);
      bids.push({ price: bidPrice, size: bidSize });
      asks.push({ price: askPrice, size: askSize });
    }
    return { symbol, bids, asks, ts: Date.now() };
  }

  start() {
    if (this._timer) return;
    this._timer = setInterval(() => this._step(), this.intervalMs);
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  _step() {
    const ts = Date.now();
    for (const [symbol, b] of this.books) {
      // Gaussian-ish shock via central limit of two uniforms.
      const shock = (Math.random() + Math.random() - 1) * b.vol;
      b.price = Math.max(b.tick, round(b.price * (1 + shock), b.tick));
      const spread = b.tick * (1 + Math.floor(Math.random() * 3));
      b.bestBid = round(b.price - spread, b.tick);
      b.bestAsk = round(b.price + spread, b.tick);
      this.emit('tick', {
        symbol,
        price: b.price,
        bestBid: b.bestBid,
        bestAsk: b.bestAsk,
        ts,
      });
    }
  }
}

module.exports = { MarketData, DEFAULT_SYMBOLS };
