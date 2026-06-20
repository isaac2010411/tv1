'use strict'

const { mapAccountUpdate } = require('../../../src/infrastructure/adapters/outbound/binance/mappers/mapAccountUpdate')
const { mapOrderTradeUpdate } = require('../../../src/infrastructure/adapters/outbound/binance/mappers/mapOrderTradeUpdate')

describe('Binance futures live mappers', () => {
  test('mapAccountUpdate normalizes balances and position direction', () => {
    const update = mapAccountUpdate({
      e: 'ACCOUNT_UPDATE',
      E: 1,
      T: 2,
      a: {
        m: 'ORDER',
        B: [{ a: 'USDT', wb: '100.5', cw: '99.5', bc: '1' }],
        P: [
          {
            s: 'BTCUSDT',
            pa: '0.01',
            ep: '50000',
            bep: '50010',
            cr: '2.5',
            up: '1.25',
            mt: 'cross',
            iw: '0',
            ps: 'BOTH',
          },
        ],
      },
    })

    expect(update.eventTime).toBe(1)
    expect(update.reason).toBe('ORDER')
    expect(update.balances[0]).toMatchObject({ asset: 'USDT', walletBalance: 100.5 })
    expect(update.positions[0]).toMatchObject({
      symbol: 'BTCUSDT',
      positionAmt: 0.01,
      direction: 'LONG',
      entryPrice: 50000,
      breakEvenPrice: 50010,
      accumulatedRealized: 2.5,
      unrealizedPnl: 1.25,
      marginType: 'cross',
      positionSide: 'BOTH',
    })
  })

  test('mapOrderTradeUpdate normalizes order lifecycle fields', () => {
    const update = mapOrderTradeUpdate({
      e: 'ORDER_TRADE_UPDATE',
      E: 10,
      T: 11,
      o: {
        s: 'ETHUSDT',
        c: 'tv1_abc',
        i: 123,
        S: 'BUY',
        o: 'MARKET',
        x: 'TRADE',
        X: 'FILLED',
        l: '0.2',
        z: '0.2',
        L: '2500',
        ap: '2500',
        N: 'USDT',
        n: '0.2',
        rp: '3.1',
        R: false,
        ps: 'BOTH',
      },
    })

    expect(update).toMatchObject({
      eventTime: 10,
      transactionTime: 11,
      symbol: 'ETHUSDT',
      clientOrderId: 'tv1_abc',
      exchangeOrderId: '123',
      side: 'BUY',
      type: 'MARKET',
      executionType: 'TRADE',
      status: 'FILLED',
      lastFilledQty: 0.2,
      accumulatedFilledQty: 0.2,
      lastFilledPrice: 2500,
      averagePrice: 2500,
      commissionAsset: 'USDT',
      commission: 0.2,
      realizedProfit: 3.1,
      reduceOnly: false,
      positionSide: 'BOTH',
    })
  })

  test('mapOrderTradeUpdate supports binance-api-node flattened futuresUser payloads', () => {
    const update = mapOrderTradeUpdate({
      eventType: 'ORDER_TRADE_UPDATE',
      eventTime: 20,
      transactionTime: 21,
      symbol: 'BTCUSDT',
      clientOrderId: 'tv1_flat',
      orderId: 456,
      side: 'SELL',
      orderType: 'MARKET',
      executionType: 'TRADE',
      orderStatus: 'FILLED',
      lastTradeQuantity: '0.001',
      totalTradeQuantity: '0.001',
      priceLastTrade: '62600',
      averagePrice: '62600',
      commissionAsset: 'USDT',
      commission: '0.025',
      isReduceOnly: false,
      positionSide: 'BOTH',
    })

    expect(update).toMatchObject({
      eventTime: 20,
      transactionTime: 21,
      symbol: 'BTCUSDT',
      clientOrderId: 'tv1_flat',
      exchangeOrderId: '456',
      side: 'SELL',
      type: 'MARKET',
      executionType: 'TRADE',
      status: 'FILLED',
      lastFilledQty: 0.001,
      accumulatedFilledQty: 0.001,
      lastFilledPrice: 62600,
      averagePrice: 62600,
      commissionAsset: 'USDT',
      commission: 0.025,
      reduceOnly: false,
      positionSide: 'BOTH',
    })
  })
})
