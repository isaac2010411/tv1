'use strict'

/**
 * PortfolioManagerPort — inbound port for the future portfolio manager.
 *
 * @typedef {Object} ExposureSnapshot
 * @property {Record<string, number>} byStrategy
 * @property {Record<string, number>} bySymbol
 * @property {number} totalNotional
 *
 * @typedef {Object} PnLSnapshot
 * @property {Record<string, number>} realizedByStrategy
 * @property {Record<string, number>} unrealizedByStrategy
 */
class PortfolioManagerPort {
  /** @returns {Promise<ExposureSnapshot>} */
  async getExposure() {
    return { byStrategy: {}, bySymbol: {}, totalNotional: 0 }
  }

  /** @returns {Promise<PnLSnapshot>} */
  async getPnLByStrategy() {
    return { realizedByStrategy: {}, unrealizedByStrategy: {} }
  }
}

module.exports = { PortfolioManagerPort }
