'use strict'

/**
 * Loads risk rule configuration from environment variables. Values are read
 * once at composition time; if a var is absent the rule is disabled (Infinity).
 *
 * Env vars:
 *   RISK_MAX_ORDER_QTY            – max quantity per single order
 *   RISK_MAX_NOTIONAL_PER_SYMBOL  – max |qty * price| per symbol (open + new)
 *   RISK_MAX_OPEN_POSITIONS       – max OPEN positions across all symbols
 *   RISK_MAX_DAILY_LOSS           – max absolute realized + unrealized loss per UTC day
 *   RISK_ALLOWED_SYMBOLS          – CSV whitelist; empty = allow all
 */
const num = (v, fallback) => {
  if (v == null || v === '') return fallback
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

const loadRiskRulesConfig = (env = process.env) => {
  const allowedRaw = String(env.RISK_ALLOWED_SYMBOLS || '').trim()
  return {
    maxOrderQty: num(env.RISK_MAX_ORDER_QTY, Number.POSITIVE_INFINITY),
    maxNotionalPerSymbol: num(env.RISK_MAX_NOTIONAL_PER_SYMBOL, Number.POSITIVE_INFINITY),
    maxOpenPositions: num(env.RISK_MAX_OPEN_POSITIONS, Number.POSITIVE_INFINITY),
    maxDailyLoss: num(env.RISK_MAX_DAILY_LOSS, Number.POSITIVE_INFINITY),
    allowedSymbols: allowedRaw
      ? allowedRaw
          .split(',')
          .map((s) => s.trim().toUpperCase())
          .filter(Boolean)
      : [],
  }
}

module.exports = { loadRiskRulesConfig }
