const { FuturesRepository } = require('../../../ports/out/FuturesRepository')
const { FuturePair } = require('../../../domain/futures/FuturePair')

class BinanceFuturesRepository extends FuturesRepository {
  constructor(binanceClient) {
    super()
    this.client = binanceClient
  }

  async getTradingPairs() {
    const exchangeInfo = await this.client.futuresExchangeInfo()
    return exchangeInfo.symbols
      .filter(s => s.status === 'TRADING')
      .map(s => new FuturePair({
        symbol: s.symbol,
        baseAsset: s.baseAsset,
        quoteAsset: s.quoteAsset,
        contractType: s.contractType,
      }))
  }
}

module.exports = { BinanceFuturesRepository }
