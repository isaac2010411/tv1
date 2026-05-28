'use strict'

const { SIGNAL_STATES: S } = require('./signalEngineStates')

/**
 * Domain Service: data-driven state transition resolver.
 *
 * All score thresholds and timing values are dynamic — they arrive via
 * `ctx.thresholds` and `ctx.timing`, computed per-asset each tick by
 * StateMachineSignalEngine from ATR% and spread. This makes the engine
 * self-calibrating: low-volatility scalp assets (e.g. XRP 1m) get tighter
 * thresholds and shorter cooldowns automatically.
 *
 * Transition context:
 * @typedef {object} TransitionContext
 * @property {number}  netScore              Attenuated score in [-1, 1]
 * @property {number}  confidence            0-100
 * @property {boolean} hasPosition           True when a local position is open
 * @property {string}  positionDirection     'long' | 'short' | null
 * @property {boolean} positionAccepted      True when the frontend just accepted a signal
 * @property {boolean} positionClosed        True when the frontend just closed a position
 * @property {boolean} nearTakeProfit        Price ≥ 80% of the way to TP
 * @property {boolean} nearInvalidation      Price moved adversely > 0.5× ATR from entry
 * @property {number}  stateAgeMs            How long the engine has been in currentState
 * @property {number}  signalAgeMs           How long since the last entry/exit signal was issued
 * @property {string}  currentState          Current state name
 * @property {{ observe, bias, setup, entry, minConfidence, exitWarn, exitRecover }} thresholds
 * @property {{ cooldownMs, entryExpiryMs, exitExpiryMs }} timing
 */

// ─── Transition table ─────────────────────────────────────────────────────────
// Guards receive (ctx: TransitionContext) → boolean.
// Within the same `from`, highest priority that matches wins.

