'use strict'

const { SpoofingDetectorService } = require('../../../../src/domain/futures/services/SpoofingDetectorService')
const { OrderBook }               = require('../../../../src/domain/futures/entities/OrderBook')

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeBook({ bids = [], asks = [] } = {}) {
  return new OrderBook({ symbol: 'BTCUSDT', bids, asks })
}

/**
 * Build a simple book with a single large bid wall at the given price.
 * Surrounding levels are small so the wall clearly exceeds the 5× median threshold.
 */
function bookWithBidWall(wallPrice, wallQty, midAsk = wallPrice + 10) {
  const bids = [
    [wallPrice,      wallQty],
    [wallPrice - 10, 1],
    [wallPrice - 20, 1],
    [wallPrice - 30, 1],
  ]
  const asks = [
    [midAsk,      1],
    [midAsk + 10, 1],
    [midAsk + 20, 1],
    [midAsk + 30, 1],
  ]
  return new OrderBook({ symbol: 'BTCUSDT', bids, asks })
}

function makeService(opts = {}) {
  return new SpoofingDetectorService({
    symbol:     'BTCUSDT',
    tickSize:   '0.10',
    minWallQty: 50,
    lifespanMs: 5_000,
    ...opts,
  })
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('SpoofingDetectorService', () => {
  describe('update() — basic tracking', () => {
    test('returns no events on first call (no previous snapshot)', () => {
      const svc  = makeService()
      const book = bookWithBidWall(30000, 100, 30010)
      const events = svc.update(book)
      expect(events).toHaveLength(0)
    })

    test('returns no events when wall persists across two updates', () => {
      const svc  = makeService()
      const book = bookWithBidWall(30000, 100, 30010)
      svc.update(book)
      const events = svc.update(book)
      expect(events).toHaveLength(0)
    })

    test('emits a SpoofingEvent when a tracked level disappears within lifespanMs', () => {
      const svc     = makeService({ lifespanMs: 60_000 })
      const withWall    = bookWithBidWall(30000, 100, 30010)
      const withoutWall = makeBook({
        bids: [[29999, 1], [29990, 1]],
        asks: [[30010, 1], [30020, 1]],
      })

      svc.update(withWall)    // level tracked
      const events = svc.update(withoutWall)  // level gone

      expect(events).toHaveLength(1)
      expect(events[0].side).toBe('bid')
      expect(events[0].confidence).toBeGreaterThan(0)
      expect(events[0].confidence).toBeLessThanOrEqual(0.99)
    })

    test('does NOT emit an event when a level disappears after lifespanMs', () => {
      jest.useFakeTimers()
      const svc       = makeService({ lifespanMs: 500 })
      const withWall  = bookWithBidWall(30000, 100, 30010)
      const emptyBook = makeBook({
        bids: [[29990, 1]],
        asks: [[30010, 1]],
      })

      svc.update(withWall)
      jest.advanceTimersByTime(600)          // past the lifespan threshold
      const events = svc.update(emptyBook)

      expect(events).toHaveLength(0)
      jest.useRealTimers()
    })
  })

  describe('update() — reason field', () => {
    test('reason includes side, price, qty and lifespan', () => {
      const svc         = makeService({ lifespanMs: 60_000 })
      const withWall    = bookWithBidWall(30000, 100, 30010)
      const withoutWall = makeBook({
        bids: [[29999, 1]],
        asks: [[30010, 1]],
      })
      svc.update(withWall)
      const [event] = svc.update(withoutWall)

      expect(event.reason).toMatch(/bid/)
      expect(event.reason).toMatch(/30000/)
      expect(event.reason).toMatch(/100/)
    })
  })

  describe('update() — confidence', () => {
    test('confidence is higher for faster disappearance', () => {
      jest.useFakeTimers()
      const svc = makeService({ lifespanMs: 10_000 })
      const withWall = bookWithBidWall(30000, 100, 30010)
      const emptyBook = makeBook({
        bids: [[29990, 1]],
        asks: [[30010, 1]],
      })

      // Scenario A: disappears immediately
      svc.update(withWall)
      jest.advanceTimersByTime(50)
      const [eventFast] = svc.update(emptyBook)

      // Scenario B: disappears just before threshold
      svc.reset()
      svc.update(withWall)
      jest.advanceTimersByTime(9_000)
      const [eventSlow] = svc.update(emptyBook)

      expect(eventFast.confidence).toBeGreaterThan(eventSlow.confidence)
      jest.useRealTimers()
    })
  })

  describe('_trackedLevels cap', () => {
    test('never grows beyond MAX_TRACKED_LEVELS (500) entries', () => {
      const svc = makeService({ minWallQty: 1 })

      // Feed 600 unique bid levels, each with qty = 100 (well over minWallQty = 1)
      const LEVELS = 600
      const step = 0.10
      for (let i = 0; i < LEVELS; i++) {
        const price = 30000 + i * step
        const book = new OrderBook({
          symbol: 'BTCUSDT',
          bids: [[price, 100]],
          asks: [[price + 5, 1]],
        })
        svc.update(book)
      }

      // Access internals directly (white-box test on critical safety property)
      expect(svc._trackedLevels.size).toBeLessThanOrEqual(500)
    })
  })

  describe('reset()', () => {
    test('clears all tracked levels', () => {
      const svc  = makeService()
      svc.update(bookWithBidWall(30000, 100, 30010))
      svc.reset()
      expect(svc._trackedLevels.size).toBe(0)
    })
  })
})
