'use strict'

/**
 * Infrastructure: simple in-memory TTL cache for Binance exchangeInfo.
 * Avoids hitting the REST endpoint on every request; default TTL = 5 minutes.
 */
class InMemoryExchangeInfoCache {
  /**
   * @param {number} ttlMs  time-to-live in milliseconds (default 5 min)
   */
  constructor(ttlMs = 5 * 60 * 1000) {
    this._ttlMs    = ttlMs
    this._data     = null
    this._fetchedAt = null
  }

  /** @returns {boolean} */
  isValid() {
    return this._data !== null && (Date.now() - this._fetchedAt) < this._ttlMs
  }

  /** @returns {object|null} */
  get() {
    return this._data
  }

  /** @param {object} data */
  set(data) {
    this._data      = data
    this._fetchedAt = Date.now()
  }

  invalidate() {
    this._data      = null
    this._fetchedAt = null
  }
}

module.exports = { InMemoryExchangeInfoCache }
