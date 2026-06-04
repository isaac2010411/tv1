'use strict'

/**
 * DynamicRiskPolicy — pure functions that decide how the RiskManager should
 * handle a signal emitted by the StateMachineSignalEngine.
 *
 * The policy is **dynamic per asset and market state**: instead of hard
 * thresholds it derives the rules at evaluation time from the live market
 * factors (ATR%, spread, spoofing, confidence, signal state). This lets the
 * same code govern BTC, XRP, low-vol majors and volatile alts without
 * per-symbol configuration files.
 *
 * Three "regimes" are recognised from ATR% (volatility relative to price):
 *   - calm    : atrPct < 0.15%   → relaxed thresholds, tighter stops
 *   - normal  : 0.15% – 0.5%
 *   - volatile: ≥ 0.5%           → stricter thresholds, wider stops
 *
 * Returned decisions are pure data so they can be logged / persisted and the
 * caller (SocketAdapter or RiskManager) decides what to actually do.
 */

const REGIME = Object.freeze({
  CALM: 'CALM',
  NORMAL: 'NORMAL',
  VOLATILE: 'VOLATILE',
})

const SIGNAL_MODE = Object.freeze({
  AUTO: 'AUTO', // RiskManager auto-opens the position
  MANUAL: 'MANUAL', // popup shown, user must accept
  REJECT: 'REJECT', // popup shown only as info / no entry allowed
})

const POSITION_ACTION = Object.freeze({
  HOLD: 'HOLD',
  CLOSE: 'CLOSE',
  ADJUST_SL: 'ADJUST_SL',
})

/**
 * Default trading cost assumptions for the cost-aware edge gate.
 *
 *   feeBps      – taker fee per side, in basis points (4 bps ≈ 0.04%).
 *   slippageBps – assumed market-impact slippage per side, in bps.
 *
 * A round-trip therefore consumes 2 × (feeBps + slippageBps) ≈ 12 bps. We
 * require the expected TP move to be ≥ `edgeMultiple` × round-trip cost
 * before approving any AUTO entry.
 */
// const DEFAULT_COSTS = Object.freeze({
//   feeBps: 4,
//   slippageBps: 2,
//   edgeMultiple: 3, // require expected TP ≥ 3× round-trip cost
// })
const DEFAULT_COSTS = Object.freeze({
  feeBps: 4,
  slippageBps: 2,
  edgeMultiple: 2, // diagnóstico scalping 1m: permite TP esperado ~8-12 bps
})
/**
 * Compute recommended position size from equity, risk budget and stop distance.
 *
 * Formula:  qty = (equity × riskPerTradePct) / (|entry − stopLoss| × contractMultiplier)
 *
 * Returns 0 when inputs are insufficient. Callers should treat 0 as "do not
 * size the order automatically".
 *
 * @param {object} params
 * @param {number} params.equity                   Account equity in quote currency (e.g. USD).
 * @param {number} [params.riskPerTradePct=0.005]  Fraction of equity to risk (0.005 = 0.5 %).
 * @param {number} params.entryPrice
 * @param {number} params.stopLoss
 * @param {number} [params.contractMultiplier=1]   For linear perp = 1. For inverse contracts adjust.
 * @param {number} [params.maxNotional]            Optional hard cap on quantity × entryPrice.
 * @returns {{ quantity: number, riskAmount: number, stopDistance: number }}
 */
