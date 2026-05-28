'use strict'

const { Decimal } = require('../../../shared/utils/decimal')
const { SpoofingEvent } = require('../entities/SpoofingEvent')

/**
 * Domain Service: detects spoofed orders in the order book.
 *
 * Algorithm:
 *  1. On each orderbook update, compare bids/asks with the previous snapshot.
 *  2. Track significant levels (qty ≥ minWallQty) that are within maxDistancePct
 *     of the mid price — far-away walls are not tactically relevant for spoofing.
 *  3. When a tracked level disappears and its total lifespan is < lifespanMs,
 *     emit a SpoofingEvent candidate with a confidence score.
 *
 * Confidence score logic:
 *  – lifespanFraction: how quickly the order vanished (higher = quicker = more suspicious)
 *  – sizeFactor: how much larger than the minimum the order was
 *  – confidence = 0.6 × lifespanFraction + 0.4 × sizeFactor  (capped at 0.99)
 *
 * Stateful; one instance per subscribed symbol.
 *
 * Defaults:
 *   minWallQty     = 50   contracts / units
 *   lifespanMs     = 10_000 ms (10 s)
 *   maxDistancePct = 0.02  (2% from mid price — levels farther away are ignored)
 */
/** Maximum number of levels to keep in _trackedLevels (prevents unbounded memory growth). */
const MAX_TRACKED_LEVELS = 500

class SpoofingDetectorService {
  /**
   * @param {object} params
   * @param {string} params.symbol
   * @param {string} params.tickSize        Used to normalise price keys
   * @param {number} [params.minWallQty]    Minimum qty for a level to be tracked
   * @param {number} [params.lifespanMs]    Max ms a level can live before being flagged
   * @param {number} [params.maxDistancePct] Max fractional distance from mid to track a level (0.02 = 2%)
   */
  constructor({ symbol, tickSize, minWallQty = 50, lifespanMs = 10_000, maxDistancePct = 0.02 }) {
    this.symbol          = symbol
    this.tickSize        = new Decimal(tickSize)
    this.minWallQty      = new Decimal(minWallQty)
    this.lifespanMs      = lifespanMs
    this.maxDistancePct  = new Decimal(maxDistancePct)

    /**
     * Tracks levels currently in the book that meet the wall threshold.
     * Key: `<side>@<roundedPrice>`
     * @type {Map<string, { side: string, price: string, firstSeen: number, peakQty: Decimal, midAtEntry: string }>}
     */
    this._trackedLevels = new Map()
  }

  // ─── Round price to tickSize ─────────────────────────────────────────────────

  _priceKey(side, price) {
    const rounded = new Decimal(price).div(this.tickSize).floor().mul(this.tickSize).toFixed()
    return `${side}@${rounded}`
  }

  // ─── Near-mid check ───────────────────────────────────────────────────────────

  _isNearMid(levelPrice, midPrice) {
    if (!midPrice || midPrice.isZero()) return true   // no mid available → allow tracking
    const dist = new Decimal(levelPrice).minus(midPrice).abs().div(midPrice)
    return dist.lessThanOrEqualTo(this.maxDistancePct)
  }

  // ─── Confidence calculation ───────────────────────────────────────────────────

  /**
   * @param {number}  lifespan      – how long the level existed in ms
   * @param {Decimal} peakQty       – peak observed quantity at the level
   * @param {Decimal} bookMedianQty – median qty across all tracked levels (dynamic denominator)
   */
  _calcConfidence(lifespan, peakQty, bookMedianQty) {
    // 0→1: how quickly the order vanished relative to the lifespan threshold
    const lifespanFraction = Math.max(0, 1 - lifespan / this.lifespanMs)
    // 0→1: how much larger the order was compared to 10× the book's current median qty.
    // Using a dynamic denominator prevents saturation on instruments with large tick sizes
    // (e.g. BTC perpetuals where a 100-contract denominator clips almost every real wall).
    const denominator = bookMedianQty && bookMedianQty.gt(0)
      ? bookMedianQty.mul(10)
      : this.minWallQty.mul(2)
    const sizeFactor = Math.min(1, peakQty.div(denominator).toNumber())
    return Math.round(Math.min(0.99, lifespanFraction * 0.6 + sizeFactor * 0.4) * 100) / 100
  }

  // ─── Main update call ─────────────────────────────────────────────────────────

