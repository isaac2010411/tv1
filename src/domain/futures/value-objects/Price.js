'use strict'

const { Decimal } = require('../../../shared/utils/decimal')
const { DomainError } = require('../../../shared/errors/DomainError')

/**
 * Value object: an immutable, non-negative price backed by Decimal.js.
 * Never use native floats for price; always go through this type.
 */
class Price {
  /**
   * @param {string|number|Decimal} value
   */
  constructor(value) {
    const d = new Decimal(value)

    if (d.isNaN() || d.isNegative()) {
      throw new DomainError(`Invalid price: ${value}`, 'INVALID_PRICE')
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
    return other instanceof Price && this._value.equals(other._value)
  }

  isGreaterThan(other) {
    return this._value.greaterThan(other instanceof Price ? other._value : new Decimal(other))
  }

  isLessThan(other) {
    return this._value.lessThan(other instanceof Price ? other._value : new Decimal(other))
  }
}

module.exports = { Price }
