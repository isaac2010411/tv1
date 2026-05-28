'use strict'

/**
 * OrderManagerPort — inbound port for the future order lifecycle manager.
 *
 * @typedef {Object} OrderSubmitResult
 * @property {string} orderId
 * @property {'ACCEPTED'|'REJECTED'} status
 * @property {string} [reason]
 */
class OrderManagerPort {
  /** @param {object} order @returns {Promise<OrderSubmitResult>} */
  // eslint-disable-next-line no-unused-vars
  async submit(order) {
    throw new Error('OrderManagerPort.submit not implemented')
  }

  /** @param {string} orderId */
  // eslint-disable-next-line no-unused-vars
  async cancel(orderId) {
    throw new Error('OrderManagerPort.cancel not implemented')
  }

  /** @returns {Promise<object[]>} */
  async getOpen() {
    return []
  }
}

module.exports = { OrderManagerPort }
