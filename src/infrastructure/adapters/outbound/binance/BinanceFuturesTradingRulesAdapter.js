'use strict'

const { FuturesTradingRulesPort } = require('../../../../domain/futures/ports/outbound/FuturesTradingRulesPort')
const { FuturesSymbol }           = require('../../../../domain/futures/entities/FuturesSymbol')
const { TradingRules }            = require('../../../../domain/futures/entities/TradingRules')
const { InMemoryExchangeInfoCache } = require('../cache/InMemoryExchangeInfoCache')
const { InfrastructureError }     = require('../../../../shared/errors/InfrastructureError')
const { logger }                  = require('../../../../shared/utils/logger')

/**
 * Outbound adapter: implements FuturesTradingRulesPort using binance-api-node.
 *
 * Responsibilities:
 * – Fetch and cache exchangeInfo (5-minute TTL)
 * – Extract filter values and map them to domain entities
 * – Throw InfrastructureError on any Binance failure
 */
class BinanceFuturesTradingRulesAdapter extends FuturesTradingRulesPort {
  /** @param {object} binanceClient – binance-api-node client instance */
  constructor(binanceClient) {
    super()
    this.client = binanceClient
    this._cache = new InMemoryExchangeInfoCache(5 * 60 * 1000)
    /** @type {Promise|null} In-flight exchangeInfo promise to prevent cache stampede */
    this._pendingFetch = null
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  async _fetchExchangeInfo() {
    if (this._cache.isValid()) return this._cache.get()
    if (this._pendingFetch) return this._pendingFetch

    this._pendingFetch = (async () => {
      try {
        logger.info('[BinanceFuturesTradingRulesAdapter] Fetching exchangeInfo…')
        const info = await this.client.futuresExchangeInfo()
        this._cache.set(info)
        return info
      } catch (err) {
        throw new InfrastructureError(
          `futuresExchangeInfo failed: ${err.message}`,
          'BINANCE_EXCHANGE_INFO_ERROR',
        )
      } finally {
        this._pendingFetch = null
      }
    })()

    return this._pendingFetch
  }

  _findSymbolData(info, symbol) {
    const data = info.symbols.find((s) => s.symbol === symbol)
    if (!data) {
      throw new InfrastructureError(
        `Symbol "${symbol}" not found in exchangeInfo`,
        'SYMBOL_NOT_FOUND',
      )
    }
    return data
  }

  _indexFilters(filters) {
    return filters.reduce((acc, f) => { acc[f.filterType] = f; return acc }, {})
  }

  // ─── Port implementation ─────────────────────────────────────────────────────

  async getSymbolInfo(symbol) {
    const info = await this._fetchExchangeInfo()
    const data = this._findSymbolData(info, symbol)

    return new FuturesSymbol({
      symbol:       data.symbol,
      status:       data.status,
      baseAsset:    data.baseAsset,
      quoteAsset:   data.quoteAsset,
      contractType: data.contractType,
      filters:      data.filters,
    })
  }

  async getTradingRules(symbol) {
    const info = await this._fetchExchangeInfo()
    const data = this._findSymbolData(info, symbol)
    const f    = this._indexFilters(data.filters)

    return new TradingRules({
      symbol,
      tickSize:       f.PRICE_FILTER?.tickSize       ?? '0.01',
      stepSize:       f.LOT_SIZE?.stepSize            ?? '0.001',
      minQty:         f.LOT_SIZE?.minQty              ?? '0.001',
      maxQty:         f.LOT_SIZE?.maxQty              ?? '1000000',
      minNotional:    f.MIN_NOTIONAL?.notional        ?? '5',
      marketStepSize: f.MARKET_LOT_SIZE?.stepSize     ?? '0.001',
      marketMinQty:   f.MARKET_LOT_SIZE?.minQty       ?? '0.001',
      marketMaxQty:   f.MARKET_LOT_SIZE?.maxQty       ?? '1000000',
      multiplierUp:   f.PERCENT_PRICE?.multiplierUp   ?? null,
      multiplierDown: f.PERCENT_PRICE?.multiplierDown ?? null,
      allowedOrderTypes: data.orderTypes ?? [],
    })
  }
}

module.exports = { BinanceFuturesTradingRulesAdapter }
