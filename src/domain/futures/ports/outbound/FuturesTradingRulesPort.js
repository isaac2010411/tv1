'use strict'

/**
 * Outbound port (interface): exchange info and trading rules.
 *
 * Implementations are responsible for fetching symbol metadata from the
 * exchange and mapping it to domain entities.  Results should be cached
 * at the adapter level (e.g. 5-minute TTL for exchangeInfo).
 */
class FuturesTradingRulesPort {
  /**
   * @param {string} symbol
   * @returns {Promise<import('../../entities/FuturesSymbol').FuturesSymbol>}
   */
  // eslint-disable-next-line no-unused-vars
  async getSymbolInfo(symbol) { throw new Error('Not implemented: getSymbolInfo') }

  /**
   * @param {string} symbol
   * @returns {Promise<import('../../entities/TradingRules').TradingRules>}
   */
  // eslint-disable-next-line no-unused-vars
  async getTradingRules(symbol) { throw new Error('Not implemented: getTradingRules') }
}

module.exports = { FuturesTradingRulesPort }
