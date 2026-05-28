'use strict'

/**
 * Value Object: a spoofing candidate event.
 *
 * A "SPOOFING_CANDIDATE" is a large order (≥ minWallQty) that:
 *  – appeared near the current mid price, AND
 *  – vanished within a short time window (< lifespanMs) without being filled.
 *
 * This is a candidate signal, NOT a certainty. The field `confidence` provides
 * a [0, 1] score. Consumers should treat it as probabilistic evidence.
 *
 * Immutable once created.
 */
class SpoofingEvent {
  /**
   * @param {object} params
   * @param {string}        params.symbol
   * @param {'bid'|'ask'}   params.side
   * @param {string}        params.price       String-formatted price
   * @param {string}        params.peakQty     Maximum observed quantity at that level
   * @param {number}        params.lifespanMs  How long the level existed before vanishing
   * @param {number}        params.detectedAt  Unix ms timestamp
   * @param {number}        [params.confidence]  Score in [0, 1] (default 0)
   * @param {string}        [params.reason]      Human-readable reason string
   * @param {boolean}       [params.nearMid]     Whether the level was near the mid price
   */
  constructor({ symbol, side, price, peakQty, lifespanMs, detectedAt, confidence = 0, reason = '', nearMid = false }) {
    this.symbol      = symbol
    this.side        = side
    this.price       = price
    this.peakQty     = peakQty
    this.lifespanMs  = lifespanMs
    this.detectedAt  = detectedAt
    this.confidence  = confidence
    this.reason      = reason
    this.nearMid     = nearMid

    Object.freeze(this)
  }

  toPlainObject() {
    return {
      type:       'SPOOFING_CANDIDATE',
      symbol:     this.symbol,
      side:       this.side,
      price:      this.price,
      peakQty:    this.peakQty,
      lifespanMs: this.lifespanMs,
      detectedAt: this.detectedAt,
      confidence: this.confidence,
      reason:     this.reason,
      nearMid:    this.nearMid,
    }
  }
}

module.exports = { SpoofingEvent }
