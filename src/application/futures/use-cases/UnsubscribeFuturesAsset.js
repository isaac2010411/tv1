'use strict'

const { ApplicationError } = require('../../../shared/errors/ApplicationError')

/**
 * Use case: closes all real-time WebSocket streams for a futures symbol.
 */
class UnsubscribeFuturesAsset {
  /**
   * @param {object} deps
   * @param {import('../../../domain/futures/ports/outbound/FuturesRealtimePort').FuturesRealtimePort} deps.realtimePort
   */
  constructor({ realtimePort }) {
    this.realtimePort = realtimePort
  }

  /**
   * @param {{ symbol: string }} input
   */
  async execute({ symbol } = {}) {
    if (!symbol) {
      throw new ApplicationError('symbol is required', 'MISSING_SYMBOL')
    }

    const normalizedSymbol = symbol.trim().toUpperCase()
    await this.realtimePort.unsubscribeSymbol(normalizedSymbol)
  }
}

module.exports = { UnsubscribeFuturesAsset }
