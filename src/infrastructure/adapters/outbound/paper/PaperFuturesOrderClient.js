'use strict'

/**
 * PaperFuturesOrderClient — outbound execution adapter for paper trading mode.
 *
 * Simulates immediate fills at the current market price obtained from the
 * injected {@link FuturesMarketDataPort}. For LIMIT orders the supplied price
 * is used; if it is missing or non-positive the order is rejected.
 *
 * In a future iteration a {@link BinanceFuturesOrderClient} can be swapped in
 * by the composition root when `TRADING_MODE=live`.
 */
class PaperFuturesOrderClient {
  /**
   * @param {object} deps
   * @param {object} deps.marketDataPort  must expose `getMarkPrice(symbol)` or `getCandles(symbol, '1m', 1)`.
   */
  constructor({ marketDataPort }) {
    this.marketDataPort = marketDataPort
  }

  async _resolvePrice(symbol, type, suppliedPrice) {
    if (type === 'LIMIT') {
      const p = Number(suppliedPrice)
      if (!Number.isFinite(p) || p <= 0) {
        throw new Error('LIMIT order requires a positive price')
      }
      return p
    }
    // MARKET — use latest close from 1m candles as a stable mark.
    if (typeof this.marketDataPort?.getMarkPrice === 'function') {
      const mp = await this.marketDataPort.getMarkPrice(symbol)
      const price = Number(mp?.markPrice ?? mp?.price ?? mp)
      if (Number.isFinite(price) && price > 0) return price
    }
    if (typeof this.marketDataPort?.getCandles === 'function') {
      const candles = await this.marketDataPort.getCandles(symbol, '1m', 1)
      const last = Array.isArray(candles) && candles.length ? candles[candles.length - 1] : null
      const close = Number(last?.close ?? last?.c)
      if (Number.isFinite(close) && close > 0) return close
    }
    throw new Error(`Unable to resolve market price for ${symbol}`)
  }

  /**
   * @param {object} order { orderId, symbol, side, type, quantity, price? }
   * @returns {Promise<{ status:'FILLED'|'REJECTED', fills:Array, reason?:string }>}
   */
  async submit(order) {
    try {
      const price = await this._resolvePrice(order.symbol, order.type, order.price)
      const fill = {
        price,
        quantity: Number(order.quantity),
        timestamp: Date.now(),
      }
      return { status: 'FILLED', fills: [fill] }
    } catch (err) {
      return { status: 'REJECTED', fills: [], reason: err.message }
    }
  }

  /** Paper orders are filled synchronously, so cancel is a no-op success. */
  // eslint-disable-next-line no-unused-vars
  async cancel(orderId) {
    return { ok: true }
  }
}

module.exports = { PaperFuturesOrderClient }
