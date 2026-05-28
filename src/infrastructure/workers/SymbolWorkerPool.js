'use strict'

const path = require('path')
const { Worker } = require('worker_threads')
const os = require('os')
const { logger } = require('../../shared/utils/logger')
const { MAIN_TO_WORKER, WORKER_TO_MAIN } = require('./protocol')

/**
 * SymbolWorkerPool (skeleton, Phase 3).
 *
 * Manages N worker threads, each handling a sticky subset of symbols
 * (consistent hashing). The pool exposes the same surface the in-process
 * adapter uses today, so the composition root can swap implementations via
 * the REALTIME_MODE env flag without other code changing.
 *
 * Default size: `min(cpus - 1, max(1, ceil(symbols / 4)))`. Override via
 * `WORKER_POOL_SIZE` env.
 *
 * Not wired into the container yet — flip REALTIME_MODE=workerPool once the
 * SymbolWorker stub is replaced with the real implementation.
 */
class SymbolWorkerPool {
  /**
   * @param {object} opts
   * @param {(msg: { room: string, event: string, payload: unknown, meta?: object }) => void} opts.onEmit
   *   Callback invoked when a worker publishes a frame ready to emit.
   * @param {number} [opts.size]
   */
  constructor({ onEmit, size } = {}) {
    if (typeof onEmit !== 'function') throw new TypeError('onEmit fn required')
    this._onEmit = onEmit
    this._size = Math.max(1, size ?? Number(process.env.WORKER_POOL_SIZE ?? Math.max(1, os.cpus().length - 1)))
    /** @type {{ worker: Worker, symbols: Set<string>, ready: boolean }[]} */
    this._workers = []
    this._symbolToIndex = new Map()
    this._disposed = false
  }

  start() {
    if (this._workers.length > 0) return
    const workerPath = path.join(__dirname, 'symbolWorker.js')
    for (let i = 0; i < this._size; i++) {
      const worker = new Worker(workerPath, { workerData: { workerId: i } })
      const entry = { worker, symbols: new Set(), ready: false }
      worker.on('message', (msg) => this._onWorkerMessage(i, msg))
      worker.on('error', (err) => logger.error(`[WorkerPool] worker ${i} error: ${err.message}`))
      worker.on('exit', (code) => {
        if (!this._disposed) {
          logger.warn(`[WorkerPool] worker ${i} exited (code=${code})`)
        }
      })
      this._workers.push(entry)
    }
    logger.info(`[WorkerPool] started size=${this._size}`)
  }

  _onWorkerMessage(index, msg) {
    switch (msg?.type) {
      case WORKER_TO_MAIN.READY:
        this._workers[index].ready = true
        return
      case WORKER_TO_MAIN.EMIT:
        return this._onEmit(msg)
      case WORKER_TO_MAIN.HEALTH:
      case WORKER_TO_MAIN.METRICS:
        return // TODO: aggregate into central /metrics
      case WORKER_TO_MAIN.ERROR:
        logger.warn(`[WorkerPool] worker ${index} reported error: ${msg.message}`)
        return
      default:
        logger.warn(`[WorkerPool] unknown msg from worker ${index}: ${msg?.type}`)
    }
  }

  _pickWorker(symbol) {
    if (this._symbolToIndex.has(symbol)) return this._symbolToIndex.get(symbol)
    // Stable hash → consistent placement
    let h = 0
    for (let i = 0; i < symbol.length; i++) h = (h * 31 + symbol.charCodeAt(i)) | 0
    const idx = Math.abs(h) % this._workers.length
    this._symbolToIndex.set(symbol, idx)
    return idx
  }

  subscribeSymbol(symbol, tickSize, intervals) {
    const idx = this._pickWorker(symbol)
    const entry = this._workers[idx]
    entry.symbols.add(symbol)
    entry.worker.postMessage({ type: MAIN_TO_WORKER.SUBSCRIBE, symbol, tickSize, intervals })
  }

  unsubscribeSymbol(symbol) {
    const idx = this._symbolToIndex.get(symbol)
    if (idx == null) return
    const entry = this._workers[idx]
    entry.symbols.delete(symbol)
    entry.worker.postMessage({ type: MAIN_TO_WORKER.UNSUBSCRIBE, symbol })
    this._symbolToIndex.delete(symbol)
  }

  async dispose() {
    this._disposed = true
    await Promise.all(this._workers.map(async (entry) => {
      try {
        entry.worker.postMessage({ type: MAIN_TO_WORKER.SHUTDOWN })
        await entry.worker.terminate()
      } catch (err) {
        logger.warn(`[WorkerPool] terminate error: ${err.message}`)
      }
    }))
    this._workers = []
    this._symbolToIndex.clear()
  }
}

module.exports = { SymbolWorkerPool }
