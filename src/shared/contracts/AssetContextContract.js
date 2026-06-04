'use strict'

const { InfrastructureError } = require('../errors/InfrastructureError')

function isObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function validateAssetContext(payload) {
  const errors = []

  if (!isObject(payload)) {
    errors.push('payload must be an object')
    return { ok: false, errors }
  }

  if (typeof payload.symbol !== 'string' || payload.symbol.trim() === '') {
    errors.push('symbol must be a non-empty string')
  }

  if (!isObject(payload.exchangeInfo)) {
    errors.push('exchangeInfo must be an object')
  }

  if (!isObject(payload.tradingRules)) {
    errors.push('tradingRules must be an object')
  }

  if (!isObject(payload.market)) {
    errors.push('market must be an object')
  } else {
    if (!isObject(payload.market.markPrice)) errors.push('market.markPrice must be an object')
    if (!isObject(payload.market.openInterest)) errors.push('market.openInterest must be an object')
    if (!isObject(payload.market.ticker24h)) errors.push('market.ticker24h must be an object')
  }

  if (!isObject(payload.orderbook)) {
    errors.push('orderbook must be an object')
  }

  if (!Array.isArray(payload.candles)) {
    errors.push('candles must be an array')
  }

  if (!isObject(payload.account)) {
    errors.push('account must be an object')
  } else {
    if (!isObject(payload.account.balance)) errors.push('account.balance must be an object')
    if (!Array.isArray(payload.account.positions)) errors.push('account.positions must be an array')
    if (!Array.isArray(payload.account.openOrders)) errors.push('account.openOrders must be an array')
  }

  return { ok: errors.length === 0, errors }
}

function assertAssetContext(payload, { channel = 'unknown' } = {}) {
  const result = validateAssetContext(payload)
  if (!result.ok) {
    throw new InfrastructureError(
      `Invalid AssetContext payload (${channel}): ${result.errors.join('; ')}`,
      'INVALID_ASSET_CONTEXT',
    )
  }
  return payload
}

module.exports = {
  validateAssetContext,
  assertAssetContext,
}
