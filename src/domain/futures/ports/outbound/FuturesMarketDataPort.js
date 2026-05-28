'use strict'

/**
 * Outbound port (interface): market data for USDⓈ-M Futures symbols.
 *
 * Every concrete adapter (e.g. BinanceFuturesMarketDataAdapter) must extend
 * this class and implement all methods.  The domain and application layers
 * depend only on this interface – never on any concrete implementation.
 */
class FuturesMarketDataPort {
  /**
   * @param {string} symbol
   * @param {number} limit
   * @returns {Promise<import('../../entities/OrderBook').OrderBook>}
   */
  // eslint-disable-next-line no-unused-vars
  async getOrderBook(symbol, limit) { throw new Error('Not implemented: getOrderBook') }

  /**
   * @param {string} symbol
   * @param {string} interval  e.g. "1m", "5m", "15m"
   * @param {number} limit
   * @returns {Promise<Array<object>>}
   */
  // eslint-disable-next-line no-unused-vars
  async getCandles(symbol, interval, limit) { throw new Error('Not implemented: getCandles') }

  /**
   * @param {string} symbol
   * @returns {Promise<{ symbol:string, markPrice:string, indexPrice:string,
   *                     lastFundingRate:string, nextFundingTime:number }>}
   */
  // eslint-disable-next-line no-unused-vars
  async getMarkPrice(symbol) { throw new Error('Not implemented: getMarkPrice') }

  /**
   * @param {string} symbol
   * @returns {Promise<{ symbol:string, openInterest:string }>}
   */
  // eslint-disable-next-line no-unused-vars
  async getOpenInterest(symbol) { throw new Error('Not implemented: getOpenInterest') }

  /**
   * @param {string} symbol
   * @returns {Promise<object>}
   */
  // eslint-disable-next-line no-unused-vars
  async getTicker24h(symbol) { throw new Error('Not implemented: getTicker24h') }

  /**
   * @param {string} symbol
   * @returns {Promise<Array<object>>}
   */
  // eslint-disable-next-line no-unused-vars
  async getRecentTrades(symbol) { throw new Error('Not implemented: getRecentTrades') }
}

module.exports = { FuturesMarketDataPort }
