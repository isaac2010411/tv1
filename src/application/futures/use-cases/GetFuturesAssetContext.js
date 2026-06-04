'use strict'

const { GetFuturesAssetContextUseCase } = require('../../../domain/futures/ports/inbound/GetFuturesAssetContextUseCase')
const { AssetContextManager } = require('../context/AssetContextManager')

/**
 * Use case: orchestrates all outbound ports to assemble a complete Futures
 * Asset Trading Context for a given symbol.
 *
 * Dependencies are injected via the constructor (no direct Binance imports).
 */
class GetFuturesAssetContext extends GetFuturesAssetContextUseCase {
  /**
   * @param {object} deps
   * @param {import('../context/AssetContextManager').AssetContextManager} [deps.assetContextManager]
   * @param {import('../../../domain/futures/ports/outbound/FuturesTradingRulesPort').FuturesTradingRulesPort} deps.tradingRulesPort
   * @param {import('../../../domain/futures/ports/outbound/FuturesMarketDataPort').FuturesMarketDataPort}     deps.marketDataPort
   * @param {import('../../../domain/futures/ports/outbound/FuturesAccountPort').FuturesAccountPort}           deps.accountPort
   */
  constructor({ assetContextManager, tradingRulesPort, marketDataPort, accountPort }) {
    super()
    this.assetContextManager =
      assetContextManager ??
      new AssetContextManager({
        tradingRulesPort,
        marketDataPort,
        accountPort,
      })
  }

  /**
   * @param {{ symbol: string }} input
   */
  async execute({ symbol } = {}) {
    return this.assetContextManager.build(symbol)
  }
}

module.exports = { GetFuturesAssetContext }
