'use strict'

const { PortfolioManager } = require('../../../../src/application/futures/portfolio/PortfolioManager')

const makeFill = ({ symbol = 'BTCUSDT', side, quantity, price }) => ({
  orderId: `ord-${Math.random()}`,
  symbol,
  side,
  fills: [{ price, quantity, timestamp: Date.now() }],
})

describe('PortfolioManager.applyFill', () => {
  test('opens a LONG position on first BUY', async () => {
    const pm = new PortfolioManager()
    const id = await pm.applyFill(makeFill({ side: 'BUY', quantity: 1, price: 100 }))
    expect(id).toBeTruthy()
    const positions = await pm.listPositions({ status: 'OPEN' })
    expect(positions).toHaveLength(1)
    expect(positions[0]).toMatchObject({ direction: 'LONG', quantity: 1, entryPrice: 100 })
  })

  test('adds to an existing same-direction position with weighted entry', async () => {
    const pm = new PortfolioManager()
    await pm.applyFill(makeFill({ side: 'BUY', quantity: 1, price: 100 }))
    await pm.applyFill(makeFill({ side: 'BUY', quantity: 1, price: 200 }))
    const [pos] = await pm.listPositions({ status: 'OPEN' })
    expect(pos.quantity).toBe(2)
    expect(pos.entryPrice).toBe(150)
  })

  test('opposite fill closes position and records realized PnL', async () => {
    const pm = new PortfolioManager()
    await pm.applyFill(makeFill({ side: 'BUY', quantity: 2, price: 100 }))
    await pm.applyFill(makeFill({ side: 'SELL', quantity: 2, price: 150 }))
    const open = await pm.listPositions({ status: 'OPEN' })
    const closed = await pm.listPositions({ status: 'CLOSED' })
    expect(open).toHaveLength(0)
    expect(closed).toHaveLength(1)
    expect(closed[0].realizedPnl).toBe(100) // (150-100)*2
  })

  test('partial close keeps position OPEN with reduced quantity', async () => {
    const pm = new PortfolioManager()
    await pm.applyFill(makeFill({ side: 'BUY', quantity: 5, price: 100 }))
    await pm.applyFill(makeFill({ side: 'SELL', quantity: 2, price: 120 }))
    const [pos] = await pm.listPositions({ status: 'OPEN' })
    expect(pos.quantity).toBe(3)
    expect(pos.realizedPnl).toBe(40) // (120-100)*2
  })

  test('over-close flips direction into a new opposite position', async () => {
    const pm = new PortfolioManager()
    await pm.applyFill(makeFill({ side: 'BUY', quantity: 2, price: 100 }))
    await pm.applyFill(makeFill({ side: 'SELL', quantity: 5, price: 90 }))
    const open = await pm.listPositions({ status: 'OPEN' })
    expect(open).toHaveLength(1)
    expect(open[0]).toMatchObject({ direction: 'SHORT', quantity: 3, entryPrice: 90 })
  })

  test('emits snapshot via realtimeNotifier on each fill', async () => {
    const notifier = { emitPortfolioSnapshot: jest.fn() }
    const pm = new PortfolioManager({ realtimeNotifier: notifier })
    await pm.applyFill(makeFill({ side: 'BUY', quantity: 1, price: 100 }))
    expect(notifier.emitPortfolioSnapshot).toHaveBeenCalled()
  })
})

describe('PortfolioManager.getSnapshot', () => {
  test('aggregates exposure and pnl', async () => {
    const pm = new PortfolioManager()
    await pm.applyFill(makeFill({ symbol: 'BTCUSDT', side: 'BUY', quantity: 1, price: 100 }))
    await pm.applyFill(makeFill({ symbol: 'ETHUSDT', side: 'BUY', quantity: 2, price: 50 }))
    const snap = await pm.getSnapshot()
    expect(snap.totalNotional).toBe(200) // 100 + 100
    expect(snap.exposureBySymbol).toEqual({ BTCUSDT: 100, ETHUSDT: 100 })
    expect(snap.positions).toHaveLength(2)
  })
})
