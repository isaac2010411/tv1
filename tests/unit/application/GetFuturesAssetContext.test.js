'use strict'

const { GetFuturesAssetContext } = require('../../../src/application/futures/use-cases/GetFuturesAssetContext')
const { FuturesSymbol }          = require('../../../src/domain/futures/entities/FuturesSymbol')
const { TradingRules }           = require('../../../src/domain/futures/entities/TradingRules')
const { OrderBook }              = require('../../../src/domain/futures/entities/OrderBook')
const { ApplicationError }       = require('../../../src/shared/errors/ApplicationError')

// ── Test doubles ──────────────────────────────────────────────────────────────

const makeTradingRulesPort = (status = 'TRADING') => ({
  getSymbolInfo: jest.fn().mockResolvedValue(
    new FuturesSymbol({
      symbol:       'BTCUSDT',
      status,
      baseAsset:    'BTC',
      quoteAsset:   'USDT',
      contractType: 'PERPETUAL',
      filters:      [],
    }),
  ),
  getTradingRules: jest.fn().mockResolvedValue(
    new TradingRules({
      symbol:          'BTCUSDT',
      tickSize:        '0.10',
      stepSize:        '0.001',
      minQty:          '0.001',
      maxQty:          '1000',
      minNotional:     '5',
      marketStepSize:  '0.001',
      marketMinQty:    '0.001',
      marketMaxQty:    '1000',
      multiplierUp:    null,
      multiplierDown:  null,
      allowedOrderTypes: ['LIMIT', 'MARKET'],
    }),
  ),
})

const makeMarketDataPort = () => ({
  getMarkPrice:    jest.fn().mockResolvedValue({ symbol: 'BTCUSDT', markPrice: '30000' }),
  getOpenInterest: jest.fn().mockResolvedValue({ symbol: 'BTCUSDT', openInterest: '12345' }),
  getTicker24h:    jest.fn().mockResolvedValue({ symbol: 'BTCUSDT', lastPrice: '30000' }),
  getCandles:      jest.fn().mockResolvedValue([]),
  getOrderBook:    jest.fn().mockResolvedValue(
    new OrderBook({ symbol: 'BTCUSDT', bids: [], asks: [] }),
  ),
})

const makeAccountPort = () => ({
  getAccountContext: jest.fn().mockResolvedValue({
    balance:    { asset: 'USDT', balance: '1000', availableBalance: '800' },
    positions:  [],
    openOrders: [],
  }),
})

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GetFuturesAssetContext', () => {
  test('returns a complete asset context for a valid symbol', async () => {
    const useCase = new GetFuturesAssetContext({
      tradingRulesPort: makeTradingRulesPort(),
      marketDataPort:   makeMarketDataPort(),
      accountPort:      makeAccountPort(),
    })

    const result = await useCase.execute({ symbol: 'btcusdt' }) // lowercase input is normalised

    expect(result.symbol).toBe('BTCUSDT')
    expect(result.exchangeInfo).toBeInstanceOf(FuturesSymbol)
    expect(result.tradingRules).toBeInstanceOf(TradingRules)
    expect(result.market.markPrice).toEqual({ symbol: 'BTCUSDT', markPrice: '30000' })
    expect(result.orderbook).toBeInstanceOf(OrderBook)
    expect(result.candles).toEqual([])
    expect(result.account.balance.asset).toBe('USDT')
  })

  test('calls all outbound ports exactly once', async () => {
    const tradingRulesPort = makeTradingRulesPort()
    const marketDataPort   = makeMarketDataPort()
    const accountPort      = makeAccountPort()

    const useCase = new GetFuturesAssetContext({ tradingRulesPort, marketDataPort, accountPort })
    await useCase.execute({ symbol: 'BTCUSDT' })

    expect(tradingRulesPort.getSymbolInfo).toHaveBeenCalledTimes(1)
    expect(tradingRulesPort.getTradingRules).toHaveBeenCalledTimes(1)
    expect(marketDataPort.getMarkPrice).toHaveBeenCalledTimes(1)
    expect(marketDataPort.getOpenInterest).toHaveBeenCalledTimes(1)
    expect(marketDataPort.getTicker24h).toHaveBeenCalledTimes(1)
    expect(marketDataPort.getCandles).toHaveBeenCalledTimes(1)
    expect(marketDataPort.getOrderBook).toHaveBeenCalledTimes(1)
    expect(accountPort.getAccountContext).toHaveBeenCalledTimes(1)
  })

  test('throws ApplicationError (MISSING_SYMBOL) when symbol is omitted', async () => {
    const useCase = new GetFuturesAssetContext({
      tradingRulesPort: makeTradingRulesPort(),
      marketDataPort:   makeMarketDataPort(),
      accountPort:      makeAccountPort(),
    })

    await expect(useCase.execute({})).rejects.toThrow(ApplicationError)
    await expect(useCase.execute({})).rejects.toThrow('symbol is required')
  })

  test('throws ApplicationError (SYMBOL_NOT_TRADING) when symbol status is not TRADING', async () => {
    const useCase = new GetFuturesAssetContext({
      tradingRulesPort: makeTradingRulesPort('BREAK'),
      marketDataPort:   makeMarketDataPort(),
      accountPort:      makeAccountPort(),
    })

    await expect(useCase.execute({ symbol: 'BTCUSDT' })).rejects.toThrow(ApplicationError)
    await expect(useCase.execute({ symbol: 'BTCUSDT' })).rejects.toThrow('not in TRADING status')
  })
})
