'use strict'

const crypto = require('crypto')

const { PortfolioManagerPort } = require('../../../domain/futures/ports/inbound/PortfolioManagerPort')
const { logger } = require('../../../shared/utils/logger')

/**
 * In-memory snapshot of open positions kept alongside Mongo persistence so
 * the OMS hot path can compute exposure/PnL without a DB round-trip.
 *
 * Persistence (when available) flows through MongoTradingPersistenceService —
 * which already buffers/coalesces writes — via the existing PaperPositionModel.
 */
class PortfolioManager extends PortfolioManagerPort {
  /**
   * @param {object} deps
   * @param {object} [deps.tradingPersistence] MongoTradingPersistenceService
   * @param {{ emitPortfolioSnapshot: Function }} [deps.realtimeNotifier]
   * @param {object} [deps.marketDataPort] for current price during snapshot
   */
  constructor({
    tradingPersistence = null,
    realtimeNotifier = null,
    marketDataPort = null,
    startingEquity = 10_000,
  } = {}) {
    super()
    this.tradingPersistence = tradingPersistence
    this.realtimeNotifier = realtimeNotifier
    this.marketDataPort = marketDataPort
    /** @type {Map<string, object>} positionId -> position */
    this._positions = new Map()
    /** YYYY-MM-DD (UTC) -> realized pnl */
    this._dailyRealized = new Map()

    // ── Paper-trading account ────────────────────────────────────────────
    // The user starts with a virtual cap (default $10k). Realized PnL of
    // every closed paper position adds/subtracts from this cap so the
    // displayed "equity" reflects the running performance of the bot
    // across restarts (we replay the cumulative realized PnL from Mongo on
    // boot — see `bootstrapPaperFromPersistence`).
    this._paperStartingEquity = Number(startingEquity) || 10_000
    this._paperRealizedToDate = 0
    this._paperBootstrapped = false
    this._countedPaperCloseIds = new Set()
  }

  /**
   * Re-hydrate cumulative paper-trading PnL from MongoDB on startup. Called
   * once from the composition root after the container is wired. Safe to
   * call again (idempotent — collapses to a no-op once bootstrapped).
   *
   * @param {{ startingEquity?: number, batchSize?: number }} [opts]
   */
  async bootstrapPaperFromPersistence({ startingEquity, batchSize = 500 } = {}) {
    if (this._paperBootstrapped) return this.getPaperAccountState()
    if (Number.isFinite(startingEquity)) {
      this._paperStartingEquity = Number(startingEquity)
    }
    if (!this.tradingPersistence?.listPaperPositions) {
      this._paperBootstrapped = true
      return this.getPaperAccountState()
    }
    let page = 1
    let totalRealized = 0
    let scanned = 0
    try {
      // Paginate over all CLOSED paper positions. We do not rely on `total`
      // alone — we keep paging until we get fewer items than the page size.
      // 500 is the upper bound enforced by listPaperPositions().
      // Practical caps avoid pathological runs (e.g. millions of rows).
      const MAX_PAGES = 200
      for (; page <= MAX_PAGES; page++) {
        const res = await this.tradingPersistence.listPaperPositions({
          status: 'CLOSED',
          limit: batchSize,
          page,
        })
        const items = res?.items ?? []
        for (const pos of items) {
          if (!pos?.positionId) continue
          if (this._countedPaperCloseIds.has(pos.positionId)) continue
          this._countedPaperCloseIds.add(pos.positionId)
          totalRealized += Number(pos.realizedPnl) || 0
          scanned += 1
        }
        if (items.length < batchSize) break
      }
      this._paperRealizedToDate = totalRealized
      this._paperBootstrapped = true
      logger.info(
        `[PortfolioManager] Paper account bootstrapped — starting=$${this._paperStartingEquity} ` +
          `realizedToDate=${totalRealized.toFixed(2)} (from ${scanned} closed positions)`,
      )
    } catch (err) {
      logger.warn(`[PortfolioManager] bootstrap paper state failed: ${err.message}`)
      this._paperBootstrapped = true
    }
    this._emitSnapshot()
    return this.getPaperAccountState()
  }

  /**
   * Record a closed paper position so the equity cap is updated in real time.
   * No-ops on duplicate ids (defends against restoration replays and against
   * the same close being routed through more than one code path).
   *
   * @param {{ id?: string, positionId?: string, realizedPnl?: number }} position
   */
  recordPaperClose(position) {
    if (!position) return
    const id = position.id ?? position.positionId
    if (!id) return
    if (this._countedPaperCloseIds.has(id)) return
    this._countedPaperCloseIds.add(id)
    const realized = Number(position.realizedPnl)
    if (Number.isFinite(realized)) {
      this._paperRealizedToDate += realized
    }
    this._emitSnapshot()
  }

