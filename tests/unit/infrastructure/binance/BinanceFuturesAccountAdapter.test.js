'use strict'

const {
  BinanceFuturesAccountAdapter,
} = require('../../../../src/infrastructure/adapters/outbound/binance/BinanceFuturesAccountAdapter')

describe('BinanceFuturesAccountAdapter.getAvailableBalance', () => {
  test('hydrates live USDT balance from futuresAccountInfo availableBalance', async () => {
    const binanceClient = {
      futuresAccountInfo: jest.fn(async () => ({
        assets: [
          { asset: 'BTC', availableBalance: '0.1', walletBalance: '0.1' },
          {
            asset: 'USDT',
            availableBalance: '123.45',
            walletBalance: '150.00',
            marginBalance: '151.00',
            crossWalletBalance: '140.00',
            unrealizedProfit: '1.25',
          },
        ],
      })),
    }
    const adapter = new BinanceFuturesAccountAdapter(binanceClient)

    const balance = await adapter.getAvailableBalance()

    expect(binanceClient.futuresAccountInfo).toHaveBeenCalled()
    expect(balance).toMatchObject({
      asset: 'USDT',
      availableBalance: 123.45,
      balance: 150,
      walletBalance: 150,
      marginBalance: 151,
      crossWalletBalance: 140,
      unrealizedProfit: 1.25,
    })
  })

  test('falls back to futuresAccountBalance when futuresAccountInfo is unavailable', async () => {
    const binanceClient = {
      futuresAccountBalance: jest.fn(async () => [
        { asset: 'USDT', availableBalance: '25.5', balance: '30', crossWalletBalance: '28' },
      ]),
    }
    const adapter = new BinanceFuturesAccountAdapter(binanceClient)

    const balance = await adapter.getAvailableBalance()

    expect(balance).toMatchObject({
      asset: 'USDT',
      availableBalance: 25.5,
      balance: 30,
      walletBalance: 30,
      crossWalletBalance: 28,
    })
  })
})
