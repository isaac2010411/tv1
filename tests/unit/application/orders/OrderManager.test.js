'use strict'

const { OrderManager } = require('../../../../src/application/futures/orders/OrderManager')
const { RiskViolationError } = require('../../../../src/shared/errors/RiskViolationError')
const { OrderRejectedError } = require('../../../../src/shared/errors/OrderRejectedError')

const makeInMemoryRepo = () => {
  const map = new Map()
  return {
    save: jest.fn(async (o) => { map.set(o.orderId, { ...o }); return o }),
    findById: jest.fn(async (id) => (map.has(id) ? { ...map.get(id) } : null)),
    findOpen: jest.fn(async () => Array.from(map.values()).filter((o) => ['NEW', 'PARTIAL'].includes(o.status))),
    list: jest.fn(async () => ({ items: Array.from(map.values()), total: map.size, page: 1, limit: 100 })),
    updateStatus: jest.fn(async (id, patch) => {
      const cur = map.get(id); if (!cur) return null
      const next = { ...cur, ...patch }; map.set(id, next); return next
    }),
    _map: map,
  }
}

const allowGuard = { evaluate: jest.fn(async () => ({ action: 'ALLOW' })) }
const blockGuard = (reason = 'too big') => ({
  evaluate: jest.fn(async () => ({ action: 'BLOCK', reason, rule: 'maxOrderQty' })),
})
const reduceGuard = (qty) => ({
  evaluate: jest.fn(async () => ({ action: 'REDUCE', adjustedQuantity: qty, reason: 'cap', rule: 'maxOrderQty' })),
})

const fillingClient = (price = 100) => ({
  submit: jest.fn(async (order) => ({
    status: 'FILLED',
    fills: [{ price, quantity: order.quantity, timestamp: Date.now() }],
  })),
  cancel: jest.fn(async () => ({ ok: true })),
})