  getPaperAccountState() {
    const equity = this._paperStartingEquity + this._paperRealizedToDate
    return {
      startingEquity: this._paperStartingEquity,
      realizedToDate: this._paperRealizedToDate,
      equity,
      bootstrapped: this._paperBootstrapped,
    }
  }

  /** Convenience used by the adapter to size positions against live equity. */
  getPaperEquity() {
    return this._paperStartingEquity + this._paperRealizedToDate
  }

  _today() {
    return new Date().toISOString().slice(0, 10)
  }

  _addRealized(amount) {
    const day = this._today()
    this._dailyRealized.set(day, (this._dailyRealized.get(day) || 0) + amount)
  }

  _findOpen(userId, symbol, direction) {
    for (const pos of this._positions.values()) {
      if (pos.status !== 'OPEN') continue
      if ((pos.userId ?? null) !== (userId ?? null)) continue
      if (pos.symbol !== symbol) continue
      if (pos.direction !== direction) continue
      return pos
    }
    return null
  }

  _findOppositeOpen(userId, symbol, direction) {
    const opposite = direction === 'LONG' ? 'SHORT' : 'LONG'
    return this._findOpen(userId, symbol, opposite)
  }

  async _persist(position) {
    if (!this.tradingPersistence?.savePaperPosition) return
    try {
      await this.tradingPersistence.savePaperPosition({
        id: position.positionId,
        userId: position.userId,
        symbol: position.symbol,
        direction: position.direction,
        entryPrice: position.entryPrice,
        quantity: position.quantity,
        stopLoss: position.stopLoss ?? null,
        takeProfit: position.takeProfit ?? null,
        openedAt: position.openedAt,
        closedAt: position.closedAt,
        status: position.status,
        currentPrice: position.currentPrice ?? null,
        unrealizedPnl: position.unrealizedPnl ?? null,
        realizedPnl: position.realizedPnl ?? null,
        closeReason: position.closeReason ?? null,
      })
    } catch (err) {
      logger.warn(`[PortfolioManager] persist failed: ${err.message}`)
    }
  }

  _emitSnapshot() {
    try {
      this.realtimeNotifier?.emitPortfolioSnapshot?.(this._buildSnapshot())
    } catch (err) {
      logger.warn(`[PortfolioManager] emit snapshot failed: ${err.message}`)
    }
  }

  _buildSnapshot(userId = null) {
    const positions = []
    let totalNotional = 0
    let totalUnrealized = 0
    let totalRealized = 0
    const exposureBySymbol = {}
    for (const pos of this._positions.values()) {
      if (userId != null && (pos.userId ?? null) !== userId) continue
      positions.push({ ...pos })
      totalRealized += Number(pos.realizedPnl || 0)
      if (pos.status === 'OPEN') {
        const notional = Number(pos.entryPrice || 0) * Number(pos.quantity || 0)
        totalNotional += notional
        exposureBySymbol[pos.symbol] = (exposureBySymbol[pos.symbol] || 0) + notional
        totalUnrealized += Number(pos.unrealizedPnl || 0)
      }
    }
    const dailyPnl = (this._dailyRealized.get(this._today()) || 0) + totalUnrealized
    const openPositions = positions.filter((p) => p.status === 'OPEN')
    const closedPositions = positions.filter((p) => p.status === 'CLOSED')
    const wins = closedPositions.filter((p) => Number(p.realizedPnl) > 0).length
    const paper = this.getPaperAccountState()
    const combinedRealized = paper.realizedToDate + totalRealized
    const paperSummary = {
      startingEquity: paper.startingEquity,
      realizedToDate: paper.realizedToDate,
      unrealizedPnl: totalUnrealized,
      realizedPnl: combinedRealized,
      equity: paper.startingEquity + combinedRealized + totalUnrealized,
      openCount: openPositions.length,
      closedCount: closedPositions.length,
      wins,
      winRate: closedPositions.length > 0 ? (wins / closedPositions.length) * 100 : 0,
      exposureBySymbol,
      totalNotional,
      bootstrapped: paper.bootstrapped,
    }
    return {
      positions,
      totalNotional,
      exposureBySymbol,
      totalUnrealized,
      totalRealized,
      dailyPnl,
      liveSummary: {
        openCount: openPositions.length,
        totalNotional,
        unrealizedPnl: totalUnrealized,
        realizedPnl: totalRealized,
        exposureBySymbol,
      },
      paper,
      paperSummary,
      timestamp: Date.now(),
    }
  }

