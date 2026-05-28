'use strict'

/**
 * RiskGuardPort — inbound port for the future risk manager.
 *
 * Implementations evaluate a candidate order against the current portfolio
 * (and any other risk inputs they require) and return a decision. The default
 * implementation in the composition root is a no-op pass-through; concrete
 * implementations live in `src/application/futures/risk/`.
 *
 * @typedef {Object} RiskDecision
 * @property {'ALLOW'|'BLOCK'|'REDUCE'} action
 * @property {string} [reason]
 * @property {number} [adjustedQuantity]  // when action === 'REDUCE'
 */
class RiskGuardPort {
  /**
   * @param {object} order        candidate order (symbol, side, qty, price...)
   * @param {object} portfolio    current portfolio snapshot (open positions, exposure)
   * @returns {Promise<RiskDecision>}
   */
  // eslint-disable-next-line no-unused-vars
  async evaluate(order, portfolio) {
    return { action: 'ALLOW' }
  }
}

class NoopRiskGuard extends RiskGuardPort {}

module.exports = { RiskGuardPort, NoopRiskGuard }
