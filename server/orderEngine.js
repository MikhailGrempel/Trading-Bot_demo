'use strict';

/**
 * Order lifecycle + a lightweight matching engine.
 *
 * Order state machine:
 *   NEW -> PARTIALLY_FILLED -> FILLED
 *   NEW/PARTIALLY_FILLED -> CANCELLED
 *   NEW -> REJECTED   (validation failure)
 *
 * MARKET orders fill immediately at the current touch. LIMIT orders rest until
 * the simulated market trades through their price, then fill (in slices, so the
 * PARTIALLY_FILLED state is exercised). Every transition emits `orderUpdate`,
 * and fills are pushed into the Portfolio.
 */

const { EventEmitter } = require('events');

let SEQ = 1;

const TERMINAL = new Set(['FILLED', 'CANCELLED', 'REJECTED']);

class OrderEngine extends EventEmitter {
  constructor(marketData, portfolio) {
    super();
    this.market = marketData;
    this.portfolio = portfolio;
    /** @type {Map<string, object>} */
    this.orders = new Map();
    this.market.on('tick', (t) => this._onTick(t));
  }

  /**
   * Place an order. `source` distinguishes manual tickets from strategy orders.
   * Returns the created order (which may already be REJECTED).
   */
  place({ symbol, side, type, price, qty, source = 'manual' }) {
    const id = `o${SEQ++}`;
    const now = Date.now();
    const order = {
      id,
      symbol,
      side,
      type,
      price: price != null ? Number(price) : null,
      qty: Number(qty),
      filled: 0,
      avgFillPrice: 0,
      status: 'NEW',
      source,
      createdAt: now,
      updatedAt: now,
    };

    const err = this._validate(order);
    if (err) {
      order.status = 'REJECTED';
      order.reject = err;
      this.orders.set(id, order);
      this.emit('orderUpdate', order);
      return order;
    }

    this.orders.set(id, order);
    this.emit('orderUpdate', order);

    if (order.type === 'MARKET') {
      const px = this._touchPrice(symbol, side);
      if (px != null) this._fill(order, order.qty, px);
    }
    return order;
  }

  cancel(id) {
    const order = this.orders.get(id);
    if (!order || TERMINAL.has(order.status)) return null;
    order.status = 'CANCELLED';
    order.updatedAt = Date.now();
    this.emit('orderUpdate', order);
    return order;
  }

  openOrders() {
    return [...this.orders.values()].filter((o) => !TERMINAL.has(o.status));
  }

  /** Recent orders, newest first, capped for the UI. */
  recent(limit = 40) {
    return [...this.orders.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit);
  }

  _validate(order) {
    if (!this.market.symbols.includes(order.symbol)) return 'unknown symbol';
    if (order.side !== 'BUY' && order.side !== 'SELL') return 'bad side';
    if (order.type !== 'LIMIT' && order.type !== 'MARKET') return 'bad type';
    if (!(order.qty > 0)) return 'qty must be positive';
    if (order.type === 'LIMIT' && !(order.price > 0)) return 'limit needs price';
    return null;
  }

  _touchPrice(symbol, side) {
    const price = this.market.getPrice(symbol);
    if (price == null) return null;
    // Buyers lift the ask, sellers hit the bid — approximate with the mid.
    return price;
  }

  _onTick(tick) {
    for (const order of this.orders.values()) {
      if (TERMINAL.has(order.status) || order.type !== 'LIMIT') continue;
      if (order.symbol !== tick.symbol) continue;
      const crosses =
        order.side === 'BUY'
          ? tick.bestAsk <= order.price
          : tick.bestBid >= order.price;
      if (!crosses) continue;

      // Fill in slices so PARTIALLY_FILLED is a real state, not a formality:
      // the first cross fills half, a later cross fills the remainder.
      const remaining = order.qty - order.filled;
      const fillQty = order.filled === 0 ? remaining * 0.5 : remaining;
      this._fill(order, fillQty, order.price);
    }
  }

  _fill(order, qty, price) {
    if (qty <= 0) return;
    const prevFilled = order.filled;
    order.avgFillPrice =
      (prevFilled * order.avgFillPrice + qty * price) / (prevFilled + qty);
    order.filled = +(order.filled + qty).toFixed(8);
    order.status = order.filled + 1e-8 >= order.qty ? 'FILLED' : 'PARTIALLY_FILLED';
    order.updatedAt = Date.now();

    const realized = this.portfolio.applyFill(order.symbol, order.side, qty, price);
    this.emit('fill', { order, qty, price, realized });
    this.emit('orderUpdate', order);
  }
}

module.exports = { OrderEngine };
