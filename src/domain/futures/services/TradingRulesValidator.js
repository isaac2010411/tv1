'use strict'

const { DomainError } = require('../../../shared/errors/DomainError')

const SUPPORTED_ORDER_TYPES = [
  'LIMIT',
  'MARKET',
  'STOP',
  'STOP_MARKET',
  'TAKE_PROFIT',
  'TAKE_PROFIT_MARKET',
  'TRAILING_STOP_MARKET',
]

/**
 * Domain service: validates a proposed order against a symbol's TradingRules.
 * Accumulates all violations before throwing so the caller receives the full
 * picture in a single error.
 */
class TradingRulesValidator {
  /**
   * @param {import('../entities/TradingRules').TradingRules} rules
   * @param {{ symbol:string, side:string, type:string, quantity:string|number,
   *            price?:string|number, reduceOnly?:boolean }} order
   * @returns {true} when the order passes all validations
   * @throws {DomainError} when one or more rules are violated
   */
  validate(rules, order) {
    const errors = []

    // ── Quantity alignment ────────────────────────────────────────────────────
    try {
      rules.validateQuantityStep(order.quantity)
    } catch (e) {
      errors.push(e.message)
    }

    // ── LIMIT-specific validations ────────────────────────────────────────────
    if (order.type === 'LIMIT') {
      if (order.price == null) {
        errors.push('Price is required for LIMIT orders')
      } else {
        try {
          rules.validatePriceTick(order.price)
        } catch (e) {
          errors.push(e.message)
        }

        try {
          rules.validateMinNotional(order.price, order.quantity)
        } catch (e) {
          errors.push(e.message)
        }
      }
    }

    // ── Order type ────────────────────────────────────────────────────────────
    if (!SUPPORTED_ORDER_TYPES.includes(order.type)) {
      errors.push(`Order type ${order.type} is not supported`)
    }

    if (errors.length > 0) {
      throw new DomainError(errors.join('; '), 'ORDER_VALIDATION_FAILED')
    }

    return true
  }
}

module.exports = { TradingRulesValidator }
