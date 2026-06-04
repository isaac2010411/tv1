'use strict'

const {
  FuturesAssetController,
} = require('../../../../src/infrastructure/adapters/inbound/http/FuturesAssetController')
const { registry } = require('../../../../src/infrastructure/observability/metrics')
const { logger } = require('../../../../src/shared/utils/logger')

function makeResponse() {
  const res = {
    _status: 200,
    _json: null,
    _headers: {},
    set: jest.fn((name, value) => {
      res._headers[name] = value
      return res
    }),
    status: jest.fn((code) => {
      res._status = code
      return res
    }),
    json: jest.fn((payload) => {
      res._json = payload
      return res
    }),
  }
  return res
}

describe('FuturesAssetController deprecation checks', () => {
  test('flags REST context endpoint as deprecated via headers/log/metric', async () => {
    const baseline = registry.snapshot().counters.asset_context_rest_deprecated_total?.series?.[0]?.value ?? 0
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {})

    const context = {
      symbol: 'BTCUSDT',
      exchangeInfo: { status: 'TRADING' },
      tradingRules: { tickSize: '0.1' },
      market: {
        markPrice: { markPrice: '30000' },
        openInterest: { openInterest: '12000' },
        ticker24h: { lastPrice: '30010' },
      },
      orderbook: { bids: [], asks: [] },
      candles: [],
      account: {
        balance: { asset: 'USDT', balance: '1000', availableBalance: '900' },
        positions: [],
        openOrders: [],
      },
    }

    const controller = new FuturesAssetController({
      getAssetContextUseCase: { execute: jest.fn().mockResolvedValue(context) },
      validateOrderUseCase: { execute: jest.fn() },
      marketDataPort: { getCandles: jest.fn() },
    })

    const req = { params: { symbol: 'btcusdt' } }
    const res = makeResponse()

    await controller.getAssetContext(req, res)

    expect(res._status).toBe(200)
    expect(res._headers.Deprecation).toBe('true')
    expect(res._headers.Sunset).toBe('2026-12-31')
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('DEPRECATED_REST_ASSET_CONTEXT'))

    const after = registry.snapshot().counters.asset_context_rest_deprecated_total?.series?.[0]?.value ?? 0
    expect(after).toBeGreaterThan(baseline)

    warnSpy.mockRestore()
  })
})
