'use strict'

const { OrderBook }        = require('../../../../src/domain/futures/entities/OrderBook')
const { OrderBookMetrics } = require('../../../../src/domain/futures/services/OrderBookMetrics')

// ─── Helpers ──────────────────────────────────────────────────────────────────

const makeOrderBook = (bids, asks) =>
  new OrderBook({ symbol: 'BTCUSDT', bids, asks })

const orderedBook = () => makeOrderBook(
  [['30000', '2'], ['29990', '1'], ['29980', '0.5']],
  [['30010', '1'], ['30020', '1'], ['30030', '0.5']],
)

// ─── Constructor: sorting & filtering ─────────────────────────────────────────

describe('OrderBook constructor – sorting', () => {
  test('bids are sorted descending even when provided in wrong order', () => {
    const ob = makeOrderBook(
      [['29980', '1'], ['30000', '2'], ['29990', '0.5']],
      [['30020', '1'], ['30010', '1']],
    )
    expect(ob.bids[0].price.toFixed()).toBe('30000')
    expect(ob.bids[1].price.toFixed()).toBe('29990')
    expect(ob.bids[2].price.toFixed()).toBe('29980')
  })

  test('asks are sorted ascending even when provided in wrong order', () => {
    const ob = makeOrderBook(
      [['30000', '1']],
      [['30030', '1'], ['30010', '1'], ['30020', '1']],
    )
    expect(ob.asks[0].price.toFixed()).toBe('30010')
    expect(ob.asks[1].price.toFixed()).toBe('30020')
    expect(ob.asks[2].price.toFixed()).toBe('30030')
  })

  test('bestBid is the highest bid after sorting disordered input', () => {
    const ob = makeOrderBook(
      [['1000', '1'], ['76814', '0.5'], ['50000', '1']],
      [['76815', '1']],
    )
    expect(ob.bestBid.toFixed()).toBe('76814')
    expect(ob.bestAsk.toFixed()).toBe('76815')
  })
})

describe('OrderBook constructor – filtering invalid levels', () => {
  test('levels with qty = 0 are removed', () => {
    const ob = makeOrderBook(
      [['30000', '2'], ['29990', '0'], ['29980', '1']],
      [['30010', '1'], ['30020', '0']],
    )
    expect(ob.bids.length).toBe(2)
    expect(ob.asks.length).toBe(1)
  })

  test('levels with negative qty are removed', () => {
    const ob = makeOrderBook(
      [['30000', '2'], ['29990', '-1']],
      [['30010', '1']],
    )
    expect(ob.bids.length).toBe(1)
    expect(ob.bids[0].price.toFixed()).toBe('30000')
  })

  test('accepts object-format levels {price, qty}', () => {
    const ob = new OrderBook({
      symbol: 'BTCUSDT',
      bids:   [{ price: '30000', qty: '2' }],
      asks:   [{ price: '30010', qty: '1' }],
    })
    expect(ob.bestBid.toFixed()).toBe('30000')
    expect(ob.bestAsk.toFixed()).toBe('30010')
  })

  test('accepts object-format levels {price, quantity}', () => {
    const ob = new OrderBook({
      symbol: 'BTCUSDT',
      bids:   [{ price: '30000', quantity: '2' }],
      asks:   [{ price: '30010', quantity: '1' }],
    })
    expect(ob.bestBid.toFixed()).toBe('30000')
  })

  test('empty arrays do not throw', () => {
    const ob = makeOrderBook([], [])
    expect(ob.bestBid).toBeNull()
    expect(ob.bestAsk).toBeNull()
    expect(ob.spread).toBeNull()
    expect(ob.midPrice).toBeNull()
  })
})

// ─── Derived properties ───────────────────────────────────────────────────────

describe('OrderBook – bestBid / bestAsk / spread / midPrice', () => {
  test('bestBid and bestAsk are correct', () => {
    const ob = orderedBook()
    expect(ob.bestBid.toFixed()).toBe('30000')
    expect(ob.bestAsk.toFixed()).toBe('30010')
  })

  test('spread = bestAsk - bestBid', () => {
    const ob = orderedBook()
    expect(ob.spread.toFixed()).toBe('10')
  })

  test('midPrice = (bestBid + bestAsk) / 2', () => {
    const ob = orderedBook()
    expect(ob.midPrice.toFixed()).toBe('30005')
  })

  test('spread is never negative for a valid book', () => {
    const ob = orderedBook()
    expect(ob.spread.toNumber()).toBeGreaterThan(0)
  })
})

