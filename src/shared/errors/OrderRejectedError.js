'use strict'

const { ApplicationError } = require('./ApplicationError')

/**
 * Thrown when an order is rejected by the exchange or repository layer.
 */
class OrderRejectedError extends ApplicationError {
  /**
   * @param {string} message
   * @param {object} [details]
   */
  constructor(message, details = {}) {
    super(message, 'ORDER_REJECTED')
    this.name = 'OrderRejectedError'
    this.details = details
  }
}

module.exports = { OrderRejectedError }
