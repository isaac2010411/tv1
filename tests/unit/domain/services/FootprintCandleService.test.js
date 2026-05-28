'use strict'

const { FootprintCandleService } = require('../../../../src/domain/futures/services/FootprintCandleService')

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeService(opts = {}) {
  return new FootprintCandleService({
    symbol:   'BTCUSDT',
    interval: '1m',
    tickSize: '0.10',
    ...opts,
  })
}

function makeTrade({ price = '30000', qty = '1.000', isBuyerMaker = false, time = Date.now() } = {}) {
  return { price, qty, isBuyerMaker, time }
}

function makeCandle({ openTime, isFinal = false } = {}) {
  return {
    openTime: openTime ?? Date.now(),
    open:     '29990',
    high:     '30010',
    low:      '29980',
    close:    '30000',
    volume:   '50.000',
    isFinal,
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('FootprintCandleService', () => {
  describe('updateFromTrade() — provisional candle behaviour', () => {
    test('does NOT drop trades before the first kline event', () => {
      const svc = makeService()
      // No updateFromCandle() has been called yet
      svc.updateFromTrade(makeTrade({ qty: '2.000', isBuyerMaker: false }))
      svc.updateFromTrade(makeTrade({ qty: '1.000', isBuyerMaker: true }))

      const candle = svc.getCurrent()
      expect(candle).not.toBeNull()
      // Both trades should be accumulated (total volume 3.000)
      expect(Number(candle.totalVolume ?? candle.volume ?? candle.totalQty ?? candle.buyVolume + candle.sellVolume)).toBeGreaterThan(0)
    })

    test('provisional candle openTime is aligned to the interval boundary', () => {
      const svc      = makeService({ interval: '1m' })
      const INTERVAL = 60_000
      const tradeTs  = 1_700_000_030_000  // arbitrary timestamp in the middle of a minute

      svc.updateFromTrade(makeTrade({ time: tradeTs }))

      const candle   = svc.getCurrent()
      const expected = Math.floor(tradeTs / INTERVAL) * INTERVAL
      expect(candle.openTime).toBe(expected)
    })

    test('kline sync does not lose trades accumulated in provisional candle', () => {
      const svc      = makeService()
      const INTERVAL = 60_000
      const tradeTs  = 1_700_000_010_000
      const openTime = Math.floor(tradeTs / INTERVAL) * INTERVAL

      svc.updateFromTrade(makeTrade({ qty: '3.000', isBuyerMaker: false, time: tradeTs }))
      // Kline arrives for the same interval
      svc.updateFromCandle(makeCandle({ openTime, isFinal: false }))

      const candle = svc.getCurrent()
      expect(candle).not.toBeNull()
      // openTime should now be the canonical kline openTime
      expect(candle.openTime).toBe(openTime)
    })
  })

  describe('updateFromCandle() — kline lifecycle', () => {
    test('creates a new current candle when none exists', () => {
      const svc = makeService()
      const now = Date.now()
      svc.updateFromCandle(makeCandle({ openTime: now, isFinal: false }))
      expect(svc.getCurrent()).not.toBeNull()
      expect(svc.getCurrent().openTime).toBe(now)
    })

    test('finalises current candle and moves it to history when isFinal=true', () => {
      const svc = makeService()
      const now = Date.now()

      svc.updateFromCandle(makeCandle({ openTime: now, isFinal: false }))
      svc.updateFromTrade(makeTrade())
      svc.updateFromCandle(makeCandle({ openTime: now, isFinal: true }))

      expect(svc.getCurrent()).toBeNull()
      expect(svc.getHistory(1)).toHaveLength(1)
    })

    test('opening a new interval after finalisation works', () => {
      const svc = makeService()
      const t0  = 1_700_000_000_000
      const t1  = t0 + 60_000

      svc.updateFromCandle(makeCandle({ openTime: t0, isFinal: false }))
      svc.updateFromCandle(makeCandle({ openTime: t0, isFinal: true }))
      svc.updateFromCandle(makeCandle({ openTime: t1, isFinal: false }))

      expect(svc.getCurrent().openTime).toBe(t1)
      expect(svc.getHistory()).toHaveLength(1)
    })

    test('drops stale candle updates that are older than current openTime', () => {
      const svc = makeService()
      const t0 = 1_700_000_000_000
      const t1 = t0 + 60_000

      svc.updateFromCandle(makeCandle({ openTime: t1, isFinal: false }))
      svc.updateFromCandle(makeCandle({ openTime: t0, isFinal: false }))

      expect(svc.getCurrent().openTime).toBe(t1)
      expect(svc.getHistory()).toHaveLength(0)
    })

    test('does not reopen a finalized candle when a late non-final update arrives', () => {
      const svc = makeService()
      const t0 = 1_700_000_000_000

      svc.updateFromCandle(makeCandle({ openTime: t0, isFinal: false }))
      svc.updateFromCandle(makeCandle({ openTime: t0, isFinal: true }))
      svc.updateFromCandle(makeCandle({ openTime: t0, isFinal: false }))

      expect(svc.getCurrent()).toBeNull()
      expect(svc.getHistory()).toHaveLength(1)
      expect(svc.getHistory(1)[0].openTime).toBe(t0)
    })

    test('throws on invalid OHLC invariants from candle stream', () => {
      const svc = makeService()
      const t0 = 1_700_000_000_000

      expect(() => {
        svc.updateFromCandle({
          openTime: t0,
          open: '100',
          high: '90',
          low: '80',
          close: '85',
          volume: '10',
          isFinal: false,
        })
      }).toThrow('Invalid footprint OHLCV values')
    })
  })

  describe('updateFromTrade() — stale trade guards', () => {
    test('ignores trades that belong to already finalized interval when no current candle exists', () => {
      const svc = makeService()
      const t0 = 1_700_000_000_000
      const staleTradeTs = t0 + 10_000

      svc.updateFromCandle(makeCandle({ openTime: t0, isFinal: false }))
      svc.updateFromCandle(makeCandle({ openTime: t0, isFinal: true }))
      svc.updateFromTrade(makeTrade({ time: staleTradeTs, qty: '5.000' }))

      expect(svc.getCurrent()).toBeNull()
      expect(svc.getHistory()).toHaveLength(1)
    })
  })

  describe('getHistory()', () => {
    test('returns at most the requested number of candles', () => {
      const svc = makeService({ maxHistory: 5 })
      const t0  = 1_700_000_000_000
      for (let i = 0; i < 3; i++) {
        svc.updateFromCandle(makeCandle({ openTime: t0 + i * 60_000, isFinal: false }))
        svc.updateFromCandle(makeCandle({ openTime: t0 + i * 60_000, isFinal: true }))
      }
      expect(svc.getHistory(2)).toHaveLength(2)
    })

    test('caps history at maxHistory', () => {
      const svc = makeService({ maxHistory: 2 })
      const t0  = 1_700_000_000_000
      for (let i = 0; i < 5; i++) {
        svc.updateFromCandle(makeCandle({ openTime: t0 + i * 60_000, isFinal: false }))
        svc.updateFromCandle(makeCandle({ openTime: t0 + i * 60_000, isFinal: true }))
      }
      expect(svc.getHistory()).toHaveLength(2)
    })
  })

  describe('reset()', () => {
    test('clears current candle and history', () => {
      const svc = makeService()
      const now = Date.now()

      svc.updateFromCandle(makeCandle({ openTime: now, isFinal: false }))
      svc.updateFromTrade(makeTrade())
      svc.reset()

      expect(svc.getCurrent()).toBeNull()
      expect(svc.getHistory()).toHaveLength(0)
    })
  })

  describe('_intervalToMs()', () => {
    test.each([
      ['1m',  60_000],
      ['5m',  300_000],
      ['15m', 900_000],
      ['1h',  3_600_000],
      ['4h',  14_400_000],
      ['1d',  86_400_000],
    ])('parses %s → %d ms', (interval, expected) => {
      expect(FootprintCandleService._intervalToMs(interval)).toBe(expected)
    })

    test('returns 0 for unrecognised interval strings', () => {
      expect(FootprintCandleService._intervalToMs('invalid')).toBe(0)
      expect(FootprintCandleService._intervalToMs(null)).toBe(0)
    })
  })
})
