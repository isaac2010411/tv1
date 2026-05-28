'use strict'

const mongoose = require('mongoose')

const FillSchema = new mongoose.Schema(
  {
    price: { type: Number, required: true },
    quantity: { type: Number, required: true },
    timestamp: { type: Number, required: true },
  },
  { _id: false },
)

const OrderSchema = new mongoose.Schema(
  {
    orderId: { type: String, required: true, unique: true, index: true },
    userId: { type: String, default: null, index: true },
    symbol: { type: String, required: true, uppercase: true, trim: true, index: true },
    side: { type: String, required: true, enum: ['BUY', 'SELL'] },
    type: { type: String, required: true, enum: ['MARKET', 'LIMIT'] },
    quantity: { type: Number, required: true },
    price: { type: Number, default: null },
    status: {
      type: String,
      required: true,
      enum: ['NEW', 'PARTIAL', 'FILLED', 'CANCELED', 'REJECTED'],
      index: true,
    },
    reduceOnly: { type: Boolean, default: false },
    createdAt: { type: Number, required: true, index: true },
    executedAt: { type: Number, default: null },
    fills: { type: [FillSchema], default: [] },
    riskDecision: { type: Object, default: null },
    reason: { type: String, default: null },
    positionId: { type: String, default: null },
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
