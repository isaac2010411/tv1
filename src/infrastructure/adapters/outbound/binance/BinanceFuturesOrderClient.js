'use strict'

const { FuturesExecutionPort } = require('../../../../domain/futures/ports/outbound/FuturesExecutionPort')

class BinanceFuturesOrderClient extends FuturesExecutionPort {
  constructor({ binanceClient, dryRun = false }) {
    super()
    if (!binanceClient) throw new Error('BinanceFuturesOrderClient requires binanceClient')
    this.client = binanceClient
    this.dryRun = !!dryRun
  }

  getClientOrderId(order) {
    const raw = String(order?.orderId || Date.now()).replace(/-/g, '').replace(/[^a-zA-Z0-9_]/g, '')
    return `tv1_${raw.slice(0, 24)}`
  }

  _payload(order) {
    const type = String(order.type || '').toUpperCase()
    const payload = {
      symbol: String(order.symbol || '').toUpperCase(),
      side: String(order.side || '').toUpperCase(),
      type,
      quantity: String(order.quantity),
      reduceOnly: order.reduceOnly ? 'true' : 'false',
      newClientOrderId: order.clientOrderId ?? this.getClientOrderId(order),
      newOrderRespType: 'RESULT',
    }

    if (type === 'LIMIT') {
      payload.price = String(order.price)
      payload.timeInForce = 'GTC'
    }

    return payload
  }

  _executionFromResponse(response = {}) {
    const executedQuantity = Number(response.executedQty ?? response.cumQty ?? 0)
    const averageFillPrice = Number(response.avgPrice ?? 0)
    const grossNotional = Number(response.cumQuote ?? executedQuantity * averageFillPrice)
    const hasFill = executedQuantity > 0 && averageFillPrice > 0
    const fill = hasFill
      ? {
          price: averageFillPrice,
          quantity: executedQuantity,
          timestamp: Number(response.updateTime ?? Date.now()),
          exchangeOrderId: response.orderId != null ? String(response.orderId) : null,
          clientOrderId: response.clientOrderId ?? null,
          executionType: 'REST_RESULT',
        }
      : null

    return {
      executedQuantity: Number.isFinite(executedQuantity) ? executedQuantity : 0,
      averageFillPrice: hasFill ? averageFillPrice : null,
      lastFillPrice: hasFill ? averageFillPrice : null,
      grossNotional: Number.isFinite(grossNotional) ? grossNotional : 0,
      fills: fill ? [fill] : [],
    }
  }

  async submit(order) {
    const payload = this._payload(order)
    if (this.dryRun) {
      return {
        status: 'DRY_RUN',
        clientOrderId: payload.newClientOrderId,
        exchangeOrderId: null,
        exchangeStatus: 'DRY_RUN',
        fills: [],
        raw: payload,
      }
    }

    const response = await this.client.futuresOrder(payload)
    const execution = this._executionFromResponse(response)
    return {
      status: response.status,
      exchangeOrderId: response.orderId != null ? String(response.orderId) : null,
      clientOrderId: response.clientOrderId ?? payload.newClientOrderId,
      exchangeStatus: response.status ?? null,
      ...execution,
      raw: response,
    }
  }

  async cancel(orderId) {
    return { ok: true, orderId }
  }

  async getOrder(query) {
    if (this.dryRun) return null
    return this.client.futuresGetOrder(query)
  }
}

module.exports = { BinanceFuturesOrderClient }