const TRANSITIONS = [
  // ── IDLE ──────────────────────────────────────────────────────────────────
  { from: S.IDLE, to: S.OBSERVING,
    guard: (ctx) => Math.abs(ctx.netScore) > ctx.thresholds.observe,
    priority: 10 },

  // ── OBSERVING ─────────────────────────────────────────────────────────────
  { from: S.OBSERVING, to: S.LONG_BIAS,
    guard: (ctx) => ctx.netScore > ctx.thresholds.bias,
    priority: 20 },
  { from: S.OBSERVING, to: S.SHORT_BIAS,
    guard: (ctx) => ctx.netScore < -ctx.thresholds.bias,
    priority: 20 },
  { from: S.OBSERVING, to: S.IDLE,
    guard: (ctx) => Math.abs(ctx.netScore) <= ctx.thresholds.observe && ctx.stateAgeMs > 5_000,
    priority: 5 },

  // ── LONG_BIAS ─────────────────────────────────────────────────────────────
  // Fast-track: skip SETUP when momentum already at entry strength
  { from: S.LONG_BIAS, to: S.LONG_ENTRY_SIGNAL,
    guard: (ctx) => ctx.netScore > ctx.thresholds.entry && ctx.confidence >= ctx.thresholds.minConfidence,
    priority: 35 },
  { from: S.LONG_BIAS, to: S.LONG_SETUP,
    guard: (ctx) => ctx.netScore > ctx.thresholds.setup,
    priority: 30 },
  { from: S.LONG_BIAS, to: S.SHORT_BIAS,
    guard: (ctx) => ctx.netScore < -ctx.thresholds.bias,
    priority: 25 },
  { from: S.LONG_BIAS, to: S.OBSERVING,
    guard: (ctx) => ctx.netScore <= ctx.thresholds.observe,
    priority: 5 },

  // ── SHORT_BIAS ────────────────────────────────────────────────────────────
  // Fast-track: skip SETUP when momentum already at entry strength
  { from: S.SHORT_BIAS, to: S.SHORT_ENTRY_SIGNAL,
    guard: (ctx) => ctx.netScore < -ctx.thresholds.entry && ctx.confidence >= ctx.thresholds.minConfidence,
    priority: 35 },
  { from: S.SHORT_BIAS, to: S.SHORT_SETUP,
    guard: (ctx) => ctx.netScore < -ctx.thresholds.setup,
    priority: 30 },
  { from: S.SHORT_BIAS, to: S.LONG_BIAS,
    guard: (ctx) => ctx.netScore > ctx.thresholds.bias,
    priority: 25 },
  { from: S.SHORT_BIAS, to: S.OBSERVING,
    guard: (ctx) => ctx.netScore >= -ctx.thresholds.observe,
    priority: 5 },

  // ── LONG_SETUP ────────────────────────────────────────────────────────────
  { from: S.LONG_SETUP, to: S.LONG_ENTRY_SIGNAL,
    guard: (ctx) => ctx.netScore > ctx.thresholds.entry && ctx.confidence >= ctx.thresholds.minConfidence,
    priority: 40 },
  { from: S.LONG_SETUP, to: S.INVALIDATED,
    guard: (ctx) => ctx.netScore < 0,
    priority: 35 },
  { from: S.LONG_SETUP, to: S.LONG_BIAS,
    guard: (ctx) => ctx.netScore <= ctx.thresholds.setup,
    priority: 5 },

  // ── SHORT_SETUP ───────────────────────────────────────────────────────────
  { from: S.SHORT_SETUP, to: S.SHORT_ENTRY_SIGNAL,
    guard: (ctx) => ctx.netScore < -ctx.thresholds.entry && ctx.confidence >= ctx.thresholds.minConfidence,
    priority: 40 },
  { from: S.SHORT_SETUP, to: S.INVALIDATED,
    guard: (ctx) => ctx.netScore > 0,
    priority: 35 },
  { from: S.SHORT_SETUP, to: S.SHORT_BIAS,
    guard: (ctx) => ctx.netScore >= -ctx.thresholds.setup,
    priority: 5 },

  // ── LONG_ENTRY_SIGNAL ─────────────────────────────────────────────────────
  { from: S.LONG_ENTRY_SIGNAL, to: S.LONG_POSITION_OPEN,
    guard: (ctx) => ctx.positionAccepted,
    priority: 50 },
  { from: S.LONG_ENTRY_SIGNAL, to: S.INVALIDATED,
    guard: (ctx) => ctx.netScore < 0,
    priority: 45 },
  { from: S.LONG_ENTRY_SIGNAL, to: S.COOLDOWN,
    guard: (ctx) => ctx.signalAgeMs > ctx.timing.entryExpiryMs,
    priority: 40 },

  // ── SHORT_ENTRY_SIGNAL ────────────────────────────────────────────────────
  { from: S.SHORT_ENTRY_SIGNAL, to: S.SHORT_POSITION_OPEN,
    guard: (ctx) => ctx.positionAccepted,
    priority: 50 },
  { from: S.SHORT_ENTRY_SIGNAL, to: S.INVALIDATED,
    guard: (ctx) => ctx.netScore > 0,
    priority: 45 },
  { from: S.SHORT_ENTRY_SIGNAL, to: S.COOLDOWN,
    guard: (ctx) => ctx.signalAgeMs > ctx.timing.entryExpiryMs,
    priority: 40 },

  // ── LONG_POSITION_OPEN ────────────────────────────────────────────────────
  { from: S.LONG_POSITION_OPEN, to: S.COOLDOWN,
    guard: (ctx) => ctx.positionClosed,
    priority: 50 },
  { from: S.LONG_POSITION_OPEN, to: S.LONG_EXIT_WARNING,
    guard: (ctx) => ctx.nearTakeProfit || ctx.nearInvalidation,
    priority: 35 },
  { from: S.LONG_POSITION_OPEN, to: S.LONG_EXIT_WARNING,
    guard: (ctx) => ctx.netScore < ctx.thresholds.exitWarn,
    priority: 30 },

  // ── SHORT_POSITION_OPEN ───────────────────────────────────────────────────
  { from: S.SHORT_POSITION_OPEN, to: S.COOLDOWN,
    guard: (ctx) => ctx.positionClosed,
    priority: 50 },
  { from: S.SHORT_POSITION_OPEN, to: S.SHORT_EXIT_WARNING,
    guard: (ctx) => ctx.nearTakeProfit || ctx.nearInvalidation,
    priority: 35 },
  { from: S.SHORT_POSITION_OPEN, to: S.SHORT_EXIT_WARNING,
    guard: (ctx) => ctx.netScore > -ctx.thresholds.exitWarn,
    priority: 30 },

  // ── LONG_EXIT_WARNING ─────────────────────────────────────────────────────
  { from: S.LONG_EXIT_WARNING, to: S.COOLDOWN,
    guard: (ctx) => ctx.positionClosed,
    priority: 50 },
  { from: S.LONG_EXIT_WARNING, to: S.LONG_EXIT_SIGNAL,
    guard: (ctx) => ctx.nearInvalidation || ctx.netScore < 0,
    priority: 40 },
  { from: S.LONG_EXIT_WARNING, to: S.LONG_POSITION_OPEN,
    guard: (ctx) => ctx.netScore >= ctx.thresholds.exitRecover,
    priority: 35 },

  // ── SHORT_EXIT_WARNING ────────────────────────────────────────────────────
  { from: S.SHORT_EXIT_WARNING, to: S.COOLDOWN,
    guard: (ctx) => ctx.positionClosed,
    priority: 50 },
  { from: S.SHORT_EXIT_WARNING, to: S.SHORT_EXIT_SIGNAL,
    guard: (ctx) => ctx.nearInvalidation || ctx.netScore > 0,
    priority: 40 },
  { from: S.SHORT_EXIT_WARNING, to: S.SHORT_POSITION_OPEN,
    guard: (ctx) => ctx.netScore <= -ctx.thresholds.exitRecover,
    priority: 35 },

  // ── LONG_EXIT_SIGNAL ─────────────────────────────────────────────────────
  { from: S.LONG_EXIT_SIGNAL, to: S.COOLDOWN,
    guard: (ctx) => ctx.positionClosed || ctx.signalAgeMs > ctx.timing.exitExpiryMs,
    priority: 50 },

  // ── SHORT_EXIT_SIGNAL ────────────────────────────────────────────────────
  { from: S.SHORT_EXIT_SIGNAL, to: S.COOLDOWN,
    guard: (ctx) => ctx.positionClosed || ctx.signalAgeMs > ctx.timing.exitExpiryMs,
    priority: 50 },

  // ── COOLDOWN ─────────────────────────────────────────────────────────────
  { from: S.COOLDOWN, to: S.IDLE,
    guard: (ctx) => ctx.stateAgeMs > ctx.timing.cooldownMs,
    priority: 10 },

  // ── INVALIDATED ──────────────────────────────────────────────────────────
  { from: S.INVALIDATED, to: S.COOLDOWN,
    guard: (_ctx) => true,
    priority: 10 },
]

// Pre-index by source state for O(1) lookup, sorted descending by priority.
const TRANSITIONS_BY_STATE = new Map()
for (const t of TRANSITIONS) {
  if (!TRANSITIONS_BY_STATE.has(t.from)) TRANSITIONS_BY_STATE.set(t.from, [])
  TRANSITIONS_BY_STATE.get(t.from).push(t)
}
for (const [, list] of TRANSITIONS_BY_STATE) {
  list.sort((a, b) => b.priority - a.priority)
}

// ─── Resolver ─────────────────────────────────────────────────────────────────

/**
 * Resolve the next state from the current state and context.
 * Returns the next state string, or the current state if no transition matches.
 *
 * @param {string}            currentState
 * @param {TransitionContext} ctx
 * @returns {string}
 */
function resolveNextState(currentState, ctx) {
  const candidates = TRANSITIONS_BY_STATE.get(currentState)
  if (!candidates) return currentState
  for (const t of candidates) {
    if (t.guard(ctx)) return t.to
  }
  return currentState
}

module.exports = { resolveNextState }
