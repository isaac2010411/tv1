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

  test('counts realized pnl from partial closes while the position remains open', async () => {
    const pm = new PortfolioManager({ startingEquity: 10_000 })
    await pm.applyFill(makeFill({ side: 'BUY', quantity: 5, price: 100 }))
    await pm.applyFill(makeFill({ side: 'SELL', quantity: 2, price: 120 }))

    const snap = await pm.getSnapshot()

    expect(snap.totalRealized).toBe(40)
    expect(snap.totalUnrealized).toBe(60)
    expect(snap.liveSummary.realizedPnl).toBe(0)
    expect(snap.paperSummary.realizedPnl).toBe(40)
    expect(snap.paperSummary.equity).toBe(10_100)
  })

  test('keeps live account state separate from paper fills', async () => {
    const pm = new PortfolioManager({ startingEquity: 10_000 })
    await pm.applyFill(makeFill({ side: 'BUY', quantity: 1, price: 100 }))
    pm.applyExchangeAccountUpdate({
      balances: [{ asset: 'USDT', walletBalance: 250, availableBalance: 200 }],
      positions: [{ symbol: 'ETHUSDT', positionAmt: -2, entryPrice: 50, unrealizedPnl: 5 }],
    })

    const snap = await pm.getSnapshot()

    expect(snap.paperSummary.openCount).toBe(1)
    expect(snap.liveSummary.openCount).toBe(1)
    expect(snap.liveSummary.equity).toBe(200)
    expect(snap.liveSummary.balance).toBe(250)
    expect(snap.liveSummary.walletBalance).toBe(250)
    expect(snap.liveSummary.availableBalance).toBe(200)
    expect(snap.liveBalance).toMatchObject({ asset: 'USDT', walletBalance: 250 })
    expect(snap.livePositions[0]).toMatchObject({ symbol: 'ETHUSDT', direction: 'SHORT', quantity: 2 })
  })

  test('normalizes live position side from signed amount instead of Binance BOTH mode', async () => {
    const pm = new PortfolioManager({ startingEquity: 10_000 })
    pm.applyExchangeAccountUpdate({
      positions: [{ symbol: 'ETHUSDT', side: 'BOTH', positionAmt: -2, entryPrice: 50, unrealizedPnl: 5 }],
    })

    const position = pm.getLiveOpenPositionForSymbol('ETHUSDT')

    expect(position).toMatchObject({
      symbol: 'ETHUSDT',
      side: 'SHORT',
      direction: 'SHORT',
      positionSide: 'BOTH',
    })
  })

  test('adds take profit and stop loss from the live opening order to live positions', async () => {
    const pm = new PortfolioManager({ startingEquity: 10_000 })
    pm.applyExchangeOrderUpdate({
      mode: 'live',
      clientOrderId: 'live-entry-1',
      symbol: 'BTCUSDT',
      side: 'BUY',
      status: 'FILLED',
      reduceOnly: false,
      stopLoss: 99,
      takeProfit: 105,
      sourceSignalId: 'signal-1',
    })
    pm.applyExchangeAccountUpdate({
      positions: [{ symbol: 'BTCUSDT', positionAmt: 1, entryPrice: 100, unrealizedPnl: 2 }],
    })

    const snap = await pm.getSnapshot()

    expect(snap.livePositions[0]).toMatchObject({
      symbol: 'BTCUSDT',
      direction: 'LONG',
      stopLoss: 99,
      takeProfit: 105,
      sourceSignalId: 'signal-1',
    })
  })

  test('patches take profit and stop loss onto an existing live position', async () => {
    const pm = new PortfolioManager({ startingEquity: 10_000 })
    pm.applyExchangeAccountUpdate({
      positions: [{ symbol: 'BTCUSDT', positionAmt: 1, entryPrice: 100, unrealizedPnl: 2 }],
    })
    pm.applyExchangeOrderUpdate({
      mode: 'live',
      clientOrderId: 'live-entry-1',
      symbol: 'BTCUSDT',
      side: 'BUY',
      status: 'FILLED',
      reduceOnly: false,
      stopLoss: '98.5',
      takeProfit: '106.25',
    })

    const position = pm.getLiveOpenPositionForSymbol('BTCUSDT')

    expect(position).toMatchObject({
      stopLoss: 98.5,
      takeProfit: 106.25,
    })
  })

  test('exposes live orders and Mongo paper history without mixing equity', async () => {
    const tradingPersistence = {
      listPaperPositions: jest.fn(async () => ({
        items: [{ positionId: 'paper-1', symbol: 'BTCUSDT', status: 'CLOSED', realizedPnl: 12 }],
        total: 1,
        page: 1,
        limit: 100,
      })),
    }
    const pm = new PortfolioManager({ tradingPersistence, startingEquity: 10_000 })
    pm.applyExchangeAccountUpdate({ balances: [{ asset: 'USDT', walletBalance: 300 }] })
    pm.applyExchangeOrderUpdate({ clientOrderId: 'live-1', symbol: 'BTCUSDT', status: 'FILLED' })

    const snap = await pm.getSnapshot()

    expect(snap.liveSummary.equity).toBe(300)
    expect(snap.liveOrders).toHaveLength(1)
    expect(snap.paperPositions).toHaveLength(1)
    expect(snap.paperPositions[0]).toMatchObject({ positionId: 'paper-1' })
    expect(tradingPersistence.listPaperPositions).toHaveBeenCalledWith({ userId: undefined, limit: 100, page: 1 })
  })

  test('includes fully closed realized pnl in paper summary equity', async () => {
    const pm = new PortfolioManager({ startingEquity: 10_000 })
    await pm.applyFill(makeFill({ side: 'BUY', quantity: 2, price: 100 }))
    await pm.applyFill(makeFill({ side: 'SELL', quantity: 2, price: 150 }))

    const snap = await pm.getSnapshot()

    expect(snap.totalRealized).toBe(100)
    expect(snap.paperSummary.realizedPnl).toBe(100)
    expect(snap.paperSummary.equity).toBe(10_100)
  })
})
