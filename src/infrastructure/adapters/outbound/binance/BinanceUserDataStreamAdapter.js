'use strict'

const { EventEmitter } = require('events')
const { logger } = require('../../../../shared/utils/logger')
const { mapAccountUpdate } = require('./mappers/mapAccountUpdate')
const { mapOrderTradeUpdate } = require('./mappers/mapOrderTradeUpdate')

class BinanceUserDataStreamAdapter extends EventEmitter {
  constructor({ binanceClient }) {
    super()
    if (!binanceClient) throw new Error('BinanceUserDataStreamAdapter requires binanceClient')
    this.client = binanceClient
    this._close = null
    this._status = 'STOPPED'
  }

  status() {
    return this._status
  }

  _setStatus(status, detail = null) {
    this._status = status
    this.emit('status', { status, detail, timestamp: Date.now() })
  }

  start({ onAccountUpdate, onOrderUpdate, onStatus } = {}) {
    if (this._close) return this._close
    if (onAccountUpdate) this.on('accountUpdate', onAccountUpdate)
    if (onOrderUpdate) this.on('orderTradeUpdate', onOrderUpdate)
    if (onStatus) this.on('status', onStatus)

    try {
      this._close = this.client.ws.futuresUser((payload) => {
        try {
          const eventType = payload?.eventType ?? payload?.e
          if (eventType === 'ACCOUNT_UPDATE') {
            this.emit('accountUpdate', mapAccountUpdate(payload))
          } else if (eventType === 'ORDER_TRADE_UPDATE') {
            this.emit('orderTradeUpdate', mapOrderTradeUpdate(payload))
          }
        } catch (err) {
          logger.warn(`[UserDataStream] event mapping failed: ${err.message}`)
          this.emit('error', err)
        }
      })
      this._setStatus('CONNECTED')
      logger.info('[UserDataStream] Binance futures user stream connected')
      return this._close
    } catch (err) {
      this._setStatus('ERROR', err.message)
      throw err
    }
  }

  stop() {
    if (!this._close) return
    try {
      if (typeof this._close === 'function') this._close()
    } catch (err) {
      logger.warn(`[UserDataStream] stop failed: ${err.message}`)
    } finally {
      this._close = null
      this._setStatus('STOPPED')
    }
  }
}

module.exports = { BinanceUserDataStreamAdapter }
