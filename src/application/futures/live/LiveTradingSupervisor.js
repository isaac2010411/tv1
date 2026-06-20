'use strict'

const { logger } = require('../../../shared/utils/logger')

class LiveTradingSupervisor {
  constructor({
    accountPort,
    userDataStreamAdapter,
    synchronizer,
    portfolioManager,
    realtimeNotifier = null,
    requireUserStream = true,
    reconciliationIntervalMs = 45_000,
  } = {}) {
    if (!accountPort) throw new Error('LiveTradingSupervisor requires accountPort')
    if (!portfolioManager) throw new Error('LiveTradingSupervisor requires portfolioManager')
    this.accountPort = accountPort
    this.userDataStreamAdapter = userDataStreamAdapter
    this.synchronizer = synchronizer
    this.portfolioManager = portfolioManager
    this.realtimeNotifier = realtimeNotifier
    this.requireUserStream = requireUserStream
    this.reconciliationIntervalMs = reconciliationIntervalMs
    this._ready = false
    this._timer = null
  }

  isReady() {
    return this._ready
  }

  async start() {
    this._ready = false
    try {
      await this.bootstrap()
      if (this.userDataStreamAdapter) {
        this.userDataStreamAdapter.start({
          onAccountUpdate: (update) => this.synchronizer?.handleAccountUpdate(update),
          onOrderUpdate: (update) => this.synchronizer?.handleOrderTradeUpdate(update),
          onStatus: (status) => this.realtimeNotifier?.emitOrderLifecycle?.({ type: 'USER_STREAM', ...status }),
        })
      } else if (this.requireUserStream) {
        throw new Error('User data stream is required for live trading')
      }
      this._ready = true
      this._emitLifecycle('LIVE_READY')
      this._scheduleReconciliation()
      logger.info('[LiveTradingSupervisor] live trading ready')
    } catch (err) {
      this._ready = false
      this._emitLifecycle('LIVE_NOT_READY', err.message)
      logger.error(`[LiveTradingSupervisor] start failed: ${err.message}`)
      if (this.requireUserStream) throw err
    }
  }

  stop() {
    this._ready = false
    if (this._timer) clearInterval(this._timer)
    this._timer = null
    this.userDataStreamAdapter?.stop?.()
    this._emitLifecycle('LIVE_STOPPED')
  }

  async bootstrap() {
    const snapshot = await this.accountPort.getAccountSnapshot()
    this.portfolioManager.applyExchangeAccountSnapshot(snapshot)
    this.realtimeNotifier?.emitPortfolioSnapshot?.(this.portfolioManager.getLiveSnapshot())
    return snapshot
  }

  async resync() {
    const before = this.portfolioManager.getLiveSnapshot()
    const snapshot = await this.bootstrap()
    const after = this.portfolioManager.getLiveSnapshot()
    if (JSON.stringify(before.liveSummary) !== JSON.stringify(after.liveSummary)) {
      this._emitLifecycle('LIVE_RECONCILED')
    }
    return snapshot
  }

  _scheduleReconciliation() {
    if (this._timer || !Number.isFinite(this.reconciliationIntervalMs) || this.reconciliationIntervalMs <= 0) return
    this._timer = setInterval(() => {
      this.resync().catch((err) => {
        this._ready = false
        this._emitLifecycle('LIVE_NOT_READY', err.message)
        logger.warn(`[LiveTradingSupervisor] reconciliation failed: ${err.message}`)
      })
    }, this.reconciliationIntervalMs)
    if (this._timer.unref) this._timer.unref()
  }

  _emitLifecycle(status, reason = null) {
    this.realtimeNotifier?.emitOrderLifecycle?.({
      type: 'LIVE_SUPERVISOR',
      status,
      reason,
      timestamp: Date.now(),
    })
  }
}

module.exports = { LiveTradingSupervisor }
