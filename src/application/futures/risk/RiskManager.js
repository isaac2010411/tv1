'use strict'

const { RiskGuardPort } = require('../../../domain/futures/ports/inbound/RiskGuardPort')
const { loadRiskRulesConfig } = require('./RiskRulesConfig')
const {
  evaluateSignal: evaluateSignalPolicy,
  evaluateActivePosition: evaluateActivePositionPolicy,
  summarizeActiveRules: summarizeActiveRulesPolicy,
  SIGNAL_MODE,
  POSITION_ACTION,
} = require('./DynamicRiskPolicy')

/**
 * RiskManager — concrete implementation of {@link RiskGuardPort}.
 *
 * Evaluates a candidate order against configured pre-trade limits and the
 * current portfolio snapshot supplied by the OrderManager / PortfolioManager.
 * Returns one of:
 *   { action: 'ALLOW' }
 *   { action: 'REDUCE', adjustedQuantity, reason }
 *   { action: 'BLOCK', reason, rule }
 *
 * The decision is pure (no I/O), so it is safe to call on the hot path of
 * every submitted order.
 */
class RiskManager extends RiskGuardPort {
  /**
   * @param {object} [deps]
   * @param {ReturnType<typeof loadRiskRulesConfig>} [deps.rules]
   */
  constructor({ rules = loadRiskRulesConfig() } = {}) {
    super()
    this.rules = rules
  }

  /**
   * @returns {Promise<{action:string, reason?:string, rule?:string, adjustedQuantity?:number}>}
   */
  async evaluate(order = {}, portfolio = {}) {
    const symbol = String(order.symbol || '').toUpperCase()
    const qty = Number(order.quantity)
    const price = Number(order.price)
    const positions = Array.isArray(portfolio.positions) ? portfolio.positions : []
    const dailyPnl = Number(portfolio.dailyPnl ?? 0)

    if (!symbol || !Number.isFinite(qty) || qty <= 0) {
      return { action: 'BLOCK', reason: 'Invalid order payload', rule: 'shape' }
    }

    if (this.rules.allowedSymbols.length > 0 && !this.rules.allowedSymbols.includes(symbol)) {
      return { action: 'BLOCK', reason: `Symbol ${symbol} not in allow-list`, rule: 'allowedSymbols' }
    }

    // Daily loss circuit breaker (loss is negative; compare absolute value).
    if (Number.isFinite(this.rules.maxDailyLoss) && dailyPnl < 0 && Math.abs(dailyPnl) >= this.rules.maxDailyLoss) {
      return {
        action: 'BLOCK',
        reason: `Daily loss limit reached (${dailyPnl} <= -${this.rules.maxDailyLoss})`,
        rule: 'maxDailyLoss',
      }
    }

    const openCount = positions.filter((p) => p.status === 'OPEN').length
    if (openCount >= this.rules.maxOpenPositions) {
      return {
        action: 'BLOCK',
        reason: `Max open positions reached (${openCount}/${this.rules.maxOpenPositions})`,
        rule: 'maxOpenPositions',
      }
    }

    // Notional check (LIMIT only — needs a price)
    if (Number.isFinite(price) && price > 0 && Number.isFinite(this.rules.maxNotionalPerSymbol)) {
      const existingNotional = positions
        .filter((p) => p.status === 'OPEN' && String(p.symbol).toUpperCase() === symbol)
        .reduce((acc, p) => acc + Math.abs(Number(p.quantity || 0) * Number(p.entryPrice || 0)), 0)
      const orderNotional = qty * price
      const total = existingNotional + orderNotional
      if (total > this.rules.maxNotionalPerSymbol) {
        const remaining = Math.max(0, this.rules.maxNotionalPerSymbol - existingNotional)
        const adjustedQuantity = remaining > 0 ? Number((remaining / price).toFixed(8)) : 0
        if (adjustedQuantity <= 0) {
          return {
            action: 'BLOCK',
            reason: `Notional cap exceeded for ${symbol}`,
            rule: 'maxNotionalPerSymbol',
          }
        }
        return {
          action: 'REDUCE',
          adjustedQuantity,
          reason: `Order notional reduced to fit ${symbol} cap`,
          rule: 'maxNotionalPerSymbol',
        }
      }
    }

    if (qty > this.rules.maxOrderQty) {
      return {
        action: 'REDUCE',
        adjustedQuantity: this.rules.maxOrderQty,
        reason: `Quantity capped to maxOrderQty (${this.rules.maxOrderQty})`,
        rule: 'maxOrderQty',
      }
    }

    return { action: 'ALLOW' }
  }

  /** Exposes current limits for the GET /risk/limits endpoint. */
  getLimits() {
    return { ...this.rules }
  }

  /**
   * Dynamic, asset-and-market-state-aware evaluation of a signal emitted by
   * the StateMachineSignalEngine. Decides whether the bot can auto-execute
   * the entry, or whether the user must confirm via popup.
   *
   * @param {object} ctx
   * @param {object} ctx.signal           Signal contract from SignalFactory.
   * @param {object} ctx.factors          MarketFactors snapshot.
   * @param {object|null} [ctx.position]  Currently OPEN position for the symbol.
   * @param {object} [ctx.accountState]   { dailyPnl, openPositionsCount }
   */
  evaluateSignal(ctx = {}) {
    return evaluateSignalPolicy(ctx)
  }

  /**
   * Decides what to do with an OPEN auto-managed position on each tick.
   * @param {object} ctx
   * @param {object} ctx.position
   * @param {object} [ctx.factors]
   * @param {string|null} [ctx.signalState]
   * @param {number|null} [ctx.markPrice]
   */
  evaluateActivePosition(ctx = {}) {
    return evaluateActivePositionPolicy(ctx)
  }

  /**
   * Returns a human-readable list of rules currently in effect for the given
   * market context. Intended for UI display.
   */
  summarizeActiveRules(ctx = {}) {
    return summarizeActiveRulesPolicy(ctx)
  }
}

module.exports = { RiskManager, SIGNAL_MODE, POSITION_ACTION }