function computePositionSize({
  equity,
  riskPerTradePct = 0.005,
  entryPrice,
  stopLoss,
  contractMultiplier = 1,
  maxNotional,
} = {}) {
  const eq = Number(equity)
  const entry = Number(entryPrice)
  const stop = Number(stopLoss)
  const stopDistance = Number.isFinite(entry) && Number.isFinite(stop) ? Math.abs(entry - stop) : 0
  if (
    !Number.isFinite(eq) ||
    eq <= 0 ||
    stopDistance <= 0 ||
    !Number.isFinite(contractMultiplier) ||
    contractMultiplier <= 0
  ) {
    return { quantity: 0, riskAmount: 0, stopDistance }
  }
  const riskAmount = eq * Math.max(0, Math.min(1, riskPerTradePct))
  let quantity = riskAmount / (stopDistance * contractMultiplier)
  if (Number.isFinite(maxNotional) && maxNotional > 0 && Number.isFinite(entry) && entry > 0) {
    const capQty = maxNotional / entry
    if (quantity > capQty) quantity = capQty
  }
  return { quantity: +quantity.toFixed(8), riskAmount: +riskAmount.toFixed(2), stopDistance: +stopDistance.toFixed(8) }
}

/**
 * Compute the expected net edge (in basis points) for a trade after fees and
 * slippage are deducted from the TP distance. Negative values mean the trade
 * has a negative expectation even on a perfect winner.
 *
 * @param {object} params
 * @param {number} params.entryPrice
 * @param {number} params.takeProfit
 * @param {object} [params.costs]   { feeBps, slippageBps }
 * @returns {{ expectedTpBps: number, roundTripCostBps: number, netEdgeBps: number }}
 */
function computeNetEdgeBps({ entryPrice, takeProfit, costs = DEFAULT_COSTS } = {}) {
  const entry = Number(entryPrice)
  const tp = Number(takeProfit)
  if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(tp)) {
    return { expectedTpBps: 0, roundTripCostBps: 0, netEdgeBps: 0 }
  }
  const expectedTpBps = (Math.abs(tp - entry) / entry) * 10_000
  const feeBps = Number(costs?.feeBps ?? DEFAULT_COSTS.feeBps)
  const slipBps = Number(costs?.slippageBps ?? DEFAULT_COSTS.slippageBps)
  const roundTripCostBps = 2 * (feeBps + slipBps)
  return {
    expectedTpBps: +expectedTpBps.toFixed(2),
    roundTripCostBps: +roundTripCostBps.toFixed(2),
    netEdgeBps: +(expectedTpBps - roundTripCostBps).toFixed(2),
  }
}

/** Returns the regime label for an ATR% value. */
function classifyRegime(atrPct) {
  if (!Number.isFinite(atrPct) || atrPct <= 0) return REGIME.NORMAL
  if (atrPct < 0.0015) return REGIME.CALM
  if (atrPct < 0.005) return REGIME.NORMAL
  return REGIME.VOLATILE
}

/** Continuous 0..1 scale from CALM→VOLATILE used to interpolate thresholds. */
function regimeScale(atrPct) {
  if (!Number.isFinite(atrPct) || atrPct <= 0) return 0.35
  // 0.001 → 0; 0.006 → 1 (clamped)
  const s = (atrPct - 0.001) / 0.005
  return Math.min(1, Math.max(0, s))
}

/** Spread sanity check: tolerate wider spreads on more volatile assets. */
function spreadAcceptable(spreadPct, atrPct) {
  if (!Number.isFinite(spreadPct)) return true
  // tolerated spread ≈ 25% of ATR%, with a 0.08% absolute floor.
  const tolerated = Math.max(0.0008, (Number.isFinite(atrPct) ? atrPct : 0.003) * 0.25)
  return spreadPct <= tolerated
}

/** Parse a "X:Y" or "X.YZ:1" risk/reward string into a number, or compute it. */
function deriveRiskReward(signal) {
  const risk = signal?.risk
  if (!risk) return null
  const { entryPrice, stopLoss, takeProfit } = risk
  if ([entryPrice, stopLoss, takeProfit].every((v) => Number.isFinite(v))) {
    const r = Math.abs(entryPrice - stopLoss)
    const t = Math.abs(takeProfit - entryPrice)
    if (r > 0) return t / r
  }
  if (typeof risk.riskReward === 'string') {
    const m = /^([\d.]+)\s*[:\/]\s*([\d.]+)/.exec(risk.riskReward)
    if (m) {
      const a = Number(m[1])
      const b = Number(m[2])
      if (Number.isFinite(a) && Number.isFinite(b) && b > 0) return a / b
    }
  }
  return null
}

