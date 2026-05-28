'use strict'

const FUTURES_SOCKET_EVENTS = Object.freeze({
  ASSET_CONTEXT: 'futures:asset:context',
  ASSET_ERROR: 'futures:asset:error',

  MARKET_TICKER: 'futures:market:ticker',
  MARKET_MARK_PRICE: 'futures:market:markPrice',
  MARKET_CANDLE: 'futures:market:candle',

  BOOK_PARTIAL: 'futures:book:partial',
  BOOK_LOCAL: 'futures:book:local',
  BOOK_HEALTH: 'futures:book:health',

  TRADE_AGG: 'futures:trade:agg',

  ORDERFLOW_CVD: 'futures:orderflow:cvd',
  ORDERFLOW_FOOTPRINT: 'futures:orderflow:footprint',
  ORDERFLOW_FOOTPRINT_INIT: 'futures:orderflow:footprint:init',

  LIQUIDITY_SHIFT: 'futures:liquidity:shift',
  SPOOFING_CANDIDATE: 'futures:spoofing:candidate',

  SIGNAL_UPDATE: 'futures:signal:update',

  PAPER_TRADE_OPENED: 'futures:paperTrade:opened',
  PAPER_TRADE_UPDATED: 'futures:paperTrade:updated',
  PAPER_TRADE_CLOSED: 'futures:paperTrade:closed',

  // Phase 2.B — Coalesced batch variants. Emitted only when EMIT_BATCH_MODE=true.
  // Payload is an array of items each shaped like the corresponding non-batch event.
  TRADE_AGG_BATCH: 'futures:trade:agg:batch',
  MARKET_MARK_PRICE_BATCH: 'futures:market:markPrice:batch',
  ORDERFLOW_CVD_BATCH: 'futures:orderflow:cvd:batch',

  // Phase 6 — Future surfaces (risk / portfolio / orders). Defined now so the
  // wire contract is stable; backend will start emitting them when the relevant
  // managers come online.
  RISK_DECISION: 'futures:risk:decision',
  PORTFOLIO_SNAPSHOT: 'futures:portfolio:snapshot',
  ORDER_LIFECYCLE: 'futures:order:lifecycle',
})

const FUTURES_SOCKET_COMMANDS = Object.freeze({
  SUBSCRIBE_ASSET: 'futures:asset:subscribe',
  UNSUBSCRIBE_ASSET: 'futures:asset:unsubscribe',

  SIGNAL_POSITION_ACCEPT: 'futures:signal:position:accept',
  SIGNAL_POSITION_CLOSE: 'futures:signal:position:close',
})

module.exports = {
  FUTURES_SOCKET_EVENTS,
  FUTURES_SOCKET_COMMANDS,
}
