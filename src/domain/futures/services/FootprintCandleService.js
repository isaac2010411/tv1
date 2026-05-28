'use strict'

const { FootprintCandle } = require('../entities/FootprintCandle')
const { RingBuffer } = require('../../../shared/utils/RingBuffer')

/**
 * Domain Service: builds and maintains FootprintCandle history for one
 * symbol + interval combination.
 *
 * – Accumulates aggressor trades into the currently open FootprintCandle.
 * – Syncs OHLCV from the candle stream (more reliable for open/close prices).
 * – When `isFinal === true` arrives, the current candle is finalised and
 *   pushed to history; a new blank candle is opened immediately.
 * – History is capped at `maxHistory` finalized candles (ring-buffer behaviour).
 *
 * Stateful; one instance per (symbol, interval) pair.
 */
class FootprintCandleService {
  /**
   * @param {object} params
   * @param {string} params.symbol
   * @param {string} params.interval
   * @param {string} params.tickSize    Price increment for level bucketing
   * @param {number} [params.maxHistory] Max finalised candles to keep in memory (default 200)
   */
  constructor({ symbol, interval, tickSize, maxHistory = 200 }) {
    this.symbol = symbol
    this.interval = interval
    this.tickSize = tickSize
    this.maxHistory = maxHistory

    /** Pre-computed interval duration in ms for provisional candle alignment. */
    this._intervalMs = FootprintCandleService._intervalToMs(interval)

    /** @type {FootprintCandle|null} */
    this._current = null

    /** @type {FootprintCandle[]} Oldest → newest */
    this._history = new RingBuffer(maxHistory)

    /** @type {number|null} Latest finalized candle openTime to reject stale reopens. */
    this._lastFinalizedOpenTime = null
  }

  // ─── Static helpers ──────────────────────────────────────────────────────────

  static _intervalToMs(interval) {
    const m = /^(\d+)([smhdw])$/.exec(interval ?? '')
    if (!m) return 0
    const n = parseInt(m[1], 10)
    const units = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }
    return n * (units[m[2]] ?? 0)
  }

  _getOrCreateCurrent(openTime) {
    if (!this._current || (openTime !== undefined && this._current.openTime !== openTime)) {
      // openTime changed → the previous candle was finalised externally; open a new one
      if (this._current && !this._current.isFinal) {
        this._finalise()
      }
      this._current = new FootprintCandle({
        symbol: this.symbol,
        interval: this.interval,
        openTime: openTime ?? Date.now(),
        tickSize: this.tickSize,
      })
    }
    return this._current
  }

  _finalise() {
    if (!this._current) return
    this._current.finalize()
    this._history.push(this._current)
    this._lastFinalizedOpenTime = this._current.openTime
  }

  // ─── Public API ───────────────────────────────────────────────────────────────

  /**
   * Feed a raw aggressor trade into the current open candle.
   *
   * If no candle exists yet (kline stream hasn't established the canonical
   * openTime), a provisional candle is created using the trade's own timestamp
   * rounded to the interval boundary.  When the first kline event arrives
   * afterwards, syncOhlcv() will align the OHLCV data without losing the
   * already-accumulated trade volume.
   *
   * @param {{ price: string|number, qty: string|number, isBuyerMaker: boolean, time: number }} trade
   */
  updateFromTrade(trade) {
    if (!this._current) {
      // Create a provisional candle aligned to the interval boundary so that
      // trades are not silently discarded before the kline stream connects.
      const tradeTs = trade.time ?? Date.now()
      const intervalMs = this._intervalMs
      const provisionalOpenTime = intervalMs > 0 ? Math.floor(tradeTs / intervalMs) * intervalMs : tradeTs
      if (
        this._lastFinalizedOpenTime != null &&
        Number.isFinite(Number(provisionalOpenTime)) &&
        provisionalOpenTime <= this._lastFinalizedOpenTime
      ) {
        return
      }
      this._current = new FootprintCandle({
        symbol: this.symbol,
        interval: this.interval,
        openTime: provisionalOpenTime,
        tickSize: this.tickSize,
      })
    }
    this._current.addTrade(trade.price, trade.qty, trade.isBuyerMaker)
  }

  /**
   * Feed a candle stream update.
   * If `isFinal` is true the current footprint candle is finalised and a new
   * one opened for the next period.
   *
   * @param {{ openTime: number, open: string, high: string, low: string, close: string, volume: string, isFinal: boolean }} candle
   */
  updateFromCandle(candle) {
    const openTime = Number(candle?.openTime)
    if (!Number.isFinite(openTime) || openTime <= 0) return

    if (this._lastFinalizedOpenTime != null && openTime <= this._lastFinalizedOpenTime) {
      return
    }
    if (this._current && openTime < this._current.openTime) {
      return
    }

    const current = this._getOrCreateCurrent(candle.openTime)
    current.syncOhlcv(candle)

    if (candle.isFinal) {
      this._finalise()
      this._current = null // Will be created fresh on next trade or candle
    }
  }

  /**
   * The currently open (incomplete) footprint candle, or null if none started yet.
   * @returns {FootprintCandle|null}
   */
  getCurrent() {
    return this._current
  }

  /**
   * The last N finalised footprint candles (oldest first).
   * @param {number} [n]
   * @returns {FootprintCandle[]}
   */
  getHistory(n = 100) {
    const all = this._history.toArray()
    return all.slice(-n)
  }

  /** Clear all state (call on unsubscribe). */
  reset() {
    this._current = null
    this._history.clear()
    this._lastFinalizedOpenTime = null
  }
}

module.exports = { FootprintCandleService }
