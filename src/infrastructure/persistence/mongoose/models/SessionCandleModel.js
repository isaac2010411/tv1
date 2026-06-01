'use strict'

const mongoose = require('mongoose')

const SessionCandleSchema = new mongoose.Schema(
  {
    sessionId: { type: String, required: true, index: true },
    symbol: { type: String, required: true, uppercase: true, trim: true, index: true },
    interval: { type: String, required: true, index: true },
    openTime: { type: Number, required: true, index: true },
    closeTime: { type: Number, default: null },
    open: { type: String, default: null },
    high: { type: String, default: null },
    low: { type: String, default: null },
    close: { type: String, default: null },
    volume: { type: String, default: null },
    isFinal: { type: Boolean, default: false, index: true },
    indicators: { type: mongoose.Schema.Types.Mixed, default: null },
    footprintSummary: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  {
    timestamps: true,
    versionKey: false,
    collection: 'session_candles',
  },
)

SessionCandleSchema.index({ sessionId: 1, symbol: 1, interval: 1, openTime: 1 }, { unique: true })
SessionCandleSchema.index({ symbol: 1, interval: 1, openTime: -1 })

const SessionCandleModel = mongoose.models.SessionCandle || mongoose.model('SessionCandle', SessionCandleSchema)

module.exports = {
  SessionCandleModel,
}
