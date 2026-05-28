'use strict'

const { performance } = require('perf_hooks')
const { OrderBook } = require('../../domain/futures/entities/OrderBook')
const { logger } = require('../../shared/utils/logger')
const { RingBuffer } = require('../../shared/utils/RingBuffer')
const { metrics } = require('../observability/metrics')

/** Maximum number of deltas to buffer while waiting for a snapshot. */
const MAX_PENDING_DELTAS = Number(process.env.MAX_PENDING_DELTAS ?? 2000)
const BUFFER_WARN_THRESHOLD = Number(process.env.LATENCY_BUFFER_WARN_THRESHOLD ?? 500)
const LATENCY_DEBUG = process.env.LATENCY_DEBUG === '1'
const LATENCY_WARN_MS = Number(process.env.LATENCY_WARN_MS ?? 8)

/**
 * Maximum emit frequency: cap calls to onBook / SpoofingDetector / LiquidityShift
 * at 20 fps (50 ms). Deltas are still applied to the bid/ask maps on every event;
 * only the expensive OrderBook construction and domain-service processing is throttled.
 */
const EMIT_THROTTLE_MS = Number(process.env.EMIT_THROTTLE_MS ?? 50)

/**
 * Maximum levels kept per side in the local book. Levels farther from the best
 * are pruned after each apply. Caps memory and emit cost regardless of stream
 * pressure.
 *
 * Why this matters: Binance diff-depth only sends explicit zero-qty deletes for
 * levels that change. Far-from-mid levels that receive a quantity but never a
 * follow-up zero stay in the map forever, causing slow OOM growth.
 */
const MAX_BOOK_LEVELS = Math.max(20, Number(process.env.MAX_BOOK_LEVELS ?? 250))

/**
 * Levels emitted downstream per side. Cap on the OrderBook entity rebuilt per
 * emit; this is what Spoofing / LiquidityShift / clients see. Bounded to limit
 * cost of the O(N log N) sort + Decimal allocation inside OrderBook.
 */
const EMIT_DEPTH = Math.max(10, Number(process.env.EMIT_DEPTH ?? 100))

/**
 * Infrastructure service: maintains a locally-reconstructed order book for a
 * single symbol from a REST snapshot + diff-depth WebSocket updates.
 *
 * Internal representation: Map<priceString, number>. Quantities use Number on
 * the hot path; Decimal is only constructed at the emit boundary inside the
 * OrderBook entity. This is the dominant GC-pressure reduction vs. the legacy
 * Decimal-everywhere implementation.
 *
 * Memory bounds: after each apply (lazily, once a side exceeds 1.5× the cap),
 * the engine prunes both sides to MAX_BOOK_LEVELS levels closest to top-of-book.
 */
class LocalOrderBookEngine {
  /**
   * @param {object}   params
   * @param {string}   params.symbol
   * @param {Function} [params.onBook]    Called with an OrderBook entity after each update
   * @param {Function} [params.onResync]  Called with (symbol) when a gap is detected
   */
  constructor({ symbol, onBook, onResync } = {}) {
    this.symbol = symbol
    this._onBook = onBook ?? (() => {})
    this._onResync = onResync ?? (() => {})

    /** @type {Map<string, number>} price → qty */
    this._bids = new Map()
    /** @type {Map<string, number>} price → qty */
    this._asks = new Map()

    this._lastUpdateId = null
    this._synced = false
    this._lastSyncAt = null
    this._lastDepthUpdateAt = null

    /** Deltas buffered while waiting for a snapshot. Bounded ring buffer. */
    this._pendingDeltas = new RingBuffer(MAX_PENDING_DELTAS)

    // Health counters
    this._resyncCount = 0
    this._gapCount = 0
    this._invalidBookCount = 0
    this._prunedLevels = 0
    this._lastEmitAt = 0
    this._lastWarnBufferLen = 0
  }

  // ─── Snapshot ────────────────────────────────────────────────────────────────

  /**
   * Apply a full REST depth snapshot.
   *
   * @param {{ lastUpdateId: number, bids: Array, asks: Array }} snapshot
   *   bids/asks are arrays of [priceString, qtyString] tuples.
   */
  applySnapshot({ lastUpdateId, bids, asks }) {
    this._bids.clear()
    this._asks.clear()

    for (const [price, qty] of bids) {
      const q = +qty
      if (q > 0) this._bids.set(price, q)
    }
    for (const [price, qty] of asks) {
      const q = +qty
      if (q > 0) this._asks.set(price, q)
    }

    this._lastUpdateId = lastUpdateId
    this._synced = true
    this._lastSyncAt = Date.now()
    this._resyncCount++
    metrics.orderBookResyncs.inc({ symbol: this.symbol })

    logger.debug(`[LocalOrderBookEngine] Snapshot applied for ${this.symbol} lastUpdateId=${lastUpdateId}`)

    this._pruneFarLevels()
    this._drainBuffer()

    this._emit()
  }

