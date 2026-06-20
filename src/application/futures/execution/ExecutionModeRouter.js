'use strict'

class ExecutionModeRouter {
  constructor({
    tradingMode = 'paper',
    liveTradingEnabled = false,
    paperTradeService,
    orderManager,
    portfolioManager,
    liveTradingSupervisor = null,
    tradingRulesPort = null,
    liveSymbolAllowlist = [],
    liveMaxOpenPositions = 1,
    liveMaxNotionalPerOrder = 50,
    liveMaxDailyLoss = 20,
  } = {}) {
    if (!paperTradeService) throw new Error('ExecutionModeRouter requires paperTradeService')
    if (!orderManager) throw new Error('ExecutionModeRouter requires orderManager')
    if (!portfolioManager) throw new Error('ExecutionModeRouter requires portfolioManager')
    this.tradingMode = tradingMode
    this.liveTradingEnabled = !!liveTradingEnabled
    this.paperTradeService = paperTradeService
    this.orderManager = orderManager
    this.portfolioManager = portfolioManager
    this.liveTradingSupervisor = liveTradingSupervisor
    this.tradingRulesPort = tradingRulesPort
    this.liveSymbolAllowlist = new Set(liveSymbolAllowlist.map((symbol) => String(symbol).toUpperCase()))
    this.liveMaxOpenPositions = Number(liveMaxOpenPositions)
    this.liveMaxNotionalPerOrder = Number(liveMaxNotionalPerOrder)
    this.liveMaxDailyLoss = Number(liveMaxDailyLoss)
  }

  isLive() {
    return this.tradingMode === 'live'
  }

  getOpenPositionForSymbol(symbol) {
    return this.isLive()
      ? this.portfolioManager.getLiveOpenPositionForSymbol(symbol)
      : this.paperTradeService.getOpenPositionForSymbol(symbol)
  }

  getDailyPnl() {
    return this.isLive()
      ? this.portfolioManager.getLiveDailyPnl?.() ?? 0
      : this.paperTradeService.getDailyPnl?.() ?? 0
  }

  async openPosition(params = {}) {
    if (!this.isLive()) return this.paperTradeService.openPosition(params)
    const symbol = String(params.symbol || '').toUpperCase()
    const direction = String(params.direction || '').toUpperCase()
    const side = direction === 'LONG' ? 'BUY' : direction === 'SHORT' ? 'SELL' : null
    if (!side) throw new Error('direction must be LONG or SHORT')
    const quantity = await this._normalizeQuantity(symbol, params.quantity, {
      entryPrice: params.entryPrice,
      requestedQuantity: params.quantity,
      reduceOnly: false,
    })
    await this._assertCanSubmitLiveOrder({
      symbol,
      side,
      quantity,
      price: params.entryPrice,
      reduceOnly: false,
    })
    return this.orderManager.submit({
      mode: 'live',
      userId: params.userId ?? 'risk-manager',
      sourceSignalId: params.sourceSignalId ?? null,
      entryPrice: params.entryPrice ?? null,
      stopLoss: params.stopLoss ?? null,
      takeProfit: params.takeProfit ?? null,
      symbol,
      side,
      type: 'MARKET',
      quantity,
      reduceOnly: false,
    })
  }

  async closePosition(params = {}) {
    if (!this.isLive()) return this.paperTradeService.closePosition(params)
    const symbol = String(params.symbol || '').toUpperCase()
    const position = this.portfolioManager.getLiveOpenPositionForSymbol(symbol)
    if (!position) return null
    const side = position.direction === 'LONG' ? 'SELL' : 'BUY'
    const quantity = await this._normalizeQuantity(symbol, params.quantity ?? position.quantity, {
      entryPrice: params.closePrice ?? position.currentPrice ?? position.entryPrice,
      requestedQuantity: params.quantity ?? position.quantity,
      reduceOnly: true,
    })
    await this._assertCanSubmitLiveOrder({
      symbol,
      side,
      quantity,
      price: params.closePrice ?? position.currentPrice ?? position.entryPrice,
      reduceOnly: true,
    })
    return this.orderManager.submit({
      mode: 'live',
      userId: params.userId ?? 'risk-manager',
      sourceSignalId: params.sourceSignalId ?? position.sourceSignalId ?? null,
      closeReason: params.closeReason ?? null,
      entryPrice: position.entryPrice ?? null,
      symbol,
      side,
      type: 'MARKET',
      quantity,
      reduceOnly: true,
    })
  }

  async closeLatestOpenPosition(params = {}) {
    if (!this.isLive()) return this.paperTradeService.closeLatestOpenPosition(params)
    return this.closePosition(params)
  }

  updateStops(params = {}) {
    if (!this.isLive()) return this.paperTradeService.updateStops(params)
    const position = this.portfolioManager.getLiveOpenPositionForSymbol(params.symbol)
    if (!position) return null
    return this.portfolioManager.updateLivePositionRisk?.({
      symbol: params.symbol,
      stopLoss: params.stopLoss,
      takeProfit: params.takeProfit,
      stopLossOrigin: params.stopLossOrigin,
    }) ?? { ...position, stopLoss: params.stopLoss ?? position.stopLoss ?? null }
  }

