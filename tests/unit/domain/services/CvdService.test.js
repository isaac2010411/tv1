'use strict'

const { CvdService } = require('../../../../src/domain/futures/services/CvdService')

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTrade({ qty = '1.000', isBuyerMaker = false, time = Date.now() } = {}) {
  return { price: '30000', qty, isBuyerMaker, time }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('CvdService', () => {
  describe('addTrade() — CVD accumulation', () => {
    test('buy aggressor trade adds positive delta to CVD', () => {
      const svc    = new CvdService({ symbol: 'BTCUSDT' })
      const result = svc.addTrade(makeTrade({ qty: '2.500', isBuyerMaker: false }))

      expect(result.delta).toBe('2.5000')
      expect(result.cvd).toBe('2.5000')
      expect(result.side).toBe('buy')
    })

    test('sell aggressor trade adds negative delta to CVD', () => {
      const svc    = new CvdService({ symbol: 'BTCUSDT' })
      const result = svc.addTrade(makeTrade({ qty: '1.500', isBuyerMaker: true }))

      expect(result.delta).toBe('-1.5000')
      expect(result.cvd).toBe('-1.5000')
      expect(result.side).toBe('sell')
    })

    test('CVD accumulates correctly across multiple trades', () => {
      const svc = new CvdService({ symbol: 'BTCUSDT' })
      const t   = Date.now()

      svc.addTrade({ price: '30000', qty: '3.000', isBuyerMaker: false, time: t })   // +3
      svc.addTrade({ price: '30000', qty: '1.000', isBuyerMaker: true,  time: t })   // -1
      const last = svc.addTrade({ price: '30000', qty: '0.500', isBuyerMaker: false, time: t })  // +0.5

      expect(last.cvd).toBe('2.5000')  // 3 - 1 + 0.5
    })
  })

  describe('getCvd()', () => {
    test('returns current CVD as a fixed-point string', () => {
      const svc = new CvdService({ symbol: 'BTCUSDT' })
      svc.addTrade(makeTrade({ qty: '5', isBuyerMaker: false }))
      expect(svc.getCvd()).toBe('5.0000')
    })

    test('returns "0.0000" on a freshly constructed service', () => {
      const svc = new CvdService({ symbol: 'BTCUSDT' })
      expect(svc.getCvd()).toBe('0.0000')
    })
  })

  describe('addTrade() — bucket tracking', () => {
    test('buy volume accumulates in all buckets', () => {
      const svc = new CvdService({ symbol: 'BTCUSDT' })
      const t   = Date.now()

      svc.addTrade({ price: '30000', qty: '4.000', isBuyerMaker: false, time: t })
      const { buckets } = svc.addTrade({ price: '30000', qty: '2.000', isBuyerMaker: false, time: t })

      expect(Number(buckets['1s'].buyVolume)).toBeCloseTo(6)
      expect(Number(buckets['1m'].buyVolume)).toBeCloseTo(6)
    })

    test('bucket delta equals buy minus sell volume', () => {
      const svc = new CvdService({ symbol: 'BTCUSDT' })
      const t   = Date.now()

      svc.addTrade({ price: '30000', qty: '5.000', isBuyerMaker: false, time: t })
      svc.addTrade({ price: '30000', qty: '2.000', isBuyerMaker: true,  time: t })
      const buckets = svc.getBuckets()

      expect(Number(buckets['1m'].delta)).toBeCloseTo(3)   // 5 - 2
    })

    test('bucket rolls over after its window expires', () => {
      jest.useFakeTimers()
      const svc = new CvdService({ symbol: 'BTCUSDT' })
      const t0  = Date.now()

      svc.addTrade({ price: '30000', qty: '5.000', isBuyerMaker: false, time: t0 })

      // Advance 2 seconds — the 1s bucket should roll
      jest.advanceTimersByTime(2_000)
      const t1 = Date.now()
      svc.addTrade({ price: '30000', qty: '1.000', isBuyerMaker: false, time: t1 })
      const buckets = svc.getBuckets()

      // After roll the 1s bucket only contains the trade at t1
      expect(Number(buckets['1s'].buyVolume)).toBeCloseTo(1)

      jest.useRealTimers()
    })
  })

  describe('reset()', () => {
    test('zeroes out CVD and all buckets', () => {
      const svc = new CvdService({ symbol: 'BTCUSDT' })
      svc.addTrade(makeTrade({ qty: '10', isBuyerMaker: false }))
      svc.reset()

      expect(svc.getCvd()).toBe('0.0000')
      const buckets = svc.getBuckets()
      for (const bucket of Object.values(buckets)) {
        expect(Number(bucket.buyVolume)).toBe(0)
        expect(Number(bucket.sellVolume)).toBe(0)
      }
    })
  })
})
