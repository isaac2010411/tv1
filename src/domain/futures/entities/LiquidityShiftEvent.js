'use strict'

/**
 * Value Object: a detected liquidity shift event.
 *
 * A "shift" is a significant change in the order book wall structure:
 * – WALL_ADDED:   a price level's qty crossed the wall threshold from below
 * – WALL_REMOVED: a wall-sized level dropped below the wall threshold (filled or cancelled)
 * Immutable once created.
 */
class LiquidityShiftEvent {
  /**
   * @param {object} params
   * @param {string}              params.symbol
   * @param {'bid'|'ask'}         params.side
   * @param {string}              params.price       String-formatted price
   * @param {string}              params.qty         Current quantity at that level
   * @param {'WALL_ADDED'|'WALL_REMOVED'} params.type
   * @param {boolean}             [params.nearMid]   Whether the wall is near the mid price
   * @param {'HIGH'|'MEDIUM'|'LOW'} [params.severity] Relative impact severity
   * @param {number}              params.timestamp   Unix ms
   */
  constructor({ symbol, side, price, qty, type, nearMid = false, severity = 'LOW', timestamp }) {
    this.symbol    = symbol
    this.side      = side
    this.price     = price
    this.qty       = qty
    this.type      = type
    this.nearMid   = nearMid
    this.severity  = severity
    this.timestamp = timestamp

    Object.freeze(this)
  }

  toPlainObject() {
    return {
      symbol:    this.symbol,
      side:      this.side,
      price:     this.price,
      qty:       this.qty,
      type:      this.type,
      nearMid:   this.nearMid,
      severity:  this.severity,
      timestamp: this.timestamp,
    }
  }
}

module.exports = { LiquidityShiftEvent }
