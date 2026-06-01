'use strict'

function toFiniteNumber(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value))
}

class IncrementalEma {
  constructor(period) {
    this.period = period
    this.k = 2 / (period + 1)
    this.samples = []
    this.value = null
  }

  update(value) {
    const n = toFiniteNumber(value)
    if (n == null) return this.value

    if (this.value == null) {
      this.samples.push(n)
      if (this.samples.length === this.period) {
        this.value = this.samples.reduce((a, b) => a + b, 0) / this.period
        this.samples = []
      }
      return this.value
    }

    this.value = n * this.k + this.value * (1 - this.k)
    return this.value
  }

  clone() {
    const copy = new IncrementalEma(this.period)
    copy.samples = this.samples.slice()
    copy.value = this.value
    return copy
  }
}

class IncrementalRsi {
  constructor(period = 14) {
    this.period = period
    this.prevClose = null
    this.seedDiffs = []
    this.avgGain = null
    this.avgLoss = null
    this.value = null
  }

  update(close) {
    const n = toFiniteNumber(close)
    if (n == null) return this.value

    if (this.prevClose == null) {
      this.prevClose = n
      return this.value
    }

    const diff = n - this.prevClose
    this.prevClose = n
    const gain = Math.max(0, diff)
    const loss = Math.max(0, -diff)

    if (this.avgGain == null || this.avgLoss == null) {
      this.seedDiffs.push({ gain, loss })
      if (this.seedDiffs.length === this.period) {
        this.avgGain = this.seedDiffs.reduce((acc, d) => acc + d.gain, 0) / this.period
        this.avgLoss = this.seedDiffs.reduce((acc, d) => acc + d.loss, 0) / this.period
        this.seedDiffs = []
        this.value = this.avgLoss === 0 ? 100 : 100 - 100 / (1 + this.avgGain / this.avgLoss)
      }
      return this.value
    }

    this.avgGain = (this.avgGain * (this.period - 1) + gain) / this.period
    this.avgLoss = (this.avgLoss * (this.period - 1) + loss) / this.period
    this.value = this.avgLoss === 0 ? 100 : 100 - 100 / (1 + this.avgGain / this.avgLoss)
    return this.value
  }

  clone() {
    const copy = new IncrementalRsi(this.period)
    copy.prevClose = this.prevClose
    copy.seedDiffs = cloneJson(this.seedDiffs)
    copy.avgGain = this.avgGain
    copy.avgLoss = this.avgLoss
    copy.value = this.value
    return copy
  }
}

class IncrementalMacd {
  constructor(fast = 12, slow = 26, signalPeriod = 9) {
    this.fast = new IncrementalEma(fast)
    this.slow = new IncrementalEma(slow)
    this.signal = new IncrementalEma(signalPeriod)
    this.line = null
    this.signalValue = null
    this.histogram = null
  }

  update(close) {
    const fast = this.fast.update(close)
    const slow = this.slow.update(close)
    if (fast == null || slow == null) return this.snapshot()

    this.line = fast - slow
    this.signalValue = this.signal.update(this.line)
    this.histogram = this.signalValue == null ? null : this.line - this.signalValue
    return this.snapshot()
  }

  snapshot() {
    return {
      line: this.line,
      signal: this.signalValue,
      histogram: this.histogram,
    }
  }

  clone() {
    const copy = new IncrementalMacd()
    copy.fast = this.fast.clone()
    copy.slow = this.slow.clone()
    copy.signal = this.signal.clone()
    copy.line = this.line
    copy.signalValue = this.signalValue
    copy.histogram = this.histogram
    return copy
  }
}

class IncrementalIndicatorService {
  constructor({ symbol, interval }) {
    this.symbol = symbol
    this.interval = interval
    this.ema20 = new IncrementalEma(20)
    this.ema50 = new IncrementalEma(50)
    this.rsi14 = new IncrementalRsi(14)
    this.macd = new IncrementalMacd()
    this.lastFinalOpenTime = null
    this.latest = null
  }

  seed(candles = []) {
    for (const candle of candles) {
      this.updateFinal(candle)
    }
    return this.latest
  }

  updateFinal(candle) {
    const openTime = Number(candle?.openTime ?? candle?.t ?? candle?.open_time)
    if (!Number.isFinite(openTime)) return this.latest
    if (this.lastFinalOpenTime != null && openTime <= this.lastFinalOpenTime) return this.latest

    this.lastFinalOpenTime = openTime
    this.latest = this._apply(candle)
    return this.latest
  }

  preview(candle) {
    const close = toFiniteNumber(candle?.close ?? candle?.c)
    if (close == null) return this.latest

    const copy = this.clone()
    return copy._apply(candle)
  }

  _apply(candle) {
    const close = toFiniteNumber(candle?.close ?? candle?.c)
    if (close == null) return this.latest

    const openTime = Number(candle?.openTime ?? candle?.t ?? candle?.open_time ?? 0) || null
    const macd = this.macd.update(close)
    return {
      symbol: this.symbol,
      interval: this.interval,
      openTime,
      ema20: this.ema20.update(close),
      ema50: this.ema50.update(close),
      rsi14: this.rsi14.update(close),
      macd,
      updatedAt: Date.now(),
    }
  }

  clone() {
    const copy = new IncrementalIndicatorService({ symbol: this.symbol, interval: this.interval })
    copy.ema20 = this.ema20.clone()
    copy.ema50 = this.ema50.clone()
    copy.rsi14 = this.rsi14.clone()
    copy.macd = this.macd.clone()
    copy.lastFinalOpenTime = this.lastFinalOpenTime
    copy.latest = this.latest ? cloneJson(this.latest) : null
    return copy
  }
}

module.exports = {
  IncrementalIndicatorService,
  IncrementalEma,
  IncrementalRsi,
  IncrementalMacd,
}
