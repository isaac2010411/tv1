'use strict'

const { randomUUID } = require('crypto')
const {
  SIGNAL_STATES,
  ENTRY_SIGNAL_STATES,
  EXIT_SIGNAL_STATES,
  EXIT_WARNING_STATES,
  LONG_STATES,
  SHORT_STATES,
  ENTRY_SIGNAL_EXPIRY_MS,
  EXIT_SIGNAL_EXPIRY_MS,
} = require('./signalEngineStates')

/**
 * Returns true when the given state should produce (or update) a signal object.
 * @param {string} state
 * @returns {boolean}
 */
function stateRequiresSignal(state) {
  return (
    ENTRY_SIGNAL_STATES.has(state) ||
    EXIT_SIGNAL_STATES.has(state)  ||
    EXIT_WARNING_STATES.has(state)
  )
}

/**
 * Derive signal direction from state.
 * @param {string} state
 * @returns {'long'|'short'|null}
 */
function _direction(state) {
  if (LONG_STATES.has(state))  return 'long'
  if (SHORT_STATES.has(state)) return 'short'
  return null
}

/**
 * Derive signal type (ENTRY | EXIT | WARNING) from state.
 * @param {string} state
 * @returns {'ENTRY'|'EXIT'|'WARNING'|null}
 */
function _type(state) {
  if (ENTRY_SIGNAL_STATES.has(state))  return 'ENTRY'
  if (EXIT_SIGNAL_STATES.has(state))   return 'EXIT'
  if (EXIT_WARNING_STATES.has(state))  return 'WARNING'
  return null
}

/**
 * Human-readable action verb for the signal.
 * @param {string} state
 * @returns {string}
 */
function _action(state) {
  const map = {
    [SIGNAL_STATES.LONG_ENTRY_SIGNAL]:  'ENTER LONG',
    [SIGNAL_STATES.SHORT_ENTRY_SIGNAL]: 'ENTER SHORT',
    [SIGNAL_STATES.LONG_EXIT_WARNING]:  'WATCH EXIT LONG',
    [SIGNAL_STATES.SHORT_EXIT_WARNING]: 'WATCH EXIT SHORT',
    [SIGNAL_STATES.LONG_EXIT_SIGNAL]:   'EXIT LONG',
    [SIGNAL_STATES.SHORT_EXIT_SIGNAL]:  'EXIT SHORT',
  }
  return map[state] ?? ''
}

/**
 * Build signal title text.
 * @param {string} state
 * @param {number} confidence
 * @returns {string}
 */
function _title(state, confidence) {
  const type  = _type(state)
  const dir   = _direction(state)
  const dirLabel = dir ? dir.toUpperCase() : ''
  if (type === 'ENTRY')   return `${dirLabel} Entry Signal — ${confidence}% confidence`
  if (type === 'EXIT')    return `Exit ${dirLabel} Position`
  if (type === 'WARNING') return `Exit Warning — ${dirLabel} weakening`
  return state
}

/**
 * Build summary text for the signal card.
 * @param {string} state
 * @param {number} score
 * @param {string[]} reasons
 * @returns {string}
 */
function _summary(state, score, reasons) {
  const dir  = _direction(state)
  const type = _type(state)
  const top = reasons[0]
  const topReason = (typeof top === 'string' ? top : top?.label) ?? 'Multiple converging factors'

  if (type === 'ENTRY') {
    return `${dir === 'long' ? 'Bullish' : 'Bearish'} momentum detected (score ${(score * 100).toFixed(0)}%). ${topReason}.`
  }
  if (type === 'EXIT') {
    return `Momentum reverting. Consider closing ${dir} position.`
  }
  if (type === 'WARNING') {
    return `${dir === 'long' ? 'Long' : 'Short'} bias weakening. Monitor closely.`
  }
  return ''
}

/**
 * Creates the full signal output contract.
 *
 * @param {object} params
 * @param {string}   params.symbol
 * @param {string}   params.state
 * @param {number}   params.netScore
 * @param {number}   params.confidence
 * @param {string[]} params.reasons
 * @param {string[]} params.missingContext
 * @param {object}   params.factors        MarketFactors from MarketContextEvaluator
 * @param {{ entryExpiryMs: number, exitExpiryMs: number }} [params.timing]  Dynamic timing from engine
 * @returns {object|null}  Signal contract, or null if state doesn't require a signal.
 */
function createSignal({ symbol, state, netScore, confidence, reasons, missingContext, factors, timing }) {
  if (!stateRequiresSignal(state)) return null

  const direction = _direction(state)
  const type      = _type(state)
  const now       = Date.now()

  const entryMs  = timing?.entryExpiryMs ?? ENTRY_SIGNAL_EXPIRY_MS
  const exitMs   = timing?.exitExpiryMs  ?? EXIT_SIGNAL_EXPIRY_MS

  const expiresAt = ENTRY_SIGNAL_STATES.has(state)
    ? now + entryMs
    : EXIT_SIGNAL_STATES.has(state)
      ? now + exitMs
      : null

  // ── Risk calculation ──────────────────────────────────────────────────────
  const { price, atr } = factors
  let risk = null
  if (type === 'ENTRY' && price && atr) {
    const stopDist = atr * 1.5
    const tpDist   = atr * 3.0

    const entryPrice        = price
    const stopLoss          = direction === 'long' ? price - stopDist : price + stopDist
    const takeProfit        = direction === 'long' ? price + tpDist   : price - tpDist
    const invalidationPrice = direction === 'long' ? price - atr * 2  : price + atr * 2

    risk = {
      entryPrice:        +entryPrice.toFixed(4),
      stopLoss:          +stopLoss.toFixed(4),
      takeProfit:        +takeProfit.toFixed(4),
      invalidationPrice: +invalidationPrice.toFixed(4),
      riskReward:        '2.00:1',
    }
  }

  return {
    id:             randomUUID(),
    symbol,
    direction,
    type,
    action:         _action(state),
    state,
    confidence,
    score:          +netScore.toFixed(4),
    title:          _title(state, confidence),
    summary:        _summary(state, netScore, reasons),
    reasons:        reasons.slice(0, 5),
    missingContext: missingContext ?? [],
    risk,
    createdAt:      now,
    expiresAt,
    source:         'STATE_MACHINE_SIGNAL_ENGINE',
  }
}

module.exports = { createSignal, stateRequiresSignal }
