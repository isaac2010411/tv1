'use strict'

const { Router } = require('express')

/**
 * Inbound HTTP routes for the Risk Manager.
 * Mounted at /api/futures/risk.
 *
 * @param {import('./RiskController').RiskController} controller
 */
const createRiskRouter = (controller) => {
  const router = Router()
  router.get('/limits', (req, res) => controller.getLimits(req, res))
  router.post('/check', (req, res) => controller.check(req, res))
  return router
}

module.exports = { createRiskRouter }
