'use strict'

const { DomainError } = require('../../../../shared/errors/DomainError')
const { ApplicationError } = require('../../../../shared/errors/ApplicationError')
const { InfrastructureError } = require('../../../../shared/errors/InfrastructureError')

/**
 * Inbound HTTP adapter for the Portfolio Manager.
 */
class PortfolioController {
  constructor({ portfolioManager }) {
    this.portfolioManager = portfolioManager
  }

  /** GET /api/futures/portfolio/positions?status=OPEN&symbol=BTCUSDT&userId= */
  async listPositions(req, res) {
    const { status, symbol, userId } = req.query
    try {
      const positions = await this.portfolioManager.listPositions({ status, symbol, userId })
      return res.json({ items: positions, total: positions.length })
    } catch (err) {
      return this._handleError(res, err)
    }
  }

  /** GET /api/futures/portfolio/positions/:id */
  async getPosition(req, res) {
    const { id } = req.params
    if (!id) return res.status(400).json({ error: 'id is required' })
    try {
      const position = await this.portfolioManager.getPosition(id)
      if (!position) return res.status(404).json({ error: `Position ${id} not found` })
      return res.json(position)
    } catch (err) {
      return this._handleError(res, err)
    }
  }

  /** GET /api/futures/portfolio/exposure */
  async getExposure(_req, res) {
    try {
      const exposure = await this.portfolioManager.getExposure()
      return res.json(exposure)
    } catch (err) {
      return this._handleError(res, err)
    }
  }

  /** GET /api/futures/portfolio/performance?userId= */
  async getPerformance(req, res) {
    const { userId } = req.query
    try {
      const perf = await this.portfolioManager.getPerformance({ userId })
      return res.json(perf)
    } catch (err) {
      return this._handleError(res, err)
    }
  }

  /** GET /api/futures/portfolio/snapshot?userId= */
  async getSnapshot(req, res) {
    const { userId } = req.query
    try {
      const snap = await this.portfolioManager.getSnapshot({ userId: userId ?? null })
      return res.json(snap)
    } catch (err) {
      return this._handleError(res, err)
    }
  }

  _handleError(res, err) {
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

module.exports = { PortfolioController }
