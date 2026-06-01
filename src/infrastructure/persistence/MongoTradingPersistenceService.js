'use strict'

const { isMongoConnected } = require('../db/mongoose')
const { PaperPositionModel } = require('./mongoose/models/PaperPositionModel')
const { SignalHistoryModel } = require('./mongoose/models/SignalHistoryModel')
const { SessionCandleModel } = require('./mongoose/models/SessionCandleModel')
const { logger } = require('../../shared/utils/logger')
const { metrics } = require('../observability/metrics')

// Phase 4 — buffered writes. SignalHistory is high-frequency (~1–5 writes/s
// per active symbol); we batch them into insertMany. PaperPosition upserts go
// through bulkWrite so multiple symbols sharing a tick collapse into one
// round-trip. Buffers flush on size threshold or on a fixed cadence.
const SIGNAL_BUFFER_MAX = Number(process.env.MONGO_SIGNAL_BUFFER_MAX ?? 50)
const SIGNAL_FLUSH_INTERVAL_MS = Number(process.env.MONGO_SIGNAL_FLUSH_MS ?? 500)
const POSITION_BUFFER_MAX = Number(process.env.MONGO_POSITION_BUFFER_MAX ?? 25)
const POSITION_FLUSH_INTERVAL_MS = Number(process.env.MONGO_POSITION_FLUSH_MS ?? 250)
const SESSION_CANDLE_BUFFER_MAX = Number(process.env.MONGO_SESSION_CANDLE_BUFFER_MAX ?? 50)
const SESSION_CANDLE_FLUSH_INTERVAL_MS = Number(process.env.MONGO_SESSION_CANDLE_FLUSH_MS ?? 500)

class MongoTradingPersistenceService {
  constructor() {
    this._signalBuffer = []
    this._signalFlushTimer = null
    this._positionBuffer = new Map() // positionId → latest doc (last-write-wins)
    this._positionFlushTimer = null
    this._sessionCandleBuffer = new Map()
    this._sessionCandleFlushTimer = null
    this._disposed = false
  }

  isEnabled() {
    return isMongoConnected()
  }

  async savePaperPosition(position) {
    if (!this.isEnabled() || !position?.id) return null

    const doc = {
      positionId: position.id,
      userId: position.userId ?? null,
      symbol: position.symbol,
      direction: position.direction,
      entryPrice: position.entryPrice,
      quantity: position.quantity ?? null,
      stopLoss: position.stopLoss ?? null,
      takeProfit: position.takeProfit ?? null,
      openedAt: position.openedAt,
      closedAt: position.closedAt ?? null,
      status: position.status,
      sourceSignalId: position.sourceSignalId ?? null,
      currentPrice: position.currentPrice ?? null,
      unrealizedPnl: position.unrealizedPnl ?? null,
      realizedPnl: position.realizedPnl ?? null,
      closeReason: position.closeReason ?? null,
    }

    // Last-write-wins coalescing: multiple updates to the same positionId
    // within the flush window collapse into the latest doc.
    this._positionBuffer.set(position.id, doc)
    if (this._positionBuffer.size >= POSITION_BUFFER_MAX) {
      await this._flushPositions()
    } else {
      this._schedulePositionFlush()
    }
    return doc
  }

  _schedulePositionFlush() {
    if (this._positionFlushTimer || this._disposed) return
    this._positionFlushTimer = setTimeout(() => {
      this._positionFlushTimer = null
      this._flushPositions().catch((err) => this.logPersistError('positions-flush', err))
    }, POSITION_FLUSH_INTERVAL_MS)
    if (this._positionFlushTimer.unref) this._positionFlushTimer.unref()
  }

  async _flushPositions() {
    if (this._positionBuffer.size === 0) return
    const docs = Array.from(this._positionBuffer.values())
    this._positionBuffer.clear()
    const t0 = Date.now()
    try {
      const ops = docs.map((doc) => ({
        updateOne: {
          filter: { positionId: doc.positionId },
          update: { $set: doc },
          upsert: true,
        },
      }))
      await PaperPositionModel.bulkWrite(ops, { ordered: false })
      metrics.mongoWriteMs.observe({ op: 'paperPosition.bulk' }, Date.now() - t0)
    } catch (err) {
      metrics.mongoErrors.inc({ op: 'paperPosition.bulk' })
      throw err
    }
  }

