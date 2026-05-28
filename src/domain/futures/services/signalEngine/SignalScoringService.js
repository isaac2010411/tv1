'use strict'

/**
 * Domain Service: scores market factors to produce a directional signal score.
 *
 * Score range:  [-1, +1]  (positive = long bias, negative = short bias)
 * Confidence:  [0, 100]  (percentage of maximum observable signal strength)
 *
 * The final netScore is attenuated by confidence:
 *   netScore = rawScore × (confidence / 100)
 *
 * Spread quality only penalises confidence — it contributes no directional score.
 */

const WEIGHTS = {
  imbalance:     0.22,
  cvdFlowRatio:  0.20,
  priceVsEma20:  0.12,
  ema20VsEma50:  0.10,
  rsi:           0.14,
  macdHistogram: 0.10,
  bidWallNearMid: 0.12,
  askWallNearMid: 0.12,
  spoofing:       0.06,
  reversalContext: 0.18,
}

/**
 * Weight profile optimised for micro-operations (30s–1m horizon).
 *
 * Order-flow signals (imbalance, CVD, walls, spoofing) dominate because they
 * carry the only information that survives at sub-minute horizons. EMA cross
 * and MACD are demoted to slow trend filters — they are still scored but they
 * never single-handedly carry an entry.
 */
const WEIGHTS_SCALP = {
  imbalance:     0.28,
  cvdFlowRatio:  0.25,
  priceVsEma20:  0.07,
  ema20VsEma50:  0.05,
  rsi:           0.05,
  macdHistogram: 0.05,
  bidWallNearMid: 0.15,
  askWallNearMid: 0.15,
  spoofing:       0.10,
  reversalContext: 0.30,
}

const WEIGHT_PROFILES = Object.freeze({
  default: WEIGHTS,
  scalp:   WEIGHTS_SCALP,
})

/**
 * @param {object} factors  MarketFactors from MarketContextEvaluator
 * @param {object} [opts]
 * @param {('default'|'scalp')} [opts.horizon='default']  Weight profile to use.
 * @returns {{ netScore: number, confidence: number, reasons: string[] }}
 */
