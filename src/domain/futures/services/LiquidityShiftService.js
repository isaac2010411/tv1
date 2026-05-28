'use strict'

const { Decimal } = require('../../../shared/utils/decimal')
const { LiquidityShiftEvent } = require('../entities/LiquidityShiftEvent')

/**
 * Domain Service: detects significant changes in order-book wall structure.
 *
 * On each update it compares the new wall set to the previous one and emits:
 *   – WALL_ADDED:   a price level crossed the wall threshold (large order appeared)
 *   – WALL_REMOVED: a wall-level is gone (filled, cancelled, or reduced below threshold)
 *
 * Additionally, the service measures near-price liquidity deltas in a configurable
 * band around the mid price and assigns a severity (HIGH / MEDIUM / LOW) based on
 * the relative change in near-price liquidity.
 *
 * Stateful; one instance per subscribed symbol.
 *
 * Defaults:
 *   wallMultiplier  = 5    (5× median qty counts as a wall)
 *   maxDistancePct  = 0.01 (only walls within 1% of mid are NEAR_PRICE)
 */
class LiquidityShiftService {
  /**
   * @param {object} params
   * @param {string} params.symbol
   * @param {number} [params.wallMultiplier]
   * @param {number} [params.maxDistancePct] Fraction of mid price that defines "near" walls
   */
  constructor({ symbol, wallMultiplier = 5, maxDistancePct = 0.01 }) {
    this.symbol         = symbol
    this.wallMultiplier = wallMultiplier
    this.maxDistancePct = new Decimal(maxDistancePct)

    /**
     * Keys of levels that were walls in the previous snapshot.
     * Key format: `<side>@<price>`
     * @type {Map<string, { side: string, price: string, qty: string, nearMid: boolean }>}
     */
    this._prevWalls = new Map()

    /** Near-price bid/ask volume from previous snapshot. */
    this._prevNearBidVol = new Decimal(0)
    this._prevNearAskVol = new Decimal(0)
  }

  // ─── Main update call ─────────────────────────────────────────────────────────

  /**
   * @param {import('../entities/OrderBook').OrderBook} orderBook
   * @param {{ medianQty?: import('decimal.js').Decimal | null }} [ctx]
   *   Optional precomputed context to skip the redundant median sort inside
   *   detectWalls when the caller has already computed it for sibling services.
   * @returns {LiquidityShiftEvent[]}
   */
  update(orderBook, ctx = null) {
    const now      = Date.now()
    const events   = []
    const midPrice = orderBook.midPrice

    const { bidWalls, askWalls } = orderBook.detectWalls({
      multiplier:     this.wallMultiplier,
      maxDistancePct: null,  // detect all walls; we label them separately
      medianQty:      ctx?.medianQty ?? null,
    })

    const isNear = (price) => {
      if (!midPrice || midPrice.isZero()) return false
      const dist = new Decimal(price).minus(midPrice).abs().div(midPrice)
      return dist.lessThanOrEqualTo(this.maxDistancePct)
    }

    // ─── Near-price liquidity ─────────────────────────────────────────────────
    const nearBidVol = orderBook.bids
      .filter((l) => isNear(l.price.toFixed()))
      .reduce((acc, l) => acc.plus(l.qty), new Decimal(0))

    const nearAskVol = orderBook.asks
      .filter((l) => isNear(l.price.toFixed()))
      .reduce((acc, l) => acc.plus(l.qty), new Decimal(0))

    // ─── Build current wall map ───────────────────────────────────────────────
    const currentWalls = new Map()
    for (const w of bidWalls) {
      const near = isNear(w.price)
      currentWalls.set(`bid@${w.price}`, { side: 'bid', price: w.price, qty: w.qty, nearMid: near })
    }
    for (const w of askWalls) {
      const near = isNear(w.price)
      currentWalls.set(`ask@${w.price}`, { side: 'ask', price: w.price, qty: w.qty, nearMid: near })
    }

    // ─── Detect new walls (WALL_ADDED) ────────────────────────────────────────
    for (const [key, wall] of currentWalls) {
      if (!this._prevWalls.has(key)) {
        events.push(new LiquidityShiftEvent({
          symbol:    this.symbol,
          side:      wall.side,
          price:     wall.price,
          qty:       wall.qty,
          type:      'WALL_ADDED',
          nearMid:   wall.nearMid,
          severity:  this._severity(wall.qty, nearBidVol, nearAskVol, wall.side),
          timestamp: now,
        }))
      }
    }

    // ─── Detect removed walls (WALL_REMOVED) ──────────────────────────────────
    for (const [key, wall] of this._prevWalls) {
      if (!currentWalls.has(key)) {
        events.push(new LiquidityShiftEvent({
          symbol:    this.symbol,
          side:      wall.side,
          price:     wall.price,
          qty:       wall.qty,
          type:      'WALL_REMOVED',
          nearMid:   wall.nearMid,
          severity:  this._severity(wall.qty, nearBidVol, nearAskVol, wall.side),
          timestamp: now,
        }))
      }
    }

    this._prevWalls      = currentWalls
    this._prevNearBidVol = nearBidVol
    this._prevNearAskVol = nearAskVol

    return events
  }

  // ─── Severity ─────────────────────────────────────────────────────────────────

  /**
   * Assigns severity based on wall qty relative to near-price total volume.
   * HIGH   → wall is > 50% of near-price side volume
   * MEDIUM → wall is > 20%
   * LOW    → otherwise
   */
  _severity(qtyStr, nearBidVol, nearAskVol, side) {
    const qty       = new Decimal(qtyStr)
    const nearTotal = side === 'bid' ? nearBidVol : nearAskVol

    if (nearTotal.isZero()) return 'LOW'

    const pct = qty.div(nearTotal)
    if (pct.greaterThan('0.5'))  return 'HIGH'
    if (pct.greaterThan('0.2'))  return 'MEDIUM'
    return 'LOW'
  }

  /** Reset state (call on unsubscribe). */
  reset() {
    this._prevWalls.clear()
    this._prevNearBidVol = new Decimal(0)
    this._prevNearAskVol = new Decimal(0)
  }
}

module.exports = { LiquidityShiftService }
