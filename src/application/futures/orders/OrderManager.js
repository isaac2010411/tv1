'use strict'

const crypto = require('crypto')

const { OrderManagerPort } = require('../../../domain/futures/ports/inbound/OrderManagerPort')
const { ApplicationError } = require('../../../shared/errors/ApplicationError')
const { RiskViolationError } = require('../../../shared/errors/RiskViolationError')
const { OrderRejectedError } = require('../../../shared/errors/OrderRejectedError')
const { logger } = require('../../../shared/utils/logger')

const VALID_SIDES = new Set(['BUY', 'SELL'])
const VALID_TYPES = new Set(['MARKET', 'LIMIT'])

/**
 * OrderManager — concrete OMS that wires risk → persist → exchange execution
 * → portfolio update → realtime notification.
 *
 * Designed for paper trading by default but agnostic of the execution client
 * (any object exposing `submit(order)` / `cancel(orderId)`).
 */
class OrderManager extends OrderManagerPort {
  /**
   * @param {object} deps
   * @param {import('../../../domain/futures/ports/outbound/OrderRepositoryPort').OrderRepositoryPort} deps.orderRepository
   * @param {import('../../../domain/futures/ports/inbound/RiskGuardPort').RiskGuardPort} deps.riskGuard
   * @param {{ submit: Function, cancel: Function }} deps.exchangeClient
   * @param {import('./PortfolioManager') | object} [deps.portfolioManager]  optional; applyFill is called when set.
   * @param {{ emitOrderLifecycle: Function, emitRiskDecision: Function }} [deps.realtimeNotifier]
   */
  constructor({ orderRepository, riskGuard, exchangeClient, portfolioManager = null, realtimeNotifier = null }) {
    super()
    if (!orderRepository) throw new Error('OrderManager requires orderRepository')
    if (!riskGuard) throw new Error('OrderManager requires riskGuard')
    if (!exchangeClient) throw new Error('OrderManager requires exchangeClient')
    this.orderRepository = orderRepository
    this.riskGuard = riskGuard
    this.exchangeClient = exchangeClient
    this.portfolioManager = portfolioManager
    this.realtimeNotifier = realtimeNotifier
  }

  setPortfolioManager(portfolioManager) {
    this.portfolioManager = portfolioManager
  }

  _validate(input) {
    const { symbol, side, type, quantity } = input || {}
    if (!symbol || typeof symbol !== 'string') {
      throw new ApplicationError('symbol is required', 'MISSING_FIELDS')
    }
    if (!VALID_SIDES.has(side)) {
      throw new ApplicationError(`side must be one of ${[...VALID_SIDES].join(',')}`, 'INVALID_SIDE')
    }
    if (!VALID_TYPES.has(type)) {
      throw new ApplicationError(`type must be one of ${[...VALID_TYPES].join(',')}`, 'INVALID_TYPE')
    }
    const qty = Number(quantity)
    if (!Number.isFinite(qty) || qty <= 0) {
      throw new ApplicationError('quantity must be a positive number', 'INVALID_QUANTITY')
    }
    if (type === 'LIMIT') {
      const price = Number(input.price)
      if (!Number.isFinite(price) || price <= 0) {
        throw new ApplicationError('price is required for LIMIT orders', 'INVALID_PRICE')
      }
    }
  }

  async _portfolioSnapshot(userId) {
    if (!this.portfolioManager || typeof this.portfolioManager.getSnapshot !== 'function') {
      return { positions: [], dailyPnl: 0 }
    }
    try {
      return await this.portfolioManager.getSnapshot({ userId })
    } catch (err) {
      logger.warn(`[OrderManager] portfolio snapshot failed: ${err.message}`)
      return { positions: [], dailyPnl: 0 }
    }
  }

  async _notifyLifecycle(order) {
    try {
      this.realtimeNotifier?.emitOrderLifecycle?.(order)
    } catch (err) {
      logger.warn(`[OrderManager] notify lifecycle failed: ${err.message}`)
    }
  }

