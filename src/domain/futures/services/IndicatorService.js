'use strict'

function toFiniteNumber(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function closeValues(candles) {
  return (Array.isArray(candles) ? candles : [])
    .map((c) => toFiniteNumber(c?.close ?? c?.c))
    .filter((n) => n !== null)
}

function computeEMASeries(values, period) {
  if (!values || values.length < period) return []
  const k = 2 / (period + 1)
  const series = []
  let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period
  series.push(ema)
  for (let i = period; i < values.length; i += 1) {
    ema = values[i] * k + ema * (1 - k)
    series.push(ema)
  }
  return series
}

function computeRSISeries(values, period = 14) {
  if (!values || values.length < period + 1) return []

  const series = []
  let gains = 0
  let losses = 0

  for (let i = 1; i <= period; i += 1) {
    const diff = values[i] - values[i - 1]
    if (diff > 0) gains += diff
    else losses -= diff
  }

  let avgGain = gains / period
  let avgLoss = losses / period
  series.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss))

  for (let i = period + 1; i < values.length; i += 1) {
    const diff = values[i] - values[i - 1]
    avgGain = (avgGain * (period - 1) + Math.max(0, diff)) / period
    avgLoss = (avgLoss * (period - 1) + Math.max(0, -diff)) / period
    series.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss))
  }

  return series
}

function computeMACDSeries(values, fast = 12, slow = 26, signalPeriod = 9) {
  const empty = { macdLine: [], signalLine: [], histogram: [], startIndex: 0 }
  if (!values || values.length < slow + signalPeriod) return empty

  const fastSeries = computeEMASeries(values, fast)
  const slowSeries = computeEMASeries(values, slow)
  if (!fastSeries.length || !slowSeries.length) return empty

  const offset = slow - fast
  const macdLine = slowSeries.map((s, i) => fastSeries[i + offset] - s)
  const signalLine = computeEMASeries(macdLine, signalPeriod)
  if (!signalLine.length) return empty

  const signalOffset = signalPeriod - 1
  const histogram = signalLine.map((sig, i) => macdLine[signalOffset + i] - sig)

  return {
    macdLine: macdLine.slice(signalOffset),
    signalLine,
    histogram,
    startIndex: slow - 1 + signalOffset,
  }
}

function latest(series) {
  return Array.isArray(series) && series.length > 0 ? series[series.length - 1] : null
}

class IndicatorService {
  computeLatest({ symbol, interval, candles }) {
    const list = Array.isArray(candles) ? candles : []
    const closes = closeValues(list)
    const lastCandle = list[list.length - 1] ?? null
    if (!lastCandle || closes.length === 0) return null

    const ema20 = latest(computeEMASeries(closes, 20))
    const ema50 = latest(computeEMASeries(closes, 50))
    const rsi14 = latest(computeRSISeries(closes, 14))
    const macd = computeMACDSeries(closes)

    return {
      symbol,
      interval,
      openTime: Number(lastCandle.openTime ?? lastCandle.t ?? lastCandle.open_time ?? 0) || null,
      ema20,
      ema50,
      rsi14,
      macd: {
        line: latest(macd.macdLine),
        signal: latest(macd.signalLine),
        histogram: latest(macd.histogram),
      },
      updatedAt: Date.now(),
    }
  }
}

module.exports = {
  IndicatorService,
  computeEMASeries,
  computeRSISeries,
  computeMACDSeries,
}
