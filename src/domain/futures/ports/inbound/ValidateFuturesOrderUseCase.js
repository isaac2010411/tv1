'use strict'

/**
 * Inbound port (interface): validate a proposed futures order against domain rules.
 */
class ValidateFuturesOrderUseCase {
  /**
   * @param {{
   *   symbol:     string,
   *   side:       string,
   *   type:       string,
   *   quantity:   string|number,
   *   price?:     string|number,
   *   reduceOnly?: boolean
   * }} input
   * @returns {Promise<{ valid: true, symbol: string, side: string, type: string,
   *                     quantity: string|number, price?: string|number, reduceOnly?: boolean }>}
   */
  // eslint-disable-next-line no-unused-vars
  async execute(input) { throw new Error('Not implemented: ValidateFuturesOrderUseCase.execute') }
}

module.exports = { ValidateFuturesOrderUseCase }
