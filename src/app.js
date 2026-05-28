'use strict'

const express = require('express')
const cors = require('cors')
const http = require('http')
const { Server } = require('socket.io')
const Binance = require('binance-api-node').default
const dotenv = require('dotenv')

const { buildFuturesContainer } = require('./composition-root/futuresContainer')
const { loadRuntimeConfig } = require('./config/runtimeConfig')
const { logger } = require('./shared/utils/logger')
const { connectMongo, isMongoConnected, disconnectMongo } = require('./infrastructure/db/mongoose')
const { MongoTradingPersistenceService } = require('./infrastructure/persistence/MongoTradingPersistenceService')
const { registry, startMemorySampler, stopMemorySampler } = require('./infrastructure/observability/metrics')
const { startGcObserver, stopGcObserver } = require('./infrastructure/observability/gcObserver')

dotenv.config()

const runtimeConfig = loadRuntimeConfig(process.env)

/**
 * Factory that builds the Express app and HTTP server with Socket.IO attached.
 * Exported as a factory so it can be reused in tests (call createApp() instead
 * of importing a singleton).
 *
 * @returns {{ app: import('express').Application, httpServer: import('http').Server, io: import('socket.io').Server }}
 */
const createApp = async () => {
  const app = express()
  const httpServer = http.createServer(app)
  const io = new Server(httpServer, {
    cors: runtimeConfig.corsOptions,
    pingInterval: 10000,
    pingTimeout: 60000,
    // Phase 2: opt-in WS payload compression. Default off because compression
    // adds CPU on every emit; enable on bandwidth-constrained deployments via
    // SOCKETIO_DEFLATE=true.
    perMessageDeflate: process.env.SOCKETIO_DEFLATE === 'true'
      ? { threshold: 1024, zlibDeflateOptions: { level: 1 } }
      : false,
  })

  // ── Global middleware ──────────────────────────────────────────────────────
  app.use(cors(runtimeConfig.corsOptions))
  app.use(express.json())

  // ── Binance client ─────────────────────────────────────────────────────────
  const binanceClient = Binance({
    apiKey: runtimeConfig.binance.apiKey,
    apiSecret: runtimeConfig.binance.apiSecret,
  })

  logger.info(`[Runtime] mode=${runtimeConfig.tradingMode} env=${runtimeConfig.nodeEnv}`)

  // ── Observability (started before any heavy work so we capture startup GC) ─
  startGcObserver()
  startMemorySampler({ intervalMs: 5_000 })

  await connectMongo(runtimeConfig.mongo)
  const persistence = isMongoConnected() ? new MongoTradingPersistenceService() : null

  // ── Composition root ───────────────────────────────────────────────────────
  const {
    futuresRouter,
    riskRouter,
    orderRouter,
    portfolioRouter,
    socketAdapter,
    realtimePort,
    portfolioManager,
  } = buildFuturesContainer({
    binanceClient,
    io,
    tradingPersistence: persistence,
    scalpConfig: runtimeConfig.scalp,
  })

  // Replay cumulative paper-trading PnL from MongoDB so the virtual $10k cap
  // continues from wherever the last session left it (instead of resetting to
  // the starting equity on every restart).
  try {
    await portfolioManager.bootstrapPaperFromPersistence({
      startingEquity: runtimeConfig.scalp?.account?.equity ?? 10_000,
    })
  } catch (err) {
    logger.warn(`[Startup] bootstrap paper account failed: ${err.message}`)
  }

  // ── HTTP routes ────────────────────────────────────────────────────────────
  app.use('/api/futures', futuresRouter)
  app.use('/api/futures/risk', riskRouter)
  app.use('/api/futures/orders', orderRouter)
  app.use('/api/futures/portfolio', portfolioRouter)

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      tradingMode: runtimeConfig.tradingMode,
      environment: runtimeConfig.nodeEnv,
      timestamp: new Date().toISOString(),
    })
  })

  // JSON metrics snapshot. Cheap to call (no formatting), suitable for a sidecar
  // exporter or quick eyeballing during development. Migrate to a Prometheus
  // text-format exposition by replacing the metrics module surface.
  app.get('/metrics', (_req, res) => {
    res.json(registry.snapshot())
  })

  // ── Socket.IO ──────────────────────────────────────────────────────────────
  io.on('connection', (socket) => {
    logger.info(`[Socket.IO] Client connected: ${socket.id}`)

    socket.on('error', (error) => {
      logger.error(`[Socket.IO] Socket error ${socket.id}`, error)
    })

    socketAdapter.register(socket)

    socket.on('disconnect', (reason) => {
      logger.info(`[Socket.IO] Client disconnected: ${socket.id} (${reason})`)
    })
  })

  /**
   * Graceful shutdown: closes the HTTP server (stops accepting new
   * connections), all Socket.IO clients, every Binance WS stream, the GC
   * observer + memory sampler, and the Mongo connection. Idempotent.
   */
  const shutdown = async () => {
    try {
      stopMemorySampler()
      stopGcObserver()
      try {
        await realtimePort.disposeAll?.()
      } catch (err) {
        logger.warn(`[Shutdown] realtime dispose error: ${err.message}`)
      }
      try {
        socketAdapter.dispose?.()
      } catch (err) {
        logger.warn(`[Shutdown] socket adapter dispose error: ${err.message}`)
      }
      try {
        await persistence?.dispose?.()
      } catch (err) {
        logger.warn(`[Shutdown] persistence dispose error: ${err.message}`)
      }
      io.disconnectSockets(true)
      await new Promise((resolve) => io.close(() => resolve()))
      await new Promise((resolve) => httpServer.close(() => resolve()))
      try {
        await disconnectMongo()
      } catch (err) {
        logger.warn(`[Shutdown] mongo disconnect error: ${err.message}`)
      }
      logger.info('[Shutdown] complete')
    } catch (err) {
      logger.error(`[Shutdown] error: ${err.message}`)
    }
  }

  return { app, httpServer, io, shutdown }
}

module.exports = { createApp }
