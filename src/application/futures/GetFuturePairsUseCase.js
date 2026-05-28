class GetFuturePairsUseCase {
  constructor(futuresRepository) {
    this.futuresRepository = futuresRepository
  }

  async execute() {
    return this.futuresRepository.getTradingPairs()
  }
}

module.exports = { GetFuturePairsUseCase }
