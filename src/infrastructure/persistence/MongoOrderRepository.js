'use strict'

const { OrderRepositoryPort } = require('../../domain/futures/ports/outbound/OrderRepositoryPort')
const { OrderModel } = require('./mongoose/models/OrderModel')
const { isMongoConnected } = require('../db/mongoose')
const { logger } = require('../../shared/utils/logger')

/**
 * MongoOrderRepository — Mongoose-backed implementation of {@link OrderRepositoryPort}.
 *
 * When Mongo is not connected (e.g. tests, local without DB), the repo falls
 * back to an in-memory Map so the OMS still functions end-to-end. This is
 * intentional: paper trading should not require persistence to be available.
 */
class MongoOrderRepository extends OrderRepositoryPort {
  constructor() {
    super()
    this._fallback = new Map() // orderId -> doc
  }

  _useDb() {
    return isMongoConnected()
  }

  async save(order) {
    if (!order?.orderId) throw new Error('order.orderId is required')
    if (!this._useDb()) {
      this._fallback.set(order.orderId, { ...order })
      return order
    }
    try {
      await OrderModel.updateOne(
        { orderId: order.orderId },
        { $set: order },
        { upsert: true },
      )
      return order
    } catch (err) {
      logger.warn(`[MongoOrderRepository] save failed: ${err.message}`)
      throw err
    }
  }

  async findById(orderId) {
    if (!this._useDb()) {
      const doc = this._fallback.get(orderId)
      return doc ? { ...doc } : null
    }
    const doc = await OrderModel.findOne({ orderId }).lean()
    return doc || null
  }

  async findByClientOrderId(clientOrderId) {
    if (!clientOrderId) return null
    if (!this._useDb()) {
      const doc = Array.from(this._fallback.values()).find((o) => o.clientOrderId === clientOrderId)
      return doc ? { ...doc } : null
    }
    const doc = await OrderModel.findOne({ clientOrderId }).lean()
    return doc || null
  }

  async findByExchangeOrderId(exchangeOrderId) {
    if (!exchangeOrderId) return null
    const id = String(exchangeOrderId)
    if (!this._useDb()) {
      const doc = Array.from(this._fallback.values()).find((o) => String(o.exchangeOrderId) === id)
      return doc ? { ...doc } : null
    }
    const doc = await OrderModel.findOne({ exchangeOrderId: id }).lean()
    return doc || null
  }

  async findOpen({ symbol, userId } = {}) {
    const openStatuses = ['NEW', 'PARTIAL']
    if (!this._useDb()) {
      return Array.from(this._fallback.values()).filter((o) => {
        if (!openStatuses.includes(o.status)) return false
        if (symbol && String(o.symbol).toUpperCase() !== String(symbol).toUpperCase()) return false
        if (userId && o.userId !== userId) return false
        return true
      })
    }
    const q = { status: { $in: openStatuses } }
    if (symbol) q.symbol = String(symbol).toUpperCase()
    if (userId) q.userId = userId
    return OrderModel.find(q).sort({ createdAt: -1 }).lean()
  }

  async list({ symbol, userId, status, limit = 100, page = 1 } = {}) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 500))
    const safePage = Math.max(1, Number(page) || 1)
    if (!this._useDb()) {
      let items = Array.from(this._fallback.values())
      if (symbol) items = items.filter((o) => o.symbol === String(symbol).toUpperCase())
      if (userId) items = items.filter((o) => o.userId === userId)
      if (status) items = items.filter((o) => o.status === String(status).toUpperCase())
      const total = items.length
      const start = (safePage - 1) * safeLimit
      return { items: items.slice(start, start + safeLimit), total, page: safePage, limit: safeLimit }
    }
    const q = {}
    if (symbol) q.symbol = String(symbol).toUpperCase()
    if (userId) q.userId = userId
    if (status) q.status = String(status).toUpperCase()
    const skip = (safePage - 1) * safeLimit
    const [items, total] = await Promise.all([
      OrderModel.find(q).sort({ createdAt: -1 }).skip(skip).limit(safeLimit).lean(),
      OrderModel.countDocuments(q),
    ])
    return { items, total, page: safePage, limit: safeLimit }
  }

  async updateStatus(orderId, patch = {}) {
    const existing = await this.findById(orderId)
    if (!existing) return null
    const updated = { ...existing, ...patch }
    await this.save(updated)
    return updated
  }

  async appendExchangeEvent(orderId, event) {
    const existing = await this.findById(orderId)
    if (!existing) return null
    const updated = {
      ...existing,
      exchangeEvents: [...(existing.exchangeEvents ?? []), event],
    }
    await this.save(updated)
    return updated
  }
}

module.exports = { MongoOrderRepository }
