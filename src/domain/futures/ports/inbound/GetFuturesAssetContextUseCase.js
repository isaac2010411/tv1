'use strict'

/**
 * Inbound port (interface): retrieve a full trading context for a futures symbol.
 * Application-layer use cases implement this interface.
 */
class GetFuturesAssetContextUseCase {
  /**
   * @param {{ symbol: string }} input
   * @returns {Promise<{
   *   symbol:       string,
   *   exchangeInfo: import('../../entities/FuturesSymbol').FuturesSymbol,
   *   tradingRules: import('../../entities/TradingRules').TradingRules,
   *   market:       { markPrice: object, openInterest: object, ticker24h: object },
   *   orderbook:    import('../../entities/OrderBook').OrderBook,
   *   candles:      Array<object>,
   *   account:      object
   * }>}
   */
  // eslint-disable-next-line no-unused-vars
  async execute(input) { throw new Error('Not implemented: GetFuturesAssetContextUseCase.execute') }
}

module.exports = { GetFuturesAssetContextUseCase }
