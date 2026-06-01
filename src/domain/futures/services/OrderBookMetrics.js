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
    const imbalanceTop10 = orderBook.imbalanceTopN(10)
    const imbalanceTop20 = orderBook.imbalanceTopN(20)
    const bidVol = orderBook.bidVolumeTopN(depth)
    const askVol = orderBook.askVolumeTopN(depth)
    const bidVolumeTop10 = orderBook.bidVolumeTopN(10)
    const askVolumeTop10 = orderBook.askVolumeTopN(10)
    // Only show tactical walls (within 1% of mid) using the top 100 levels
    const walls     = orderBook.detectWalls({ multiplier: 5, maxDistancePct: 0.01, depth: 100 })

    const heatmapSnapshot = {
      bids: orderBook.bids.slice(0, 30).map((l) => ({ price: l.price.toFixed(), quantity: l.qty.toFixed() })),
      asks: orderBook.asks.slice(0, 30).map((l) => ({ price: l.price.toFixed(), quantity: l.qty.toFixed() })),
      timestamp: Date.now(),
    }

    return {
      symbol:       orderBook.symbol,
      timestamp:    Date.now(),
      bestBid:      orderBook.bestBid?.toFixed() ?? null,
      bestAsk:      orderBook.bestAsk?.toFixed() ?? null,
      spread:       orderBook.spread?.toFixed()    ?? null,
      spreadPct:    orderBook.spreadPct?.toFixed()  ?? null,
      midPrice:     orderBook.midPrice?.toFixed()   ?? null,
      imbalance:    imbalance.toFixed(4),
      imbalanceTop10: imbalanceTop10.toFixed(4),
      imbalanceTop20: imbalanceTop20.toFixed(4),
      bidVolumeTop: bidVol.toFixed(),
      askVolumeTop: askVol.toFixed(),
      bidVolumeTop10: bidVolumeTop10.toFixed(),
      askVolumeTop10: askVolumeTop10.toFixed(),
      bidDominance: imbalance.greaterThan(0),
      askDominance: imbalance.lessThan(0),
      walls,
      heatmapSnapshot,
    }
  }
}

module.exports = { OrderBookMetrics }
