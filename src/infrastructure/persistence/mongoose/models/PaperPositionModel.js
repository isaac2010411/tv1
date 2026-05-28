'use strict'

const mongoose = require('mongoose')

const PaperPositionSchema = new mongoose.Schema(
  {
    positionId: { type: String, required: true, unique: true, index: true },
    userId: { type: String, default: null, index: true },
    symbol: { type: String, required: true, uppercase: true, trim: true, index: true },
    direction: { type: String, required: true, enum: ['LONG', 'SHORT'] },
    entryPrice: { type: Number, required: true },
    quantity: { type: Number, default: null },
    stopLoss: { type: Number, default: null },
    takeProfit: { type: Number, default: null },
    openedAt: { type: Number, required: true, index: true },
    closedAt: { type: Number, default: null, index: true },
    status: { type: String, required: true, enum: ['OPEN', 'CLOSED'], index: true },
    sourceSignalId: { type: String, default: null },
    currentPrice: { type: Number, default: null },
    unrealizedPnl: { type: Number, default: null },
    realizedPnl: { type: Number, default: null },
    closeReason: { type: String, default: null },
  },
  {
    timestamps: true,
    versionKey: false,
    collection: 'paper_positions',
  },
)

PaperPositionSchema.index({ userId: 1, symbol: 1, openedAt: -1 })
PaperPositionSchema.index({ symbol: 1, openedAt: -1 })
PaperPositionSchema.index({ status: 1, openedAt: -1 })

const PaperPositionModel = mongoose.models.PaperPosition || mongoose.model('PaperPosition', PaperPositionSchema)

module.exports = {
  PaperPositionModel,
}
