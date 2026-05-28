'use strict'

const { Decimal } = require('../../../shared/utils/decimal')
const { DomainError } = require('../../../shared/errors/DomainError')

/**
 * Value object: an immutable, non-negative quantity backed by Decimal.js.
 * Never use native floats for quantity; always go through this type.
 */
class Quantity {
  /**
   * @param {string|number|Decimal} value
   */
  constructor(value) {
    const d = new Decimal(value)

    if (d.isNaN() || d.isNegative()) {
      throw new DomainError(`Invalid quantity: ${value}`, 'INVALID_QUANTITY')
    }

    this._value = d
  }

  /** @returns {Decimal} */
  get value() {
    return this._value
  }

  toString() {
    return this._value.toFixed()
  }

  equals(other) {
    return other instanceof Quantity && this._value.equals(other._value)
  }

  isZero() {
    return this._value.isZero()
  }
}

module.exports = { Quantity }
