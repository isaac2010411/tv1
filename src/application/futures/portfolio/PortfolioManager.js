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

    this._liveBalances = new Map()
    this._livePositions = new Map()
    this._liveOrders = new Map()
    this._liveRiskBySymbol = new Map()
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

  getExecutionEquity(mode) {
    return mode === 'live' ? this.getLiveEquity() : this.getPaperEquity()
  }

  applyExchangeAccountSnapshot(snapshot = {}) {
    this._liveBalances.clear()
    this._livePositions.clear()
    this._liveOrders.clear()
    const openSymbols = new Set()

    for (const balance of snapshot.balances ?? []) {
      const asset = balance.asset ?? 'USDT'
      this._liveBalances.set(asset, {
        asset,
        walletBalance: Number(balance.walletBalance ?? balance.balance ?? 0),
        availableBalance: Number(balance.availableBalance ?? 0),
        crossWalletBalance: Number(balance.crossWalletBalance ?? 0),
        balanceChange: Number(balance.balanceChange ?? 0),
      })
    }

    for (const position of snapshot.positions ?? []) {
      const normalized = this._normalizeLivePosition(position)
      if (normalized && normalized.direction !== 'FLAT') {
        this._livePositions.set(normalized.symbol, normalized)
        openSymbols.add(normalized.symbol)
      }
    }

    for (const symbol of this._liveRiskBySymbol.keys()) {
      if (!openSymbols.has(symbol)) this._liveRiskBySymbol.delete(symbol)
    }

    for (const order of snapshot.openOrders ?? []) {
      const key = String(order.clientOrderId ?? order.orderId ?? `${order.symbol}:${Date.now()}`)
      this._liveOrders.set(key, { ...order })
    }

    this._emitSnapshot()
  }

  applyExchangeAccountUpdate(update = {}) {
    for (const balance of update.balances ?? []) {
      const asset = balance.asset ?? 'USDT'
      const existing = this._liveBalances.get(asset) ?? { asset }
      this._liveBalances.set(asset, {
        ...existing,
        ...balance,
        walletBalance: Number(balance.walletBalance ?? existing.walletBalance ?? 0),
        crossWalletBalance: Number(balance.crossWalletBalance ?? existing.crossWalletBalance ?? 0),
        balanceChange: Number(balance.balanceChange ?? 0),
      })
    }

    for (const position of update.positions ?? []) {
      const normalized = this._normalizeLivePosition(position)
      if (!normalized) continue
      if (normalized.direction === 'FLAT') {
        this._livePositions.delete(normalized.symbol)
        this._liveRiskBySymbol.delete(normalized.symbol)
      } else {
        this._livePositions.set(normalized.symbol, normalized)
      }
    }

    this._emitSnapshot()
  }

  applyExchangeOrderUpdate(update = {}) {
    const key = String(update.clientOrderId ?? update.exchangeOrderId ?? `${update.symbol}:${Date.now()}`)
    const existing = this._liveOrders.get(key) ?? {}
    const merged = { ...existing, ...update, updatedAt: Date.now() }
    this._liveOrders.set(key, merged)
    this._mergeLivePositionRiskFromOrder(merged)
    this._emitSnapshot()
    return merged
  }

  updateLivePositionRisk({ symbol, stopLoss, takeProfit, stopLossOrigin, sourceSignalId } = {}) {
    const normalizedSymbol = String(symbol || '').toUpperCase()
    if (!normalizedSymbol) return null
    const existingRisk = this._liveRiskBySymbol.get(normalizedSymbol) ?? {}
    const patch = {}
    if (stopLoss !== undefined) patch.stopLoss = this._numberOrNull(stopLoss)
    if (takeProfit !== undefined) patch.takeProfit = this._numberOrNull(takeProfit)
    if (stopLossOrigin !== undefined) patch.stopLossOrigin = stopLossOrigin ?? null
    if (sourceSignalId !== undefined) patch.sourceSignalId = sourceSignalId ?? null
    const nextRisk = { ...existingRisk, ...patch }
    this._liveRiskBySymbol.set(normalizedSymbol, nextRisk)

    const existingPosition = this._livePositions.get(normalizedSymbol)
    if (existingPosition) {
      const updated = { ...existingPosition, ...nextRisk }
      this._livePositions.set(normalizedSymbol, updated)
      this._emitSnapshot()
      return { ...updated }
    }
    return null
  }

  getLiveEquity() {
    const usdt = this._liveBalances.get('USDT')
    const available = Number(usdt?.availableBalance)
    if (Number.isFinite(available) && available > 0) return available
    const wallet = Number(usdt?.walletBalance ?? usdt?.balance)
    if (Number.isFinite(wallet) && wallet > 0) return wallet
    return 0
  }

  getLiveBalance(asset = 'USDT') {
    const balance = this._liveBalances.get(String(asset || 'USDT').toUpperCase())
    return balance ? { ...balance } : null
  }

  getLiveOpenPositionForSymbol(symbol) {
    const pos = this._livePositions.get(String(symbol || '').toUpperCase())
    return pos ? { ...pos } : null
  }

  getLiveSnapshot() {
    return {
      mode: 'live',
      liveBalances: Array.from(this._liveBalances.values()).map((balance) => ({ ...balance })),
      liveBalance: this.getLiveBalance('USDT'),
      livePositions: Array.from(this._livePositions.values()).map((position) => ({ ...position })),
      liveOrders: Array.from(this._liveOrders.values()).map((order) => ({ ...order })),
      liveSummary: this._buildLiveSummary(),
      timestamp: Date.now(),
    }
  }

  getLiveDailyPnl() {
    let total = 0
    for (const order of this._liveOrders.values()) {
      total += Number(order.realizedProfit || 0)
    }
    return total
  }

  _normalizeLivePosition(position = {}) {
    const symbol = String(position.symbol || '').toUpperCase()
    if (!symbol) return null
    const amt = Number(position.positionAmt ?? position.quantity ?? 0)
    const direction = position.direction ?? (amt > 0 ? 'LONG' : amt < 0 ? 'SHORT' : 'FLAT')
    const positionSide = position.positionSide ?? position.side ?? null
    const quantity = Math.abs(amt)
    const entryPrice = Number(position.entryPrice ?? 0)
    const currentPrice = Number(position.currentPrice ?? position.markPrice ?? entryPrice)
    const unrealizedPnl = Number(position.unrealizedPnl ?? position.unRealizedProfit ?? 0)
    const realizedPnl = Number(position.accumulatedRealized ?? position.realizedPnl ?? 0)
    return {
      ...position,
      id: `live:${symbol}`,
      positionId: `live:${symbol}`,
      symbol,
      side: direction,
      positionSide,
      direction,
      positionAmt: amt,
      quantity,
      entryPrice,
      currentPrice,
      unrealizedPnl,
      realizedPnl,
      ...this._liveRiskBySymbol.get(symbol),
      status: direction === 'FLAT' ? 'CLOSED' : 'OPEN',
      autoManaged: true,
      mode: 'live',
    }
  }

  _mergeLivePositionRiskFromOrder(order = {}) {
    if (order.mode !== 'live' || order.reduceOnly) return
    const symbol = String(order.symbol || '').toUpperCase()
    if (!symbol) return
    const patch = {}
    if (order.stopLoss !== undefined) patch.stopLoss = this._numberOrNull(order.stopLoss)
    if (order.takeProfit !== undefined) patch.takeProfit = this._numberOrNull(order.takeProfit)
    if (order.sourceSignalId !== undefined) patch.sourceSignalId = order.sourceSignalId ?? null
    if (Object.keys(patch).length === 0) return
    this.updateLivePositionRisk({ symbol, ...patch })
  }

  _numberOrNull(value) {
    if (value == null) return null
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }

  _buildLiveSummary() {
    const livePositions = Array.from(this._livePositions.values())
    const usdtBalance = this.getLiveBalance('USDT') ?? {
      asset: 'USDT',
      walletBalance: 0,
      availableBalance: 0,
      crossWalletBalance: 0,
    }
    const walletBalance = Number(usdtBalance.walletBalance ?? usdtBalance.balance ?? 0)
    const availableBalance = Number(usdtBalance.availableBalance ?? 0)
    const crossWalletBalance = Number(usdtBalance.crossWalletBalance ?? 0)
    const exposureBySymbol = {}
    let totalNotional = 0
    let unrealizedPnl = 0
    let realizedPnl = 0

    for (const position of livePositions) {
      const notional = Number(position.entryPrice || 0) * Number(position.quantity || 0)
      totalNotional += notional
      unrealizedPnl += Number(position.unrealizedPnl || 0)
      realizedPnl += Number(position.realizedPnl || 0)
      exposureBySymbol[position.symbol] = (exposureBySymbol[position.symbol] || 0) + notional
    }

    return {
      asset: usdtBalance.asset ?? 'USDT',
      equity: this.getLiveEquity(),
      balance: Number.isFinite(walletBalance) ? walletBalance : 0,
      walletBalance: Number.isFinite(walletBalance) ? walletBalance : 0,
      availableBalance: Number.isFinite(availableBalance) ? availableBalance : 0,
      crossWalletBalance: Number.isFinite(crossWalletBalance) ? crossWalletBalance : 0,
      openCount: livePositions.length,
      totalNotional,
      unrealizedPnl,
      realizedPnl,
      dailyPnl: this.getLiveDailyPnl() + unrealizedPnl,
      exposureBySymbol,
    }
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
    const liveSnapshot = this.getLiveSnapshot()
    return {
      positions,
      livePositions: liveSnapshot.livePositions,
      liveOrders: liveSnapshot.liveOrders,
      liveBalances: liveSnapshot.liveBalances,
      liveBalance: liveSnapshot.liveBalance,
      totalNotional,
      exposureBySymbol,
      totalUnrealized,
      totalRealized,
      dailyPnl,
      liveSummary: liveSnapshot.liveSummary,
      paper,
      paperSummary,
      timestamp: Date.now(),
    }
  }

  async _loadPaperHistory({ userId = null, limit = 100 } = {}) {
    if (!this.tradingPersistence?.listPaperPositions) return []
    try {
      const result = await this.tradingPersistence.listPaperPositions({
        userId: userId ?? undefined,
        limit,
        page: 1,
      })
      return Array.isArray(result?.items) ? result.items : []
    } catch (err) {
      logger.warn(`[PortfolioManager] load paper history failed: ${err.message}`)
      return []
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
    const snapshot = this._buildSnapshot(userId)
    const paperPositions = await this._loadPaperHistory({ userId })
    if (paperPositions.length > 0) {
      snapshot.paperPositions = paperPositions
      snapshot.paperHistory = paperPositions
    } else {
      snapshot.paperPositions = snapshot.positions
      snapshot.paperHistory = snapshot.positions
    }
    return snapshot
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
