'use strict'

/**
 * Entity: exchange-level metadata for a futures trading symbol.
 * Populated from Binance exchangeInfo; contains no mutable trading state.
 */
class FuturesSymbol {
  /**
   * @param {object} params
   * @param {string} params.symbol       – e.g. "BTCUSDT"
   * @param {string} params.status       – e.g. "TRADING" | "BREAK"
   * @param {string} params.baseAsset    – e.g. "BTC"
   * @param {string} params.quoteAsset   – e.g. "USDT"
   * @param {string} params.contractType – e.g. "PERPETUAL"
   * @param {Array}  params.filters      – raw filter array from exchangeInfo
   */
  constructor({ symbol, status, baseAsset, quoteAsset, contractType, filters }) {
    this.symbol       = symbol
    this.status       = status
    this.baseAsset    = baseAsset
    this.quoteAsset   = quoteAsset
    this.contractType = contractType
    this.filters      = filters || []
  }

  /** Returns true only when the symbol is actively tradeable. */
  isTrading() {
    return this.status === 'TRADING'
  }

  toJSON() {
    return {
      symbol:       this.symbol,
      status:       this.status,
      baseAsset:    this.baseAsset,
      quoteAsset:   this.quoteAsset,
      contractType: this.contractType,
    }
  }
}

module.exports = { FuturesSymbol }