  /**
   * Apply an order fill to the in-memory book.
   * @param {object} order  the persisted order (with `fills`, `side`, `symbol`)
   * @returns {Promise<string|null>} positionId if open/updated, null otherwise
   */
  async applyFill(order) {
    if (!order || !Array.isArray(order.fills) || order.fills.length === 0) return null
    const userId = order.userId ?? null
    const symbol = String(order.symbol).toUpperCase()
    const direction = order.side === 'BUY' ? 'LONG' : 'SHORT'

    const fillQty = order.fills.reduce((acc, f) => acc + Number(f.quantity || 0), 0)
    if (fillQty <= 0) return null
    const fillNotional = order.fills.reduce(
      (acc, f) => acc + Number(f.quantity || 0) * Number(f.price || 0),
      0,
    )
    const avgPrice = fillNotional / fillQty

    // Closing or reducing an opposite position first.
    const opposite = this._findOppositeOpen(userId, symbol, direction)
    if (opposite) {
      const closeQty = Math.min(opposite.quantity, fillQty)
      const realized = opposite.direction === 'LONG'
        ? (avgPrice - opposite.entryPrice) * closeQty
        : (opposite.entryPrice - avgPrice) * closeQty
      opposite.realizedPnl = (opposite.realizedPnl || 0) + realized
      this._addRealized(realized)
      opposite.quantity -= closeQty
      opposite.currentPrice = avgPrice
      if (opposite.quantity <= 1e-12) {
        opposite.status = 'CLOSED'
        opposite.closedAt = Date.now()
        opposite.unrealizedPnl = 0
        opposite.closeReason = 'OPPOSITE_FILL'
      } else {
        const notional = opposite.entryPrice * opposite.quantity
        opposite.unrealizedPnl = opposite.direction === 'LONG'
          ? (avgPrice - opposite.entryPrice) * opposite.quantity
          : (opposite.entryPrice - avgPrice) * opposite.quantity
        opposite._notional = notional
      }
      await this._persist(opposite)

      const leftover = fillQty - closeQty
      this._emitSnapshot()
      if (leftover <= 1e-12) return opposite.positionId

      // Remainder opens a new position in the opposite direction.
      return this._openOrAdd({ userId, symbol, direction, quantity: leftover, avgPrice, sourceOrderId: order.orderId })
    }

    return this._openOrAdd({ userId, symbol, direction, quantity: fillQty, avgPrice, sourceOrderId: order.orderId })
  }

  async _openOrAdd({ userId, symbol, direction, quantity, avgPrice, sourceOrderId }) {
    const existing = this._findOpen(userId, symbol, direction)
    let position
    if (existing) {
      const newQty = existing.quantity + quantity
      const newEntry = (existing.entryPrice * existing.quantity + avgPrice * quantity) / newQty
      existing.quantity = newQty
      existing.entryPrice = newEntry
      existing.currentPrice = avgPrice
      existing.unrealizedPnl = 0
      position = existing
    } else {
      position = {
        positionId: crypto.randomUUID(),
        userId,
        symbol,
        direction,
        entryPrice: avgPrice,
        quantity,
        currentPrice: avgPrice,
        unrealizedPnl: 0,
        realizedPnl: 0,
        stopLoss: null,
        takeProfit: null,
        openedAt: Date.now(),
        closedAt: null,
        status: 'OPEN',
        sourceOrderId,
      }
      this._positions.set(position.positionId, position)
    }
    await this._persist(position)
    this._emitSnapshot()
    return position.positionId
  }

  async getSnapshot({ userId = null } = {}) {
    return this._buildSnapshot(userId)
  }

  async getExposure() {
    const snap = this._buildSnapshot()
    return { byStrategy: {}, bySymbol: snap.exposureBySymbol, totalNotional: snap.totalNotional }
  }

  async getPnLByStrategy() {
    const snap = this._buildSnapshot()
    return {
      realizedByStrategy: { default: snap.totalRealized },
      unrealizedByStrategy: { default: snap.totalUnrealized },
    }
  }

  async getPosition(positionId) {
    const pos = this._positions.get(positionId)
    return pos ? { ...pos } : null
  }

  async listPositions({ userId = null, status = null, symbol = null } = {}) {
    return Array.from(this._positions.values()).filter((p) => {
      if (userId != null && (p.userId ?? null) !== userId) return false
      if (status && p.status !== String(status).toUpperCase()) return false
      if (symbol && p.symbol !== String(symbol).toUpperCase()) return false
      return true
    })
  }

  async getPerformance({ userId = null } = {}) {
    const snap = this._buildSnapshot(userId)
    return {
      dailyPnl: snap.dailyPnl,
      realized: snap.totalRealized,
      unrealized: snap.totalUnrealized,
      exposure: snap.totalNotional,
      positionsOpen: snap.positions.filter((p) => p.status === 'OPEN').length,
      timestamp: snap.timestamp,
    }
  }
}

module.exports = { PortfolioManager }