  onPriceTick(params = {}) {
    if (!this.isLive()) return this.paperTradeService.onPriceTick(params)
    return []
  }

  getAllOpenPositions() {
    if (!this.isLive()) return this.paperTradeService.getAllOpenPositions()
    return this.portfolioManager.getLiveSnapshot().livePositions
  }

  getClosedPositions() {
    if (!this.isLive()) return this.paperTradeService.getClosedPositions()
    return []
  }

  clearSymbolHistory(symbol) {
    if (!this.isLive()) this.paperTradeService.clearSymbolHistory?.(symbol)
  }

  importPosition(position) {
    if (!this.isLive()) return this.paperTradeService.importPosition(position)
    return null
  }

  async _normalizeQuantity(symbol, quantity, meta = {}) {
    const requestedQty = Number(quantity)
    let qty = requestedQty
    if (!Number.isFinite(qty) || qty <= 0) {
      throw new Error(`quantity must be a positive number (requested=${quantity})`)
    }
    if (this.tradingRulesPort?.getTradingRules) {
      const rules = await this.tradingRulesPort.getTradingRules(symbol)
      const entryPrice = Number(meta.entryPrice)
      if (
        !meta.reduceOnly &&
        Number.isFinite(entryPrice) &&
        entryPrice > 0 &&
        Number.isFinite(this.liveMaxNotionalPerOrder) &&
        this.liveMaxNotionalPerOrder > 0 &&
        qty * entryPrice > this.liveMaxNotionalPerOrder
      ) {
        qty = this.liveMaxNotionalPerOrder / entryPrice
      }
      if (rules?.normalizeQuantity) qty = Number(rules.normalizeQuantity(qty))
      const minQty = Number(rules?.marketMinQty ?? rules?.minQty)
      if (Number.isFinite(minQty) && qty < minQty) {
        const minNotional = Number.isFinite(entryPrice) && entryPrice > 0 ? minQty * entryPrice : null
        const requestedNotional =
          Number.isFinite(entryPrice) && entryPrice > 0 && Number.isFinite(requestedQty)
            ? requestedQty * entryPrice
            : null
        throw new Error(
          `quantity ${qty} is below minimum ${minQty} for ${symbol}` +
            ` (requested=${Number.isFinite(requestedQty) ? requestedQty : 'n/a'}` +
            `, requestedNotional=${requestedNotional != null ? requestedNotional.toFixed(2) : 'n/a'}` +
            `, minNotional≈${minNotional != null ? minNotional.toFixed(2) : 'n/a'}` +
            `, liveMaxNotional=${this.liveMaxNotionalPerOrder})`,
        )
      }
    }
    return qty
  }

  async _assertCanSubmitLiveOrder({ symbol, side, quantity, price, reduceOnly }) {
    if (!this.liveTradingEnabled) throw new Error('live trading is disabled')
    if (!this.liveTradingSupervisor?.isReady?.()) throw new Error('live trading supervisor is not ready')
    if (!this.liveSymbolAllowlist.has(symbol)) throw new Error(`${symbol} is not in LIVE_SYMBOL_ALLOWLIST`)

    const livePositions = this.portfolioManager.getLiveSnapshot().livePositions
    const openCount = livePositions.filter((position) => position.status === 'OPEN').length
    const existing = this.portfolioManager.getLiveOpenPositionForSymbol(symbol)
    if (!reduceOnly) {
      const openOrders = await this.orderManager.getOpen?.({ symbol })
      const hasPendingOrder = Array.isArray(openOrders) && openOrders.some((order) => order.mode === 'live')
      if (hasPendingOrder) throw new Error(`pending live order already exists for ${symbol}`)
    }
    if (!reduceOnly && !existing && openCount >= this.liveMaxOpenPositions) {
      throw new Error(`LIVE_MAX_OPEN_POSITIONS exceeded (${this.liveMaxOpenPositions})`)
    }

    if (!reduceOnly && existing) {
      const wouldOpenOpposite =
        (existing.direction === 'LONG' && side === 'SELL') ||
        (existing.direction === 'SHORT' && side === 'BUY')
      if (wouldOpenOpposite) throw new Error(`opposite live position already open for ${symbol}`)
    }

    const notional = Number(price || existing?.entryPrice || 0) * Number(quantity || 0)
    if (!reduceOnly && Number.isFinite(notional) && notional > this.liveMaxNotionalPerOrder) {
      throw new Error(`LIVE_MAX_NOTIONAL_PER_ORDER exceeded (${notional.toFixed(2)})`)
    }

    const dailyPnl = Number(this.portfolioManager.getLiveDailyPnl?.() ?? 0)
    if (Number.isFinite(dailyPnl) && dailyPnl <= -Math.abs(this.liveMaxDailyLoss)) {
      throw new Error(`LIVE_MAX_DAILY_LOSS reached (${dailyPnl.toFixed(2)})`)
    }
  }
}

module.exports = { ExecutionModeRouter }
