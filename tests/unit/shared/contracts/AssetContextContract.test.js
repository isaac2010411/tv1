'use strict'

const { validateAssetContext, assertAssetContext } = require('../../../../src/shared/contracts/AssetContextContract')
const { InfrastructureError } = require('../../../../src/shared/errors/InfrastructureError')

describe('AssetContextContract', () => {
  test('accepts valid asset context payload', () => {
    const payload = {
      symbol: 'BTCUSDT',
      exchangeInfo: { status: 'TRADING' },
      tradingRules: { tickSize: '0.10' },
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

    const result = validateAssetContext(payload)

    expect(result.ok).toBe(true)
    expect(result.errors).toEqual([])
    expect(assertAssetContext(payload, { channel: 'unit' })).toBe(payload)
  })

  test('rejects malformed payload', () => {
    const bad = {
      symbol: '',
      market: null,
      account: { positions: 'bad' },
    }

    const result = validateAssetContext(bad)

    expect(result.ok).toBe(false)
    expect(result.errors.length).toBeGreaterThan(0)
    expect(() => assertAssetContext(bad)).toThrow(InfrastructureError)
  })
})
