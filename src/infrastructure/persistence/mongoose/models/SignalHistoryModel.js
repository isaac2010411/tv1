'use strict'

const mongoose = require('mongoose')

const SignalHistorySchema = new mongoose.Schema(
  {
    timestamp: { type: Number, required: true, index: true },
    symbol: { type: String, required: true, uppercase: true, trim: true, index: true },
    interval: { type: String, default: '1m' },
    state: { type: String, required: true, index: true },
    prevState: { type: String, default: null },
    netScore: { type: Number, default: 0 },
    confidence: { type: Number, default: 0 },
    reasons: { type: [String], default: [] },
    missingContext: { type: [String], default: [] },
    decision: {
      type: String,
      default: 'SIGNAL_UPDATE',
      enum: [
        'SIGNAL_UPDATE',
        'AUTO_EXECUTED',
        'AUTO_ACCEPTED',
        'AUTO_CLOSED',
        'POSITION_ACCEPTED',
        'POSITION_CLOSED',
        'PAPER_TRADE_OPENED',
        'PAPER_TRADE_CLOSED',
      ],
      index: true,
    },
    activeSignalId: { type: String, default: null },
    positionId: { type: String, default: null },
    orderBookSnapshotId: { type: String, default: null },
    cvdSnapshotId: { type: String, default: null },
    footprintSnapshotId: { type: String, default: null },
  },
  {
    timestamps: true,
    versionKey: false,
    collection: 'signal_history',
  },
)

SignalHistorySchema.index({ symbol: 1, timestamp: -1 })
SignalHistorySchema.index({ state: 1, timestamp: -1 })
SignalHistorySchema.index({ decision: 1, timestamp: -1 })

const SignalHistoryModel = mongoose.models.SignalHistory || mongoose.model('SignalHistory', SignalHistorySchema)

module.exports = {
  SignalHistoryModel,
}
