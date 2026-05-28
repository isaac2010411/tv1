'use strict'

const { LocalOrderBookEngine, MAX_BOOK_LEVELS, EMIT_DEPTH } = require('../../../src/infrastructure/marketdata/LocalOrderBookEngine')

function makeEngine(emits = []) {
  return new LocalOrderBookEngine({
    symbol: 'TESTUSDT',
    onBook: (ob) => emits.push(ob),
    onResync: () => {},
  })
}

describe('LocalOrderBookEngine', () => {
  test('applies snapshot and emits a normalised OrderBook', () => {
    const emits = []
    const engine = makeEngine(emits)

    engine.applySnapshot({
      lastUpdateId: 100,
      bids: [['100', '1'], ['99', '2']],
      asks: [['101', '1'], ['102', '2']],
    })

    expect(emits).toHaveLength(1)
    expect(emits[0].bestBid.toFixed()).toBe('100')
    expect(emits[0].bestAsk.toFixed()).toBe('101')
  })

  test('applyDelta updates and removes zero-qty levels', () => {
    const emits = []
    const engine = makeEngine(emits)
    engine.applySnapshot({ lastUpdateId: 1, bids: [['100', '1']], asks: [['101', '1']] })

    // Wait past the emit throttle by mutating internals (test-only).
    engine._lastEmitAt = 0
    engine.applyDelta({
      firstUpdateId: 2,
      finalUpdateId: 3,
      prevFinalUpdateId: 1,
      bids: [['100', '0'], ['99', '5']], // remove 100, add 99
      asks: [],
    })

    const last = emits[emits.length - 1]
    expect(last.bestBid.toFixed()).toBe('99')
  })

  test('prunes the book to MAX_BOOK_LEVELS per side', () => {
    const engine = makeEngine()
    // Build a snapshot above 1.5× the cap so the lazy prune triggers
    const N = Math.ceil(MAX_BOOK_LEVELS * 1.6)
    const bids = []
    const asks = []
    for (let i = 0; i < N; i++) {
      bids.push([String(10_000 - i), '1'])
      asks.push([String(10_000 + i + 1), '1'])
    }
    engine.applySnapshot({ lastUpdateId: 1, bids, asks })

    const health = engine.getHealth()
    expect(health.bidLevels).toBeLessThanOrEqual(MAX_BOOK_LEVELS)
    expect(health.askLevels).toBeLessThanOrEqual(MAX_BOOK_LEVELS)
    expect(health.prunedLevels).toBeGreaterThan(0)
  })

  test('limits emitted OrderBook depth to EMIT_DEPTH', () => {
    const emits = []
    const engine = makeEngine(emits)
    const N = EMIT_DEPTH + 50
    const bids = []
    const asks = []
    for (let i = 0; i < N; i++) {
      bids.push([String(10_000 - i), '1'])
      asks.push([String(10_000 + i + 1), '1'])
    }
    engine.applySnapshot({ lastUpdateId: 1, bids, asks })

    expect(emits[emits.length - 1].bids.length).toBeLessThanOrEqual(EMIT_DEPTH)
    expect(emits[emits.length - 1].asks.length).toBeLessThanOrEqual(EMIT_DEPTH)
  })

  test('triggers resync on a gap', () => {
    const emits = []
    let resyncCalled = false
    const engine = new LocalOrderBookEngine({
      symbol: 'TESTUSDT',
      onBook: (ob) => emits.push(ob),
      onResync: () => { resyncCalled = true },
    })
    engine.applySnapshot({ lastUpdateId: 10, bids: [['100', '1']], asks: [['101', '1']] })

    engine.applyDelta({
      firstUpdateId: 100, // gap: jumped from 10 to 100
      finalUpdateId: 101,
      prevFinalUpdateId: 99,
      bids: [],
      asks: [],
    })

    expect(resyncCalled).toBe(true)
    expect(engine.getHealth().gapCount).toBe(1)
    expect(engine.getHealth().bookSynced).toBe(false)
  })

  test('reset clears all state', () => {
    const engine = makeEngine()
    engine.applySnapshot({ lastUpdateId: 1, bids: [['100', '1']], asks: [['101', '1']] })
    engine.reset()
    const health = engine.getHealth()
    expect(health.bidLevels).toBe(0)
    expect(health.askLevels).toBe(0)
    expect(health.bookSynced).toBe(false)
    expect(health.pendingDeltas).toBe(0)
  })
})
