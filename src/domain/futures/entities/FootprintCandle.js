'use strict'

const { Decimal } = require('../../../shared/utils/decimal')
const { DomainError } = require('../../../shared/errors/DomainError')

/**
 * Entity: a single OHLCV candle extended with per-price-level buy/sell volume.
 * Used by FootprintCandleService to accumulate trade flow within a candle period.
 *
 * All arithmetic uses Decimal.js – no native float operations.
 */
class FootprintCandle {
  /**
   * @param {object} params
   * @param {string} params.symbol
   * @param {string} params.interval
   * @param {number} params.openTime   Unix ms
   * @param {string} params.tickSize   Price increment for bucketing (e.g. '0.10')
   */
  constructor({ symbol, interval, openTime, tickSize }) {
    this.symbol   = symbol
    this.interval = interval
    this.openTime = openTime
    this.tickSize = new Decimal(tickSize)

    this.open   = null
    this.high   = null
    this.low    = null
    this.close  = null
    this.volume = new Decimal(0)
    this.isFinal = false

    /**
     * Map<roundedPrice string, { buyVol: Decimal, sellVol: Decimal }>
     * Key is the price level rounded to tickSize
     */
    this.levels = new Map()
  }

  // ─── Round a price to the nearest tickSize ──────────────────────────────────

  _bucket(price) {
    const p = new Decimal(price)
    return p.div(this.tickSize).floor().mul(this.tickSize).toFixed()
  }

  // ─── Accumulate a single aggressor trade ────────────────────────────────────

  /**
   * @param {string|number} price
   * @param {string|number} qty
   * @param {boolean}       isBuyerMaker  true = sell aggressor, false = buy aggressor
   */
  addTrade(price, qty, isBuyerMaker) {
    const bucket = this._bucket(price)
    const q      = new Decimal(qty)
    const p      = new Decimal(price)

    // OHLCV
    if (this.open === null) {
      this.open  = p
      this.high  = p
      this.low   = p
      this.close = p
    } else {
      if (p.gt(this.high)) this.high = p
      if (p.lt(this.low))  this.low  = p
      this.close = p
    }
    this.volume = this.volume.plus(q)

    // Per-level accumulation
    if (!this.levels.has(bucket)) {
      this.levels.set(bucket, { buyVol: new Decimal(0), sellVol: new Decimal(0) })
    }
    const level = this.levels.get(bucket)
    if (isBuyerMaker) {
      level.sellVol = level.sellVol.plus(q)
    } else {
      level.buyVol = level.buyVol.plus(q)
    }
  }

  /**
   * Sync OHLCV from the candle stream update (more reliable than from trades alone).
   * @param {object} candle
   * @param {string} candle.open
   * @param {string} candle.high
   * @param {string} candle.low
   * @param {string} candle.close
   * @param {string} candle.volume
   */
  syncOhlcv(candle) {
    let open
    let high
    let low
    let close
    let volume

    try {
      open = new Decimal(candle.open)
      high = new Decimal(candle.high)
      low = new Decimal(candle.low)
      close = new Decimal(candle.close)
      volume = new Decimal(candle.volume)
    } catch (err) {
      throw new DomainError(`Invalid footprint OHLCV payload: ${err.message}`, 'INVALID_FOOTPRINT_OHLCV')
    }

    if (open.lte(0) || high.lte(0) || low.lte(0) || close.lte(0) || volume.lt(0)) {
      throw new DomainError('Invalid footprint OHLCV values: non-positive price or negative volume', 'INVALID_FOOTPRINT_OHLCV')
    }
    if (high.lt(low)) {
      throw new DomainError('Invalid footprint OHLCV values: high is below low', 'INVALID_FOOTPRINT_OHLCV')
    }
    if (open.gt(high) || open.lt(low) || close.gt(high) || close.lt(low)) {
      throw new DomainError('Invalid footprint OHLCV values: open/close outside low-high range', 'INVALID_FOOTPRINT_OHLCV')
    }

    this.open = open
    this.high = high
    this.low = low
    this.close = close
    this.volume = volume
  }

  /** Mark candle as complete (no more trades will be added). */
  finalize() {
    this.isFinal = true
    return this
  }

  /** Plain serialisable object safe to emit over Socket.IO. */
  toPlainObject() {
    const levels = []
    for (const [price, { buyVol, sellVol }] of this.levels) {
      const total = buyVol.plus(sellVol)
      const delta = buyVol.minus(sellVol)
      levels.push({
        price,
        buyVol:  buyVol.toFixed(4),
        sellVol: sellVol.toFixed(4),
        total:   total.toFixed(4),
        delta:   delta.toFixed(4),
      })
    }
    // Sort ascending by price
    levels.sort((a, b) => new Decimal(a.price).cmp(new Decimal(b.price)))

    return {
      symbol:   this.symbol,
      interval: this.interval,
      openTime: this.openTime,
      open:     this.open  ? this.open.toFixed()  : null,
      high:     this.high  ? this.high.toFixed()  : null,
      low:      this.low   ? this.low.toFixed()   : null,
      close:    this.close ? this.close.toFixed()  : null,
      volume:   this.volume.toFixed(4),
      isFinal:  this.isFinal,
      levels,
    }
  }
}

module.exports = { FootprintCandle }
