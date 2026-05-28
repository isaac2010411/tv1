'use strict'

const { FuturesMarketDataPort } = require('../../../../domain/futures/ports/outbound/FuturesMarketDataPort')
const { OrderBook }             = require('../../../../domain/futures/entities/OrderBook')
const { InfrastructureError }   = require('../../../../shared/errors/InfrastructureError')

/**
 * Outbound adapter: implements FuturesMarketDataPort using binance-api-node.
 *
 * Responsibilities:
 * – Call Binance Futures REST endpoints
 * – Normalise raw payloads to domain entities / plain objects
 * – Throw InfrastructureError on any Binance failure
 */
class BinanceFuturesMarketDataAdapter extends FuturesMarketDataPort {
  /** @param {object} binanceClient – binance-api-node client instance */
  constructor(binanceClient) {
    super()
    this.client = binanceClient
  }

  async getOrderBook(symbol, limit = 20) {
    try {
      const raw = await this.client.futuresBook({ symbol, limit })

      // binance-api-node may return arrays [price, qty] or objects {price, quantity}
      const toTuple = (l) => Array.isArray(l) ? [l[0], l[1]] : [l.price, l.quantity ?? l.qty]

      return new OrderBook({
        symbol,
        bids: raw.bids.map(toTuple),
        asks: raw.asks.map(toTuple),
      })
    } catch (err) {
      throw new InfrastructureError(`getOrderBook failed: ${err.message}`, 'BINANCE_ORDER_BOOK_ERROR')
    }
  }

  /**
   * Returns the raw snapshot for LocalOrderBookEngine initialisation.
   * Returns { lastUpdateId, bids: [[price,qty],...], asks: [[price,qty],...] }
   */
  async getOrderBookRaw(symbol, limit = 1000) {
    try {
      const raw = await this.client.futuresBook({ symbol, limit })
      const toTuple = (l) => Array.isArray(l) ? [l[0], l[1]] : [l.price, l.quantity ?? l.qty]
      return {
        lastUpdateId: raw.lastUpdateId,
        bids: raw.bids.map(toTuple),
        asks: raw.asks.map(toTuple),
      }
    } catch (err) {
      throw new InfrastructureError(`getOrderBookRaw failed: ${err.message}`, 'BINANCE_ORDER_BOOK_ERROR')
    }
  }

  async getCandles(symbol, interval = '15m', limit = 100) {
    try {
      const candles = await this.client.futuresCandles({ symbol, interval, limit })
      return candles.map((c) => ({
        openTime:    c.openTime,
        open:        c.open,
        high:        c.high,
        low:         c.low,
        close:       c.close,
        volume:      c.volume,
        closeTime:   c.closeTime,
        quoteVolume: c.quoteAssetVolume,
        trades:      c.trades,
      }))
    } catch (err) {
      throw new InfrastructureError(`getCandles failed: ${err.message}`, 'BINANCE_CANDLES_ERROR')
    }
  }

  async getMarkPrice(symbol) {
    try {
      const raw = await this.client.futuresMarkPrice({ symbol })
      return {
        symbol:                raw.symbol,
        markPrice:             raw.markPrice,
        indexPrice:            raw.indexPrice,
        estimatedSettlePrice:  raw.estimatedSettlePrice,
        lastFundingRate:       raw.lastFundingRate,
        nextFundingTime:       raw.nextFundingTime,
      }
    } catch (err) {
      throw new InfrastructureError(`getMarkPrice failed: ${err.message}`, 'BINANCE_MARK_PRICE_ERROR')
    }
  }

