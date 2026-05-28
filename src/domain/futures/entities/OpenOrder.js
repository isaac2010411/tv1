'use strict'

const { Decimal } = require('../../../shared/utils/decimal')

/**
 * Entity: a single open order on a futures symbol.
 * All quantity and price fields use Decimal.js.
 */
class OpenOrder {
  /**
   * @param {object} params
   * @param {string|number} params.orderId
   * @param {string} params.symbol
   * @param {string} params.side         – "BUY" | "SELL"
   * @param {string} params.type         – "LIMIT" | "MARKET" | etc.
   * @param {string} params.price
   * @param {string} params.origQty
   * @param {string} params.executedQty
   * @param {string} params.status
   * @param {boolean} params.reduceOnly
   * @param {string} params.timeInForce
   */
  constructor({ orderId, symbol, side, type, price, origQty, executedQty, status, reduceOnly, timeInForce }) {
    this.orderId      = orderId
    this.symbol       = symbol
    this.side         = side
    this.type         = type
    this.price        = new Decimal(price || 0)
    this.origQty      = new Decimal(origQty)
    this.executedQty  = new Decimal(executedQty)
    this.status       = status
    this.reduceOnly   = Boolean(reduceOnly)
    this.timeInForce  = timeInForce
  }

  /** Unfilled quantity remaining. */
  get remainingQty() {
    return this.origQty.minus(this.executedQty)
  }

  toJSON() {
    return {
      orderId:      this.orderId,
      symbol:       this.symbol,
      side:         this.side,
      type:         this.type,
      price:        this.price.toFixed(),
      origQty:      this.origQty.toFixed(),
      executedQty:  this.executedQty.toFixed(),
      remainingQty: this.remainingQty.toFixed(),
      status:       this.status,
      reduceOnly:   this.reduceOnly,
      timeInForce:  this.timeInForce,
    }
  }
}

module.exports = { OpenOrder }