  // ─── Delta ───────────────────────────────────────────────────────────────────

  applyDelta({ firstUpdateId, finalUpdateId, prevFinalUpdateId, bids, asks }) {
    if (!Array.isArray(bids) || !Array.isArray(asks)) {
      logger.warn(
        `[LocalOrderBookEngine] applyDelta received non-array bids/asks for ${this.symbol} ` +
          `— dropping delta (firstUpdateId=${firstUpdateId})`,
      )
      return
    }

    if (!this._synced) {
      this._pendingDeltas.push({ firstUpdateId, finalUpdateId, prevFinalUpdateId, bids, asks })
      const len = this._pendingDeltas.size
      if (
        LATENCY_DEBUG &&
        len >= BUFFER_WARN_THRESHOLD &&
        len - this._lastWarnBufferLen >= 100
      ) {
        this._lastWarnBufferLen = len
        logger.warn(`[LocalOrderBookEngine] Pending delta buffer high for ${this.symbol}: ${len}`)
      }
      return
    }

    this._applyValidatedDelta({ firstUpdateId, finalUpdateId, prevFinalUpdateId, bids, asks })
  }

  // ─── Internal ────────────────────────────────────────────────────────────────

  _drainBuffer() {
    const t0 = performance.now()
    const pending = this._pendingDeltas.toArray()
    this._pendingDeltas.clear()
    this._lastWarnBufferLen = 0

    let applied = 0

    for (const delta of pending) {
      if (delta.finalUpdateId <= this._lastUpdateId) continue

      if (delta.firstUpdateId > this._lastUpdateId + 1) {
        logger.warn(
          `[LocalOrderBookEngine] Buffer gap for ${this.symbol}: ` +
            `expected firstUpdateId <= ${this._lastUpdateId + 1}, got ${delta.firstUpdateId}`,
        )
        this._synced = false
        this._gapCount++
        metrics.orderBookGaps.inc({ symbol: this.symbol })
        this._onResync(this.symbol)
        return
      }

      this._applyBidAskMaps(delta.bids, delta.asks)
      this._lastUpdateId = delta.finalUpdateId
      this._lastDepthUpdateAt = Date.now()
      applied++
    }

    if (applied > 0) {
      logger.debug(`[LocalOrderBookEngine] Replayed ${applied} buffered delta(s) for ${this.symbol}`)
      if (LATENCY_DEBUG) {
        const ms = performance.now() - t0
        if (ms >= LATENCY_WARN_MS) {
          logger.warn(
            `[LocalOrderBookEngine] Slow buffer drain for ${this.symbol}: ${ms.toFixed(2)}ms (${applied} deltas)`,
          )
        }
      }
    }
  }

  _applyValidatedDelta({ firstUpdateId, finalUpdateId, prevFinalUpdateId, bids, asks }) {
    const t0 = LATENCY_DEBUG ? performance.now() : 0
    if (finalUpdateId <= this._lastUpdateId) return

    const hasGap =
      prevFinalUpdateId != null
        ? prevFinalUpdateId !== this._lastUpdateId && firstUpdateId > this._lastUpdateId + 1
        : firstUpdateId > this._lastUpdateId + 1

    if (hasGap) {
      this._gapCount++
      this._synced = false
      metrics.orderBookGaps.inc({ symbol: this.symbol })
      logger.warn(
        `[LocalOrderBookEngine] Gap for ${this.symbol}: ` +
          `pu=${prevFinalUpdateId} !== lastUpdateId=${this._lastUpdateId} ` +
          `(firstUpdateId=${firstUpdateId})`,
      )
      this._onResync(this.symbol)
      return
    }

    this._applyBidAskMaps(bids, asks)
    this._lastUpdateId = finalUpdateId
    this._lastDepthUpdateAt = Date.now()

    // Prune lazily: only when one side exceeds 1.5× the cap, to amortize cost.
    if (this._bids.size > MAX_BOOK_LEVELS * 1.5 || this._asks.size > MAX_BOOK_LEVELS * 1.5) {
      this._pruneFarLevels()
    }

    this._emit()

    if (LATENCY_DEBUG) {
      const ms = performance.now() - t0
      if (ms >= LATENCY_WARN_MS) {
        logger.warn(`[LocalOrderBookEngine] Slow delta apply for ${this.symbol}: ${ms.toFixed(2)}ms`)
      }
    }
  }

  /**
   * Merge a bids/asks update into the internal maps.
   * Entries with qty === 0 are removed; others are upserted as Number.
   */
  _applyBidAskMaps(bids, asks) {
    for (const entry of bids) {
      const price = Array.isArray(entry) ? entry[0] : entry.price
      const qtyRaw = Array.isArray(entry) ? entry[1] : (entry.quantity ?? entry.qty)
      const q = +qtyRaw
      if (!(q > 0)) {
        this._bids.delete(price)
      } else {
        this._bids.set(price, q)
      }
    }
    for (const entry of asks) {
      const price = Array.isArray(entry) ? entry[0] : entry.price
      const qtyRaw = Array.isArray(entry) ? entry[1] : (entry.quantity ?? entry.qty)
      const q = +qtyRaw
      if (!(q > 0)) {
        this._asks.delete(price)
      } else {
        this._asks.set(price, q)
      }
    }
  }