  async getOpenInterest(symbol) {
    try {
      // binance-api-node does not expose futuresOpenInterest — call the public endpoint directly
      const res = await fetch(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${encodeURIComponent(symbol)}`)
      if (!res.ok) {
        const text = await res.text()
        throw new Error(`HTTP ${res.status}: ${text}`)
      }
      const raw = await res.json()
      return {
        symbol:       raw.symbol,
        openInterest: raw.openInterest,
      }
    } catch (err) {
      throw new InfrastructureError(`getOpenInterest failed: ${err.message}`, 'BINANCE_OPEN_INTEREST_ERROR')
    }
  }

  async getTicker24h(symbol) {
    try {
      const raw = await this.client.futuresDailyStats({ symbol })
      return {
        symbol:              raw.symbol,
        priceChange:         raw.priceChange,
        priceChangePercent:  raw.priceChangePercent,
        weightedAvgPrice:    raw.weightedAvgPrice,
        lastPrice:           raw.lastPrice,
        volume:              raw.volume,
        quoteVolume:         raw.quoteVolume,
        highPrice:           raw.highPrice,
        lowPrice:            raw.lowPrice,
        openTime:            raw.openTime,
        closeTime:           raw.closeTime,
        count:               raw.count,
      }
    } catch (err) {
      throw new InfrastructureError(`getTicker24h failed: ${err.message}`, 'BINANCE_TICKER_ERROR')
    }
  }

  async getRecentTrades(symbol) {
    try {
      const raw = await this.client.futuresTrades({ symbol, limit: 50 })
      return raw.map((t) => ({
        id:          t.id,
        price:       t.price,
        qty:         t.qty,
        time:        t.time,
        isBuyerMaker: t.isBuyerMaker,
      }))
    } catch (err) {
      throw new InfrastructureError(`getRecentTrades failed: ${err.message}`, 'BINANCE_RECENT_TRADES_ERROR')
    }
  }

  /**
   * Returns approximate footprint candle history derived from kline data.
   * Each candle has 3 price levels (low / mid / high) with buy/sell volume
   * distributed according to the candle's directional bias.
   * Taker buy volume is sourced directly from Binance klines.
   *
   * @param {string} symbol
   * @param {string} interval
   * @param {number} limit
   * @returns {Promise<object[]>}  Array of footprint plain objects (isFinal=true)
   */
  async getFootprintHistory(symbol, interval = '1m', limit = 50) {
    try {
      // Use the raw REST endpoint so we get the full kline array including
      // taker-buy base asset volume at index [9], which binance-api-node does
      // not always expose as a named property.
      const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=${limit + 1}`
      const res = await fetch(url)
      if (!res.ok) {
        const text = await res.text()
        throw new Error(`HTTP ${res.status}: ${text}`)
      }
      const raw = await res.json()
      // Exclude the last entry — it is the currently open (incomplete) candle
      const closed = raw.slice(0, -1)

      return closed.map((c) => {
        // Raw kline array positions:
        // [0]openTime [1]open [2]high [3]low [4]close [5]volume
        // [6]closeTime [7]quoteVol [8]trades [9]takerBuyBaseVol [10]takerBuyQuoteVol
        const totalVol = parseFloat(c[5])  || 0
        const buyVol   = Math.min(parseFloat(c[9]) || 0, totalVol)
        const sellVol  = Math.max(0, totalVol - buyVol)

        const open  = parseFloat(c[1])
        const high  = parseFloat(c[2])
        const low   = parseFloat(c[3])
        const close = parseFloat(c[4])
        const mid   = (high + low) / 2

        // Weight buy/sell across 3 levels based on directional bias
        const isBullish = close >= open
        const buyW  = isBullish ? [0.10, 0.40, 0.50] : [0.40, 0.40, 0.20]
        const sellW = isBullish ? [0.40, 0.40, 0.20] : [0.50, 0.40, 0.10]

        const levels = [low, mid, high].map((price, i) => {
          const bv = buyVol  * buyW[i]
          const sv = sellVol * sellW[i]
          return {
            price:   price.toFixed(2),
            buyVol:  bv.toFixed(4),
            sellVol: sv.toFixed(4),
            total:   (bv + sv).toFixed(4),
            delta:   (bv - sv).toFixed(4),
          }
        })

        return {
          symbol,
          interval,
          openTime: c[0],
          open:     c[1],
          high:     c[2],
          low:      c[3],
          close:    c[4],
          volume:   c[5],
          isFinal:  true,
          levels,
        }
      })
    } catch (err) {
      throw new InfrastructureError(`getFootprintHistory failed: ${err.message}`, 'BINANCE_FOOTPRINT_HISTORY_ERROR')
    }
  }
}

module.exports = { BinanceFuturesMarketDataAdapter }
