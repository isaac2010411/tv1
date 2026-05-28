'use strict'

const { DomainError } = require('../../../../shared/errors/DomainError')
const { ApplicationError } = require('../../../../shared/errors/ApplicationError')
const { InfrastructureError } = require('../../../../shared/errors/InfrastructureError')
const { RiskViolationError } = require('../../../../shared/errors/RiskViolationError')
const { OrderRejectedError } = require('../../../../shared/errors/OrderRejectedError')

/**
 * Inbound HTTP adapter for the Order Management System.
 *
 * Mapping:
 *   – RiskViolationError → 409
 *   – OrderRejectedError → 422
 *   – DomainError       → 422
 *   – ApplicationError  → 400
 *   – InfrastructureError → 502
 */
class OrderController {
  constructor({ orderManager }) {
    this.orderManager = orderManager
  }

  /** POST /api/futures/orders */
  async submit(req, res) {
    try {
      const order = await this.orderManager.submit(req.body || {})
      return res.status(201).json(order)
    } catch (err) {
      return this._handleError(res, err)
    }
  }

  /** GET /api/futures/orders/:id */
  async getById(req, res) {
    const { id } = req.params
    if (!id) return res.status(400).json({ error: 'id is required' })
    try {
      const order = await this.orderManager.get(id)
      if (!order) return res.status(404).json({ error: `Order ${id} not found` })
      return res.json(order)
    } catch (err) {
      return this._handleError(res, err)
    }
  }

  /** PUT /api/futures/orders/:id/cancel */
  async cancel(req, res) {
    const { id } = req.params
    if (!id) return res.status(400).json({ error: 'id is required' })
    try {
      const order = await this.orderManager.cancel(id)
      return res.json(order)
    } catch (err) {
      return this._handleError(res, err)
    }
  }

  /** GET /api/futures/orders/open?symbol=&userId= */
  async getOpen(req, res) {
    const { symbol, userId } = req.query
    try {
      const orders = await this.orderManager.getOpen({ symbol, userId })
      return res.json(orders)
    } catch (err) {
      return this._handleError(res, err)
    }
  }

  /** GET /api/futures/orders?symbol=&status=&limit=&page= */
  async list(req, res) {
    const { symbol, userId, status, limit, page } = req.query
    try {
      const result = await this.orderManager.list({ symbol, userId, status, limit, page })
      return res.json(result)
    } catch (err) {
      return this._handleError(res, err)
    }
  }

  _handleError(res, err) {
    if (err instanceof RiskViolationError) {
      return res.status(409).json({ error: err.message, code: err.code, details: err.details })
    }
    if (err instanceof OrderRejectedError) {
      return res.status(422).json({ error: err.message, code: err.code, details: err.details })
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

module.exports = { OrderController }
