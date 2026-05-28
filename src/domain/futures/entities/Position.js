'use strict'

const { Decimal } = require('../../../shared/utils/decimal')

/**
 * Entity: an open or tracked futures position for a single symbol.
 * All monetary fields use Decimal.js – never native floats.
 */
class Position {
  /**
   * @param {object} params
   * @param {string} params.symbol
   * @param {string} params.side          – "LONG" | "SHORT" | "BOTH"
   * @param {string} params.entryPrice
   * @param {string} params.positionAmt
   * @param {string} params.unrealizedPnl
   * @param {string|number} params.leverage
   * @param {string} params.marginType    – "isolated" | "cross"
   */
  constructor({ symbol, side, entryPrice, positionAmt, unrealizedPnl, leverage, marginType }) {
    this.symbol        = symbol
    this.side          = side
    this.entryPrice    = new Decimal(entryPrice)
    this.positionAmt   = new Decimal(positionAmt)
    this.unrealizedPnl = new Decimal(unrealizedPnl)
    this.leverage      = parseInt(leverage, 10)
    this.marginType    = marginType
  }

  /** Returns true when the position has a non-zero size. */
  isOpen() {
    return !this.positionAmt.isZero()
  }

  toJSON() {
    return {
      symbol:        this.symbol,
      side:          this.side,
      entryPrice:    this.entryPrice.toFixed(),
      positionAmt:   this.positionAmt.toFixed(),
      unrealizedPnl: this.unrealizedPnl.toFixed(),
      leverage:      this.leverage,
      marginType:    this.marginType,
    }
  }
}

module.exports = { Position }
