'use strict'

const { ApplicationError } = require('./ApplicationError')

/**
 * Thrown when a risk rule blocks or reduces an order.
 */
class RiskViolationError extends ApplicationError {
  /**
   * @param {string} message human readable reason
   * @param {object} [details] { rule, limit, actual }
   */
  constructor(message, details = {}) {
    super(message, 'RISK_VIOLATION')
    this.name = 'RiskViolationError'
    this.details = details
  }
}

module.exports = { RiskViolationError }
