'use strict'

const { DomainError } = require('../../../../shared/errors/DomainError')
const { ApplicationError } = require('../../../../shared/errors/ApplicationError')
const { InfrastructureError } = require('../../../../shared/errors/InfrastructureError')
const { RiskViolationError } = require('../../../../shared/errors/RiskViolationError')

/**
 * Inbound HTTP adapter for the Risk Manager.
 *
 * Maps:
 *   – DomainError → 422
 *   – RiskViolationError → 409 (conflict — order would breach a rule)
 *   – ApplicationError → 400
 *   – InfrastructureError → 502
 */
class RiskController {
  constructor({ riskManager, portfolioManager = null }) {
    this.riskManager = riskManager
    this.portfolioManager = portfolioManager
  }

  /** GET /api/futures/risk/limits */
  async getLimits(_req, res) {
    try {
      const limits = this.riskManager.getLimits()
      return res.json(limits)
    } catch (err) {
      return this._handleError(res, err)
    }
  }

  /**
   * POST /api/futures/risk/check
   * Body: { symbol, side, type, quantity, price?, userId? }
   */
  async check(req, res) {
    const { symbol, side, type, quantity, price, userId } = req.body || {}
    if (!symbol || !side || !type || quantity == null) {
      return res.status(400).json({ error: 'symbol, side, type and quantity are required' })
    }
    try {
      const portfolio = this.portfolioManager
        ? await this.portfolioManager.getSnapshot({ userId: userId ?? null })
        : { positions: [], dailyPnl: 0 }
      const decision = await this.riskManager.evaluate(
        { symbol: String(symbol).toUpperCase(), side, type, quantity: Number(quantity), price: price != null ? Number(price) : null },
        portfolio,
      )
      return res.json({ decision })
    } catch (err) {
      return this._handleError(res, err)
    }
  }

  _handleError(res, err) {
    if (err instanceof RiskViolationError) {
      return res.status(409).json({ error: err.message, code: err.code, details: err.details })
    }
    if (err instanceof DomainError) {
      return res.status(422).json({ error: err.message, code: err.code })
    }
    if (err instanceof ApplicationError) {
      return res.status(400).json({ error: err.message, code: err.code })
    }
    if (err instanceof InfrastructureError) {
      return res.status(502).json({ error: err.message, code: err.code })
    }
    return res.status(500).json({ error: 'Internal server error' })
  }
}

module.exports = { RiskController }
