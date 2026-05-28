'use strict'

const { Router } = require('express')

/**
 * Inbound HTTP routes for the Portfolio Manager.
 * Mounted at /api/futures/portfolio.
 *
 * @param {import('./PortfolioController').PortfolioController} controller
 */
const createPortfolioRouter = (controller) => {
  const router = Router()
  router.get('/positions', (req, res) => controller.listPositions(req, res))
  router.get('/positions/:id', (req, res) => controller.getPosition(req, res))
  router.get('/exposure', (req, res) => controller.getExposure(req, res))
  router.get('/performance', (req, res) => controller.getPerformance(req, res))
  router.get('/snapshot', (req, res) => controller.getSnapshot(req, res))
  return router
}

module.exports = { createPortfolioRouter }
