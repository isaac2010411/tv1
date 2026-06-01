'use strict'

function isFiniteNumber(value) {
  return Number.isFinite(Number(value))
}

function normalizeNumber(value) {
  if (value == null || value === '') return null
  return isFiniteNumber(value) ? Number(value) : null
}

function buildPositionId(symbol) {
  return `paper-${symbol}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function effectiveQuantity(quantity) {
  const qty = Number(quantity)
  return Number.isFinite(qty) && qty > 0 ? qty : 1
}

function calculateUnrealizedPnl(direction, entryPrice, currentPrice, quantity = 1) {
  if (!isFiniteNumber(entryPrice) || !isFiniteNumber(currentPrice)) return null
  const entry = Number(entryPrice)
  const current = Number(currentPrice)
  const perUnit = direction === 'SHORT' ? entry - current : current - entry
  return perUnit * effectiveQuantity(quantity)
}

class PaperTradeService {
  constructor() {
    this._openBySymbol = new Map()
    this._closedBySymbol = new Map()
  }

  openPosition({
    symbol,
    userId,
    direction,
    entryPrice,
    quantity = null,
    stopLoss = null,
    takeProfit = null,
    sourceSignalId = null,
    openedAt = Date.now(),
    autoManaged = false,
    autoExecutionMeta = null,
  }) {
    const normalizedSymbol = (symbol ?? '').trim().toUpperCase()
    if (!normalizedSymbol) {
      throw new Error('symbol is required')
    }
    if (direction !== 'LONG' && direction !== 'SHORT') {
      throw new Error('direction must be LONG or SHORT')
    }
    if (!isFiniteNumber(entryPrice)) {
      throw new Error('entryPrice is required and must be numeric')
    }

    // Enforce a single OPEN position per symbol. Caller decides whether to
    // close the existing one first; we refuse to open a second to keep the
    // state machine and risk policy consistent ("1 op por activo").
    const existingForSymbol = this._openBySymbol.get(normalizedSymbol)
    if (existingForSymbol && existingForSymbol.size > 0) {
      const err = new Error(`A position is already open for ${normalizedSymbol}`)
      err.code = 'POSITION_ALREADY_OPEN'
      throw err
    }

    const position = {
      id: buildPositionId(normalizedSymbol),
      userId: userId ?? null,
      symbol: normalizedSymbol,
      direction,
      entryPrice: Number(entryPrice),
      quantity: normalizeNumber(quantity),
      stopLoss: normalizeNumber(stopLoss),
      takeProfit: normalizeNumber(takeProfit),
      openedAt: Number(openedAt),
      closedAt: null,
      status: 'OPEN',
      sourceSignalId,
      currentPrice: Number(entryPrice),
      unrealizedPnl: 0,
      realizedPnl: null,
      closeReason: null,
      autoManaged: !!autoManaged,
      autoExecutionMeta: autoExecutionMeta ?? null,
    }

    if (!this._openBySymbol.has(normalizedSymbol)) {
      this._openBySymbol.set(normalizedSymbol, new Map())
    }
    this._openBySymbol.get(normalizedSymbol).set(position.id, position)

    return { ...position }
  }

  /**
   * Mutate the stops of an OPEN position in place (trailing SL / break-even
   * moves done by the RiskManager). Returns the new snapshot or null when
   * the position is unknown or already closed.
   */
  updateStops({ symbol, positionId, stopLoss, takeProfit }) {
    const normalizedSymbol = (symbol ?? '').trim().toUpperCase()
    const symbolMap = this._openBySymbol.get(normalizedSymbol)
    if (!symbolMap || !positionId || !symbolMap.has(positionId)) return null
    const pos = symbolMap.get(positionId)
    if (stopLoss !== undefined && isFiniteNumber(stopLoss)) pos.stopLoss = Number(stopLoss)
    if (takeProfit !== undefined && isFiniteNumber(takeProfit)) pos.takeProfit = Number(takeProfit)
    return { ...pos }
  }

  /** Returns the (single) open position for a symbol, or null. */
  getOpenPositionForSymbol(symbol) {
    const normalizedSymbol = (symbol ?? '').trim().toUpperCase()
    const symbolMap = this._openBySymbol.get(normalizedSymbol)
    if (!symbolMap || symbolMap.size === 0) return null
    const first = symbolMap.values().next().value
    return first ? { ...first } : null
  }

  /** Aggregate dailyPnl across the open + closed paper book. */
  getDailyPnl() {
    let total = 0
    for (const symbolMap of this._openBySymbol.values()) {
      for (const pos of symbolMap.values()) {
        total += Number(pos.unrealizedPnl ?? 0)
      }
    }
    const startOfDay = new Date(); startOfDay.setUTCHours(0, 0, 0, 0)
    const startMs = startOfDay.getTime()
    for (const list of this._closedBySymbol.values()) {
      for (const pos of list) {
        if ((pos.closedAt ?? 0) >= startMs) total += Number(pos.realizedPnl ?? 0)
      }
    }
    return total
  }

  closePosition({ symbol, positionId, closePrice = null, closeReason = 'MANUAL', closedAt = Date.now() }) {
    const normalizedSymbol = (symbol ?? '').trim().toUpperCase()
    const symbolMap = this._openBySymbol.get(normalizedSymbol)
    if (!symbolMap || !symbolMap.has(positionId)) return null

    const existing = symbolMap.get(positionId)
    const price = isFiniteNumber(closePrice) ? Number(closePrice) : existing.currentPrice
    const realizedPnl = calculateUnrealizedPnl(existing.direction, existing.entryPrice, price, existing.quantity)

    const closed = {
      ...existing,
      currentPrice: price,
      unrealizedPnl: 0,
      realizedPnl,
      closedAt: Number(closedAt),
      status: 'CLOSED',
      closeReason,
    }

    symbolMap.delete(positionId)
    if (symbolMap.size === 0) this._openBySymbol.delete(normalizedSymbol)

    if (!this._closedBySymbol.has(normalizedSymbol)) {
      this._closedBySymbol.set(normalizedSymbol, [])
    }
    const history = this._closedBySymbol.get(normalizedSymbol)
    history.unshift(closed)
    if (history.length > 1000) history.length = 1000

    return { ...closed }
  }

  closeLatestOpenPosition({ symbol, closePrice = null, closeReason = 'MANUAL', closedAt = Date.now() }) {
    const normalizedSymbol = (symbol ?? '').trim().toUpperCase()
    const symbolMap = this._openBySymbol.get(normalizedSymbol)
    if (!symbolMap || symbolMap.size === 0) return null

    const latest = Array.from(symbolMap.values()).sort((a, b) => b.openedAt - a.openedAt)[0]
    return this.closePosition({
      symbol: normalizedSymbol,
      positionId: latest.id,
      closePrice,
      closeReason,
      closedAt,
    })
  }

  onPriceTick({ symbol, price, now = Date.now() }) {
    const normalizedSymbol = (symbol ?? '').trim().toUpperCase()
    if (!normalizedSymbol || !isFiniteNumber(price)) return []
    const symbolMap = this._openBySymbol.get(normalizedSymbol)
    if (!symbolMap || symbolMap.size === 0) return []

    const output = []
    for (const position of symbolMap.values()) {
      const nextPrice = Number(price)
      const nextUnrealizedPnl = calculateUnrealizedPnl(
        position.direction,
        position.entryPrice,
        nextPrice,
        position.quantity,
      )
      position.currentPrice = nextPrice
      position.unrealizedPnl = nextUnrealizedPnl

      output.push({ type: 'UPDATED', position: { ...position } })

      const shouldStop =
        position.stopLoss != null &&
        ((position.direction === 'LONG' && nextPrice <= position.stopLoss) ||
          (position.direction === 'SHORT' && nextPrice >= position.stopLoss))

      const shouldTakeProfit =
        position.takeProfit != null &&
        ((position.direction === 'LONG' && nextPrice >= position.takeProfit) ||
          (position.direction === 'SHORT' && nextPrice <= position.takeProfit))

      if (!shouldStop && !shouldTakeProfit) continue

      const closeReason = shouldTakeProfit ? 'TAKE_PROFIT' : 'STOP_LOSS'
      const closed = this.closePosition({
        symbol: normalizedSymbol,
        positionId: position.id,
        closePrice: nextPrice,
        closeReason,
        closedAt: now,
      })

      if (closed) output.push({ type: 'CLOSED', position: closed })
    }

    return output
  }

  /**
   * Import a pre-existing OPEN position (e.g. restored from MongoDB on reconnect).
   * Skips if a position with the same id is already tracked.
   */
  importPosition(position) {
    const normalizedSymbol = (position?.symbol ?? '').trim().toUpperCase()
    if (!normalizedSymbol || !position?.id) return
    if (!this._openBySymbol.has(normalizedSymbol)) {
      this._openBySymbol.set(normalizedSymbol, new Map())
    }
    const symbolMap = this._openBySymbol.get(normalizedSymbol)
    if (!symbolMap.has(position.id)) {
      symbolMap.set(position.id, {
        autoManaged: !!position.autoManaged,
        autoExecutionMeta: position.autoExecutionMeta ?? null,
        ...position,
      })
    }
  }

  getOpenPositions(symbol) {
    const normalizedSymbol = (symbol ?? '').trim().toUpperCase()
    const symbolMap = this._openBySymbol.get(normalizedSymbol)
    if (!symbolMap) return []
    return Array.from(symbolMap.values()).map((position) => ({ ...position }))
  }

  getAllOpenPositions() {
    const positions = []
    for (const symbolMap of this._openBySymbol.values()) {
      for (const position of symbolMap.values()) positions.push({ ...position })
    }
    return positions
  }

  getClosedPositions(symbol = null) {
    const normalizedSymbol = symbol == null ? null : (symbol ?? '').trim().toUpperCase()
    if (normalizedSymbol) {
      return (this._closedBySymbol.get(normalizedSymbol) ?? []).map((position) => ({ ...position }))
    }
    const positions = []
    for (const list of this._closedBySymbol.values()) {
      for (const position of list) positions.push({ ...position })
    }
    return positions
  }

  /**
   * Drop the closed-position history for a symbol. Open positions are kept so
   * that an unsubscribe + resubscribe sequence does not lose state.
   * Call this from the socket adapter when a symbol has no more subscribers.
   */
  clearSymbolHistory(symbol) {
    const normalizedSymbol = (symbol ?? '').trim().toUpperCase()
    if (!normalizedSymbol) return
    this._closedBySymbol.delete(normalizedSymbol)
  }
}

module.exports = {
  PaperTradeService,
}
