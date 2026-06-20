'use strict'

const {
  BinanceFuturesOrderClient,
} = require('../../../../src/infrastructure/adapters/outbound/binance/BinanceFuturesOrderClient')

describe('BinanceFuturesOrderClient.submit', () => {
  test('maps RESULT response fill details for Mongo persistence fallback', async () => {
    const binanceClient = {
      futuresOrder: jest.fn(async () => ({
        orderId: 123,
        clientOrderId: 'tv1_abc',
        status: 'FILLED',
        avgPrice: '62623.10000',
        executedQty: '0.001',
        cumQuote: '62.62310',
        updateTime: 1780631081502,
      })),
    }
    const client = new BinanceFuturesOrderClient({ binanceClient })

    const result = await client.submit({
      orderId: 'abc',
      clientOrderId: 'tv1_abc',
      symbol: 'BTCUSDT',
      side: 'SELL',
      type: 'MARKET',
      quantity: 0.001,
    })

    expect(result).toMatchObject({
      status: 'FILLED',
      exchangeOrderId: '123',
      clientOrderId: 'tv1_abc',
      executedQuantity: 0.001,
      averageFillPrice: 62623.1,
      lastFillPrice: 62623.1,
      grossNotional: 62.6231,
    })
    expect(result.fills).toEqual([
      expect.objectContaining({
        price: 62623.1,
        quantity: 0.001,
        exchangeOrderId: '123',
        clientOrderId: 'tv1_abc',
        executionType: 'REST_RESULT',
      }),
    ])
  })
})
