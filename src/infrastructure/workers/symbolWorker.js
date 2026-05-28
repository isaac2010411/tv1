'use strict'

/**
 * SymbolWorker (skeleton, Phase 3).
 *
 * Runs inside a `worker_threads` context. Owns its own Binance WS connection
 * and per-symbol services (LocalOrderBookEngine, Spoofing, LiquidityShift,
 * CVD, Footprint, SignalEngine). Publishes ready-to-emit frames back to the
 * main thread via `parentPort.postMessage`.
 *
 * This file is intentionally a STUB to lock down the protocol shape and
 * allow the pool wiring to be built. Wire the real services in a follow-up
 * once Phase 3 is approved for activation; the migration is mechanical:
 *
 *   1. Move the `_initSymbolServices` body from FuturesAssetSocketAdapter
 *      into `_handleSubscribe` below (drop the io / room concept; replace
 *      `this._emitToRoom(room, evt, payload, meta)` with `_post('EMIT',
 *      { room, event: evt, payload, meta })`).
 *   2. Move the depth queue + drain logic alongside.
 *   3. Keep `PaperTradeService` in the main thread — workers only emit
 *      MARK_PRICE; main applies them to the paper engine.
 *
 * Activation gate: only spawned when REALTIME_MODE=workerPool.
 */

const { parentPort, workerData } = require('worker_threads')
const { MAIN_TO_WORKER, WORKER_TO_MAIN } = require('./protocol')

if (!parentPort) {
  throw new Error('SymbolWorker must be loaded as a worker_thread')
}

const workerId = workerData?.workerId ?? 'unknown'
const subscriptions = new Map() // symbol → { intervals, tickSize, services... }

function post(type, body = {}) {
  parentPort.postMessage({ type, ...body })
}

function handleSubscribe({ symbol, tickSize, intervals }) {
  if (subscriptions.has(symbol)) return
  subscriptions.set(symbol, { tickSize, intervals })
  // TODO Phase 3.2: instantiate LocalOrderBookEngine + service bundle here
  // and open the Binance WS for `symbol`. For now we just acknowledge.
  post(WORKER_TO_MAIN.HEALTH, { symbol, snapshot: { status: 'subscribed' } })
}

function handleUnsubscribe({ symbol }) {
  if (!subscriptions.has(symbol)) return
  // TODO Phase 3.2: dispose services + close WS
  subscriptions.delete(symbol)
  post(WORKER_TO_MAIN.HEALTH, { symbol, snapshot: { status: 'unsubscribed' } })
}

function handleShutdown() {
  for (const symbol of Array.from(subscriptions.keys())) {
    handleUnsubscribe({ symbol })
  }
  parentPort.close()
}

parentPort.on('message', (msg) => {
  try {
    switch (msg?.type) {
      case MAIN_TO_WORKER.SUBSCRIBE:   return handleSubscribe(msg)
      case MAIN_TO_WORKER.UNSUBSCRIBE: return handleUnsubscribe(msg)
      case MAIN_TO_WORKER.SET_CONFIG:  return  // reserved
      case MAIN_TO_WORKER.SHUTDOWN:    return handleShutdown()
      default:
        post(WORKER_TO_MAIN.ERROR, { message: `Unknown msg type: ${msg?.type}` })
    }
  } catch (err) {
    post(WORKER_TO_MAIN.ERROR, { message: err.message, stack: err.stack })
  }
})

post(WORKER_TO_MAIN.READY, { workerId })
