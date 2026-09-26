'use strict';

/**
 * Strategy registry with per-strategy on/off toggles — roadmap item #1
 * ("Add new trading strategies that can be toggled on or off from the UI").
 *
 * Each strategy keeps a short price window per symbol and, when enabled, emits
 * a signal (BUY/SELL/FLAT) plus a confidence score. Enabled strategies place
 * small orders through the OrderEngine; the confidence surfaces on the UI as a
 * lightweight analytics badge — the seam where roadmap item #3's ML models
 * would later produce the score instead of these transparent heuristics.
 */

const { EventEmitter } = require('events');

class Strategy {
  constructor({ id, name, description, window = 20 }) {
    this.id = id;
    this.name = name;
    this.description = description;
    this.enabled = false;
    this.window = window;
    /** @type {Map<string, number[]>} */
    this.history = new Map();
    this.lastSignal = new Map();
  }

  _push(symbol, price) {
    const arr = this.history.get(symbol) || [];
    arr.push(price);
    if (arr.length > this.window) arr.shift();
    this.history.set(symbol, arr);
    return arr;
  }

  // eslint-disable-next-line no-unused-vars
  evaluate(symbol, price) {
    return { signal: 'FLAT', confidence: 0 };
  }
}

/** Buys dips / sells rips relative to the rolling mean (z-score reversion). */
class MeanReversion extends Strategy {
  constructor() {
    super({
      id: 'mean-reversion',
      name: 'Mean Reversion',
      description: 'Fades stretched moves back toward the rolling mean (z-score).',
      window: 24,
    });
  }

  evaluate(symbol, price) {
    const arr = this._push(symbol, price);
    if (arr.length < this.window) return { signal: 'FLAT', confidence: 0 };
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    const variance =
      arr.reduce((a, b) => a + (b - mean) ** 2, 0) / arr.length;
    const std = Math.sqrt(variance) || 1e-9;
    const z = (price - mean) / std;
    const confidence = Math.min(1, Math.abs(z) / 2.5);
    if (z > 1.2) return { signal: 'SELL', confidence, z: +z.toFixed(2) };
    if (z < -1.2) return { signal: 'BUY', confidence, z: +z.toFixed(2) };
    return { signal: 'FLAT', confidence: +confidence.toFixed(2), z: +z.toFixed(2) };
  }
}

/** Rides short-term momentum (fast vs slow moving-average crossover). */
class Momentum extends Strategy {
  constructor() {
    super({
      id: 'momentum',
      name: 'Momentum',
      description: 'Trades in the direction of a fast/slow moving-average cross.',
      window: 30,
    });
    this.fast = 5;
    this.slow = 20;
  }

  evaluate(symbol, price) {
    const arr = this._push(symbol, price);
    if (arr.length < this.slow) return { signal: 'FLAT', confidence: 0 };
    const avg = (n) => {
      const slice = arr.slice(-n);
      return slice.reduce((a, b) => a + b, 0) / slice.length;
    };
    const fast = avg(this.fast);
    const slow = avg(this.slow);
    const spread = (fast - slow) / slow;
    const confidence = Math.min(1, Math.abs(spread) / 0.004);
    if (spread > 0.0008) return { signal: 'BUY', confidence: +confidence.toFixed(2) };
    if (spread < -0.0008) return { signal: 'SELL', confidence: +confidence.toFixed(2) };
    return { signal: 'FLAT', confidence: +confidence.toFixed(2) };
  }
}

class StrategyManager extends EventEmitter {
  constructor(marketData, orderEngine, { orderQty = { BTCUSDT: 0.05, ETHUSDT: 0.5, SOLUSDT: 10 } } = {}) {
    super();
    this.market = marketData;
    this.engine = orderEngine;
    this.orderQty = orderQty;
    this.strategies = new Map();
    /** Throttle so a strategy does not fire on every single tick. */
    this.lastOrderAt = new Map();
    this.cooldownMs = 4000;

    for (const s of [new MeanReversion(), new Momentum()]) {
      this.strategies.set(s.id, s);
    }
    this.market.on('tick', (t) => this._onTick(t));
  }

  list() {
    return [...this.strategies.values()].map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      enabled: s.enabled,
      lastSignal: [...s.lastSignal.entries()].map(([symbol, sig]) => ({
        symbol,
        ...sig,
      })),
    }));
  }

  setEnabled(id, enabled) {
    const s = this.strategies.get(id);
    if (!s) return null;
    s.enabled = !!enabled;
    this.emit('strategyUpdate', this.list());
    return s;
  }

  _onTick(tick) {
    let changed = false;
    for (const s of this.strategies.values()) {
      const result = s.evaluate(tick.symbol, tick.price);
      s.lastSignal.set(tick.symbol, result);
      changed = true;
      if (!s.enabled || result.signal === 'FLAT') continue;

      const key = `${s.id}:${tick.symbol}`;
      const last = this.lastOrderAt.get(key) || 0;
      if (Date.now() - last < this.cooldownMs) continue;
      if (result.confidence < 0.5) continue;

      this.lastOrderAt.set(key, Date.now());
      this.engine.place({
        symbol: tick.symbol,
        side: result.signal,
        type: 'MARKET',
        qty: this.orderQty[tick.symbol] || 1,
        source: s.id,
      });
    }
    if (changed) this.emit('strategyUpdate', this.list());
  }
}

module.exports = { StrategyManager };
