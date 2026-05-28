'use strict'

/**
 * OrderRepositoryPort — outbound port for the order management system.
 * Concrete adapters persist and query orders. Implementations live in
 * `src/infrastructure/persistence/`.
 *
 * @typedef {Object} OrderRecord
 * @property {string} orderId
 * @property {string|null} userId
 * @property {string} symbol
 * @property {'BUY'|'SELL'} side
 * @property {'MARKET'|'LIMIT'} type
 * @property {number} quantity
 * @property {number|null} price
 * @property {'NEW'|'PARTIAL'|'FILLED'|'CANCELED'|'REJECTED'} status
 * @property {number} createdAt
 * @property {number|null} executedAt
 * @property {Array<object>} fills
 * @property {object|null} riskDecision
 * @property {string|null} reason
 */
class OrderRepositoryPort {
  // eslint-disable-next-line no-unused-vars
  async save(order) { throw new Error('OrderRepositoryPort.save not implemented') }
  // eslint-disable-next-line no-unused-vars
  async findById(orderId) { throw new Error('OrderRepositoryPort.findById not implemented') }
  // eslint-disable-next-line no-unused-vars
  async findOpen({ symbol, userId } = {}) { return [] }
  // eslint-disable-next-line no-unused-vars
  async updateStatus(orderId, patch) { throw new Error('OrderRepositoryPort.updateStatus not implemented') }
}

module.exports = { OrderRepositoryPort }
