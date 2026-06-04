'use strict'

const { AssetContextManager } = require('../../../src/application/futures/context/AssetContextManager')
const { FuturesSymbol } = require('../../../src/domain/futures/entities/FuturesSymbol')
const { TradingRules } = require('../../../src/domain/futures/entities/TradingRules')
const { OrderBook } = require('../../../src/domain/futures/entities/OrderBook')
const { ApplicationError } = require('../../../src/shared/errors/ApplicationError')

const makeTradingRulesPort = (status = 'TRADING') => ({
  getSymbolInfo: jest.fn().mockResolvedValue(
    new FuturesSymbol({
      symbol: 'BTCUSDT',
      status,
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
      contractType: 'PERPETUAL',
      filters: [],
    }),
  ),
  getTradingRules: jest.fn().mockResolvedValue(
    new TradingRules({
      symbol: 'BTCUSDT',
      tickSize: '0.10',
      stepSize: '0.001',
      minQty: '0.001',
      maxQty: '1000',
      minNotional: '5',
      marketStepSize: '0.001',
      marketMinQty: '0.001',
      marketMaxQty: '1000',
      multiplierUp: null,
      multiplierDown: null,
      allowedOrderTypes: ['LIMIT', 'MARKET'],
    }),
  ),
})

const makeMarketDataPort = () => ({
  getMarkPrice: jest.fn().mockResolvedValue({ symbol: 'BTCUSDT', markPrice: '30000' }),
  getOpenInterest: jest.fn().mockResolvedValue({ symbol: 'BTCUSDT', openInterest: '12345' }),
  getTicker24h: jest.fn().mockResolvedValue({ symbol: 'BTCUSDT', lastPrice: '30000' }),
  getCandles: jest.fn().mockResolvedValue([]),
  getOrderBook: jest.fn().mockResolvedValue(new OrderBook({ symbol: 'BTCUSDT', bids: [], asks: [] })),
})

const makeAccountPort = () => ({
  getAccountContext: jest.fn().mockResolvedValue({
    balance: { asset: 'USDT', balance: '1000', availableBalance: '800' },
    positions: [],
    openOrders: [],
  }),
})

describe('AssetContextManager', () => {
  test('builds complete context for a valid symbol', async () => {
    const manager = new AssetContextManager({
      tradingRulesPort: makeTradingRulesPort(),
      marketDataPort: makeMarketDataPort(),
      accountPort: makeAccountPort(),
      riskManager: { getLimits: jest.fn().mockReturnValue({ maxOpenPositions: 1 }) },
      portfolioManager: { getSnapshot: jest.fn().mockResolvedValue({ dailyPnl: 0 }) },
    })

    const result = await manager.build('btcusdt')

    expect(result.symbol).toBe('BTCUSDT')
    expect(result.exchangeInfo).toBeInstanceOf(FuturesSymbol)
    expect(result.tradingRules).toBeInstanceOf(TradingRules)
    expect(result.market.markPrice).toEqual({ symbol: 'BTCUSDT', markPrice: '30000' })
    expect(result.orderbook).toBeInstanceOf(OrderBook)
    expect(result.positions).toEqual([])
    expect(result.orders).toEqual([])
    expect(result.risk).toEqual({ maxOpenPositions: 1 })
    expect(result.portfolio).toEqual({ dailyPnl: 0 })
  })

  test('throws ApplicationError when symbol is missing', async () => {
    const manager = new AssetContextManager({
      tradingRulesPort: makeTradingRulesPort(),
      marketDataPort: makeMarketDataPort(),
      accountPort: makeAccountPort(),
    })

    await expect(manager.build('')).rejects.toThrow(ApplicationError)
    await expect(manager.build('')).rejects.toThrow('symbol is required')
  })

  test('throws ApplicationError when symbol status is not TRADING', async () => {
    const manager = new AssetContextManager({
      tradingRulesPort: makeTradingRulesPort('BREAK'),
      marketDataPort: makeMarketDataPort(),
      accountPort: makeAccountPort(),
    })

    await expect(manager.build('BTCUSDT')).rejects.toThrow(ApplicationError)
    await expect(manager.build('BTCUSDT')).rejects.toThrow('not in TRADING status')
  })
})
