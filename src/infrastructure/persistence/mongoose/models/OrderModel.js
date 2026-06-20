'use strict'

const mongoose = require('mongoose')

const FillSchema = new mongoose.Schema(
  {
    price: { type: Number, required: true },
    quantity: { type: Number, required: true },
    timestamp: { type: Number, required: true },
    exchangeOrderId: { type: String, default: null },
    clientOrderId: { type: String, default: null },
    executionType: { type: String, default: null },
  },
  { _id: false },
)

const OrderSchema = new mongoose.Schema(
  {
    orderId: { type: String, required: true, unique: true, index: true },
    userId: { type: String, default: null, index: true },
    mode: { type: String, enum: ['paper', 'live', null], default: null, index: true },
    sourceSignalId: { type: String, default: null, index: true },
    closeReason: { type: String, default: null },
    entryPrice: { type: Number, default: null },
    stopLoss: { type: Number, default: null },
    takeProfit: { type: Number, default: null },
    requestedQuantity: { type: Number, default: null },
    executedQuantity: { type: Number, default: 0 },
    averageFillPrice: { type: Number, default: null },
    lastFillPrice: { type: Number, default: null },
    grossNotional: { type: Number, default: 0 },
    symbol: { type: String, required: true, uppercase: true, trim: true, index: true },
    side: { type: String, required: true, enum: ['BUY', 'SELL'] },
    type: { type: String, required: true, enum: ['MARKET', 'LIMIT'] },
    quantity: { type: Number, required: true },
    price: { type: Number, default: null },
    status: {
      type: String,
      required: true,
      enum: ['NEW', 'PARTIAL', 'FILLED', 'CANCELED', 'REJECTED', 'DRY_RUN'],
      index: true,
    },
    reduceOnly: { type: Boolean, default: false },
    createdAt: { type: Number, required: true, index: true },
    executedAt: { type: Number, default: null },
    fills: { type: [FillSchema], default: [] },
    riskDecision: { type: Object, default: null },
    reason: { type: String, default: null },
    positionId: { type: String, default: null },
    exchangeOrderId: { type: String, default: null, index: true },
    clientOrderId: { type: String, default: null, index: true },
    exchangeStatus: { type: String, default: null, index: true },
    exchangeEvents: { type: [Object], default: [] },
    realizedProfit: { type: Number, default: 0 },
    commission: { type: Number, default: 0 },
    commissionAsset: { type: String, default: null },
    feeDetails: { type: [Object], default: [] },
    netRealizedProfit: { type: Number, default: 0 },
  },
  {
    versionKey: false,
    collection: 'futures_orders',
  },
)

OrderSchema.index({ symbol: 1, status: 1, createdAt: -1 })
OrderSchema.index({ userId: 1, createdAt: -1 })

const OrderModel = mongoose.models.FuturesOrder || mongoose.model('FuturesOrder', OrderSchema)

module.exports = { OrderModel }