/**
 * Decide what the RiskManager should do with an incoming entry signal.
 *
 * @param {object} params
 * @param {object} params.signal           Signal contract from SignalFactory.
 * @param {object} params.factors          MarketFactors from MarketContextEvaluator.
 * @param {object|null} [params.position]  Current OPEN position for the symbol, if any.
 * @param {object} [params.accountState]   { dailyPnl, openPositionsCount }
 * @returns {{
 *   mode: 'AUTO'|'MANUAL'|'REJECT',
 *   approved: boolean,
 *   regime: string,
 *   reasons: string[],
 *   minConfidence: number,
 *   minRiskReward: number,
 *   adjustedRisk: object|null,
 *   rule?: string,
 * }}
 */
function evaluateSignal({ signal, factors = {}, position = null, accountState = {} } = {}) {
  const reasons = []
  const atrPct = factors.atrPct
  const regime = classifyRegime(atrPct)
  const scale = regimeScale(atrPct)
  // 'auto' (default) ⇒ the bot self-executes every signal that clears the
  // hard risk gates. 'semi' ⇒ keep the legacy popup flow for soft-fail
  // signals so the human can approve them. Hard gates (spread, cost edge,
  // open position, daily-loss brake) always block regardless of mode.
  const executionMode = String(accountState?.executionMode || 'auto').toLowerCase() === 'semi' ? 'semi' : 'auto'
  const horizon = String(accountState?.horizon || 'default').toLowerCase() === 'scalp' ? 'scalp' : 'default'

  // Dynamic thresholds — interpolated by regime.
  const minConfidenceBase = Math.round(55 + 25 * scale) // 55 → 80 %
  const minRiskRewardBase = +(1.5 + 0.7 * scale).toFixed(2) // 1.50 → 2.20
  const stopAtrMult = 1.2 + 0.6 * scale // 1.2 → 1.8 × ATR
  const tpAtrMult = stopAtrMult * minRiskRewardBase

  // Order-flow rebound context: when the evaluator confirmed a technical
  // bounce *aligned with the signal direction*, relax confidence / R-R / cost
  // edge so the bot can react. Pure mean-reversion scalps trade tight TPs and
  // tend to fail the standard 3× cost gate built for trend continuation.
  const rebound = factors.reversalContext
  const reboundAligned = !!(rebound && rebound.active && signal?.direction && rebound.direction === signal.direction)
  const minConfidence = reboundAligned ? Math.max(40, minConfidenceBase - 10) : minConfidenceBase
  const minRiskReward = reboundAligned ? Math.max(1.2, +(minRiskRewardBase - 0.4).toFixed(2)) : minRiskRewardBase
  if (reboundAligned) {
    reasons.push(`Rebound context aligned (strength ${rebound.strength}) — thresholds relaxed`)
  }

  // Always block when there is already an open position for the symbol —
  // policy is max 1 op per asset.
  if (position && position.status === 'OPEN') {
    return {
      mode: SIGNAL_MODE.REJECT,
      approved: false,
      regime,
      reasons: [`Already has an open ${position.direction} position for ${signal?.symbol}`],
      minConfidence,
      minRiskReward,
      adjustedRisk: null,
      rule: 'singlePositionPerSymbol',
    }
  }

  // Spread guard.
  if (!spreadAcceptable(factors.spreadPct, atrPct)) {
    reasons.push(`Spread too wide (${(factors.spreadPct * 100).toFixed(3)}% vs tolerated)`)
    return {
      mode: SIGNAL_MODE.REJECT,
      approved: false,
      regime,
      reasons,
      minConfidence,
      minRiskReward,
      adjustedRisk: null,
      rule: 'spreadGuard',
    }
  }

  // Daily-loss soft brake (paper-trading scale: $250 default). In auto mode
  // this is a hard REJECT so the bot doesn't keep trading through losses;
  // in semi mode it surfaces as a MANUAL popup for the trader to confirm.
  const dailyPnl = Number(accountState?.dailyPnl ?? 0)
  const softDailyLoss = Number(accountState?.dailyLossSoftLimit ?? 250)
  if (Number.isFinite(dailyPnl) && dailyPnl <= -softDailyLoss) {
    reasons.push(`Daily PnL below soft brake (${dailyPnl.toFixed(2)} ≤ -${softDailyLoss})`)
    return {
      mode: executionMode === 'auto' ? SIGNAL_MODE.REJECT : SIGNAL_MODE.MANUAL,
      approved: false,
      regime,
      reasons,
      minConfidence,
      minRiskReward,
      adjustedRisk: null,
      rule: 'dailyLossSoftBrake',
      executionMode,
    }
  }

  // Spoofing on the same side as the signal direction → suspect, downgrade.
  const sameSideSpoof =
    (signal?.direction === 'long' && factors.recentSpoofingBid) ||
    (signal?.direction === 'short' && factors.recentSpoofingAsk)
  if (sameSideSpoof) {
    reasons.push('Spoofing detected on signal side — manual confirmation required')
  }

  // Build adjusted risk levels from ATR (override the engine's static 1.5/3.0).
  let adjustedRisk = null
  const price = Number(signal?.risk?.entryPrice ?? factors.price)
  const atr = Number(factors.atr)
  if (Number.isFinite(price) && Number.isFinite(atr) && atr > 0 && signal?.direction) {
    const costs = accountState?.costs ?? null
    const edgeMultipleBase = Number(costs?.edgeMultiple ?? DEFAULT_COSTS.edgeMultiple)
    const edgeMultiple = reboundAligned
      ? Math.min(edgeMultipleBase, 1)
      : horizon === 'scalp'
        ? Math.min(edgeMultipleBase, 1.1)
        : edgeMultipleBase
    const feeBps = Number(costs?.feeBps ?? DEFAULT_COSTS.feeBps)
    const slipBps = Number(costs?.slippageBps ?? DEFAULT_COSTS.slippageBps)
    const roundTripCostBps = 2 * (feeBps + slipBps)
    const shouldExpandTp = horizon === 'scalp' || reboundAligned
    const minCostTpBps = shouldExpandTp ? roundTripCostBps * edgeMultiple + 0.1 : 0
    const recentRangeBps = Number(factors.recentRangeBps)
    const recentRangeTpBps =
      shouldExpandTp && Number.isFinite(recentRangeBps)
        ? Math.min(30, Math.max(0, recentRangeBps * (reboundAligned ? 0.35 : 0.25)))
        : 0
    const minDynamicTpBps = Math.max(minCostTpBps, recentRangeTpBps)
    const stopDist = atr * stopAtrMult
    const tpDist = Math.max(atr * tpAtrMult, (price * minDynamicTpBps) / 10_000)
    const stopLoss = signal.direction === 'long' ? price - stopDist : price + stopDist
    const takeProfit = signal.direction === 'long' ? price + tpDist : price - tpDist
    adjustedRisk = {
      entryPrice: +price.toFixed(6),
      stopLoss: +stopLoss.toFixed(6),
      takeProfit: +takeProfit.toFixed(6),
      stopAtrMult: +stopAtrMult.toFixed(2),
      tpAtrMult: +tpAtrMult.toFixed(2),
      minDynamicTpBps: +minDynamicTpBps.toFixed(2),
      recentRangeBps: Number.isFinite(recentRangeBps) ? +recentRangeBps.toFixed(2) : null,
      riskReward: +minRiskReward.toFixed(2),
    }

    // ── Cost-aware edge gate ────────────────────────────────────────────────
    // At 30s–1m horizons, round-trip fees + slippage routinely eat the entire
    // TP move on calm regimes. Require the expected TP move to clear a
    // multiple of the round-trip cost before allowing AUTO execution.
    const edge = computeNetEdgeBps({ entryPrice: price, takeProfit, costs: costs ?? undefined })
    adjustedRisk.expectedTpBps = edge.expectedTpBps
    adjustedRisk.roundTripCostBps = edge.roundTripCostBps
    adjustedRisk.netEdgeBps = edge.netEdgeBps
    // ~2× cost instead of 3× when the rebound context is aligned.
    const minTpBps = edge.roundTripCostBps * edgeMultiple
    if (edge.expectedTpBps < minTpBps) {
      reasons.push(`Expected TP ${edge.expectedTpBps}bps < required ${minTpBps.toFixed(2)}bps (cost edge)`)
      return {
        mode: SIGNAL_MODE.REJECT,
        approved: false,
        regime,
        reasons,
        minConfidence,
        minRiskReward,
        adjustedRisk,
        rule: 'costEdge',
      }
    }

    // ── Position sizing ─────────────────────────────────────────────────────
    // When the caller supplies the current equity, attach a recommended
    // quantity sized so a stop-out costs exactly `riskPerTradePct` of equity.
    // For the $10k paper cap with 0.5% risk this yields $50 max loss per trade.
    const equity = Number(accountState?.equity)
    if (Number.isFinite(equity) && equity > 0) {
      const sizing = computePositionSize({
        equity,
        riskPerTradePct: Number(accountState?.riskPerTradePct ?? 0.005),
        entryPrice: price,
        stopLoss,
        contractMultiplier: Number(accountState?.contractMultiplier ?? 1),
        maxNotional: Number(accountState?.maxNotional ?? equity * 3),
      })
      adjustedRisk.recommendedQuantity = sizing.quantity
      adjustedRisk.riskAmount = sizing.riskAmount
    }
  }

  // Confidence + R/R checks.
  const confidence = Number(signal?.confidence ?? 0)
  const rr = deriveRiskReward(signal) ?? minRiskReward
  const confidenceOk = confidence >= minConfidence
  const riskRewardOk = rr >= minRiskReward

  if (!confidenceOk) reasons.push(`Confidence ${confidence}% < required ${minConfidence}%`)
  if (!riskRewardOk) reasons.push(`R/R ${rr.toFixed(2)} < required ${minRiskReward.toFixed(2)}`)

  const canAuto = confidenceOk && riskRewardOk && !sameSideSpoof && !!adjustedRisk
  if (canAuto) {
    reasons.unshift(
      `${regime} regime — auto-exec OK (conf ${confidence}% ≥ ${minConfidence}%, R/R ${rr.toFixed(2)} ≥ ${minRiskReward.toFixed(2)})`,
    )
    return {
      mode: SIGNAL_MODE.AUTO,
      approved: true,
      regime,
      reasons,
      minConfidence,
      minRiskReward,
      adjustedRisk,
      rule: 'dynamicAutoExec',
      executionMode,
    }
  }

  // Soft-fail path. In fully-autonomous mode we still execute as long as a
  // valid adjusted-risk plan exists — the trader explicitly opted out of
  // manual confirmation. In semi mode we fall back to a MANUAL popup so a
  // human can sanity-check the entry.
  if (executionMode === 'auto' && adjustedRisk) {
    reasons.unshift(`Auto-mode override — bot executes soft-fail signal (conf ${confidence}% / R/R ${rr.toFixed(2)})`)
    return {
      mode: SIGNAL_MODE.AUTO,
      approved: true,
      regime,
      reasons,
      minConfidence,
      minRiskReward,
      adjustedRisk,
      rule: 'autoModeOverride',
      executionMode,
    }
  }

  return {
    mode: SIGNAL_MODE.MANUAL,
    approved: false,
    regime,
    reasons,
    minConfidence,
    minRiskReward,
    adjustedRisk,
    rule: 'dynamicManualReview',
    executionMode,
  }
}

