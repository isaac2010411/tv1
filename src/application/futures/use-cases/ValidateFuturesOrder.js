'use strict'

const { ValidateFuturesOrderUseCase } = require('../../../domain/futures/ports/inbound/ValidateFuturesOrderUseCase')
const { TradingRulesValidator }       = require('../../../domain/futures/services/TradingRulesValidator')
const { NoopRiskGuard }               = require('../../../domain/futures/ports/inbound/RiskGuardPort')
const { ApplicationError }            = require('../../../shared/errors/ApplicationError')

/**
 * Use case: validates a proposed futures order against exchange and domain rules.
 * Does NOT send any real orders to Binance.
 */
class ValidateFuturesOrder extends ValidateFuturesOrderUseCase {
  /**
   * @param {object} deps
   * @param {import('../../../domain/futures/ports/outbound/FuturesTradingRulesPort').FuturesTradingRulesPort} deps.tradingRulesPort
   * @param {import('../../../domain/futures/ports/inbound/RiskGuardPort').RiskGuardPort} [deps.riskGuard]
   *   Optional risk gate. Defaults to NoopRiskGuard (ALLOW). Phase 6 hook.
   */
  constructor({ tradingRulesPort, riskGuard = null }) {
    super()
    this.tradingRulesPort = tradingRulesPort
    this.validator        = new TradingRulesValidator()
    this.riskGuard        = riskGuard ?? new NoopRiskGuard()
  }

  /**
   * @param {{ symbol:string, side:string, type:string, quantity:string|number,
   *            price?:string|number, reduceOnly?:boolean }} input
   */
  async execute({ symbol, side, type, quantity, price, reduceOnly } = {}) {
    if (!symbol || !side || !type || quantity == null) {
      throw new ApplicationError(
        'symbol, side, type and quantity are required',
        'MISSING_FIELDS',
      )
    }

    const normalizedSymbol = symbol.trim().toUpperCase()

    const [symbolInfo, rules] = await Promise.all([
      this.tradingRulesPort.getSymbolInfo(normalizedSymbol),
      this.tradingRulesPort.getTradingRules(normalizedSymbol),
    ])

    if (!symbolInfo.isTrading()) {
      throw new ApplicationError(
        `Symbol ${normalizedSymbol} is not in TRADING status`,
        'SYMBOL_NOT_TRADING',
      )
    }

    // Domain validation – may throw DomainError
    this.validator.validate(rules, { symbol: normalizedSymbol, side, type, quantity, price, reduceOnly })

    // Phase 6 risk gate (no-op by default; real implementation arrives with
    // the risk manager module).
    const order = { symbol: normalizedSymbol, side, type, quantity, price, reduceOnly }
    const decision = await this.riskGuard.evaluate(order, { positions: [] })
    if (decision?.action === 'BLOCK') {
      throw new ApplicationError(
        decision.reason || 'Order blocked by risk guard',
        'RISK_BLOCKED',
      )
    }
    const finalQuantity = decision?.action === 'REDUCE' && decision.adjustedQuantity != null
      ? decision.adjustedQuantity
      : quantity

    return { valid: true, symbol: normalizedSymbol, side, type, quantity: finalQuantity, price, reduceOnly }
  }
}

module.exports = { ValidateFuturesOrder }
