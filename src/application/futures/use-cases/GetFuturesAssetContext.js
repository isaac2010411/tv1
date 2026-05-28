'use strict'

const { GetFuturesAssetContextUseCase } = require('../../../domain/futures/ports/inbound/GetFuturesAssetContextUseCase')
const { ApplicationError } = require('../../../shared/errors/ApplicationError')

/**
 * Use case: orchestrates all outbound ports to assemble a complete Futures
 * Asset Trading Context for a given symbol.
 *
 * Dependencies are injected via the constructor (no direct Binance imports).
 */
class GetFuturesAssetContext extends GetFuturesAssetContextUseCase {
  /**
   * @param {object} deps
   * @param {import('../../../domain/futures/ports/outbound/FuturesTradingRulesPort').FuturesTradingRulesPort} deps.tradingRulesPort
   * @param {import('../../../domain/futures/ports/outbound/FuturesMarketDataPort').FuturesMarketDataPort}     deps.marketDataPort
   * @param {import('../../../domain/futures/ports/outbound/FuturesAccountPort').FuturesAccountPort}           deps.accountPort
   */
  constructor({ tradingRulesPort, marketDataPort, accountPort }) {
    super()
    this.tradingRulesPort = tradingRulesPort
    this.marketDataPort   = marketDataPort
    this.accountPort      = accountPort
  }

  /**
   * @param {{ symbol: string }} input
   */
  async execute({ symbol } = {}) {
    if (!symbol) {
      throw new ApplicationError('symbol is required', 'MISSING_SYMBOL')
    }

    const normalizedSymbol = symbol.trim().toUpperCase()

    const [
      symbolInfo,
      tradingRules,
      markPrice,
      openInterest,
      ticker24h,
      candles,
      orderbook,
      account,
    ] = await Promise.all([
      this.tradingRulesPort.getSymbolInfo(normalizedSymbol),
      this.tradingRulesPort.getTradingRules(normalizedSymbol),
      this.marketDataPort.getMarkPrice(normalizedSymbol),
      this.marketDataPort.getOpenInterest(normalizedSymbol),
      this.marketDataPort.getTicker24h(normalizedSymbol),
      this.marketDataPort.getCandles(normalizedSymbol, '15m', 100),
      this.marketDataPort.getOrderBook(normalizedSymbol, 20),
      this.accountPort.getAccountContext(normalizedSymbol),
    ])

    if (!symbolInfo.isTrading()) {
      throw new ApplicationError(
        `Symbol ${normalizedSymbol} is not in TRADING status`,
        'SYMBOL_NOT_TRADING',
      )
    }

    return {
      symbol:       normalizedSymbol,
      exchangeInfo: symbolInfo,
      tradingRules,
      market: {
        markPrice,
        openInterest,
        ticker24h,
      },
      orderbook,
      candles,
      account,
    }
  }
}

module.exports = { GetFuturesAssetContext }
