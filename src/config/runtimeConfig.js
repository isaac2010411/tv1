'use strict'

const toList = (value) =>
  String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)

const toBoolean = (value) => ['1', 'true', 'yes', 'on'].includes(String(value || '').toLowerCase())

const toNumber = (value, fallback) => {
  if (value == null || value === '') return fallback
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

const toInteger = (value, fallback) => {
  const n = toNumber(value, fallback)
  return Number.isFinite(n) ? Math.trunc(n) : fallback
}

const loadExecutionMode = (raw) => {
  const v = String(raw || 'auto').toLowerCase()
  return v === 'semi' || v === 'manual' ? 'semi' : 'auto'
}

const loadScalpConfig = (env) => ({
  // 'scalp' enables the micro-operation profile (order-flow heavy weights,
  // counter-trend EMA gate, cost-aware risk gate, time-stop). 'default'
  // keeps the legacy behavior.
  horizon: (env.SIGNAL_HORIZON || 'default').toLowerCase() === 'scalp' ? 'scalp' : 'default',
  // 'auto' (default) → the bot executes every signal that passes hard
  // risk gates without asking the user. 'semi' → keep the popup-based
  // manual review for soft-fail signals (low confidence / R/R / spoofing).
  executionMode: loadExecutionMode(env.EXECUTION_MODE),
  // Override for how long an entry signal stays valid for the *human* to
  // approve when running in semi-manual mode. Defaults to 60s (vs the
  // engine's 10–30s ATR-scaled default) so the popup doesn't expire while
  // the trader is still looking at it. Set to 0 to disable the override.
  manualReviewExpiryMs: toNumber(env.MANUAL_REVIEW_EXPIRY_MS, 60_000),
  account: {
    equity: toNumber(env.PAPER_ACCOUNT_EQUITY, 10_000),
    riskPerTradePct: toNumber(env.RISK_PER_TRADE_PCT, 0.005),
    maxNotional: toNumber(env.RISK_MAX_NOTIONAL_PER_ORDER, undefined),
    contractMultiplier: toNumber(env.CONTRACT_MULTIPLIER, 1),
  },
  costs: {
    feeBps: toNumber(env.TRADING_FEE_BPS, 4),
    slippageBps: toNumber(env.TRADING_SLIPPAGE_BPS, 2),
    edgeMultiple: toNumber(env.TRADING_EDGE_MULTIPLE, 3),
  },
  position: {
    // Time-stop in ms. 0 disables (default). 60_000 recommended for scalp.
    timeStopMs: toNumber(env.POSITION_TIME_STOP_MS, 0),
    minTpProgress: toNumber(env.POSITION_MIN_TP_PROGRESS, 0.30),
  },
})

const loadRuntimeConfig = (env = process.env) => {
  const nodeEnv = env.NODE_ENV || 'development'
  const allowedOrigins = toList(env.CORS_ALLOWED_ORIGINS)
  const allowOpenCors = nodeEnv !== 'production' && allowedOrigins.length === 0
  const tradingMode = String(env.TRADING_MODE || 'paper').toLowerCase()

  if (!['paper', 'live'].includes(tradingMode)) {
    throw new Error('TRADING_MODE must be paper or live')
  }

  if (tradingMode === 'live' && !toBoolean(env.ENABLE_LIVE_TRADING)) {
    throw new Error('ENABLE_LIVE_TRADING must be true when TRADING_MODE is live')
  }

  const liveDryRun = toBoolean(env.LIVE_DRY_RUN)
  const liveSymbolAllowlist = toList(env.LIVE_SYMBOL_ALLOWLIST).map((symbol) => symbol.toUpperCase())
  const liveMaxOpenPositions = toInteger(env.LIVE_MAX_OPEN_POSITIONS, 1)
  const liveMaxNotionalPerOrder = toNumber(env.LIVE_MAX_NOTIONAL_PER_ORDER, 50)
  const liveMaxDailyLoss = toNumber(env.LIVE_MAX_DAILY_LOSS, 20)
  const liveRequireUserStream = env.LIVE_REQUIRE_USER_STREAM == null
    ? true
    : toBoolean(env.LIVE_REQUIRE_USER_STREAM)
  const liveOrderFillTimeoutMs = toInteger(env.LIVE_ORDER_FILL_TIMEOUT_MS, 10_000)

  if (tradingMode === 'live') {
    if (liveSymbolAllowlist.length === 0) {
      throw new Error('LIVE_SYMBOL_ALLOWLIST is required when TRADING_MODE is live')
    }
    if (!Number.isFinite(liveMaxOpenPositions) || liveMaxOpenPositions <= 0) {
      throw new Error('LIVE_MAX_OPEN_POSITIONS must be greater than 0 when TRADING_MODE is live')
    }
    if (!Number.isFinite(liveMaxNotionalPerOrder) || liveMaxNotionalPerOrder <= 0) {
      throw new Error('LIVE_MAX_NOTIONAL_PER_ORDER must be greater than 0 when TRADING_MODE is live')
    }
    if (!Number.isFinite(liveMaxDailyLoss) || liveMaxDailyLoss <= 0) {
      throw new Error('LIVE_MAX_DAILY_LOSS must be greater than 0 when TRADING_MODE is live')
    }
  }

  if (nodeEnv === 'production' && allowedOrigins.length === 0) {
    throw new Error('CORS_ALLOWED_ORIGINS is required in production')
  }

  const corsOptions = {
    origin(origin, callback) {
      if (allowOpenCors) return callback(null, true)
      if (!origin || allowedOrigins.includes(origin)) return callback(null, true)
      return callback(new Error('Origin not allowed by CORS'))
    },
    methods: ['GET', 'POST'],
    credentials: true,
  }

  return {
    nodeEnv,
    port: Number.parseInt(env.PORT || '5000', 10),
    tradingMode,
    liveTradingEnabled: toBoolean(env.ENABLE_LIVE_TRADING),
    liveDryRun,
    liveSymbolAllowlist,
    liveMaxOpenPositions,
    liveMaxNotionalPerOrder,
    liveMaxDailyLoss,
    liveRequireUserStream,
    liveOrderFillTimeoutMs,
    corsOptions,
    binance: {
      apiKey: env.BINANCE_API_KEY || '',
      apiSecret: env.BINANCE_SECRET_KEY || '',
    },
    mongo: {
      uri: env.MONGO_URI || '',
      dbName: env.MONGO_DB_NAME || undefined,
    },
    scalp: loadScalpConfig(env),
  }
}

module.exports = { loadRuntimeConfig }
