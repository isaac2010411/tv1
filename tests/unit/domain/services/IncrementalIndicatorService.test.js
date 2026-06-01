'use strict'

const { IndicatorService } = require('../../../../src/domain/futures/services/IndicatorService')
const { IncrementalIndicatorService } = require('../../../../src/domain/futures/services/IncrementalIndicatorService')

function candle(i, close = i, isFinal = true) {
  return {
    symbol: 'BTCUSDT',
    interval: '1m',
    openTime: 1_700_000_000_000 + i * 60_000,
    open: String(close),
    high: String(close + 1),
    low: String(close - 1),
    close: String(close),
    volume: '10',
    isFinal,
  }
}

function expectClose(actual, expected) {
  if (expected == null) {
    expect(actual).toBeNull()
    return
  }
  expect(actual).toBeCloseTo(expected, 10)
}

describe('IncrementalIndicatorService', () => {
  test('matches legacy latest indicators after sequential finalized candles', () => {
    const candles = Array.from({ length: 80 }, (_, i) => candle(i + 1, 100 + i))
    const legacy = new IndicatorService().computeLatest({
      symbol: 'BTCUSDT',
      interval: '1m',
      candles,
    })
    const incremental = new IncrementalIndicatorService({ symbol: 'BTCUSDT', interval: '1m' })
    let latest = null

    for (const c of candles) {
      latest = incremental.updateFinal(c)
    }

    expect(latest).toMatchObject({
      symbol: 'BTCUSDT',
      interval: '1m',
      openTime: candles[candles.length - 1].openTime,
    })
    expectClose(latest.ema20, legacy.ema20)
    expectClose(latest.ema50, legacy.ema50)
    expectClose(latest.rsi14, legacy.rsi14)
    expectClose(latest.macd.line, legacy.macd.line)
    expectClose(latest.macd.signal, legacy.macd.signal)
    expectClose(latest.macd.histogram, legacy.macd.histogram)
  })

  test('preview does not mutate finalized state', () => {
    const candles = Array.from({ length: 30 }, (_, i) => candle(i + 1, 100 + i))
    const incremental = new IncrementalIndicatorService({ symbol: 'BTCUSDT', interval: '1m' })
    incremental.seed(candles)
    const finalized = incremental.latest

    const preview = incremental.preview(candle(31, 200, false))

    expect(preview.openTime).toBe(candle(31).openTime)
    expect(incremental.latest).toBe(finalized)
    expect(incremental.lastFinalOpenTime).toBe(candles[candles.length - 1].openTime)
  })
})
