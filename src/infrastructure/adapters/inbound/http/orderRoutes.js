'use strict'

const { Router } = require('express')

/**
 * Inbound HTTP routes for the Order Management System.
 * Mounted at /api/futures/orders.
 *
 * @param {import('./OrderController').OrderController} controller
 */
const createOrderRouter = (controller) => {
  const router = Router()
  // NOTE: list specific routes before parameterised ones to avoid `/open`
  // being captured by `/:id`.
  router.get('/open', (req, res) => controller.getOpen(req, res))
  router.get('/', (req, res) => controller.list(req, res))
  router.post('/', (req, res) => controller.submit(req, res))
  router.get('/:id', (req, res) => controller.getById(req, res))
  router.put('/:id/cancel', (req, res) => controller.cancel(req, res))
  return router
}

module.exports = { createOrderRouter }