/**
 * Decide what to do with an OPEN, auto-managed position on each tick.
 *
 * @param {object} params
 * @param {object} params.position         Open paper-trade position.
 * @param {object} [params.factors]        Latest MarketFactors snapshot.
 * @param {string} [params.signalState]    Current state-machine state.
 * @param {number} [params.markPrice]      Latest mark price.
 * @returns {{
 *   action: 'HOLD'|'CLOSE'|'ADJUST_SL',
 *   reason?: string,
 *   newStopLoss?: number,
 *   closeReason?: string,
 * }}
 */
function evaluateActivePosition({
  position,
  factors = {},
  signalState = null,
  markPrice = null,
  now = Date.now(),
  config = {},
  netScore = null,
  signalIssuedAt = null,
  consecutiveExitTicks = 0,
} = {}) {
  if (!position || position.status !== 'OPEN') return { action: POSITION_ACTION.HOLD }
  const dir = String(position.direction).toUpperCase()
  const price = Number(markPrice ?? position.currentPrice ?? factors.price)
  const entry = Number(position.entryPrice)
  const tp = Number(position.takeProfit)
  const sl = Number(position.stopLoss)
  const atr = Number(factors.atr)

  // 1. INVALIDATED → close immediately.
  if (signalState === 'INVALIDATED') {
    return {
      action: POSITION_ACTION.CLOSE,
      closeReason: 'SIGNAL_INVALIDATED',
      reason: 'state-machine reached INVALIDATED',
    }
  }

  // 1b. EXIT_SIGNAL → close only when at least one condition is met:
  //   (a) trade is at a loss
  //   (b) signal has been live ≥ exitGuardMs (multi-tick by time)
  //   (c) opposing netScore exceeds strong threshold
  //   (d) signal age ≥ exitMultiTickMs (configurable tick confirmation)
  const isExitSignal =
    (dir === 'LONG' && signalState === 'LONG_EXIT_SIGNAL') || (dir === 'SHORT' && signalState === 'SHORT_EXIT_SIGNAL')

  if (isExitSignal) {
    // Consecutive-tick gate: require ≥ exitConfirmTicks engine cycles in EXIT_SIGNAL
    // before evaluating any close condition. Default 2 (≈4 s at 2 s cadence).
    const minExitTicks = Number(config?.exitConfirmTicks ?? 2)

    if (consecutiveExitTicks >= minExitTicks) {
      const atLoss =
        Number.isFinite(price) && Number.isFinite(entry) && (dir === 'LONG' ? price <= entry : price >= entry)

      const signalAge = signalIssuedAt != null && Number.isFinite(signalIssuedAt) ? now - signalIssuedAt : 0

      const exitGuardMs = Number(config?.exitGuardMs ?? 0)
      const timeExpired = exitGuardMs > 0 && signalAge >= exitGuardMs

      const exitMultiTickMs = Number(config?.exitMultiTickMs ?? 0)
      const multiTick = exitMultiTickMs > 0 && signalAge >= exitMultiTickMs

      const strongThreshold = Number(config?.exitOpposingScoreThreshold ?? 0.55)
      const opposingScore =
        netScore != null &&
        ((dir === 'LONG' && netScore < -strongThreshold) || (dir === 'SHORT' && netScore > strongThreshold))

      if (atLoss || timeExpired || opposingScore || multiTick) {
        const trigger = atLoss
          ? 'at-loss'
          : timeExpired
            ? 'time-guard'
            : opposingScore
              ? 'opposing-score'
              : 'multi-tick'
        return {
          action: POSITION_ACTION.CLOSE,
          closeReason: 'SIGNAL_EXIT',
          reason: `EXIT_SIGNAL confirmed (${trigger}, ${consecutiveExitTicks} ticks)`,
        }
      }
    }
    // Tick threshold not yet reached or no condition met — observe without closing.
  }

  // 1b. Time-stop — for micro-operations (30s–1m): if the position has been
  //     open for `timeStopMs` and price hasn't reached `minTpProgress` of the
  //     TP distance, close it. Disabled by default (timeStopMs = 0) for
  //     backward compatibility; the adapter opts in by passing config.
  const timeStopMs = Number(config?.timeStopMs ?? 0)
  const minTpProgress = Number(config?.minTpProgress ?? 0.3)
  const openedAt = Number(position.openedAt)
  if (
    timeStopMs > 0 &&
    Number.isFinite(openedAt) &&
    now - openedAt >= timeStopMs &&
    Number.isFinite(entry) &&
    Number.isFinite(tp) &&
    Number.isFinite(price)
  ) {
    const tpDist = Math.abs(tp - entry)
    if (tpDist > 0) {
      const progress = dir === 'LONG' ? (price - entry) / tpDist : (entry - price) / tpDist
      if (progress < minTpProgress) {
        return {
          action: POSITION_ACTION.CLOSE,
          closeReason: 'TIME_STOP',
          reason: `time-stop (${Math.round((now - openedAt) / 1000)}s, progress ${(progress * 100).toFixed(0)}% < ${(minTpProgress * 100).toFixed(0)}%)`,
        }
      }
    }
  }

  // 2. Spoofing on the adverse side → tighten SL to entry (break-even).
  //     Guard: require at least 0.5×ATR of profit before locking break-even;
  //     without this, a position opened at a 1×ATR stop gets pinned immediately.
  const adverseSpoof = (dir === 'LONG' && factors.recentSpoofingAsk) || (dir === 'SHORT' && factors.recentSpoofingBid)
  if (adverseSpoof && Number.isFinite(entry) && Number.isFinite(sl) && Number.isFinite(price)) {
    const minBeProfit = Number.isFinite(atr) && atr > 0 ? atr * 0.5 : entry * 0.0005
    const meaningfulProfit = dir === 'LONG' ? price >= entry + minBeProfit : price <= entry - minBeProfit
    if (meaningfulProfit) {
      const beSL = entry
      const improves = dir === 'LONG' ? beSL > sl : beSL < sl
      if (improves) {
        return {
          action: POSITION_ACTION.ADJUST_SL,
          newStopLoss: +beSL.toFixed(6),
          reason: 'adverse-side spoofing detected — move SL to break-even',
          stopLossOrigin: 'BREAK_EVEN',
        }
      }
    }
  }

  // 3. Exit warning while in profit → break-even SL.
  //     Guard: require at least 0.5×ATR of profit so a single-tick exit
  //     warning cannot immediately pin the SL to entry price.
  if (
    signalState &&
    ((dir === 'LONG' && signalState === 'LONG_EXIT_WARNING') ||
      (dir === 'SHORT' && signalState === 'SHORT_EXIT_WARNING')) &&
    Number.isFinite(entry) &&
    Number.isFinite(price)
  ) {
    const minBeProfit = Number.isFinite(atr) && atr > 0 ? atr * 0.5 : entry * 0.0005
    const meaningfulProfit = dir === 'LONG' ? price >= entry + minBeProfit : price <= entry - minBeProfit
    if (meaningfulProfit && Number.isFinite(sl)) {
      const beSL = entry
      const improves = dir === 'LONG' ? beSL > sl : beSL < sl
      if (improves) {
        return {
          action: POSITION_ACTION.ADJUST_SL,
          newStopLoss: +beSL.toFixed(6),
          reason: 'exit-warning while in profit — lock break-even',
          stopLossOrigin: 'BREAK_EVEN',
        }
      }
    }
  }

  // 4. Trailing SL: when price has covered ≥ 60% of the TP distance, lock 30%
  //    of that progress as a hard floor.
  if (Number.isFinite(entry) && Number.isFinite(tp) && Number.isFinite(price)) {
    const tpDist = Math.abs(tp - entry)
    if (tpDist > 0) {
      const progress = dir === 'LONG' ? (price - entry) / tpDist : (entry - price) / tpDist
      if (progress >= 0.6) {
        const lockDist = tpDist * 0.3
        const newSL = dir === 'LONG' ? entry + lockDist : entry - lockDist
        const improves = !Number.isFinite(sl) || (dir === 'LONG' ? newSL > sl : newSL < sl)
        if (improves) {
          return {
            action: POSITION_ACTION.ADJUST_SL,
            newStopLoss: +newSL.toFixed(6),
            reason: `trailing-SL — ${Math.round(progress * 100)}% of TP reached, lock 30%`,
            stopLossOrigin: 'TRAILING',
          }
        }
      }
    }
  }

  // 5. ATR-based trailing once price > 1× ATR in favor — drag SL by 1× ATR.
  if (Number.isFinite(atr) && atr > 0 && Number.isFinite(entry) && Number.isFinite(price)) {
    const favor = dir === 'LONG' ? price - entry : entry - price
    if (favor >= atr) {
      const trailSL = dir === 'LONG' ? price - atr : price + atr
      const improves = !Number.isFinite(sl) || (dir === 'LONG' ? trailSL > sl : trailSL < sl)
      if (improves) {
        return {
          action: POSITION_ACTION.ADJUST_SL,
          newStopLoss: +trailSL.toFixed(6),
          reason: 'ATR trailing — drag SL by 1×ATR behind price',
          stopLossOrigin: 'TRAILING',
        }
      }
    }
  }

  return { action: POSITION_ACTION.HOLD }
}

