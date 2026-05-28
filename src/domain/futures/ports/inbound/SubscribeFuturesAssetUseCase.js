'use strict'

/**
 * Inbound port (interface): subscribe to real-time updates for a futures symbol.
 */
class SubscribeFuturesAssetUseCase {
  /**
   * @param {{ symbol: string, intervals?: string[], handlers: object }} input
   * @returns {Promise<void>}
   */
  // eslint-disable-next-line no-unused-vars
  async execute(input) { throw new Error('Not implemented: SubscribeFuturesAssetUseCase.execute') }
}

module.exports = { SubscribeFuturesAssetUseCase }
