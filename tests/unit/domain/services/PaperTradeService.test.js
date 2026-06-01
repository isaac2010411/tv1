'use strict'

const { PaperTradeService } = require('../../../../src/domain/futures/services/PaperTradeService')

describe('PaperTradeService', () => {
  test('opens and closes a LONG position manually with realized pnl', () => {
    const svc = new PaperTradeService()
    const opened = svc.openPosition({
      symbol: 'BTCUSDT',
      userId: 'u1',
      direction: 'LONG',
      entryPrice: 100,
      stopLoss: 95,
      takeProfit: 110,
    })

    const closed = svc.closePosition({
      symbol: 'BTCUSDT',
      positionId: opened.id,
      closePrice: 108,
      closeReason: 'MANUAL',
    })

    expect(closed).not.toBeNull()
    expect(closed.status).toBe('CLOSED')
    expect(closed.realizedPnl).toBe(8)
    expect(svc.getOpenPositions('BTCUSDT')).toHaveLength(0)
  })

  test('closes by take profit on LONG tick', () => {
    const svc = new PaperTradeService()
    const opened = svc.openPosition({
      symbol: 'BTCUSDT',
      userId: 'u1',
      direction: 'LONG',
      entryPrice: 100,
      stopLoss: 95,
      takeProfit: 105,
    })

    const events = svc.onPriceTick({ symbol: 'BTCUSDT', price: 106 })
    const closed = events.find((event) => event.type === 'CLOSED')

    expect(closed).toBeDefined()
    expect(closed.position.id).toBe(opened.id)
    expect(closed.position.closeReason).toBe('TAKE_PROFIT')
    expect(closed.position.realizedPnl).toBe(6)
  })

  test('closes by stop loss on SHORT tick', () => {
    const svc = new PaperTradeService()
    const opened = svc.openPosition({
      symbol: 'BTCUSDT',
      userId: 'u1',
      direction: 'SHORT',
      entryPrice: 100,
      stopLoss: 103,
      takeProfit: 94,
    })

    const events = svc.onPriceTick({ symbol: 'BTCUSDT', price: 104 })
    const closed = events.find((event) => event.type === 'CLOSED')

    expect(closed).toBeDefined()
    expect(closed.position.id).toBe(opened.id)
    expect(closed.position.closeReason).toBe('STOP_LOSS')
    expect(closed.position.realizedPnl).toBe(-4)
  })

  test('scales unrealized and realized pnl by quantity', () => {
    const svc = new PaperTradeService()
    const opened = svc.openPosition({
      symbol: 'BTCUSDT',
      userId: 'u1',
      direction: 'LONG',
      entryPrice: 100,
      quantity: 3,
    })

    const [updated] = svc.onPriceTick({ symbol: 'BTCUSDT', price: 102 })
    const closed = svc.closePosition({
      symbol: 'BTCUSDT',
      positionId: opened.id,
      closePrice: 105,
      closeReason: 'MANUAL',
    })

    expect(updated.position.unrealizedPnl).toBe(6)
    expect(closed.realizedPnl).toBe(15)
    expect(svc.getAllOpenPositions()).toHaveLength(0)
    expect(svc.getClosedPositions('BTCUSDT')).toHaveLength(1)
  })
})
