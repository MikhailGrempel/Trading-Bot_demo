'use strict';

/**
 * Kraken exchange adapter (reference).
 *
 * The client's bot runs on the Kraken API with a dry-run mode. This adapter
 * mirrors that venue behind the exact same contract the rest of the app uses:
 * it emits `tick` ({ symbol, price, bestBid, bestAsk, ts }), identical to the
 * simulator and the Binance adapter — so switching venues never ripples past
 * this file.
 *
 * Market data: Kraken WebSocket API v2 (`wss://ws.kraken.com/v2`), `ticker`
 * channel. Order routing: Kraken REST `AddOrder` / `CancelOrder`, with the
 * `validate` flag used as the dry-run switch (Kraken evaluates the order and
 * returns what it *would* do without ever placing it) — that maps directly onto
 * the "dry mode for testing" the client described.
 *
 * Kept inert in the demo (USE_LIVE=false, no keys) so the project stays
 * dependency-free and never touches a live venue. Provide a WebSocket client
 * and credentials to go live.
 */

const { EventEmitter } = require('events');

const USE_LIVE = false; // demo stays on the simulator
const WS_V2_URL = 'wss://ws.kraken.com/v2';
const REST_BASE = 'https://api.kraken.com';

class KrakenMarketData extends EventEmitter {
  /**
   * @param {string[]} symbols Kraken pair names, e.g. ['BTC/USD', 'ETH/USD']
   * @param {object}   deps    inject a WebSocket implementation to go live
   */
  constructor(symbols, { WebSocketImpl = null } = {}) {
    super();
    this.symbols = symbols;
    this.WebSocketImpl = WebSocketImpl;
    this.ws = null;
  }

  start() {
    if (!USE_LIVE || !this.WebSocketImpl) {
      throw new Error(
        'KrakenMarketData is a reference adapter. Provide a WebSocket ' +
          'implementation and set USE_LIVE=true to stream real Kraken data.'
      );
    }
    this.ws = new this.WebSocketImpl(WS_V2_URL);
    this.ws.on('open', () => {
      this.ws.send(
        JSON.stringify({
          method: 'subscribe',
          params: { channel: 'ticker', symbol: this.symbols },
        })
      );
    });
    this.ws.on('message', (raw) => this._onMessage(raw));
    this.ws.on('close', () => this.emit('disconnected'));
  }

  _onMessage(raw) {
    const msg = JSON.parse(raw);
    // Kraken WS v2 ticker: { channel:"ticker", type:"update"|"snapshot",
    //   data:[{ symbol:"BTC/USD", bid, ask, last, ... }] }
    if (msg.channel !== 'ticker' || !Array.isArray(msg.data)) return;
    for (const d of msg.data) {
      const bestBid = Number(d.bid);
      const bestAsk = Number(d.ask);
      this.emit('tick', {
        symbol: d.symbol,
        price: d.last != null ? Number(d.last) : (bestBid + bestAsk) / 2,
        bestBid,
        bestAsk,
        ts: Date.now(),
      });
    }
  }

  stop() {
    if (this.ws) this.ws.close();
    this.ws = null;
  }
}

/**
 * Reference order router for Kraken REST. `dryRun` toggles Kraken's native
 * `validate` flag — the same idea as the bot's existing dry mode. Signing and
 * transport are intentionally left as injected dependencies so this file has no
 * third-party imports in the demo.
 *
 * @param {object} deps.signedFetch  (path, payload) => Promise<json>, adds the
 *   API-Key / API-Sign headers and nonce Kraken requires on private endpoints.
 */
function createKrakenRouter({ signedFetch, dryRun = true } = {}) {
  if (typeof signedFetch !== 'function') {
    throw new Error('createKrakenRouter needs a signedFetch implementation.');
  }
  return {
    restBase: REST_BASE,
    async placeOrder({ pair, side, ordertype, volume, price }) {
      // AddOrder: type=buy|sell, ordertype=market|limit|..., validate=dry-run
      return signedFetch('/0/private/AddOrder', {
        pair,
        type: side, // 'buy' | 'sell'
        ordertype, // 'market' | 'limit' | 'stop-loss' | ...
        volume: String(volume),
        ...(price != null ? { price: String(price) } : {}),
        validate: dryRun, // true => Kraken validates without placing (dry mode)
      });
    },
    async cancelOrder(txid) {
      return signedFetch('/0/private/CancelOrder', { txid });
    },
  };
}

module.exports = { KrakenMarketData, createKrakenRouter, USE_LIVE };
