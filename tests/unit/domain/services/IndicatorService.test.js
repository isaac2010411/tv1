'use strict'

const { IndicatorService } = require('../../../../src/domain/futures/services/IndicatorService')

function candle(i, close = i) {
  return {
    symbol: 'BTCUSDT',
    interval: '1m',
    openTime: 1_700_000_000_000 + i * 60_000,
    open: String(close),
    high: String(close + 1),
    low: String(close - 1),
    close: String(close),
    volume: '10',
  }
}

describe('IndicatorService', () => {
  test('computes latest backend indicator contract', () => {
    const candles = Array.from({ length: 80 }, (_, i) => candle(i + 1, 100 + i))
    const result = new IndicatorService().computeLatest({
      symbol: 'BTCUSDT',
      interval: '1m',
      candles,
    })

    expect(result).toMatchObject({
      symbol: 'BTCUSDT',
      interval: '1m',
      openTime: candles[candles.length - 1].openTime,
    })
    expect(result.ema20).toEqual(expect.any(Number))
    expect(result.ema50).toEqual(expect.any(Number))
    expect(result.rsi14).toEqual(expect.any(Number))
    expect(result.macd.line).toEqual(expect.any(Number))
    expect(result.macd.signal).toEqual(expect.any(Number))
    expect(result.macd.histogram).toEqual(expect.any(Number))
  })

  test('returns null without candle data', () => {
    expect(new IndicatorService().computeLatest({ symbol: 'BTCUSDT', interval: '1m', candles: [] })).toBeNull()
  })
})
