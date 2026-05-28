'use strict'

const { DomainError } = require('../../../shared/errors/DomainError')

/**
 * Value object: validates and normalises a futures trading symbol.
 * Exported as TradingSymbol to avoid shadowing the built-in global Symbol.
 */
class TradingSymbol {
  /**
   * @param {string} value – e.g. "btcusdt" or "BTCUSDT"
   */
  constructor(value) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new DomainError('Symbol must be a non-empty string', 'INVALID_SYMBOL')
    }

    const normalized = value.trim().toUpperCase()

    if (!/^[A-Z0-9]{2,20}$/.test(normalized)) {
      throw new DomainError(`Invalid symbol format: "${value}"`, 'INVALID_SYMBOL_FORMAT')
    }

    this._value = normalized
  }

  get value() {
    return this._value
  }

  equals(other) {
    return other instanceof TradingSymbol && other._value === this._value
  }

  toString() {
    return this._value
  }
}

module.exports = { TradingSymbol }
