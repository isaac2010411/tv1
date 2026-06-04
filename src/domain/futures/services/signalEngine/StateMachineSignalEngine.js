'use strict'

const { evaluateMarketContext } = require('./MarketContextEvaluator')
const { calculateScore } = require('./SignalScoringService')
const { resolveNextState } = require('./SignalTransitionService')
const { createSignal, stateRequiresSignal } = require('./SignalFactory')
const { SIGNAL_STATES, ENTRY_SIGNAL_STATES, POSITION_ACTIVE_STATES } = require('./signalEngineStates')

/**
 * Domain Service: orchestrates the state machine signal engine for one symbol.
 *
 * The engine is stateful — one instance per subscribed symbol.
 * It does NOT execute orders. It emits analysis signals only.
 *
 * Position state is communicated from the frontend via notifyPositionAccepted /
 * notifyPositionClosed so the backend remains the authoritative state machine.
 *
 * @param {object} [opts]
 * @param {string} [opts.interval='1m']  Primary candle interval for indicators
 * @param {('default'|'scalp')} [opts.horizon='default']  Scoring weight profile.
 */
class StateMachineSignalEngine {
  constructor({ interval = '1m', horizon = 'default', minEntryExpiryMs = 0, minExitExpiryMs = 0 } = {}) {
    this.interval = interval
    this.horizon = horizon === 'scalp' ? 'scalp' : 'default'
    this._minEntryExpiryMs = Number.isFinite(minEntryExpiryMs) && minEntryExpiryMs > 0 ? minEntryExpiryMs : 0
    this._minExitExpiryMs = Number.isFinite(minExitExpiryMs) && minExitExpiryMs > 0 ? minExitExpiryMs : 0

    /** @type {string} */
    this._state = SIGNAL_STATES.IDLE
    /** @type {number} */
    this._stateEnteredAt = Date.now()
    /** @type {object|null} */
    this._lastSignal = null
    /** @type {number|null} */
    this._signalIssuedAt = null

    // Position state communicated by the frontend
    /** @type {boolean} */
    this._hasPosition = false
    /** @type {'long'|'short'|null} */
    this._positionDirection = null
    /** @type {number|null} */
    this._positionEntryPrice = null
    /** @type {number|null} */
    this._positionTakeProfit = null
    /** @type {number|null} */
    this._positionStopLoss = null
    /** @type {boolean} */
    this._positionAccepted = false
    /** @type {boolean} */
    this._positionClosed = false
  }

  // ─── Position notifications (called from socket command handlers) ───────────

  /**
   * Notify the engine that the frontend accepted an entry signal.
   * Causes the state machine to transition to POSITION_OPEN on the next tick.
   *
   * @param {object} [positionCtx]
   * @param {number|null} [positionCtx.entryPrice]
   * @param {number|null} [positionCtx.takeProfit]
   * @param {number|null} [positionCtx.stopLoss]
   */
  notifyPositionAccepted({ direction = null, entryPrice = null, takeProfit = null, stopLoss = null } = {}) {
    const directionInput = direction
    const normalizedDirection = typeof directionInput === 'string' ? directionInput.trim().toLowerCase() : null

    this._positionAccepted = true
    this._hasPosition = true
    this._positionEntryPrice = entryPrice
    this._positionTakeProfit = takeProfit
    this._positionStopLoss = stopLoss
    this._positionDirection =
      normalizedDirection === 'long' || normalizedDirection === 'short'
        ? normalizedDirection
        : ENTRY_SIGNAL_STATES.has(this._state)
          ? this._state.startsWith('LONG')
            ? 'long'
            : 'short'
          : this._positionDirection

    // Restore/accept can happen while the machine is not in *_ENTRY_SIGNAL
    // (e.g. page reconnect). Force an in-position state immediately so
    // entry transitions do not continue emitting new entry signals.
    if (!POSITION_ACTIVE_STATES.has(this._state)) {
      if (this._positionDirection === 'long') {
        this._state = SIGNAL_STATES.LONG_POSITION_OPEN
      } else if (this._positionDirection === 'short') {
        this._state = SIGNAL_STATES.SHORT_POSITION_OPEN
      }
      this._stateEnteredAt = Date.now()
    }
  }

  /**
   * Notify the engine that the frontend closed the position.
   * Causes the state machine to transition to COOLDOWN on the next tick.
   */
  notifyPositionClosed() {
    this._positionClosed = true
    this._hasPosition = false
    this._positionDirection = null
    this._positionEntryPrice = null
    this._positionTakeProfit = null
    this._positionStopLoss = null
  }

  // ─── Main process method ─────────────────────────────────────────────────────