function calculateScore(factors, opts = {}) {
  const horizon = opts.horizon === 'scalp' ? 'scalp' : 'default'
  const W = WEIGHT_PROFILES[horizon]
  const {
    imbalance,
    cvdFlowRatio,
    ema20,
    ema50,
    rsi,
    macdHistogram,
    bidWallNearMid,
    askWallNearMid,
    recentSpoofingBid,
    recentSpoofingAsk,
    price,
    spreadOk,
    reversalContext,
    missingContext = [],
  } = factors

  // A confirmed technical rebound (sharp move + flow flip + OB confirmation)
  // makes the macro EMA/RSI/MACD trend filters actively misleading: they all
  // still point in the direction of the *exhausted* move. We neutralise their
  // contribution and disable the counter-trend EMA gate when this context is
  // aligned with the rebound direction the engine is about to surface.
  const reversal = reversalContext && reversalContext.active ? reversalContext : null

  let rawScore     = 0
  let totalPossible = 0
  const reasons    = []

  // Helper: cap contribution to ±weight and emit a structured reason
  // (label + directional side) so the UI can colour-code per long/short.
  const add = (contribution, weight, reason) => {
    const capped = Math.max(-weight, Math.min(weight, contribution * weight))
    rawScore     += capped
    totalPossible += weight
    if (reason && Math.abs(contribution) > 0.1) {
      const side = capped > 0 ? 'LONG' : capped < 0 ? 'SHORT' : 'NEUTRAL'
      reasons.push({ label: reason, side, weight: +capped.toFixed(3) })
    }
  }

  // Helper for fixed-sign contributions (walls, spoofing, RSI extremes).
  const addFixed = (signed, weight, reason) => {
    rawScore      += signed * weight
    totalPossible += weight
    if (reason) {
      const side = signed > 0 ? 'LONG' : signed < 0 ? 'SHORT' : 'NEUTRAL'
      reasons.push({ label: reason, side, weight: +(signed * weight).toFixed(3) })
    }
  }

  // 1. Order book imbalance [-1, +1] → score
  if (imbalance !== null && imbalance !== undefined) {
    const dir = imbalance > 0 ? 'BULL' : 'BEAR'
    add(imbalance, W.imbalance, `OB imbalance ${dir} (${(imbalance * 100).toFixed(1)}%)`)
  }

  // 2. CVD flow ratio [0, 1] → centred to [-1, +1]
  if (cvdFlowRatio !== null && cvdFlowRatio !== undefined) {
    const centred = (cvdFlowRatio - 0.5) * 2
    const dir = centred > 0 ? 'BUY flow' : 'SELL flow'
    add(centred, W.cvdFlowRatio, `CVD ${dir} (${(cvdFlowRatio * 100).toFixed(1)}%)`)
  }

  // 3. Price vs EMA20  — suppressed during a confirmed rebound (the price has
  //    just stretched away from / through the EMA so the static sign is noise).
  if (price !== null && ema20 !== null && !reversal) {
    const signal = price > ema20 ? 1 : -1
    add(signal, W.priceVsEma20, `Price ${price > ema20 ? 'above' : 'below'} EMA20`)
  } else if (price !== null && ema20 !== null && reversal) {
    totalPossible += W.priceVsEma20
    reasons.push({ label: 'Price vs EMA20 muted (rebound context)', side: 'NEUTRAL', weight: 0 })
  }

  // 4. EMA20 vs EMA50 (trend direction) — suppressed during a rebound for the
  //    same reason: the macro EMA cross still reflects the exhausted move.
  if (ema20 !== null && ema50 !== null && !reversal) {
    const signal = ema20 > ema50 ? 1 : -1
    add(signal, W.ema20VsEma50, `EMA20 ${ema20 > ema50 ? '>' : '<'} EMA50 (${ema20 > ema50 ? 'uptrend' : 'downtrend'})`)
  } else if (ema20 !== null && ema50 !== null && reversal) {
    totalPossible += W.ema20VsEma50
  }

  // 5. RSI (0-100): oversold < 35 → bullish +1, overbought > 65 → bearish -1
  if (rsi !== null) {
    if (rsi < 35) {
      addFixed(1, W.rsi, `RSI oversold (${rsi.toFixed(1)})`)
    } else if (rsi > 65) {
      addFixed(-1, W.rsi, `RSI overbought (${rsi.toFixed(1)})`)
    } else {
      totalPossible += W.rsi
    }
  }

  // 6. MACD histogram
  if (macdHistogram !== null) {
    // Normalise: clip to ±1 using tanh-like soft clip
    const norm = Math.tanh(macdHistogram / (Math.abs(macdHistogram) + 1e-8))
    const dir = norm > 0 ? 'BULLISH' : 'BEARISH'
    add(norm, W.macdHistogram, `MACD hist ${dir}`)
  }

  // 7. Bid wall near mid → bullish support
  if (bidWallNearMid) {
    addFixed(1, W.bidWallNearMid, 'Bid wall near mid (support)')
  } else {
    totalPossible += W.bidWallNearMid
  }

  // 8. Ask wall near mid → bearish resistance
  if (askWallNearMid) {
    addFixed(-1, W.askWallNearMid, 'Ask wall near mid (resistance)')
  } else {
    totalPossible += W.askWallNearMid
  }

  // 9. Spoofing (bearish: recent bid spoofing = fake support; bullish: ask spoofing = fake resistance)
  if (recentSpoofingBid) {
    addFixed(-1, W.spoofing, 'Bid spoofing detected (fake support)')
  } else if (recentSpoofingAsk) {
    addFixed(1, W.spoofing, 'Ask spoofing detected (fake resistance)')
  } else {
    totalPossible += W.spoofing
  }

  // 10. Reversal / exhaustion context (order-flow driven).
  //     When active, surfaces an explicit directional contribution scaled by
  //     the detector's strength. This lets the engine fire entries on technical
  //     rebounds even when slow EMA/RSI/MACD filters still point the other way.
  if (reversal && reversal.direction) {
    const signed = reversal.direction === 'long' ? 1 : -1
    addFixed(signed * Math.max(0.4, reversal.strength), W.reversalContext,
      `Rebound context ${reversal.direction.toUpperCase()} (disp ${reversal.displacementAtr}× ATR)`)
  } else {
    totalPossible += W.reversalContext
  }

  // ── Confidence ──────────────────────────────────────────────────────────────
  // Combines two qualities:
  //   contextQuality  — how complete & clean the input data is (missing
  //                     context / wide spread).
  //   directionalStrength — how strongly the available factors agree on a
  //                     single direction (|rawScore| / totalPossible).
  // A perfect 100 % requires both: complete data AND strong consensus among
  // the indicators. With this, weak / mixed signals no longer surface as
  // "100% confidence".
  const missingPenalty = Math.min(1, missingContext.length * 0.2)
  const spreadPenalty  = spreadOk ? 0 : 0.15
  const contextQuality = Math.max(0, 1 - missingPenalty - spreadPenalty)
  const directionalStrength = totalPossible > 0
    ? Math.min(1, Math.abs(rawScore) / totalPossible)
    : 0
  const confidence     = Math.max(0, Math.min(100,
    Math.round(contextQuality * (0.25 + 0.75 * directionalStrength) * 100),
  ))

  // ── Net score ───────────────────────────────────────────────────────────────
  let clipped  = totalPossible > 0
    ? Math.max(-1, Math.min(1, rawScore / totalPossible))
    : 0

  // ── EMA trend gate (scalp only) ─────────────────────────────────────────────
  // At sub-minute horizons a clean entry against the 1m EMA20/50 trend has
  // markedly worse expectancy. Halve the score (not block) when the proposed
  // direction fights the macro EMA trend, so it can still surface as MANUAL
  // but won't auto-fire.
  //
  // Exception: an active rebound context aligned with the proposed direction
  // *is* a counter-trend setup by definition (we're trading against the
  // exhausted move). Skip the gate so technical bounces can fire.
  if (horizon === 'scalp' && ema20 !== null && ema50 !== null) {
    const trendUp   = ema20 > ema50
    const trendDown = ema20 < ema50
    const counterTrend = (clipped > 0 && trendDown) || (clipped < 0 && trendUp)
    const reboundAligned = reversal && (
      (clipped > 0 && reversal.direction === 'long') ||
      (clipped < 0 && reversal.direction === 'short')
    )
    if (counterTrend && !reboundAligned) {
      clipped *= 0.5
      reasons.push({ label: 'Counter-trend vs EMA20/50 — score halved', side: 'NEUTRAL', weight: 0 })
    } else if (counterTrend && reboundAligned) {
      reasons.push({ label: 'Counter-trend gate bypassed — rebound aligned', side: 'NEUTRAL', weight: 0 })
    }
  }

  const netScore = clipped * (confidence / 100)

  return { netScore, confidence, reasons }
}

module.exports = { calculateScore, WEIGHTS, WEIGHTS_SCALP, WEIGHT_PROFILES }
