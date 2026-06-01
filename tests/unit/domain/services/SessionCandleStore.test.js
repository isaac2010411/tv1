'use strict'

const { SessionCandleStore } = require('../../../../src/domain/futures/services/SessionCandleStore')

function makeCandle({ i = 0, close = 100, isFinal = false } = {}) {
  return {
    symbol: 'BTCUSDT',
    interval: '1m',
    openTime: 1_700_000_000_000 + i * 60_000,
    closeTime: 1_700_000_059_999 + i * 60_000,
    open: String(close - 1),
    high: String(close + 1),
    low: String(close - 2),
    close: String(close),
    volume: '10',
    isFinal,
  }
}

describe('SessionCandleStore', () => {
  test('tracks open candles, finalized history, indicators and footprint snapshots', () => {
    const store = new SessionCandleStore({
      symbol: 'BTCUSDT',
      intervals: ['1m'],
      tickSize: '0.10',
      maxHistory: 5,
    })

    const openUpdate = store.upsertCandle(makeCandle({ i: 0, close: 100, isFinal: false }))
    expect(openUpdate.currentCandle.openTime).toBe(makeCandle({ i: 0 }).openTime)
    expect(openUpdate.snapshot.session.candlesCount).toBe(0)

    store.addTrade({
      symbol: 'BTCUSDT',
      price: '100.10',
      qty: '2',
      isBuyerMaker: false,
      time: makeCandle({ i: 0 }).openTime + 1_000,
    })

    const finalUpdate = store.upsertCandle(makeCandle({ i: 0, close: 101, isFinal: true }))
    expect(finalUpdate.wasFinalized).toBe(true)
    expect(finalUpdate.currentCandle).toBeNull()
    expect(store.getHistory('1m')).toHaveLength(1)
    expect(finalUpdate.snapshot.latestClosedCandle.close).toBe('101')
    expect(finalUpdate.footprint.toPlainObject().levels).toHaveLength(1)
  })

  test('seeds capped history and ignores duplicate final candles', () => {
    const store = new SessionCandleStore({
      symbol: 'BTCUSDT',
      intervals: ['1m'],
      tickSize: '0.10',
      maxHistory: 2,
    })

    store.seedCandles('1m', [
      makeCandle({ i: 0, isFinal: true }),
      makeCandle({ i: 1, isFinal: true }),
      makeCandle({ i: 2, isFinal: true }),
    ])

    expect(store.getHistory('1m')).toHaveLength(2)
    expect(store.getHistory('1m')[0].openTime).toBe(makeCandle({ i: 1 }).openTime)

    const duplicate = store.upsertCandle(makeCandle({ i: 2, close: 110, isFinal: true }))
    expect(duplicate.wasFinalized).toBe(true)
    expect(store.getHistory('1m')).toHaveLength(2)
  })

  test('hydrates seeded history with per-candle indicators', () => {
    const store = new SessionCandleStore({
      symbol: 'BTCUSDT',
      intervals: ['1m'],
      tickSize: '0.10',
      maxHistory: 100,
    })
    const candles = Array.from({ length: 80 }, (_, i) => makeCandle({
      i,
      close: 100 + i,
      isFinal: true,
    }))

    const history = store.seedCandles('1m', candles)
    const latest = history[history.length - 1]

    expect(latest.indicators).toMatchObject({
      symbol: 'BTCUSDT',
      interval: '1m',
      openTime: latest.openTime,
    })
    expect(latest).toMatchObject({
      symbol: 'BTCUSDT',
      interval: '1m',
      isFinal: true,
    })
    expect(latest.indicators.ema20).toEqual(expect.any(Number))
    expect(latest.indicators.ema50).toEqual(expect.any(Number))
    expect(latest.indicators.rsi14).toEqual(expect.any(Number))
    expect(latest.indicators.macd.histogram).toEqual(expect.any(Number))
    expect(store.getSnapshot('1m').indicators.openTime).toBe(latest.openTime)
  })
})