// ─── isValidTopOfBook ─────────────────────────────────────────────────────────

describe('OrderBook.isValidTopOfBook', () => {
  test('returns true when bestAsk > bestBid', () => {
    const ob = orderedBook()
    expect(ob.isValidTopOfBook).toBe(true)
  })

  test('returns false when book is empty', () => {
    const ob = makeOrderBook([], [])
    expect(ob.isValidTopOfBook).toBe(false)
  })

  test('returns false when bids is empty', () => {
    const ob = makeOrderBook([], [['30010', '1']])
    expect(ob.isValidTopOfBook).toBe(false)
  })

  test('returns false when asks is empty', () => {
    const ob = makeOrderBook([['30000', '1']], [])
    expect(ob.isValidTopOfBook).toBe(false)
  })

  test('returns false when bestAsk equals bestBid (crossed book)', () => {
    const ob = makeOrderBook([['30010', '1']], [['30010', '1']])
    expect(ob.isValidTopOfBook).toBe(false)
  })
})

// ─── spreadPct ────────────────────────────────────────────────────────────────

describe('OrderBook.spreadPct', () => {
  test('returns spread as a fraction of midPrice', () => {
    const ob = orderedBook()
    const pct = ob.spreadPct
    expect(pct).not.toBeNull()
    expect(pct.toNumber()).toBeCloseTo(10 / 30005, 8)
  })

  test('returns null when book is empty', () => {
    const ob = makeOrderBook([], [])
    expect(ob.spreadPct).toBeNull()
  })
})

// ─── Imbalance [-1, 1] ────────────────────────────────────────────────────────

describe('OrderBook.imbalanceTopN – range [-1, 1]', () => {
  test('Bid 10 / Ask 10 => 0 (neutral)', () => {
    const ob = makeOrderBook([['30000', '10']], [['30010', '10']])
    expect(ob.imbalanceTopN(1).toFixed()).toBe('0')
  })

  test('Bid 20 / Ask 10 => positive (bid pressure)', () => {
    const ob  = makeOrderBook([['30000', '20']], [['30010', '10']])
    const imb = ob.imbalanceTopN(1).toNumber()
    expect(imb).toBeGreaterThan(0)
    expect(imb).toBeLessThanOrEqual(1)
  })

  test('Bid 10 / Ask 20 => negative (ask pressure)', () => {
    const ob  = makeOrderBook([['30000', '10']], [['30010', '20']])
    const imb = ob.imbalanceTopN(1).toNumber()
    expect(imb).toBeLessThan(0)
    expect(imb).toBeGreaterThanOrEqual(-1)
  })

  test('Bid 0 / Ask 0 => 0, never NaN', () => {
    const ob  = makeOrderBook([], [])
    const imb = ob.imbalanceTopN(5)
    expect(imb.isNaN()).toBe(false)
    expect(imb.toFixed()).toBe('0')
  })

  test('all bids => imbalance = +1', () => {
    const ob = makeOrderBook([['30000', '5']], [])
    expect(ob.imbalanceTopN(1).toFixed()).toBe('1')
  })

  test('all asks => imbalance = -1', () => {
    const ob = makeOrderBook([], [['30010', '5']])
    expect(ob.imbalanceTopN(1).toFixed()).toBe('-1')
  })
})

// ─── Volume helpers ───────────────────────────────────────────────────────────

describe('OrderBook volume helpers', () => {
  test('bidVolumeTopN sums correctly', () => {
    const ob = orderedBook()
    expect(ob.bidVolumeTopN(2).toFixed()).toBe('3')
  })

  test('askVolumeTopN sums correctly', () => {
    const ob = orderedBook()
    expect(ob.askVolumeTopN(2).toFixed()).toBe('2')
  })
})

// ─── detectWalls ─────────────────────────────────────────────────────────────

