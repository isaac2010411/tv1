'use strict'

/**
 * Outbound port (interface): real-time WebSocket streams for futures data.
 *
 * Implementations handle connection lifecycle, reconnection, and mapping of
 * raw WebSocket frames to plain objects before invoking handlers.
 */
class FuturesRealtimePort {
  /**
   * Opens all required streams for `symbol` and calls the provided handlers
   * as new data arrives.  Implementations must be idempotent: calling
   * subscribeSymbol twice for the same symbol should be a no-op.
   *
   * @param {string} symbol
   * @param {{
   *   onTicker?:    (data: object) => void,
   *   onMarkPrice?: (data: object) => void,
   *   onOrderBook?: (data: object) => void,
   *   onDiffDepth?: (data: object) => void,
   *   onCandle?:    (data: object) => void,
   *   onTrade?:     (data: object) => void,
   *   intervals?:   string[]
   * }} handlers
   * @returns {Promise<void>}
   */
  // eslint-disable-next-line no-unused-vars
  async subscribeSymbol(symbol, handlers) { throw new Error('Not implemented: subscribeSymbol') }

  /**
   * Closes all streams for `symbol`.
   * @param {string} symbol
   * @returns {Promise<void>}
   */
  // eslint-disable-next-line no-unused-vars
  async unsubscribeSymbol(symbol) { throw new Error('Not implemented: unsubscribeSymbol') }

  /**
   * Subscribes to the authenticated user-data stream.
   * @param {{ onAccountUpdate?: Function, onOrderUpdate?: Function }} handlers
   * @returns {Promise<void>}
   */
  // eslint-disable-next-line no-unused-vars
  async subscribeUserData(handlers) { throw new Error('Not implemented: subscribeUserData') }
}

module.exports = { FuturesRealtimePort }
