'use strict'

const { RingBuffer } = require('../../../shared/utils/RingBuffer')
const { FootprintCandleService } = require('./FootprintCandleService')
const { IncrementalIndicatorService } = require('./IncrementalIndicatorService')

class SessionCandleStore {
  constructor({ symbol, intervals = ['1m'], tickSize, maxHistory = 500 }) {
    this.symbol = symbol
    this.tickSize = tickSize
    this.maxHistory = maxHistory
    this._intervals = new Map()

    for (const interval of intervals) {
      this._ensureInterval(interval)
    }
  }

  _ensureInterval(interval) {
    if (!this._intervals.has(interval)) {
      this._intervals.set(interval, {
        history: new RingBuffer(this.maxHistory),
        currentCandle: null,
        indicators: new IncrementalIndicatorService({ symbol: this.symbol, interval }),
        footprint: new FootprintCandleService({
          symbol: this.symbol,
          interval,
          tickSize: this.tickSize,
          maxHistory: this.maxHistory,
        }),
        lastUpdatedAt: null,
      })
    }
    return this._intervals.get(interval)
  }

  seedCandles(interval, candles = []) {
    const state = this._ensureInterval(interval)
    const closedCandles = (Array.isArray(candles) ? candles : [])
      .filter((c) => c && c.openTime != null)
      .sort((a, b) => Number(a.openTime) - Number(b.openTime))
      .slice(-this.maxHistory)

    state.history.clear()
    state.indicators = new IncrementalIndicatorService({ symbol: this.symbol, interval })
    for (const candle of closedCandles) {
      const indicators = state.indicators.updateFinal(candle)
      state.history.push({
        ...candle,
        symbol: candle.symbol ?? this.symbol,
        interval: candle.interval ?? interval,
        isFinal: candle.isFinal ?? true,
        indicators,
      })
    }
    state.lastUpdatedAt = Date.now()

    return this.getHistory(interval)
  }

  upsertCandle(candle) {
    const interval = candle?.interval
    if (!interval) return null

    const state = this._ensureInterval(interval)
    const openTime = Number(candle?.openTime)
    if (!Number.isFinite(openTime) || openTime <= 0) return null

    state.currentCandle = candle.isFinal ? null : candle
    let finalizedCandle = null
    let indicators = null

    if (candle.isFinal) {
      const latest = state.history.toArray().slice(-1)[0]
      if (!latest || Number(latest.openTime) < openTime) {
        indicators = state.indicators.updateFinal(candle)
        finalizedCandle = { ...candle, indicators }
        state.history.push(finalizedCandle)
      } else if (Number(latest.openTime) === openTime) {
        indicators = state.indicators.latest
        finalizedCandle = { ...candle, indicators }
      }
    } else {
      indicators = state.indicators.preview(candle)
    }

    let footprint = null
    try {
      state.footprint.updateFromCandle(candle)
      footprint = state.footprint.getCurrent() ?? state.footprint.getHistory(1)[0] ?? null
    } finally {
      state.lastUpdatedAt = Date.now()
    }

    return {
      symbol: this.symbol,
      interval,
      currentCandle: state.currentCandle,
      finalizedCandle,
      wasFinalized: Boolean(finalizedCandle),
      history: this.getHistory(interval),
      indicators,
      footprint,
      snapshot: this.getSnapshot(interval),
    }
  }

  addTrade(trade) {
    for (const state of this._intervals.values()) {
      state.footprint.updateFromTrade(trade)
      state.lastUpdatedAt = Date.now()
    }
  }

  getHistory(interval, limit = this.maxHistory) {
    const state = this._ensureInterval(interval)
    return state.history.toArray().slice(-limit)
  }

  getCandleHistoryMap() {
    const map = new Map()
    for (const [interval, state] of this._intervals) {
      map.set(interval, state.history.toArray())
    }
    return map
  }

  getFootprintHistory(interval, limit = 100) {
    const state = this._ensureInterval(interval)
    return state.footprint.getHistory(limit)
  }

  getFootprintPlainHistory(interval, limit = 100) {
    return this.getFootprintHistory(interval, limit).map((candle) => candle.toPlainObject())
  }

  getSnapshot(interval) {
    const state = this._ensureInterval(interval)
    const currentFootprint = state.footprint.getCurrent()
    const latestFootprint = currentFootprint ?? state.footprint.getHistory(1)[0] ?? null
    return {
      symbol: this.symbol,
      interval,
      currentCandle: state.currentCandle,
      latestClosedCandle: state.history.toArray().slice(-1)[0] ?? null,
      indicators: state.indicators.latest,
      footprint: latestFootprint ? latestFootprint.toPlainObject() : null,
      session: {
        candlesCount: state.history.size,
        closedCandlesCount: state.history.size,
        lastFinalOpenTime: state.indicators.lastFinalOpenTime,
        lastUpdatedAt: state.lastUpdatedAt,
      },
    }
  }

  reset() {
    for (const state of this._intervals.values()) {
      state.history.clear()
      state.currentCandle = null
      state.indicators = new IncrementalIndicatorService({
        symbol: this.symbol,
        interval: state.indicators.interval,
      })
      state.footprint.reset()
      state.lastUpdatedAt = null
    }
  }
}

module.exports = { SessionCandleStore }
