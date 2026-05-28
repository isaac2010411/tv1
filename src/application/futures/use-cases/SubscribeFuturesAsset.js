'use strict'

const { SubscribeFuturesAssetUseCase } = require('../../../domain/futures/ports/inbound/SubscribeFuturesAssetUseCase')
const { ApplicationError }             = require('../../../shared/errors/ApplicationError')

/**
 * Use case: opens real-time WebSocket streams for a futures symbol.
 * Delegates to FuturesRealtimePort; never touches Binance directly.
 */
class SubscribeFuturesAsset extends SubscribeFuturesAssetUseCase {
  /**
   * @param {object} deps
   * @param {import('../../../domain/futures/ports/outbound/FuturesRealtimePort').FuturesRealtimePort}     deps.realtimePort
   * @param {import('../../../domain/futures/ports/outbound/FuturesMarketDataPort').FuturesMarketDataPort} deps.marketDataPort
   */
  constructor({ realtimePort, marketDataPort }) {
    super()
    this.realtimePort   = realtimePort
    this.marketDataPort = marketDataPort
  }

  /**
   * @param {{ symbol: string, intervals?: string[], handlers: object }} input
   */
  async execute({ symbol, intervals = ['1m'], handlers } = {}) {
    if (!symbol) {
      throw new ApplicationError('symbol is required', 'MISSING_SYMBOL')
    }
    if (!handlers || typeof handlers !== 'object') {
      throw new ApplicationError('handlers are required', 'MISSING_HANDLERS')
    }

    const normalizedSymbol = symbol.trim().toUpperCase()

    await this.realtimePort.subscribeSymbol(normalizedSymbol, { ...handlers, intervals })
  }
}

module.exports = { SubscribeFuturesAsset }
