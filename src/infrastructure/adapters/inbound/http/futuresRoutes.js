'use strict'

const { Router } = require('express')

/**
 * Inbound HTTP routes for futures asset endpoints.
 *
 * Mounted at /api/futures by the app bootstrap.
 *
 * @param {import('./FuturesAssetController').FuturesAssetController} controller
 * @returns {import('express').Router}
 */
const createFuturesAssetRouter = (controller) => {
  const router = Router()

  /**
   * GET /api/futures/candles?symbol=BTCUSDT&interval=1m&limit=30
   * Returns OHLCV candle data for a symbol and interval.
   */
  router.get('/candles', (req, res) => controller.getCandles(req, res))

  /**
   * GET /api/futures/assets/:symbol/context
   * Returns the full Futures Asset Trading Context for a symbol.
   * @deprecated Prefer Socket.IO ASSET_CONTEXT payload after subscribe.
   */
  router.get('/assets/:symbol/context', (req, res) => controller.getAssetContext(req, res))

  /**
   * POST /api/futures/assets/:symbol/validate-order
   * Validates an order against exchange trading rules without sending it.
   */
  router.post('/assets/:symbol/validate-order', (req, res) => controller.validateOrder(req, res))
  /**
   * GET /api/futures/assets/:symbol/health
   * Returns health metrics for the locally-reconstructed order book engine.
   */
  router.get('/assets/:symbol/health', (req, res) => controller.getMarketDataHealth(req, res))

  /**
   * GET /api/futures/footprint?symbol=BTCUSDT&interval=1m&limit=50
   * Returns approximate footprint history from kline taker-buy data.
   */
  router.get('/footprint', (req, res) => controller.getFootprintHistory(req, res))

  /**
   * GET /api/futures/paper-positions?symbol=BTCUSDT&status=OPEN&from=...&to=...&limit=100&page=1
   * Returns persisted paper positions with filtering/pagination.
   */
  router.get('/paper-positions', (req, res) => controller.getPaperPositions(req, res))

  /**
   * GET /api/futures/signal-history?symbol=BTCUSDT&state=...&decision=...&from=...&to=...
   * Returns explainable signal history with filtering/pagination.
   */
  router.get('/signal-history', (req, res) => controller.getSignalHistory(req, res))

  /**
   * GET /api/futures/session-candles?symbol=BTCUSDT&interval=1m&limit=200
   * Returns persisted session candles with backend-calculated indicators.
   */
  router.get('/session-candles', (req, res) => controller.getSessionCandles(req, res))

  return router
}

module.exports = { createFuturesAssetRouter }
