'use strict'

/**
 * Per-room emit coalescer.
 *
 * Accumulates payloads for high-frequency events (TRADE_AGG, MARK_PRICE, CVD)
 * and flushes them as a single batched emit on a fixed cadence (default 50 ms).
 * Reduces socket.io frame overhead when many small events fire in a tight
 * window — particularly useful when EMIT_BATCH_MODE=true is enabled.
 *
 * Lifecycle:
 *   - enqueue(room, event, payload)  — buffer one item
 *   - dispose()                      — stop all timers and drop buffers
 *
 * The caller (FuturesAssetSocketAdapter) wires this in front of `_emitToRoom`
 * for events listed in `BATCHABLE_EVENTS`. Non-batchable events bypass the
 * coalescer and emit immediately.
 */
class EmitCoalescer {
  /**
   * @param {object} opts
   * @param {(room: string, event: string, payload: unknown) => void} opts.emit
   *   Synchronous emit function (typically `this._emitToRoom` bound).
   * @param {Map<string, string>} opts.batchEventMap
   *   Map of single-event-name → batch-event-name.
   * @param {number} [opts.windowMs] default 50
   */
  constructor({ emit, batchEventMap, windowMs = 50 } = {}) {
    if (typeof emit !== 'function') throw new TypeError('emit fn required')
    if (!(batchEventMap instanceof Map)) throw new TypeError('batchEventMap Map required')
    this._emit = emit
    this._batchEventMap = batchEventMap
    this._windowMs = windowMs
    // room → event → payload[]
    this._buffers = new Map()
    this._timer = null
    this._disposed = false
  }

  enqueue(room, event, payload) {
    if (this._disposed) return false
    const batchEvent = this._batchEventMap.get(event)
    if (!batchEvent) return false

    let roomBuf = this._buffers.get(room)
    if (!roomBuf) {
      roomBuf = new Map()
      this._buffers.set(room, roomBuf)
    }
    let eventBuf = roomBuf.get(batchEvent)
    if (!eventBuf) {
      eventBuf = []
      roomBuf.set(batchEvent, eventBuf)
    }
    eventBuf.push(payload)
    this._scheduleFlush()
    return true
  }

  _scheduleFlush() {
    if (this._timer) return
    this._timer = setTimeout(() => {
      this._timer = null
      this._flush()
    }, this._windowMs)
    if (this._timer.unref) this._timer.unref()
  }

  _flush() {
    if (this._disposed) return
    for (const [room, roomBuf] of this._buffers) {
      for (const [batchEvent, items] of roomBuf) {
        if (items.length === 0) continue
        try {
          this._emit(room, batchEvent, items)
        } catch {
          // Emit errors are recorded by _emitToRoom itself; swallow here so a
          // single bad room doesn't poison the whole batch window.
        }
      }
    }
    this._buffers.clear()
  }

  dispose() {
    this._disposed = true
    if (this._timer) {
      clearTimeout(this._timer)
      this._timer = null
    }
    this._buffers.clear()
  }
}

module.exports = { EmitCoalescer }
