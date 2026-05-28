'use strict'

/**
 * Domain service: computes derived metrics from an OrderBook entity.
 * Stateless – call compute() with any valid OrderBook instance.
 */
class OrderBookMetrics {
  /**
   * @param {import('../entities/OrderBook').OrderBook} orderBook
   * @param {number} depth  number of price levels to consider (default 20)
   * @returns {{
   *   spread:       string|null,
   *   spreadPct:    string|null,
   *   midPrice:     string|null,
   *   imbalance:    string,
   *   bidVolumeTop: string,
   *   askVolumeTop: string,
   *   bidDominance: boolean,
   *   askDominance: boolean,
   *   walls: { bidWalls: Array, askWalls: Array }
   * }}
   */
  compute(orderBook, depth = 20) {
    const imbalance = orderBook.imbalanceTopN(depth)
    const bidVol    = orderBook.bidVolumeTopN(depth)
    const askVol    = orderBook.askVolumeTopN(depth)
    // Only show tactical walls (within 1% of mid) using the top 100 levels
    const walls     = orderBook.detectWalls({ multiplier: 5, maxDistancePct: 0.01, depth: 100 })

    return {
      spread:       orderBook.spread?.toFixed()    ?? null,
      spreadPct:    orderBook.spreadPct?.toFixed()  ?? null,
      midPrice:     orderBook.midPrice?.toFixed()   ?? null,
      imbalance:    imbalance.toFixed(4),
      bidVolumeTop: bidVol.toFixed(),
      askVolumeTop: askVol.toFixed(),
      bidDominance: imbalance.greaterThan(0),
      askDominance: imbalance.lessThan(0),
      walls,
    }
  }
}

module.exports = { OrderBookMetrics }