  /**
   * Drop levels that are too far from the best, keeping only the top
   * MAX_BOOK_LEVELS per side. Prevents unbounded growth caused by levels deep
   * in the book that never receive a zero-qty delete.
   */
  _pruneFarLevels() {
    if (this._bids.size > MAX_BOOK_LEVELS) {
      const bidPrices = new Array(this._bids.size)
      let i = 0
      for (const p of this._bids.keys()) bidPrices[i++] = +p
      bidPrices.sort((a, b) => b - a)
      const cutoff = bidPrices[MAX_BOOK_LEVELS - 1]
      let removed = 0
      for (const p of this._bids.keys()) {
        if (+p < cutoff) {
          this._bids.delete(p)
          removed++
        }
      }
      this._prunedLevels += removed
    }

    if (this._asks.size > MAX_BOOK_LEVELS) {
      const askPrices = new Array(this._asks.size)
      let i = 0
      for (const p of this._asks.keys()) askPrices[i++] = +p
      askPrices.sort((a, b) => a - b)
      const cutoff = askPrices[MAX_BOOK_LEVELS - 1]
      let removed = 0
      for (const p of this._asks.keys()) {
        if (+p > cutoff) {
          this._asks.delete(p)
          removed++
        }
      }
      this._prunedLevels += removed
    }

    metrics.orderBookLevels.set({ symbol: this.symbol, side: 'bid' }, this._bids.size)
    metrics.orderBookLevels.set({ symbol: this.symbol, side: 'ask' }, this._asks.size)
  }

  // ─── Emit ────────────────────────────────────────────────────────────────────

  _emit() {
    const now = Date.now()
    if (now - this._lastEmitAt < EMIT_THROTTLE_MS) return
    this._lastEmitAt = now

    const t0 = performance.now()
    const bids = topKByPrice(this._bids, EMIT_DEPTH, /*descending*/ true)
    const asks = topKByPrice(this._asks, EMIT_DEPTH, /*descending*/ false)

    try {
      const ob = new OrderBook({ symbol: this.symbol, bids, asks })
      if (!ob.isValidTopOfBook) {
        this._invalidBookCount++
        return
      }
      this._onBook(ob)

      const ms = performance.now() - t0
      metrics.orderBookEmitLatencyMs.observe({ symbol: this.symbol }, ms)
      if (LATENCY_DEBUG && ms >= LATENCY_WARN_MS) {
        logger.warn(`[LocalOrderBookEngine] Slow book emit for ${this.symbol}: ${ms.toFixed(2)}ms`)
      }
    } catch (err) {
      logger.warn(`[LocalOrderBookEngine] Failed to build OrderBook for ${this.symbol}: ${err.message}`)
    }
  }

  // ─── Health ──────────────────────────────────────────────────────────────────

  getHealth() {
    const now = Date.now()
    return {
      symbol: this.symbol,
      bookSynced: this._synced,
      lastUpdateAgeMs: this._lastDepthUpdateAt ? now - this._lastDepthUpdateAt : null,
      lastSyncAt: this._lastSyncAt,
      lastUpdateId: this._lastUpdateId,
      resyncCount: this._resyncCount,
      gapCount: this._gapCount,
      invalidBookCount: this._invalidBookCount,
      bidLevels: this._bids.size,
      askLevels: this._asks.size,
      prunedLevels: this._prunedLevels,
      pendingDeltas: this._pendingDeltas.size,
    }
  }

  reset() {
    this._bids.clear()
    this._asks.clear()
    this._pendingDeltas.clear()
    this._lastUpdateId = null
    this._synced = false
    this._lastDepthUpdateAt = null
    this._lastEmitAt = 0
    this._lastWarnBufferLen = 0
  }
}

/**
 * Returns the top-K [priceString, qtyString] tuples from a price→qty Map,
 * sorted by price. With MAX_BOOK_LEVELS bounding the source map a full sort is
 * cheap; avoids heap-implementation complexity.
 */
function topKByPrice(map, k, descending) {
  if (map.size === 0) return []
  const entries = new Array(map.size)
  let i = 0
  for (const [p, q] of map) {
    entries[i++] = [p, +p, q]
  }
  entries.sort(descending ? (a, b) => b[1] - a[1] : (a, b) => a[1] - b[1])
  const n = Math.min(k, entries.length)
  const out = new Array(n)
  for (let j = 0; j < n; j++) {
    const e = entries[j]
    out[j] = [e[0], String(e[2])]
  }
  return out
}

module.exports = { LocalOrderBookEngine, MAX_BOOK_LEVELS, EMIT_DEPTH }
