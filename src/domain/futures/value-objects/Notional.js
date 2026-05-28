'use strict'

const { Decimal } = require('../../../shared/utils/decimal')
const { DomainError } = require('../../../shared/errors/DomainError')

/**
 * Value object: price × quantity, backed by Decimal.js.
 * Represents the notional value of a position or order.
 */
class Notional {
  /**
   * @param {string|number|Decimal|import('./Price').Price} price
   * @param {string|number|Decimal|import('./Quantity').Quantity} quantity
   */
  constructor(price, quantity) {
    const p = new Decimal(price && price._value ? price._value : price)
    const q = new Decimal(quantity && quantity._value ? quantity._value : quantity)

    if (p.isNaN() || q.isNaN()) {
      throw new DomainError('Invalid notional inputs', 'INVALID_NOTIONAL')
    }

    this._value = p.mul(q)
  }

  /** @returns {Decimal} */
  get value() {
    return this._value
  }

  toString() {
    return this._value.toFixed()
  }

  isGreaterThanOrEqualTo(minNotional) {
    const min = new Decimal(
      minNotional && minNotional._value ? minNotional._value : minNotional
    )
    return this._value.greaterThanOrEqualTo(min)
  }
}

module.exports = { Notional }
