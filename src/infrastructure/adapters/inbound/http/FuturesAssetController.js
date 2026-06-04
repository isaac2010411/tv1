'use strict'

const { DomainError } = require('../../../../shared/errors/DomainError')
const { ApplicationError } = require('../../../../shared/errors/ApplicationError')
const { InfrastructureError } = require('../../../../shared/errors/InfrastructureError')
const { assertAssetContext } = require('../../../../shared/contracts/AssetContextContract')
const { logger } = require('../../../../shared/utils/logger')
const { metrics } = require('../../../observability/metrics')

/**
 * Inbound HTTP adapter: handles Express requests for futures asset endpoints.
 *
 * Rules:
 * – No Binance calls here. Only use cases are invoked.
 * – No trading logic here. Only input validation and error mapping.
 * – Domain errors  → 422 Unprocessable Entity
 * – Application errors → 400 Bad Request
 * – Infrastructure errors → 502 Bad Gateway
 */
class FuturesAssetController {
  /**
   * @param {object} deps
   * @param {import('../../../../application/futures/use-cases/GetFuturesAssetContext').GetFuturesAssetContext}   deps.getAssetContextUseCase
   * @param {import('../../../../application/futures/use-cases/ValidateFuturesOrder').ValidateFuturesOrder}       deps.validateOrderUseCase
   * @param {import('../../../../domain/futures/ports/outbound/FuturesMarketDataPort').FuturesMarketDataPort}     deps.marketDataPort
   */
  constructor({
    getAssetContextUseCase,
    validateOrderUseCase,
    marketDataPort,
    socketAdapter,
    tradingPersistence = null,
  }) {
    this.getAssetContextUseCase = getAssetContextUseCase
    this.validateOrderUseCase = validateOrderUseCase
    this.marketDataPort = marketDataPort
    this.socketAdapter = socketAdapter // optional; used for health endpoint
    this.tradingPersistence = tradingPersistence
  }

  /**
   * GET /api/futures/assets/:symbol/context
   * @deprecated Use Socket.IO bootstrap event futures:asset:context after
   * futures:asset:subscribe. Kept temporarily for backward compatibility.
   */
  async getAssetContext(req, res) {
    const { symbol } = req.params

    if (!symbol || typeof symbol !== 'string') {
      return res.status(400).json({ error: 'symbol param is required' })
    }

    // Explicit deprecation signal for clients and observability.
    if (typeof res.set === 'function') {
      res.set('Deprecation', 'true')
      res.set('Sunset', '2026-12-31')
    }
    metrics.assetContextRestDeprecatedHits.inc({})
    logger.warn(`[DEPRECATED_REST_ASSET_CONTEXT] symbol=${symbol.trim().toUpperCase()}`)

    try {
      const context = await this.getAssetContextUseCase.execute({ symbol })
      assertAssetContext(context, { channel: 'rest' })
      return res.json(context)
    } catch (err) {
      return this._handleError(res, err)
    }
  }

  /**
   * POST /api/futures/assets/:symbol/validate-order
   * Body: { side, type, quantity, price?, reduceOnly? }
   */
  async validateOrder(req, res) {
    const { symbol } = req.params
    const { side, type, quantity, price, reduceOnly } = req.body

    try {
      const result = await this.validateOrderUseCase.execute({
        symbol,
        side,
        type,
        quantity,
        price,
        reduceOnly,
      })
      return res.json(result)
    } catch (err) {
      return this._handleError(res, err)
    }
  }

  /**
   * GET /api/futures/candles?symbol=BTCUSDT&interval=1m&limit=30
   */
  async getCandles(req, res) {
    const { symbol, interval = '1m', limit = 100 } = req.query

    if (!symbol || typeof symbol !== 'string') {
      return res.status(400).json({ error: 'symbol query param is required' })
    }

    const parsedLimit = Math.min(parseInt(limit, 10) || 100, 1000)

    try {
      const candles = await this.marketDataPort.getCandles(symbol.trim().toUpperCase(), interval, parsedLimit)
      return res.json(candles)
    } catch (err) {
      return this._handleError(res, err)
    }
  }

  /**
   * GET /api/futures/footprint?symbol=BTCUSDT&interval=1m&limit=50
   * Returns approximate footprint candle history built from kline data.
   */
  async getFootprintHistory(req, res) {
    const { symbol, interval = '1m', limit = 50 } = req.query

    if (!symbol || typeof symbol !== 'string') {
      return res.status(400).json({ error: 'symbol query param is required' })
    }

    const parsedLimit = Math.min(parseInt(limit, 10) || 50, 200)

    try {
      const footprints = await this.marketDataPort.getFootprintHistory(
        symbol.trim().toUpperCase(),
        interval,
        parsedLimit,
      )
      return res.json(footprints)
    } catch (err) {
      return this._handleError(res, err)
    }
  }

  // ─── Error mapping ───────────────────────────────────────────────────────────

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
    // Unexpected errors – do not leak internal details
    return res.status(500).json({ error: 'Internal server error' })
  }

  /**
   * GET /api/futures/assets/:symbol/health
   * Returns market-data health for a locally-reconstructed order book.
   */
  async getMarketDataHealth(req, res) {
    const { symbol } = req.params

    if (!symbol || typeof symbol !== 'string') {
      return res.status(400).json({ error: 'symbol param is required' })
    }

    if (!this.socketAdapter) {
      return res.status(503).json({ error: 'Health data not available' })
    }

    const health = this.socketAdapter.getSymbolHealth(symbol.trim().toUpperCase())
    if (!health) {
      return res.status(404).json({ error: `No active subscription for ${symbol.toUpperCase()}` })
    }

    return res.json(health)
  }

  /**
   * GET /api/futures/paper-positions?symbol=BTCUSDT&status=OPEN&from=...&to=...&limit=100&page=1
   */
  async getPaperPositions(req, res) {
    if (!this.tradingPersistence) {
      return res.status(503).json({ error: 'Persistence is not available' })
    }

    const { symbol, userId, status, from, to, limit = 100, page = 1 } = req.query

    try {
      const result = await this.tradingPersistence.listPaperPositions({
        symbol,
        userId,
        status,
        from,
        to,
        limit,
        page,
      })
      return res.json(result)
    } catch (err) {
      return this._handleError(res, err)
    }
  }

  /**
   * GET /api/futures/signal-history?symbol=BTCUSDT&state=LONG_ENTRY_SIGNAL&decision=SIGNAL_UPDATE
   */
  async getSignalHistory(req, res) {
    if (!this.tradingPersistence) {
      return res.status(503).json({ error: 'Persistence is not available' })
    }

    const { symbol, state, decision, from, to, limit = 100, page = 1 } = req.query

    try {
      const result = await this.tradingPersistence.listSignalHistory({
        symbol,
        state,
        decision,
        from,
        to,
        limit,
        page,
      })
      return res.json(result)
    } catch (err) {
      return this._handleError(res, err)
    }
  }

  /**
   * GET /api/futures/session-candles?symbol=BTCUSDT&interval=1m&from=...&to=...
   */
  async getSessionCandles(req, res) {
    if (!this.tradingPersistence) {
      return res.status(503).json({ error: 'Persistence is not available' })
    }

    const { sessionId = 'default', symbol, interval = '1m', from, to, limit = 100, page = 1 } = req.query

    try {
      const result = await this.tradingPersistence.listSessionCandles({
        sessionId,
        symbol,
        interval,
        from,
        to,
        limit,
        page,
      })
      return res.json(result)
    } catch (err) {
      return this._handleError(res, err)
    }
  }
}

module.exports = { FuturesAssetController }
