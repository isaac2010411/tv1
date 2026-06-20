'use strict'

const toNumber = (value, fallback = 0) => {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

const mapOrderTradeUpdate = (payload = {}) => {
  const order = payload.order ?? payload.o ?? payload
  return {
    eventTime: payload.eventTime ?? payload.E ?? null,
    transactionTime: payload.transactionTime ?? payload.T ?? null,
    symbol: order.symbol ?? order.s ?? null,
    clientOrderId: order.clientOrderId ?? order.c ?? payload.clientOrderId ?? null,
    exchangeOrderId: order.orderId != null
      ? String(order.orderId)
      : order.i != null
        ? String(order.i)
        : payload.orderId != null
          ? String(payload.orderId)
          : null,
    side: order.side ?? order.S ?? null,
    type: order.type ?? order.orderType ?? order.o ?? null,
    executionType: order.executionType ?? order.x ?? null,
    status: order.status ?? order.orderStatus ?? order.X ?? null,
    lastFilledQty: toNumber(order.lastFilledQty ?? order.lastTradeQuantity ?? order.l),
    accumulatedFilledQty: toNumber(order.accumulatedFilledQty ?? order.totalTradeQuantity ?? order.z),
    lastFilledPrice: toNumber(order.lastFilledPrice ?? order.priceLastTrade ?? order.L),
    averagePrice: toNumber(order.averagePrice ?? order.ap),
    commissionAsset: order.commissionAsset ?? order.N ?? null,
    commission: toNumber(order.commission ?? order.n),
    realizedProfit: toNumber(order.realizedProfit ?? order.rp),
    reduceOnly: Boolean(order.reduceOnly ?? order.isReduceOnly ?? order.R),
    positionSide: order.positionSide ?? order.ps ?? 'BOTH',
  }
}

module.exports = { mapOrderTradeUpdate }
