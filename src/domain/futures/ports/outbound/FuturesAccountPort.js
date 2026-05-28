'use strict'

/**
 * Outbound port (interface): account context for a futures trader.
 *
 * Implementations must never expose raw exchange payloads; all data must be
 * mapped to domain entities before being returned.
 */
class FuturesAccountPort {
  /**
   * @param {string} symbol
   * @returns {Promise<{
   *   balance:    { asset:string, balance:string, availableBalance:string },
   *   positions:  import('../../entities/Position').Position[],
   *   openOrders: import('../../entities/OpenOrder').OpenOrder[]
   * }>}
   */
  // eslint-disable-next-line no-unused-vars
  async getAccountContext(symbol) { throw new Error('Not implemented: getAccountContext') }

  /**
   * @param {string} symbol
   * @returns {Promise<import('../../entities/Position').Position[]>}
   */
  // eslint-disable-next-line no-unused-vars
  async getOpenPositions(symbol) { throw new Error('Not implemented: getOpenPositions') }

  /**
   * @param {string} symbol
   * @returns {Promise<import('../../entities/OpenOrder').OpenOrder[]>}
   */
  // eslint-disable-next-line no-unused-vars
  async getOpenOrders(symbol) { throw new Error('Not implemented: getOpenOrders') }

  /**
   * @returns {Promise<{ asset:string, balance:string, availableBalance:string, crossWalletBalance:string }>}
   */
  async getAvailableBalance() { throw new Error('Not implemented: getAvailableBalance') }
}

module.exports = { FuturesAccountPort }
