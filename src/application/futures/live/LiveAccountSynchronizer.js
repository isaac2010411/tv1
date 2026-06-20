'use strict'

const { logger } = require('../../../shared/utils/logger')

class LiveAccountSynchronizer {
  constructor({ portfolioManager, orderRepository, realtimeNotifier = null, assetContextManager = null } = {}) {
    if (!portfolioManager) throw new Error('LiveAccountSynchronizer requires portfolioManager')
    if (!orderRepository) throw new Error('LiveAccountSynchronizer requires orderRepository')
    this.portfolioManager = portfolioManager
    this.orderRepository = orderRepository
    this.realtimeNotifier = realtimeNotifier
    this.assetContextManager = assetContextManager
  }

  async handleAccountUpdate(update) {
    this.portfolioManager.applyExchangeAccountUpdate(update)
    const snapshot = this.portfolioManager.getLiveSnapshot()
    this.realtimeNotifier?.emitPortfolioSnapshot?.(snapshot)
    for (const position of update?.positions ?? []) {
      if (position?.symbol) {
        this.realtimeNotifier?._scheduleAssetContextRefresh?.(position.symbol, 'LIVE_ACCOUNT_UPDATE')
      }
    }
    return snapshot
  }

  async handleOrderTradeUpdate(update) {
    let order = null
    if (update?.clientOrderId && typeof this.orderRepository.findByClientOrderId === 'function') {
      order = await this.orderRepository.findByClientOrderId(update.clientOrderId)
    }
    if (!order && update?.exchangeOrderId && typeof this.orderRepository.findByExchangeOrderId === 'function') {
      order = await this.orderRepository.findByExchangeOrderId(update.exchangeOrderId)
    }
    if (order && typeof this.orderRepository.appendExchangeEvent === 'function') {
      order = await this.orderRepository.appendExchangeEvent(order.orderId, update)
    } else if (order) {
      order.exchangeEvents = [...(order.exchangeEvents ?? []), update]
      await this.orderRepository.save(order)
    }
    if (order) {
      const fill = this._fillFromUpdate(update)
      const fee = this._feeFromUpdate(update)
      const fills = fill ? [...(order.fills ?? []), fill] : (order.fills ?? [])
      const feeDetails = fee ? [...(order.feeDetails ?? []), fee] : (order.feeDetails ?? [])
      const executedQuantity = Number(update.accumulatedFilledQty ?? order.executedQuantity ?? 0)
      const averageFillPrice = Number(update.averagePrice || order.averageFillPrice || 0)
      const lastFillPrice = Number(update.lastFilledPrice || order.lastFillPrice || 0)
      const grossNotional = Number.isFinite(executedQuantity) && Number.isFinite(averageFillPrice)
        ? executedQuantity * averageFillPrice
        : Number(order.grossNotional || 0)
      const realizedProfit = Number(order.realizedProfit || 0) + Number(update.realizedProfit || 0)
      const commission = Number(order.commission || 0) + Number(update.commission || 0)
      const updated = {
        ...order,
        exchangeStatus: update.status ?? order.exchangeStatus ?? null,
        status: this._domainStatus(update.status ?? order.status),
        exchangeOrderId: update.exchangeOrderId ?? order.exchangeOrderId ?? null,
        clientOrderId: update.clientOrderId ?? order.clientOrderId ?? null,
        fills,
        executedQuantity,
        averageFillPrice: Number.isFinite(averageFillPrice) && averageFillPrice > 0 ? averageFillPrice : null,
        lastFillPrice: Number.isFinite(lastFillPrice) && lastFillPrice > 0 ? lastFillPrice : null,
        grossNotional,
        realizedProfit,
        commission,
        commissionAsset: update.commissionAsset ?? order.commissionAsset ?? null,
        feeDetails,
        netRealizedProfit: realizedProfit - commission,
        executedAt: ['FILLED', 'CANCELED', 'REJECTED', 'EXPIRED'].includes(update.status) ? Date.now() : order.executedAt,
      }
      await this.orderRepository.save(updated)
      this.realtimeNotifier?.emitOrderLifecycle?.(updated)
      order = updated
    } else {
      logger.warn(
        `[LiveAccountSynchronizer] order not found for clientOrderId=${update?.clientOrderId ?? 'null'} ` +
          `exchangeOrderId=${update?.exchangeOrderId ?? 'null'} status=${update?.status ?? 'null'}`,
      )
    }

    this.portfolioManager.applyExchangeOrderUpdate(order ?? update)
    this.realtimeNotifier?.emitPortfolioSnapshot?.(this.portfolioManager.getLiveSnapshot())
    if (update?.symbol) this.realtimeNotifier?._scheduleAssetContextRefresh?.(update.symbol, 'LIVE_ORDER_UPDATE')
    return order
  }

  _domainStatus(status) {
    if (status === 'PARTIALLY_FILLED') return 'PARTIAL'
    if (status === 'EXPIRED') return 'REJECTED'
    return status
  }

  _fillFromUpdate(update = {}) {
    const quantity = Number(update.lastFilledQty || 0)
    const price = Number(update.lastFilledPrice || update.averagePrice || 0)
    if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(price) || price <= 0) return null
    return {
      price,
      quantity,
      timestamp: Number(update.transactionTime || update.eventTime || Date.now()),
      exchangeOrderId: update.exchangeOrderId ?? null,
      clientOrderId: update.clientOrderId ?? null,
      executionType: update.executionType ?? null,
    }
  }

  _feeFromUpdate(update = {}) {
    const amount = Number(update.commission || 0)
    if (!Number.isFinite(amount) || amount <= 0) return null
    return {
      asset: update.commissionAsset ?? null,
      amount,
      timestamp: Number(update.transactionTime || update.eventTime || Date.now()),
      exchangeOrderId: update.exchangeOrderId ?? null,
      clientOrderId: update.clientOrderId ?? null,
    }
  }
}

module.exports = { LiveAccountSynchronizer }