  /**
   * Process an OrderBook snapshot and return any detected SpoofingEvents.
   * Call this on every `onBook` callback from the LocalOrderBookEngine.
   *
   * @param {import('../entities/OrderBook').OrderBook} orderBook
   * @param {{ medianQty?: import('decimal.js').Decimal | null }} [ctx]
   *   Optional precomputed context shared with sibling services to avoid
   *   recomputing the book-wide median qty on every emit.
   * @returns {SpoofingEvent[]}
   */
  update(orderBook, ctx = null) {
    const now      = Date.now()
    const events   = []
    const midPrice = orderBook.midPrice
    const midNum   = midPrice ? new Decimal(midPrice) : null

    const currentKeys = new Set()

    for (const level of orderBook.bids) {
      if (level.qty.gte(this.minWallQty) && this._isNearMid(level.price, midPrice)) {
        const key = this._priceKey('bid', level.price.toFixed())
        currentKeys.add(key)
        if (!this._trackedLevels.has(key)) {
          // Evict oldest entry if at capacity to prevent unbounded memory growth
          if (this._trackedLevels.size >= MAX_TRACKED_LEVELS) {
            const firstKey = this._trackedLevels.keys().next().value
            this._trackedLevels.delete(firstKey)
          }
          this._trackedLevels.set(key, {
            side: 'bid',
            price: level.price.toFixed(),
            firstSeen: now,
            peakQty: level.qty,
            midAtEntry: midNum ? midNum.toFixed() : '0',
          })
        } else {
          const tracked = this._trackedLevels.get(key)
          if (level.qty.gt(tracked.peakQty)) tracked.peakQty = level.qty
        }
      }
    }

    for (const level of orderBook.asks) {
      if (level.qty.gte(this.minWallQty) && this._isNearMid(level.price, midPrice)) {
        const key = this._priceKey('ask', level.price.toFixed())
        currentKeys.add(key)
        if (!this._trackedLevels.has(key)) {
          if (this._trackedLevels.size >= MAX_TRACKED_LEVELS) {
            const firstKey = this._trackedLevels.keys().next().value
            this._trackedLevels.delete(firstKey)
          }
          this._trackedLevels.set(key, {
            side: 'ask',
            price: level.price.toFixed(),
            firstSeen: now,
            peakQty: level.qty,
            midAtEntry: midNum ? midNum.toFixed() : '0',
          })
        } else {
          const tracked = this._trackedLevels.get(key)
          if (level.qty.gt(tracked.peakQty)) tracked.peakQty = level.qty
        }
      }
    }

    // Compute book-wide median quantity for dynamic confidence denominator
    // (use the precomputed value from the shared context when available).
    let bookMedianQty = ctx?.medianQty ?? null
    if (bookMedianQty === null) {
      const allQtys = [...orderBook.bids, ...orderBook.asks]
        .map((l) => l.qty)
        .filter((q) => q.gt(0))
        .sort((a, b) => a.comparedTo(b))
      bookMedianQty = allQtys.length > 0
        ? (allQtys.length % 2 === 0
          ? allQtys[allQtys.length / 2 - 1].plus(allQtys[allQtys.length / 2]).div(2)
          : allQtys[Math.floor(allQtys.length / 2)])
        : null
    }

    // Detect levels that were tracked but are no longer in the snapshot
    for (const [key, tracked] of this._trackedLevels) {
      if (!currentKeys.has(key)) {
        const lifespan = now - tracked.firstSeen
        if (lifespan < this.lifespanMs) {
          const confidence = this._calcConfidence(lifespan, tracked.peakQty, bookMedianQty)
          // Build descriptive reason with concrete numbers for downstream consumers
          const distancePct = tracked.midAtEntry && Number(tracked.midAtEntry) > 0
            ? (Math.abs(Number(tracked.price) - Number(tracked.midAtEntry)) / Number(tracked.midAtEntry) * 100).toFixed(3)
            : 'n/a'
          const reason = `${tracked.side} wall of ${tracked.peakQty.toFixed(2)} contracts at ${tracked.price} vanished in ${lifespan}ms (threshold ${this.lifespanMs}ms), ${distancePct}% from mid at entry`
          events.push(new SpoofingEvent({
            symbol:     this.symbol,
            side:       tracked.side,
            price:      tracked.price,
            peakQty:    tracked.peakQty.toFixed(4),
            lifespanMs: lifespan,
            detectedAt: now,
            confidence,
            reason,
            nearMid:    true,
          }))
        }
        this._trackedLevels.delete(key)
      }
    }

    return events
  }

  /** Reset all tracked state (call on unsubscribe). */
  reset() {
    this._trackedLevels.clear()
  }
}

module.exports = { SpoofingDetectorService }