  /**
   * Process current market data and advance the state machine.
   *
   * @param {string} symbol
   * @param {object} ctx  Assembled market context
   * @param {import('../../entities/OrderBook').OrderBook|null} ctx.orderBook
   * @param {Map<string, object[]>} ctx.candleHistory
   * @param {object[]} ctx.cvdHistory
   * @param {object[]} ctx.spoofingCandidates
   * @param {number|null} ctx.markPrice
   *
   * @returns {object} EngineResult
   */
  process(symbol, ctx) {
    const prevState = this._state
    const now = Date.now()

    // 1. Evaluate market factors
    const factors = evaluateMarketContext({
      orderBook: ctx.orderBook ?? null,
      candleHistory: ctx.candleHistory ?? new Map(),
      cvdHistory: ctx.cvdHistory ?? [],
      spoofingCandidates: ctx.spoofingCandidates ?? [],
      markPrice: ctx.markPrice ?? null,
      interval: this.interval,
      positionContext: this._hasPosition
        ? {
            direction: this._positionDirection,
            entryPrice: this._positionEntryPrice,
            takeProfit: this._positionTakeProfit,
            stopLoss: this._positionStopLoss,
          }
        : null,
    })

    // 2. Calculate score
    const { netScore, confidence, reasons } = calculateScore(factors, { horizon: this.horizon })

    // 3. Compute dynamic thresholds based on asset volatility (ATR%)
    //    volt = 1.0 → medium reference (ATR ≈ 0.3% of price, e.g. BTC ~270 on $90k)
    //    volt < 1.0 → low vol (e.g. XRP 1m) → tighter thresholds, faster signals
    //    volt > 1.0 → high vol → require stronger confirmation
    const atrPct = factors.atrPct ?? 0.003
    const spreadPct = factors.spreadPct ?? 0
    const volt = Math.min(Math.max(atrPct / 0.003, 0.4), 2.5)

    // Linear scale: volt=0.4 → ×0.88; volt=1.0 → ×1.00; volt=2.5 → ×1.30
    const ts = (base) => +(base * (0.8 + 0.2 * volt)).toFixed(3)
    // Spread surcharge on entry: wide spread requires stronger conviction
    const spl = spreadPct > 0.001 ? +Math.min(spreadPct * 8, 0.06).toFixed(3) : 0

    // const thresholds = {
    //   observe:       ts(0.11),                             // |score| to leave IDLE
    //   bias:          ts(0.27),                             // |score| to reach BIAS
    //   setup:         ts(0.45),                             // |score| to reach SETUP
    //   entry:         +(ts(0.60) + spl).toFixed(3),         // |score| to fire ENTRY_SIGNAL
    //   minConfidence: Math.round(35 + 15 * Math.min(volt, 1.0)),  // 35–50%
    //   exitWarn:      ts(0.27),                             // reuses bias level
    //   exitRecover:   ts(0.45),                             // reuses setup level
    // }
    const thresholds = {
      observe: ts(0.08),
      bias: ts(0.12),
      setup: ts(0.2),
      entry: +(ts(0.28) + spl).toFixed(3),
      minConfidence: Math.round(28 + 10 * Math.min(volt, 1.0)),
      exitWarn: ts(0.12),
      exitRecover: ts(0.2),
    }
    // Timing: fast for low-vol scalping, conservative for high-vol assets.
    // Apply optional floors (used in semi-manual mode to keep the human
    // approval popup alive long enough).
    const timing = {
      cooldownMs: Math.max(15_000, Math.round(20_000 * volt)), // 15s → 50s
      entryExpiryMs: Math.max(this._minEntryExpiryMs, 10_000, Math.round(12_000 * volt)), // 10s → 30s
      exitExpiryMs: Math.max(this._minExitExpiryMs, 15_000, Math.round(18_000 * volt)), // 15s → 45s
    }

    // 4. Build transition context
    const stateAgeMs = now - this._stateEnteredAt
    const signalAgeMs = this._signalIssuedAt ? now - this._signalIssuedAt : 0

    const transCtx = {
      netScore,
      confidence,
      hasPosition: this._hasPosition,
      positionDirection: this._positionDirection,
      positionAccepted: this._positionAccepted,
      positionClosed: this._positionClosed,
      nearTakeProfit: factors.nearTakeProfit ?? false,
      nearInvalidation: factors.nearInvalidation ?? false,
      stateAgeMs,
      signalAgeMs,
      currentState: this._state,
      thresholds,
      timing,
    }

    // 5. Resolve next state
    const nextState = resolveNextState(this._state, transCtx)
    const stateChanged = nextState !== prevState

    if (stateChanged) {
      this._state = nextState
      this._stateEnteredAt = now
    }

    // 6. Reset one-shot flags after they have been consumed
    this._positionAccepted = false
    this._positionClosed = false

    // 7. Emit a signal if required
    let signal = null
    if (stateRequiresSignal(this._state)) {
      if (stateChanged || this._lastSignal?.state !== this._state) {
        signal = createSignal({
          symbol,
          state: this._state,
          netScore,
          confidence,
          reasons,
          missingContext: factors.missingContext,
          factors,
          timing,
        })
        if (signal) {
          this._lastSignal = signal
          this._signalIssuedAt = now
        }
      }
    } else {
      // Clear stale signals when leaving signal states
      if (prevState !== this._state && this._lastSignal?.state !== this._state) {
        this._lastSignal = null
      }
    }

    // 8. Determine active signal (still within expiry window)
    let activeSignal = null
    if (this._lastSignal) {
      const isExpired = this._lastSignal.expiresAt && now > this._lastSignal.expiresAt
      if (!isExpired) activeSignal = this._lastSignal
    }

    return {
      state: this._state,
      prevState,
      stateChanged,
      netScore: +netScore.toFixed(4),
      confidence,
      signal,
      activeSignal,
      hasPosition: this._hasPosition,
      positionDirection: this._positionDirection,
      reasons,
      missingContext: factors.missingContext,
      factors,
    }
  }

  // ─── Accessors ────────────────────────────────────────────────────────────

  getState() {
    return this._state
  }
  getActiveSignal() {
    return this._lastSignal
  }
  isInPosition() {
    return this._hasPosition
  }

  /** Reset all state (call on symbol unsubscribe). */
  reset() {
    this._state = SIGNAL_STATES.IDLE
    this._stateEnteredAt = Date.now()
    this._lastSignal = null
    this._signalIssuedAt = null
    this._hasPosition = false
    this._positionDirection = null
    this._positionEntryPrice = null
    this._positionTakeProfit = null
    this._positionStopLoss = null
    this._positionAccepted = false
    this._positionClosed = false
  }
}

module.exports = { StateMachineSignalEngine }
