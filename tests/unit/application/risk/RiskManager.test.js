'use strict'

const { RiskManager } = require('../../../../src/application/futures/risk/RiskManager')

describe('RiskManager.evaluate', () => {
  const baseRules = {
    maxOrderQty: 10,
    maxNotionalPerSymbol: 100_000,
    maxOpenPositions: 3,
    maxDailyLoss: 500,
    allowedSymbols: [],
  }

  test('ALLOW when within all limits', async () => {
    const rm = new RiskManager({ rules: baseRules })
    const decision = await rm.evaluate(
      { symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: 1 },
      { positions: [], dailyPnl: 0 },
    )
    expect(decision).toEqual({ action: 'ALLOW' })
  })

  test('BLOCK on invalid payload', async () => {
    const rm = new RiskManager({ rules: baseRules })
    const decision = await rm.evaluate({ symbol: '', quantity: 0 }, {})
    expect(decision.action).toBe('BLOCK')
    expect(decision.rule).toBe('shape')
  })

  test('BLOCK when symbol not in allow-list', async () => {
    const rm = new RiskManager({ rules: { ...baseRules, allowedSymbols: ['ETHUSDT'] } })
    const decision = await rm.evaluate(
      { symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: 1 },
      { positions: [] },
    )
    expect(decision.action).toBe('BLOCK')
    expect(decision.rule).toBe('allowedSymbols')
  })

  test('BLOCK when max open positions reached', async () => {
    const rm = new RiskManager({ rules: { ...baseRules, maxOpenPositions: 1 } })
    const decision = await rm.evaluate(
      { symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: 1 },
      { positions: [{ status: 'OPEN', symbol: 'ETHUSDT' }] },
    )
    expect(decision.action).toBe('BLOCK')
    expect(decision.rule).toBe('maxOpenPositions')
  })

  test('BLOCK when daily loss limit reached', async () => {
    const rm = new RiskManager({ rules: { ...baseRules, maxDailyLoss: 500 } })
    const decision = await rm.evaluate(
      { symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: 1 },
      { positions: [], dailyPnl: -600 },
    )
    expect(decision.action).toBe('BLOCK')
    expect(decision.rule).toBe('maxDailyLoss')
  })

  test('REDUCE when quantity exceeds maxOrderQty', async () => {
    const rm = new RiskManager({ rules: baseRules })
    const decision = await rm.evaluate(
      { symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: 50 },
      { positions: [] },
    )
    expect(decision.action).toBe('REDUCE')
    expect(decision.adjustedQuantity).toBe(10)
    expect(decision.rule).toBe('maxOrderQty')
  })

  test('REDUCE when notional cap exceeded (LIMIT)', async () => {
    const rm = new RiskManager({ rules: { ...baseRules, maxNotionalPerSymbol: 1000, maxOrderQty: 100 } })
    const decision = await rm.evaluate(
      { symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', quantity: 1, price: 1500 },
      { positions: [] },
    )
    expect(decision.action).toBe('REDUCE')
    expect(decision.rule).toBe('maxNotionalPerSymbol')
    expect(decision.adjustedQuantity).toBeCloseTo(1000 / 1500, 6)
  })

  test('BLOCK when existing notional already exhausts cap', async () => {
    const rm = new RiskManager({ rules: { ...baseRules, maxNotionalPerSymbol: 1000, maxOrderQty: 100 } })
    const decision = await rm.evaluate(
      { symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', quantity: 1, price: 100 },
      { positions: [{ status: 'OPEN', symbol: 'BTCUSDT', quantity: 10, entryPrice: 100 }] },
    )
    expect(decision.action).toBe('BLOCK')
    expect(decision.rule).toBe('maxNotionalPerSymbol')
  })

  test('getLimits returns the active configuration', () => {
    const rm = new RiskManager({ rules: baseRules })
    expect(rm.getLimits()).toMatchObject(baseRules)
  })
})
