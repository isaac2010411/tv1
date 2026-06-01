'use strict'

const { Decimal } = require('../../../shared/utils/decimal')

/**
 * Domain Service: tracks Cumulative Volume Delta (CVD) for a symbol.
 *
 * CVD = running sum of (buy aggressor volume − sell aggressor volume).
 * – buy  aggressor trade (isBuyerMaker === false): delta = +qty
 * – sell aggressor trade (isBuyerMaker === true):  delta = −qty
 *
 * Additionally maintains time-bucketed CVD for four windows:
 *   1s  – ultra-short read
 *   1m  – footprint / scalping context
 *   5m  – intraday structure
 *   15m – session reference
 *
 * Stateful; one instance per subscribed symbol.
 */
class CvdService {
  /** Window durations in milliseconds */
  static BUCKET_WINDOWS = {
    '1s':  1_000,
    '1m':  60_000,
    '5m':  300_000,
    '15m': 900_000,
  }

  /**
   * @param {object} params
   * @param {string} params.symbol
   */
  constructor({ symbol }) {
    this.symbol = symbol
    this._cvd   = new Decimal(0)

    /**
     * Per-window state: { startMs, buyVolume, sellVolume }
     * @type {Map<string, { startMs: number, buyVolume: Decimal, sellVolume: Decimal }>}
     */
    this._buckets = new Map()
    const now = Date.now()
    for (const [label] of Object.entries(CvdService.BUCKET_WINDOWS)) {
      this._buckets.set(label, { startMs: now, buyVolume: new Decimal(0), sellVolume: new Decimal(0) })
    }
  }

  // ─── Public API ───────────────────────────────────────────────────────────────

  /**
   * Record a single aggressor trade and return the updated CVD state.
   *
   * @param {{ price: string|number, qty: string|number, isBuyerMaker: boolean, time: number }} trade
   * @returns {{
   *   cvd:     string,
   *   delta:   string,
   *   price:   string,
   *   side:    'buy'|'sell',
   *   time:    number,
   *   buckets: object,
   * }}
   */
  addTrade(trade) {
    const qty   = new Decimal(trade.qty)
    const delta = trade.isBuyerMaker ? qty.neg() : qty

    this._cvd = this._cvd.plus(delta)

    const now      = trade.time ?? Date.now()
    const isBuy    = !trade.isBuyerMaker
    const buckets  = this._updateBuckets(qty, isBuy, now)

    const point = {
      time: now,
      cvd: Number(this._cvd.toFixed(4)),
      delta: Number(delta.toFixed(4)),
      price: String(trade.price),
      side: isBuy ? 'buy' : 'sell',
    }

    return {
      cvd:     this._cvd.toFixed(4),
      delta:   delta.toFixed(4),
      price:   String(trade.price),
      side:    isBuy ? 'buy' : 'sell',
      time:    now,
      buckets,
      point,
    }
  }

  /** @returns {string} current CVD value as fixed-point string */
  getCvd() {
    return this._cvd.toFixed(4)
  }

  /**
   * Returns a snapshot of all bucket values, rolling over expired windows first.
   * @returns {object} label → { buyVolume, sellVolume, delta, cvd, startMs }
   */
  getBuckets() {
    const now = Date.now()
    this._rollBuckets(now)

    const out = {}
    for (const [label, bucket] of this._buckets) {
      const buyVol  = bucket.buyVolume
      const sellVol = bucket.sellVolume
      out[label] = {
        buyVolume:  buyVol.toFixed(4),
        sellVolume: sellVol.toFixed(4),
        delta:      buyVol.minus(sellVol).toFixed(4),
        startMs:    bucket.startMs,
      }
    }
    return out
  }

  /** Reset accumulated CVD and all buckets (e.g. on new trading session). */
  reset() {
    this._cvd = new Decimal(0)
    const now = Date.now()
    for (const [label] of this._buckets) {
      this._buckets.set(label, { startMs: now, buyVolume: new Decimal(0), sellVolume: new Decimal(0) })
    }
  }

  // ─── Internal ─────────────────────────────────────────────────────────────────

  _rollBuckets(now) {
    for (const [label, bucket] of this._buckets) {
      const windowMs = CvdService.BUCKET_WINDOWS[label]
      if (now - bucket.startMs >= windowMs) {
        this._buckets.set(label, { startMs: now, buyVolume: new Decimal(0), sellVolume: new Decimal(0) })
      }
    }
  }

  _updateBuckets(qty, isBuy, now) {
    this._rollBuckets(now)

    for (const bucket of this._buckets.values()) {
      if (isBuy) {
        bucket.buyVolume = bucket.buyVolume.plus(qty)
      } else {
        bucket.sellVolume = bucket.sellVolume.plus(qty)
      }
    }

    return this.getBuckets()
  }
}

module.exports = { CvdService }
