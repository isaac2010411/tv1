'use strict'

const { LiquidityShiftService } = require('../../../../src/domain/futures/services/LiquidityShiftService')
const { OrderBook }             = require('../../../../src/domain/futures/entities/OrderBook')

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeBook({ bids = [], asks = [] } = {}) {
  return new OrderBook({ symbol: 'BTCUSDT', bids, asks })
}

/**
 * Book where one bid stands out as a clear wall (all others small → exceeds 5× median).
 * mid ≈ 30005 so the wall at 30000 is within the default 1% band.
 */
function bookWithSingleBidWall(wallPrice = 30000, wallQty = 500) {
  return makeBook({
    bids: [
      [wallPrice,      wallQty],
      [wallPrice - 10, 1],
      [wallPrice - 20, 1],
      [wallPrice - 30, 1],
    ],
    asks: [
      [wallPrice + 10, 1],
      [wallPrice + 20, 1],
      [wallPrice + 30, 1],
      [wallPrice + 40, 1],
    ],
  })
}

function makeService(opts = {}) {
  return new LiquidityShiftService({ symbol: 'BTCUSDT', ...opts })
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('LiquidityShiftService', () => {
  describe('update() — WALL_ADDED', () => {
    test('emits WALL_ADDED on the first update where a wall appears', () => {
      const svc    = makeService()
      const noWall = makeBook({
        bids: [[29990, 1], [29980, 1]],
        asks: [[30010, 1], [30020, 1]],
      })
      const withWall = bookWithSingleBidWall()

      svc.update(noWall)
      const events = svc.update(withWall)

      const added = events.filter((e) => e.type === 'WALL_ADDED')
      expect(added.length).toBeGreaterThanOrEqual(1)
      expect(added[0].side).toBe('bid')
    })

    test('does not emit WALL_ADDED for a wall that already existed', () => {
      const svc      = makeService()
      const withWall = bookWithSingleBidWall()

      svc.update(withWall)
      const events = svc.update(withWall)  // same wall still there

      expect(events.filter((e) => e.type === 'WALL_ADDED')).toHaveLength(0)
    })
  })

  describe('update() — WALL_REMOVED', () => {
    test('emits WALL_REMOVED when a wall disappears', () => {
      const svc      = makeService()
      const withWall = bookWithSingleBidWall()
      const noWall   = makeBook({
        bids: [[29990, 1], [29980, 1]],
        asks: [[30010, 1], [30020, 1]],
      })

      svc.update(withWall)
      const events = svc.update(noWall)

      const removed = events.filter((e) => e.type === 'WALL_REMOVED')
      expect(removed.length).toBeGreaterThanOrEqual(1)
      expect(removed[0].side).toBe('bid')
    })

    test('does not emit WALL_REMOVED if no wall was previously tracked', () => {
      const svc    = makeService()
      const noWall = makeBook({
        bids: [[29990, 1], [29980, 1]],
        asks: [[30010, 1], [30020, 1]],
      })

      svc.update(noWall)
      const events = svc.update(noWall)

      expect(events.filter((e) => e.type === 'WALL_REMOVED')).toHaveLength(0)
    })
  })

  describe('update() — severity', () => {
    test('emits HIGH severity when wall qty dominates near-price volume', () => {
      const svc      = makeService()
      const noWall   = makeBook({
        bids: [[29990, 1], [29980, 1]],
        asks: [[30010, 1], [30020, 1]],
      })
      // Wall qty = 500, surrounding near-price levels = 1 each → > 50% of near volume
      const withWall = bookWithSingleBidWall(30000, 500)

      svc.update(noWall)
      const events = svc.update(withWall)

      const added = events.filter((e) => e.type === 'WALL_ADDED' && e.nearMid)
      expect(added[0]?.severity).toBe('HIGH')
    })
  })

  describe('event fields', () => {
    test('LiquidityShiftEvent has required fields', () => {
      const svc      = makeService()
      const noWall   = makeBook({
        bids: [[29990, 1], [29980, 1]],
        asks: [[30010, 1], [30020, 1]],
      })
      const withWall = bookWithSingleBidWall()

      svc.update(noWall)
      const [event] = svc.update(withWall)

      expect(event).toMatchObject({
        symbol:    'BTCUSDT',
        type:      expect.stringMatching(/WALL_ADDED|WALL_REMOVED/),
        side:      expect.stringMatching(/bid|ask/),
        severity:  expect.stringMatching(/HIGH|MEDIUM|LOW/),
        timestamp: expect.any(Number),
      })
    })
  })

  describe('reset()', () => {
    test('clears wall state so next update has no WALL_REMOVED events', () => {
      const svc      = makeService()
      const withWall = bookWithSingleBidWall()
      const noWall   = makeBook({
        bids: [[29990, 1], [29980, 1]],
        asks: [[30010, 1], [30020, 1]],
      })

      svc.update(withWall)
      svc.reset()

      const events = svc.update(noWall)  // after reset, prevWalls is empty
      expect(events.filter((e) => e.type === 'WALL_REMOVED')).toHaveLength(0)
    })
  })
})