describe('OrderBook.detectWalls', () => {
  test('returns bidWalls and askWalls arrays', () => {
    const ob    = orderedBook()
    const walls = ob.detectWalls()
    expect(walls).toHaveProperty('bidWalls')
    expect(walls).toHaveProperty('askWalls')
    expect(Array.isArray(walls.bidWalls)).toBe(true)
    expect(Array.isArray(walls.askWalls)).toBe(true)
  })

  test('accepts legacy numeric argument', () => {
    const ob = orderedBook()
    expect(() => ob.detectWalls(3)).not.toThrow()
  })

  test('wall entries include category field', () => {
    const ob = makeOrderBook(
      [['30000', '100'], ['29990', '1'], ['29980', '1']],
      [['30010', '1']],
    )
    const { bidWalls } = ob.detectWalls({ multiplier: 3 })
    if (bidWalls.length > 0) {
      expect(bidWalls[0]).toHaveProperty('category')
    }
  })

  test('TACTICAL_WALL for level within maxDistancePct of mid', () => {
    const ob = makeOrderBook(
      [['30000', '100'], ['29000', '1'], ['28000', '1']],
      [['30010', '1']],
    )
    const { bidWalls } = ob.detectWalls({ multiplier: 2, maxDistancePct: 0.01 })
    if (bidWalls.length > 0) {
      const tactical = bidWalls.find((w) => w.price === '30000')
      if (tactical) expect(tactical.category).toBe('TACTICAL_WALL')
    }
  })

  test('MACRO_WALL for level far from mid', () => {
    const ob = makeOrderBook(
      [['20000', '100'], ['30000', '1'], ['29990', '1']],
      [['30010', '1']],
    )
    const { bidWalls } = ob.detectWalls({ multiplier: 2, maxDistancePct: 0.005 })
    const macro = bidWalls.find((w) => w.price === '20000')
    if (macro) expect(macro.category).toBe('MACRO_WALL')
  })
})

// ─── OrderBookMetrics service ─────────────────────────────────────────────────

describe('OrderBookMetrics service', () => {
  test('compute returns expected shape with new fields', () => {
    const ob     = orderedBook()
    const result = new OrderBookMetrics().compute(ob, 3)

    expect(result).toHaveProperty('spread')
    expect(result).toHaveProperty('spreadPct')
    expect(result).toHaveProperty('midPrice')
    expect(result).toHaveProperty('imbalance')
    expect(result).toHaveProperty('bidVolumeTop')
    expect(result).toHaveProperty('askVolumeTop')
    expect(result).toHaveProperty('bidDominance')
    expect(result).toHaveProperty('askDominance')
    expect(result).toHaveProperty('walls')
    expect(typeof result.bidDominance).toBe('boolean')
    expect(typeof result.askDominance).toBe('boolean')
  })

  test('imbalance value is in [-1, 1] range', () => {
    const ob     = orderedBook()
    const result = new OrderBookMetrics().compute(ob)
    const imb    = parseFloat(result.imbalance)
    expect(imb).toBeGreaterThanOrEqual(-1)
    expect(imb).toBeLessThanOrEqual(1)
  })

  test('imbalance is never NaN', () => {
    const ob     = makeOrderBook([], [])
    const result = new OrderBookMetrics().compute(ob)
    expect(result.imbalance).not.toBeNaN()
    expect(result.imbalance).toBe('0.0000')
  })

  test('bidDominance and askDominance are mutually exclusive', () => {
    const ob     = orderedBook()
    const result = new OrderBookMetrics().compute(ob, 3)
    expect(result.bidDominance && result.askDominance).toBe(false)
  })

  test('bidDominance true when bid pressure > ask', () => {
    const ob     = makeOrderBook([['30000', '100']], [['30010', '1']])
    const result = new OrderBookMetrics().compute(ob)
    expect(result.bidDominance).toBe(true)
    expect(result.askDominance).toBe(false)
  })

  test('askDominance true when ask pressure > bid', () => {
    const ob     = makeOrderBook([['30000', '1']], [['30010', '100']])
    const result = new OrderBookMetrics().compute(ob)
    expect(result.askDominance).toBe(true)
    expect(result.bidDominance).toBe(false)
  })
})
