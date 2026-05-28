'use strict'

/**
 * Worker protocol — message contracts between main thread and SymbolWorker.
 *
 * Wire format is JSON over `MessagePort` (postMessage). Binary payloads via
 * SharedArrayBuffer are reserved for Phase 3.2 (book snapshots).
 *
 * Main → Worker:
 *   { type: 'SUBSCRIBE',   symbol, tickSize, intervals }
 *   { type: 'UNSUBSCRIBE', symbol }
 *   { type: 'SET_CONFIG',  patch: { ... } }
 *   { type: 'SHUTDOWN' }
 *
 * Worker → Main:
 *   { type: 'EMIT',        room, event, payload, meta? }
 *   { type: 'HEALTH',      symbol, snapshot }
 *   { type: 'METRICS',     snapshot }              // periodic
 *   { type: 'READY' }                              // worker has booted
 *   { type: 'ERROR',       symbol?, message, stack? }
 */

const MAIN_TO_WORKER = Object.freeze({
  SUBSCRIBE:   'SUBSCRIBE',
  UNSUBSCRIBE: 'UNSUBSCRIBE',
  SET_CONFIG:  'SET_CONFIG',
  SHUTDOWN:    'SHUTDOWN',
})

const WORKER_TO_MAIN = Object.freeze({
  EMIT:    'EMIT',
  HEALTH:  'HEALTH',
  METRICS: 'METRICS',
  READY:   'READY',
  ERROR:   'ERROR',
})

module.exports = { MAIN_TO_WORKER, WORKER_TO_MAIN }
