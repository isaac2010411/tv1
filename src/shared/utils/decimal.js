'use strict'

const Decimal = require('decimal.js')

/**
 * Wraps a value into a Decimal instance.
 * Use this instead of `new Decimal(v)` directly for consistent behavior.
 * @param {string|number|Decimal} value
 * @returns {Decimal}
 */
const toDecimal = (value) => new Decimal(value)

/**
 * Returns the number of decimal places a value has.
 * @param {string|number|Decimal} value
 * @returns {number}
 */
const decimalPlaces = (value) => {
  const str = new Decimal(value).toFixed()
  const dotIndex = str.indexOf('.')
  return dotIndex === -1 ? 0 : str.length - dotIndex - 1
}

module.exports = { toDecimal, decimalPlaces, Decimal }