  async saveSignalHistory(entry) {
    if (!this.isEnabled() || !entry?.symbol || !entry?.state) return null
    const doc = {
      timestamp: entry.timestamp ?? Date.now(),
      symbol: entry.symbol,
      interval: entry.interval ?? '1m',
      state: entry.state,
      prevState: entry.prevState ?? null,
      netScore: entry.netScore ?? 0,
      confidence: entry.confidence ?? 0,
      reasons: Array.isArray(entry.reasons) ? entry.reasons : [],
      missingContext: Array.isArray(entry.missingContext) ? entry.missingContext : [],
      decision: entry.decision ?? 'SIGNAL_UPDATE',
      activeSignalId: entry.activeSignalId ?? null,
      positionId: entry.positionId ?? null,
      orderBookSnapshotId: entry.orderBookSnapshotId ?? null,
      cvdSnapshotId: entry.cvdSnapshotId ?? null,
      footprintSnapshotId: entry.footprintSnapshotId ?? null,
      signalRisk: entry.signalRisk ?? null,
      adjustedRisk: entry.adjustedRisk ?? null,
      autoExecution: entry.autoExecution ?? null,
      factorsSummary: entry.factorsSummary ?? null,
    }
    this._signalBuffer.push(doc)
    if (this._signalBuffer.length >= SIGNAL_BUFFER_MAX) {
      await this._flushSignals()
    } else {
      this._scheduleSignalFlush()
    }
    return doc
  }

  async saveSessionCandle(snapshot) {
    if (!this.isEnabled() || !snapshot?.symbol || !snapshot?.interval || snapshot?.openTime == null) return null

    const doc = {
      sessionId: snapshot.sessionId ?? 'default',
      symbol: snapshot.symbol,
      interval: snapshot.interval,
      openTime: Number(snapshot.openTime),
      closeTime: snapshot.closeTime == null ? null : Number(snapshot.closeTime),
      open: snapshot.open == null ? null : String(snapshot.open),
      high: snapshot.high == null ? null : String(snapshot.high),
      low: snapshot.low == null ? null : String(snapshot.low),
      close: snapshot.close == null ? null : String(snapshot.close),
      volume: snapshot.volume == null ? null : String(snapshot.volume),
      isFinal: Boolean(snapshot.isFinal),
      indicators: snapshot.indicators ?? null,
      footprintSummary: snapshot.footprintSummary ?? null,
    }

    const key = `${doc.sessionId}:${doc.symbol}:${doc.interval}:${doc.openTime}`
    this._sessionCandleBuffer.set(key, doc)
    if (this._sessionCandleBuffer.size >= SESSION_CANDLE_BUFFER_MAX) {
      await this._flushSessionCandles()
    } else {
      this._scheduleSessionCandleFlush()
    }
    return doc
  }

  _scheduleSignalFlush() {
    if (this._signalFlushTimer || this._disposed) return
    this._signalFlushTimer = setTimeout(() => {
      this._signalFlushTimer = null
      this._flushSignals().catch((err) => this.logPersistError('signals-flush', err))
    }, SIGNAL_FLUSH_INTERVAL_MS)
    if (this._signalFlushTimer.unref) this._signalFlushTimer.unref()
  }

  async _flushSignals() {
    if (this._signalBuffer.length === 0) return
    const batch = this._signalBuffer
    this._signalBuffer = []
    const t0 = Date.now()
    try {
      await SignalHistoryModel.insertMany(batch, { ordered: false })
      metrics.mongoWriteMs.observe({ op: 'signalHistory.insertMany' }, Date.now() - t0)
    } catch (err) {
      metrics.mongoErrors.inc({ op: 'signalHistory.insertMany' })
      throw err
    }
  }

  _scheduleSessionCandleFlush() {
    if (this._sessionCandleFlushTimer || this._disposed) return
    this._sessionCandleFlushTimer = setTimeout(() => {
      this._sessionCandleFlushTimer = null
      this._flushSessionCandles().catch((err) => this.logPersistError('sessionCandles-flush', err))
    }, SESSION_CANDLE_FLUSH_INTERVAL_MS)
    if (this._sessionCandleFlushTimer.unref) this._sessionCandleFlushTimer.unref()
  }