describe('OrderManager.submit', () => {
  test('happy path: persists NEW then FILLED, notifies lifecycle, applies fill to portfolio', async () => {
    const repo = makeInMemoryRepo()
    const portfolio = { getSnapshot: jest.fn(async () => ({ positions: [], dailyPnl: 0 })), applyFill: jest.fn(async () => 'pos-1') }
    const notifier = { emitOrderLifecycle: jest.fn(), emitRiskDecision: jest.fn() }
    const om = new OrderManager({
      orderRepository: repo,
      riskGuard: allowGuard,
      exchangeClient: fillingClient(100),
      portfolioManager: portfolio,
      realtimeNotifier: notifier,
    })

    const order = await om.submit({ symbol: 'btcusdt', side: 'BUY', type: 'MARKET', quantity: 1 })

    expect(order.symbol).toBe('BTCUSDT')
    expect(order.status).toBe('FILLED')
    expect(order.fills).toHaveLength(1)
    expect(order.positionId).toBe('pos-1')
    expect(repo.save).toHaveBeenCalledTimes(2) // NEW then FILLED
    expect(notifier.emitOrderLifecycle).toHaveBeenCalledTimes(2)
    expect(notifier.emitRiskDecision).toHaveBeenCalledTimes(1)
    expect(portfolio.applyFill).toHaveBeenCalledWith(expect.objectContaining({ status: 'FILLED' }))
  })

  test('derives executed quantity and notional from returned fills', async () => {
    const repo = makeInMemoryRepo()
    const om = new OrderManager({
      orderRepository: repo,
      riskGuard: allowGuard,
      exchangeClient: fillingClient(125),
      portfolioManager: { getSnapshot: async () => ({ positions: [], dailyPnl: 0 }), applyFill: async () => null },
    })

    const order = await om.submit({ symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: 0.002 })

    expect(order.executedQuantity).toBe(0.002)
    expect(order.averageFillPrice).toBe(125)
    expect(order.lastFillPrice).toBe(125)
    expect(order.grossNotional).toBe(0.25)
  })

  test('REDUCE adjusts quantity before submitting to exchange', async () => {
    const repo = makeInMemoryRepo()
    const exchange = fillingClient(50)
    const om = new OrderManager({
      orderRepository: repo,
      riskGuard: reduceGuard(2),
      exchangeClient: exchange,
      portfolioManager: { getSnapshot: async () => ({ positions: [], dailyPnl: 0 }), applyFill: async () => null },
    })
    const order = await om.submit({ symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: 10 })
    expect(order.quantity).toBe(2)
    expect(exchange.submit).toHaveBeenCalledWith(expect.objectContaining({ quantity: 2 }))
  })

  test('persists precomputed clientOrderId before exchange submit returns', async () => {
    const repo = makeInMemoryRepo()
    const exchange = {
      getClientOrderId: jest.fn(({ orderId }) => `tv1_${orderId.replace(/-/g, '').slice(0, 24)}`),
      submit: jest.fn(async (order) => ({
        status: 'NEW',
        clientOrderId: order.clientOrderId,
        exchangeOrderId: '123',
        fills: [],
      })),
      cancel: jest.fn(),
    }
    const om = new OrderManager({
      orderRepository: repo,
      riskGuard: allowGuard,
      exchangeClient: exchange,
      portfolioManager: { getSnapshot: async () => ({ positions: [], dailyPnl: 0 }) },
    })

    await om.submit({ symbol: 'BTCUSDT', side: 'SELL', type: 'MARKET', quantity: 0.001 })
    const firstSave = repo.save.mock.calls[0][0]

    expect(firstSave.status).toBe('NEW')
    expect(firstSave.clientOrderId).toMatch(/^tv1_/)
    expect(exchange.submit).toHaveBeenCalledWith(expect.objectContaining({ clientOrderId: firstSave.clientOrderId }))
  })

  test('live filled orders stay in futures orders and do not write paper positions', async () => {
    const repo = makeInMemoryRepo()
    const portfolio = {
      getSnapshot: jest.fn(async () => ({ positions: [], dailyPnl: 0 })),
      applyFill: jest.fn(async () => 'paper-pos-1'),
    }
    const om = new OrderManager({
      orderRepository: repo,
      riskGuard: allowGuard,
      exchangeClient: fillingClient(100),
      portfolioManager: portfolio,
    })

    const order = await om.submit({ mode: 'live', symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: 1 })

    expect(order.status).toBe('FILLED')
    expect(order.mode).toBe('live')
    expect(order.positionId).toBeNull()
    expect(portfolio.applyFill).not.toHaveBeenCalled()
    expect(repo.save).toHaveBeenCalledTimes(2)
    expect(Array.from(repo._map.values())).toHaveLength(1)
    expect(Array.from(repo._map.values())[0]).toMatchObject({ mode: 'live', status: 'FILLED' })
  })

  test('BLOCK throws RiskViolationError and does not call exchange', async () => {
    const repo = makeInMemoryRepo()
    const exchange = fillingClient()
    const om = new OrderManager({
      orderRepository: repo,
      riskGuard: blockGuard('over limit'),
      exchangeClient: exchange,
      portfolioManager: null,
    })
    await expect(
      om.submit({ symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: 100 }),
    ).rejects.toBeInstanceOf(RiskViolationError)
    expect(exchange.submit).not.toHaveBeenCalled()
    expect(repo.save).not.toHaveBeenCalled()
  })

  test('invalid payload throws ApplicationError-style error', async () => {
    const om = new OrderManager({
      orderRepository: makeInMemoryRepo(),
      riskGuard: allowGuard,
      exchangeClient: fillingClient(),
    })
    await expect(om.submit({ symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: 0 })).rejects.toThrow()
    await expect(om.submit({ symbol: 'BTCUSDT', side: 'X', type: 'MARKET', quantity: 1 })).rejects.toThrow()
    await expect(om.submit({ symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', quantity: 1 })).rejects.toThrow()
  })

  test('exchange rejection persists REJECTED and throws OrderRejectedError', async () => {
    const repo = makeInMemoryRepo()
    const exchange = {
      submit: jest.fn(async () => ({ status: 'REJECTED', fills: [], reason: 'no liquidity' })),
      cancel: jest.fn(),
    }
    const om = new OrderManager({
      orderRepository: repo,
      riskGuard: allowGuard,
      exchangeClient: exchange,
      portfolioManager: { getSnapshot: async () => ({ positions: [], dailyPnl: 0 }), applyFill: async () => null },
    })
    await expect(
      om.submit({ symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quantity: 1 }),
    ).rejects.toBeInstanceOf(OrderRejectedError)
    const persisted = Array.from(repo._map.values())
    expect(persisted[0].status).toBe('REJECTED')
  })
})

describe('OrderManager.cancel', () => {
  test('cancels an open order', async () => {
    const repo = makeInMemoryRepo()
    const exchange = fillingClient(100)
    const om = new OrderManager({
      orderRepository: repo,
      riskGuard: allowGuard,
      exchangeClient: { submit: async () => ({ status: 'NEW', fills: [] }), cancel: exchange.cancel },
      portfolioManager: { getSnapshot: async () => ({ positions: [], dailyPnl: 0 }) },
    })
    await repo.save({ orderId: 'o1', status: 'NEW', symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', quantity: 1, price: 100, fills: [], createdAt: Date.now() })
    const canceled = await om.cancel('o1')
    expect(canceled.status).toBe('CANCELED')
  })

  test('throws when order not found', async () => {
    const om = new OrderManager({
      orderRepository: makeInMemoryRepo(),
      riskGuard: allowGuard,
      exchangeClient: fillingClient(),
    })
    await expect(om.cancel('missing')).rejects.toThrow(/not found/i)
  })
})
