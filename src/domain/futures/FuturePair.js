class FuturePair {
  constructor({ symbol, baseAsset, quoteAsset, contractType }) {
    this.symbol = symbol
    this.baseAsset = baseAsset
    this.quoteAsset = quoteAsset
    this.contractType = contractType
  }
}

module.exports = { FuturePair }