  async _flushSessionCandles() {
    if (this._sessionCandleBuffer.size === 0) return
    const docs = Array.from(this._sessionCandleBuffer.values())
    this._sessionCandleBuffer.clear()
    const t0 = Date.now()
    try {
      const ops = docs.map((doc) => ({
        updateOne: {
          filter: {
            sessionId: doc.sessionId,
            symbol: doc.symbol,
            interval: doc.interval,
            openTime: doc.openTime,
          },
          update: { $set: doc },
          upsert: true,
        },
      }))
      await SessionCandleModel.bulkWrite(ops, { ordered: false })
      metrics.mongoWriteMs.observe({ op: 'sessionCandle.bulk' }, Date.now() - t0)
    } catch (err) {
      metrics.mongoErrors.inc({ op: 'sessionCandle.bulk' })
      throw err
    }
  }

  /**
   * Force-flush all buffered writes. Call on shutdown.
   */
  async flush() {
    const tasks = []
    if (this._signalBuffer.length > 0) tasks.push(this._flushSignals())
    if (this._positionBuffer.size > 0) tasks.push(this._flushPositions())
    if (this._sessionCandleBuffer.size > 0) tasks.push(this._flushSessionCandles())
    await Promise.allSettled(tasks)
  }

  async dispose() {
    this._disposed = true
    if (this._signalFlushTimer) clearTimeout(this._signalFlushTimer)
    if (this._positionFlushTimer) clearTimeout(this._positionFlushTimer)
    if (this._sessionCandleFlushTimer) clearTimeout(this._sessionCandleFlushTimer)
    this._signalFlushTimer = null
    this._positionFlushTimer = null
    this._sessionCandleFlushTimer = null
    await this.flush()
  }

  async listPaperPositions({ symbol, userId, status, from, to, limit = 100, page = 1 }) {
    if (!this.isEnabled()) return { items: [], total: 0, page, limit }

    // Flush pending buffered writes so reads see the latest state.
    await this._flushPositions().catch(() => {})

    const q = {}
    if (symbol) q.symbol = symbol.toUpperCase()
    if (userId) q.userId = userId
    if (status) q.status = status.toUpperCase()
    if (from != null || to != null) {
      q.openedAt = {}
      if (from != null) q.openedAt.$gte = Number(from)
      if (to != null) q.openedAt.$lte = Number(to)
    }

    const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 500))
    const safePage = Math.max(1, Number(page) || 1)
    const skip = (safePage - 1) * safeLimit

    const [items, total] = await Promise.all([
      PaperPositionModel.find(q).sort({ openedAt: -1 }).skip(skip).limit(safeLimit).lean(),
      PaperPositionModel.countDocuments(q),
    ])

    return { items, total, page: safePage, limit: safeLimit }
  }

  async listSignalHistory({ symbol, state, decision, from, to, limit = 100, page = 1 }) {
    if (!this.isEnabled()) return { items: [], total: 0, page, limit }

    await this._flushSignals().catch(() => {})

    const q = {}
    if (symbol) q.symbol = symbol.toUpperCase()
    if (state) q.state = state
    if (decision) q.decision = decision
    if (from != null || to != null) {
      q.timestamp = {}
      if (from != null) q.timestamp.$gte = Number(from)
      if (to != null) q.timestamp.$lte = Number(to)
    }

    const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 500))
    const safePage = Math.max(1, Number(page) || 1)
    const skip = (safePage - 1) * safeLimit

    const [items, total] = await Promise.all([
      SignalHistoryModel.find(q).sort({ timestamp: -1 }).skip(skip).limit(safeLimit).lean(),
      SignalHistoryModel.countDocuments(q),
    ])

    return { items, total, page: safePage, limit: safeLimit }
  }

  async listSessionCandles({ sessionId = 'default', symbol, interval = '1m', from, to, limit = 100, page = 1 }) {
    if (!this.isEnabled()) return { items: [], total: 0, page, limit }

    await this._flushSessionCandles().catch(() => {})

    const q = { sessionId, interval }
    if (symbol) q.symbol = symbol.toUpperCase()
    if (from != null || to != null) {
      q.openTime = {}
      if (from != null) q.openTime.$gte = Number(from)
      if (to != null) q.openTime.$lte = Number(to)
    }

    const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 1000))
    const safePage = Math.max(1, Number(page) || 1)
    const skip = (safePage - 1) * safeLimit

    const [items, total] = await Promise.all([
      SessionCandleModel.find(q).sort({ openTime: -1 }).skip(skip).limit(safeLimit).lean(),
      SessionCandleModel.countDocuments(q),
    ])

    return { items, total, page: safePage, limit: safeLimit }
  }

  logPersistError(action, err) {
    logger.warn(`[MongoPersistence] ${action} failed: ${err.message}`)
  }
}

module.exports = {
  MongoTradingPersistenceService,
}
