'use strict'

const { createApp } = require('./app')
const { logger } = require('./shared/utils/logger')

const PORT = process.env.PORT || 5000
const SHUTDOWN_TIMEOUT_MS = Number(process.env.SHUTDOWN_TIMEOUT_MS ?? 10_000)

const bootstrap = async () => {
  const { httpServer, shutdown } = await createApp()
  httpServer.listen(PORT, () => {
    logger.info(`Server running on port ${PORT}`)
  })

  let shuttingDown = false
  const handleSignal = (signal) => async () => {
    if (shuttingDown) return
    shuttingDown = true
    logger.info(`[Signal] ${signal} received — initiating graceful shutdown`)

    // Hard exit fallback if shutdown hangs (e.g. a stuck WS close)
    const forceExit = setTimeout(() => {
      logger.error(`[Shutdown] timeout after ${SHUTDOWN_TIMEOUT_MS}ms — forcing exit`)
      process.exit(1)
    }, SHUTDOWN_TIMEOUT_MS)
    if (forceExit.unref) forceExit.unref()

    try {
      await shutdown()
      clearTimeout(forceExit)
      process.exit(0)
    } catch (err) {
      logger.error(`[Shutdown] failed: ${err.message}`)
      process.exit(1)
    }
  }

  process.once('SIGTERM', handleSignal('SIGTERM'))
  process.once('SIGINT', handleSignal('SIGINT'))

  process.on('uncaughtException', (err) => {
    logger.error(`[uncaughtException] ${err.stack ?? err.message}`)
  })
  process.on('unhandledRejection', (reason) => {
    logger.error(`[unhandledRejection] ${reason instanceof Error ? reason.stack : String(reason)}`)
  })
}

bootstrap().catch((err) => {
  logger.error(`Failed to start server: ${err.message}`)
  process.exit(1)
})
