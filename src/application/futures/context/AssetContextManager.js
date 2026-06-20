'use strict'

const { ApplicationError } = require('../../../shared/errors/ApplicationError')

/**
 * Single builder for Futures Asset Context.
 *
 * This class is the backend source of truth for asset-context payloads used by
 * both REST and Socket.IO flows.
 */
class AssetContextManager {
  /**
   * @param {object} deps
   * @param {import('../../../domain/futures/ports/outbound/FuturesTradingRulesPort').FuturesTradingRulesPort} deps.tradingRulesPort
   * @param {import('../../../domain/futures/ports/outbound/FuturesMarketDataPort').FuturesMarketDataPort} deps.marketDataPort
   * @param {import('../../../domain/futures/ports/outbound/FuturesAccountPort').FuturesAccountPort} deps.accountPort
   * @param {import('../risk/RiskManager').RiskManager | null} [deps.riskManager]
   * @param {import('../portfolio/PortfolioManager').PortfolioManager | null} [deps.portfolioManager]
   */
  constructor({ tradingRulesPort, marketDataPort, accountPort, riskManager = null, portfolioManager = null }) {
    this.tradingRulesPort = tradingRulesPort
    this.marketDataPort = marketDataPort
    this.accountPort = accountPort
    this.riskManager = riskManager
    this.portfolioManager = portfolioManager
  }

  /**
   * @param {string} symbol
   */
  async build(symbol) {
    if (!symbol || typeof symbol !== 'string' || !symbol.trim()) {
      throw new ApplicationError('symbol is required', 'MISSING_SYMBOL')
    }

    const normalizedSymbol = symbol.trim().toUpperCase()

    const [symbolInfo, tradingRules, markPrice, openInterest, ticker24h, candles, orderbook, account, portfolio] =
      await Promise.all([
        this.tradingRulesPort.getSymbolInfo(normalizedSymbol),
        this.tradingRulesPort.getTradingRules(normalizedSymbol),
        this.marketDataPort.getMarkPrice(normalizedSymbol),
        this.marketDataPort.getOpenInterest(normalizedSymbol),
        this.marketDataPort.getTicker24h(normalizedSymbol),
        this.marketDataPort.getCandles(normalizedSymbol, '15m', 100),
        this.marketDataPort.getOrderBook(normalizedSymbol, 20),
        this.accountPort.getAccountContext(normalizedSymbol),
        this._safePortfolioSnapshot(),
      ])

    if (!symbolInfo.isTrading()) {
      throw new ApplicationError(`Symbol ${normalizedSymbol} is not in TRADING status`, 'SYMBOL_NOT_TRADING')
    }

    const liveSummary = portfolio?.liveSummary ?? null
    const liveBalance = portfolio?.liveBalance ?? null

    return {
      symbol: normalizedSymbol,
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

      // Additive fields to progressively converge to the unified context
      // contract without breaking current consumers.
      positions: Array.isArray(account?.positions) ? account.positions : [],
      orders: Array.isArray(account?.openOrders) ? account.openOrders : [],
      signals: null,
      risk: this.riskManager?.getLimits?.() ?? null,
      portfolio,
      liveSummary,
      liveBalance,
      orderFlow: null,
    }
  }

  async _safePortfolioSnapshot() {
    if (!this.portfolioManager?.getSnapshot) return null
    try {
      return await this.portfolioManager.getSnapshot()
    } catch (_) {
      return null
    }
  }
}

module.exports = { AssetContextManager }
