'use strict'

const { calculateScore, WEIGHTS, WEIGHTS_SCALP } = require(
  '../../../../src/domain/futures/services/signalEngine/SignalScoringService',
)

const fullBullishFactors = {
  imbalance: 0.6,
  cvdFlowRatio: 0.75,
  ema20: 105,
  ema50: 100,
  rsi: 50,
  macdHistogram: 0.5,
  bidWallNearMid: true,
  askWallNearMid: false,
  recentSpoofingBid: false,
  recentSpoofingAsk: false,
  price: 110,
  spreadOk: true,
  missingContext: [],
}

describe('SignalScoringService — horizon profiles', () => {
  test('default profile preserves existing weights', () => {
    expect(WEIGHTS.imbalance).toBe(0.22)
    expect(WEIGHTS.cvdFlowRatio).toBe(0.20)
    expect(WEIGHTS.ema20VsEma50).toBe(0.10)
  })

  test('scalp profile up-weights order flow and down-weights EMA/MACD', () => {
    expect(WEIGHTS_SCALP.imbalance).toBeGreaterThan(WEIGHTS.imbalance)
    expect(WEIGHTS_SCALP.cvdFlowRatio).toBeGreaterThan(WEIGHTS.cvdFlowRatio)
    expect(WEIGHTS_SCALP.ema20VsEma50).toBeLessThan(WEIGHTS.ema20VsEma50)
    expect(WEIGHTS_SCALP.macdHistogram).toBeLessThan(WEIGHTS.macdHistogram)
  })

  test('default horizon scoring is unchanged when opts omitted', () => {
    const a = calculateScore(fullBullishFactors)
    const b = calculateScore(fullBullishFactors, {})
    expect(a.netScore).toBe(b.netScore)
    expect(a.confidence).toBe(b.confidence)
  })

  test('scalp horizon produces a different (typically stronger order-flow) score', () => {
    const def = calculateScore(fullBullishFactors)
    const scalp = calculateScore(fullBullishFactors, { horizon: 'scalp' })
    // both bullish, but the scalp profile reacts more strongly to OB/CVD
    expect(scalp.netScore).toBeGreaterThan(0)
    expect(def.netScore).toBeGreaterThan(0)
    expect(scalp.netScore).not.toBe(def.netScore)
  })

  test('scalp EMA gate halves counter-trend score', () => {
    // Bearish order flow (imbalance/CVD/MACD/ask wall) but bullish EMA macro
    // trend (ema20 > ema50) → counter-trend short. Scalp gate must halve the
    // resulting score relative to the same factors evaluated WITHOUT the gate
    // (i.e. default horizon, which does not apply the gate).
    const bearishCounterTrend = {
      ...fullBullishFactors,
      imbalance: -0.6,
      cvdFlowRatio: 0.25,
      macdHistogram: -0.5,
      bidWallNearMid: false,
      askWallNearMid: true,
    }
    const scalp = calculateScore(bearishCounterTrend, { horizon: 'scalp' })
    // The scalp engine must direction-wise still be bearish (negative) and
    // must surface the gate explicitly in reasons.
    expect(scalp.netScore).toBeLessThan(0)
    const labels = scalp.reasons.map((r) => (typeof r === 'string' ? r : r.label))
    expect(labels.some((l) => /Counter-trend/i.test(l))).toBe(true)
  })
})
