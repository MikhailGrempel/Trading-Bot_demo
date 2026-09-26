'use strict';

/**
 * Exchange adapter boundary.
 *
 * The brief says exchange integration (Binance, Coinbase, ...) is already wired
 * up and that swapping/extending endpoints is part of the job. This file is the
 * seam that makes that a one-file change: the rest of the app only depends on
 * the MarketData event shape (`tick` with { symbol, price, bestBid, bestAsk }),
 * so a real adapter just has to emit the same events.
 *
 * Below is a *reference* Binance combined-stream adapter. It is intentionally
 * inert in the demo (no key required, not started) to keep the project running
 * with zero dependencies and zero live-exchange calls. Flip USE_LIVE and give
 * it a WebSocket client to go live against real market data.
 *
 *   const feed = new BinanceMarketData(['btcusdt', 'ethusdt']);
 *   feed.on('tick', t => ...)   // same contract as the simulator
 *
 * Order routing would live alongside this (signed REST for placement, the user
 * data stream for fills) behind the same OrderEngine interface used here.
 */

const { EventEmitter } = require('events');

const USE_LIVE = false; // demo stays on the simulator; set true with a WS client wired in

const COMBINED_STREAM_BASE = 'wss://stream.binance.com:9443/stream?streams=';

class BinanceMarketData extends EventEmitter {
  /**
   * @param {string[]} symbols lower-case symbols, e.g. ['btcusdt']
   * @param {object}   deps    inject a WebSocket implementation to go live
   */
  constructor(symbols, { WebSocketImpl = null } = {}) {
    super();
    this.symbols = symbols;
    this.WebSocketImpl = WebSocketImpl;
    this.ws = null;
  }

  /** Build the combined book-ticker stream URL for all subscribed symbols. */
  streamUrl() {
    const streams = this.symbols.map((s) => `${s}@bookTicker`).join('/');
    return COMBINED_STREAM_BASE + streams;
  }

  start() {
    if (!USE_LIVE || !this.WebSocketImpl) {
      throw new Error(
        'BinanceMarketData is a reference adapter. Provide a WebSocket ' +
          'implementation and set USE_LIVE=true to stream real data.'
      );
    }
    this.ws = new this.WebSocketImpl(this.streamUrl());
    this.ws.on('message', (raw) => this._onMessage(raw));
    this.ws.on('close', () => this.emit('disconnected'));
  }

  _onMessage(raw) {
    // Binance bookTicker payload: { b: bestBid, B: bidQty, a: bestAsk, A: askQty }
    const msg = JSON.parse(raw);
    const d = msg.data || msg;
    const bestBid = Number(d.b);
    const bestAsk = Number(d.a);
    this.emit('tick', {
      symbol: (d.s || '').toUpperCase(),
      price: (bestBid + bestAsk) / 2,
      bestBid,
      bestAsk,
      ts: Date.now(),
    });
  }

  stop() {
    if (this.ws) this.ws.close();
    this.ws = null;
  }
}

module.exports = { BinanceMarketData, USE_LIVE };