/**
 * Build a list of human-readable rules currently in effect for the given
 * market factors. Used by the UI to display what the RiskManager is enforcing
 * without exposing implementation details.
 *
 * @param {object} params
 * @param {object} [params.factors]   MarketFactors snapshot.
 * @param {object|null} [params.position]  Open auto-managed position (optional).
 * @returns {string[]}
 */
function summarizeActiveRules({ factors = {}, position = null } = {}) {
  const atrPct = factors.atrPct
  const regime = classifyRegime(atrPct)
  const scale = regimeScale(atrPct)
  const minConfidence = Math.round(55 + 25 * scale)
  const minRiskReward = +(1.5 + 0.7 * scale).toFixed(2)
  const stopAtrMult = +(1.2 + 0.6 * scale).toFixed(2)
  const toleratedSpread = Math.max(0.0008, (Number.isFinite(atrPct) ? atrPct : 0.003) * 0.25)

  const rules = [
    `Régimen ${regime} (ATR% ${(atrPct ? atrPct * 100 : 0).toFixed(3)}%)`,
    `Confianza mínima ${minConfidence}%`,
    `R/R mínimo ${minRiskReward.toFixed(2)}:1`,
    `Stop dinámico ${stopAtrMult}×ATR`,
    `Spread tolerado ≤ ${(toleratedSpread * 100).toFixed(3)}%`,
    `Máximo 1 operación por activo`,
  ]

  if (position && position.status === 'OPEN') {
    rules.push('Break-even SL en EXIT_WARNING con profit')
    rules.push('Break-even SL ante spoofing adverso')
    rules.push('Trailing 30% al alcanzar 60% del TP')
    rules.push('Trailing 1×ATR cuando precio favorece ≥1×ATR')
    rules.push('Cierre inmediato en INVALIDATED')
    rules.push('Cierre condicional en EXIT_SIGNAL (pérdida, tiempo, score opuesto o multi-tick)')
  }

  return rules
}

module.exports = {
  REGIME,
  SIGNAL_MODE,
  POSITION_ACTION,
  DEFAULT_COSTS,
  classifyRegime,
  regimeScale,
  evaluateSignal,
  evaluateActivePosition,
  summarizeActiveRules,
  computePositionSize,
  computeNetEdgeBps,
}
