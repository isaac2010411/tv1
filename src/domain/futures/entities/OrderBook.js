'use strict'

const { Decimal } = require('../../../shared/utils/decimal')

/**
 * Entity: a normalised, immutable snapshot of an order book.
 * All numeric operations use Decimal.js – no native float arithmetic.
 *
 * Constructor guarantees:
 *  – Only levels with finite price and qty > 0 are kept.
 *  – Bids are sorted descending by price (best bid first).
 *  – Asks are sorted ascending by price (best ask first).
 */
class OrderBook {
  /**
   * @param {object}   params
   * @param {string}   params.symbol
   * @param {Array<[string, string]|{price:string, quantity:string}>} params.bids
   * @param {Array<[string, string]|{price:string, quantity:string}>} params.asks
   */
  constructor({ symbol, bids = [], asks = [] }) {
    this.symbol = symbol

    const toLevel = (level) => {
      const rawPrice = Array.isArray(level) ? level[0] : level.price
      const rawQty   = Array.isArray(level) ? level[1] : (level.quantity ?? level.qty)
      return {
        price: new Decimal(rawPrice),
        qty:   new Decimal(rawQty),
      }
    }

    const isValid = (level) =>
      level.price.isFinite() &&
      level.qty.isFinite() &&
      level.qty.greaterThan(0)

    this.bids = bids
      .map(toLevel)
      .filter(isValid)
      .sort((a, b) => b.price.cmp(a.price))   // highest price first

    this.asks = asks
      .map(toLevel)
      .filter(isValid)
      .sort((a, b) => a.price.cmp(b.price))   // lowest price first
  }

  // ─── Derived properties ──────────────────────────────────────────────────────

  /** @returns {Decimal|null} */
  get bestBid() {
    return this.bids[0]?.price ?? null
  }

  /** @returns {Decimal|null} */
  get bestAsk() {
    return this.asks[0]?.price ?? null
  }

  /** @returns {Decimal|null} absolute spread */
  get spread() {
    if (!this.bestBid || !this.bestAsk) return null
    return this.bestAsk.minus(this.bestBid)
  }

  /** @returns {Decimal|null} */
  get midPrice() {
    if (!this.bestBid || !this.bestAsk) return null
    return this.bestBid.plus(this.bestAsk).div(2)
  }

  /** True only when bestAsk > bestBid (valid, non-crossed book). */
  get isValidTopOfBook() {
    return Boolean(
      this.bestBid &&
      this.bestAsk &&
      this.bestAsk.greaterThan(this.bestBid),
    )
  }

  /** @returns {Decimal|null} spread as a fraction of midPrice */
  get spreadPct() {
    if (!this.isValidTopOfBook || !this.midPrice || this.midPrice.isZero()) return null
    return this.spread.div(this.midPrice)
  }

  // ─── Volume helpers ──────────────────────────────────────────────────────────

  /** Total bid quantity across the top-N price levels. */
  bidVolumeTopN(n) {
    return this.bids.slice(0, n).reduce((acc, l) => acc.plus(l.qty), new Decimal(0))
  }

  /** Total ask quantity across the top-N price levels. */
  askVolumeTopN(n) {
    return this.asks.slice(0, n).reduce((acc, l) => acc.plus(l.qty), new Decimal(0))
  }

  /**
   * Order-book imbalance in the top-N levels.
   * Returns a value in [-1, 1]:
   *   +1 = maximum bid pressure
   *    0 = neutral
   *   -1 = maximum ask pressure
   */
  imbalanceTopN(n) {
    const bidVol = this.bidVolumeTopN(n)
    const askVol = this.askVolumeTopN(n)
    const total  = bidVol.plus(askVol)
    if (total.isZero()) return new Decimal(0)
    return bidVol.minus(askVol).div(total)
  }

  /**
   * Detects anomalous "wall" levels where qty >= median(allQtys) × multiplier.
   *
   * Accepts a config object or a plain number (legacy, treated as `multiplier`).
   *
   * @param {number|{multiplier?: number, maxDistancePct?: number|null, depth?: number|null, medianQty?: import('decimal.js').Decimal|null}} config
   *   multiplier      – how many times the median a level must be to count as a wall (default 3)
   *   maxDistancePct  – if set, only levels within this fraction of midPrice are TACTICAL_WALL;
   *                     farther levels are labelled MACRO_WALL (default null = always MACRO_WALL)
   *   depth           – cap the number of levels searched on each side (default null = all)
   *   medianQty       – optional precomputed median to skip the internal sort (Phase 2 perf opt)
   */
  detectWalls(config = {}) {
    // Backwards-compat: allow detectWalls(3) numeric shorthand
    if (typeof config === 'number') config = { multiplier: config }

    const {
      multiplier     = 3,
      maxDistancePct = null,
      depth          = null,
      medianQty      = null,
    } = config

    const bids = depth ? this.bids.slice(0, depth) : this.bids
    const asks = depth ? this.asks.slice(0, depth) : this.asks

    let median = medianQty
    if (median === null) {
      const allQtys = [...bids, ...asks].map((l) => l.qty)
      if (allQtys.length === 0) return { bidWalls: [], askWalls: [] }
      const sorted = [...allQtys].sort((a, b) => a.cmp(b))
      const mid    = Math.floor(sorted.length / 2)
      median = sorted.length % 2 === 0
        ? sorted[mid - 1].plus(sorted[mid]).div(2)
        : sorted[mid]
    }
    if (!median || median.isZero?.()) {
      // No qty signal at all → no walls.
      if (bids.length === 0 && asks.length === 0) return { bidWalls: [], askWalls: [] }
    }

    const threshold = median.mul(multiplier)
    const midPrice  = this.midPrice

    const categorize = (level) => {
      if (maxDistancePct == null || !midPrice || midPrice.isZero()) return 'MACRO_WALL'
      const distPct = level.price.minus(midPrice).abs().div(midPrice)
      return distPct.lessThanOrEqualTo(maxDistancePct) ? 'TACTICAL_WALL' : 'MACRO_WALL'
    }

    const toPlain = (l) => ({
      price:    l.price.toFixed(),
      qty:      l.qty.toFixed(),
      category: categorize(l),
    })

    return {
      bidWalls: bids.filter((l) => l.qty.greaterThanOrEqualTo(threshold)).map(toPlain),
      askWalls: asks.filter((l) => l.qty.greaterThanOrEqualTo(threshold)).map(toPlain),
    }
  }

  toJSON() {
    return {
      symbol:   this.symbol,
      bestBid:  this.bestBid?.toFixed()  ?? null,
      bestAsk:  this.bestAsk?.toFixed()  ?? null,
      spread:   this.spread?.toFixed()   ?? null,
      midPrice: this.midPrice?.toFixed() ?? null,
      bids:     this.bids.map((l) => [l.price.toFixed(), l.qty.toFixed()]),
      asks:     this.asks.map((l) => [l.price.toFixed(), l.qty.toFixed()]),
    }
  }
}

module.exports = { OrderBook }