  /**
   * Submit a new order.
   * @param {object} input
   * @returns {Promise<object>} persisted order record
   */
  async submit(input = {}) {
    this._validate(input)
    const symbol = String(input.symbol).toUpperCase()
    const userId = input.userId ?? null

    const portfolio = await this._portfolioSnapshot(userId)
    const candidate = {
      symbol,
      side: input.side,
      type: input.type,
      quantity: Number(input.quantity),
      price: input.price != null ? Number(input.price) : null,
      reduceOnly: !!input.reduceOnly,
    }

    const decision = await this.riskGuard.evaluate(candidate, portfolio)
    try {
      this.realtimeNotifier?.emitRiskDecision?.({ symbol, side: candidate.side, decision })
    } catch (err) {
      logger.warn(`[OrderManager] notify risk failed: ${err.message}`)
    }

    if (decision?.action === 'BLOCK') {
      throw new RiskViolationError(decision.reason || 'Order blocked by risk', { rule: decision.rule })
    }

    let finalQty = candidate.quantity
    if (decision?.action === 'REDUCE' && decision.adjustedQuantity != null) {
      finalQty = Number(decision.adjustedQuantity)
      if (!Number.isFinite(finalQty) || finalQty <= 0) {
        throw new RiskViolationError(decision.reason || 'Risk reduced quantity to 0', { rule: decision.rule })
      }
    }

    const orderId = crypto.randomUUID()
    const precomputedClientOrderId =
      typeof this.exchangeClient.getClientOrderId === 'function'
        ? this.exchangeClient.getClientOrderId({ ...input, orderId, symbol, quantity: finalQty })
        : null

    const order = {
      orderId,
      userId,
      mode: input.mode ?? null,
      sourceSignalId: input.sourceSignalId ?? null,
      closeReason: input.closeReason ?? null,
      entryPrice: input.entryPrice != null ? Number(input.entryPrice) : candidate.price,
      stopLoss: input.stopLoss != null ? Number(input.stopLoss) : null,
      takeProfit: input.takeProfit != null ? Number(input.takeProfit) : null,
      requestedQuantity: finalQty,
      executedQuantity: 0,
      averageFillPrice: null,
      lastFillPrice: null,
      grossNotional: 0,
      feeDetails: [],
      netRealizedProfit: 0,
      symbol,
      side: candidate.side,
      type: candidate.type,
      quantity: finalQty,
      price: candidate.price,
      reduceOnly: candidate.reduceOnly,
      status: 'NEW',
      createdAt: Date.now(),
      executedAt: null,
      fills: [],
      riskDecision: decision,
      reason: null,
      positionId: null,
      exchangeOrderId: null,
      clientOrderId: precomputedClientOrderId,
      exchangeStatus: null,
      exchangeEvents: [],
      realizedProfit: 0,
      commission: 0,
      commissionAsset: null,
    }
    await this.orderRepository.save(order)
    await this._notifyLifecycle(order)

    let exchangeResult
    try {
      exchangeResult = await this.exchangeClient.submit(order)
    } catch (err) {
      const failed = { ...order, status: 'REJECTED', reason: err.message, executedAt: Date.now() }
      await this.orderRepository.save(failed)
      await this._notifyLifecycle(failed)
      throw new OrderRejectedError(`Exchange error: ${err.message}`)
    }

    const resultFills = Array.isArray(exchangeResult.fills) ? exchangeResult.fills : []
    const fillQuantity = resultFills.reduce((acc, fill) => acc + Number(fill.quantity || 0), 0)
    const fillNotional = resultFills.reduce(
      (acc, fill) => acc + Number(fill.quantity || 0) * Number(fill.price || 0),
      0,
    )
    const derivedAverageFillPrice = fillQuantity > 0 ? fillNotional / fillQuantity : null

    const updated = {
      ...order,
      status: exchangeResult.status,
      exchangeOrderId: exchangeResult.exchangeOrderId ?? null,
      clientOrderId: exchangeResult.clientOrderId ?? null,
      exchangeStatus: exchangeResult.exchangeStatus ?? exchangeResult.status ?? null,
      exchangeEvents: exchangeResult.raw ? [exchangeResult.raw] : [],
      fills: resultFills,
      executedQuantity: Number(exchangeResult.executedQuantity ?? fillQuantity),
      averageFillPrice: exchangeResult.averageFillPrice ?? derivedAverageFillPrice,
      lastFillPrice: exchangeResult.lastFillPrice ?? resultFills.at(-1)?.price ?? null,
      grossNotional: Number(exchangeResult.grossNotional ?? fillNotional),
      executedAt: Date.now(),
      reason: exchangeResult.reason || null,
    }

    const shouldApplyPaperFill = updated.status === 'FILLED' && updated.mode !== 'live'
    if (shouldApplyPaperFill && this.portfolioManager?.applyFill) {
      try {
        const positionId = await this.portfolioManager.applyFill(updated)
        if (positionId) updated.positionId = positionId
      } catch (err) {
        logger.warn(`[OrderManager] portfolio applyFill failed: ${err.message}`)
      }
    } else if (updated.mode === 'live' && this.portfolioManager?.applyExchangeOrderUpdate) {
      this.portfolioManager.applyExchangeOrderUpdate(updated)
    }

    await this.orderRepository.save(updated)
    await this._notifyLifecycle(updated)

    if (updated.status === 'REJECTED') {
      throw new OrderRejectedError(updated.reason || 'Order rejected by exchange')
    }
    return updated
  }

  async cancel(orderId) {
    const order = await this.orderRepository.findById(orderId)
    if (!order) throw new ApplicationError(`Order ${orderId} not found`, 'ORDER_NOT_FOUND')
    if (['FILLED', 'CANCELED', 'REJECTED'].includes(order.status)) {
      return order
    }
    try {
      await this.exchangeClient.cancel(orderId)
    } catch (err) {
      logger.warn(`[OrderManager] exchange cancel failed: ${err.message}`)
    }
    const updated = { ...order, status: 'CANCELED', executedAt: Date.now() }
    await this.orderRepository.save(updated)
    await this._notifyLifecycle(updated)
    return updated
  }

  async get(orderId) {
    return this.orderRepository.findById(orderId)
  }

  async getOpen({ symbol, userId } = {}) {
    return this.orderRepository.findOpen({ symbol, userId })
  }

  async list({ symbol, userId, status, limit, page } = {}) {
    if (typeof this.orderRepository.list === 'function') {
      return this.orderRepository.list({ symbol, userId, status, limit, page })
    }
    return { items: [], total: 0, page: 1, limit: limit || 100 }
  }
}

module.exports = { OrderManager }
