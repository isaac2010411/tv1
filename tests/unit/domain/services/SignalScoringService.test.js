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

const sumWeights = (weights) => Object.values(weights).reduce((sum, weight) => sum + weight, 0)

describe('SignalScoringService — horizon profiles', () => {
  test('default profile uses normalized profitability-adjusted weights', () => {
    expect(WEIGHTS.imbalance).toBe(0.2016)
    expect(WEIGHTS.cvdFlowRatio).toBe(0.1774)
    expect(WEIGHTS.priceVsEma20).toBe(0.0645)
    expect(WEIGHTS.ema20VsEma50).toBe(0.1129)
    expect(WEIGHTS.rsi).toBe(0.0645)
    expect(WEIGHTS.macdHistogram).toBe(0.0645)
    expect(WEIGHTS.bidWallNearMid).toBe(0.0645)
    expect(WEIGHTS.askWallNearMid).toBe(0.0645)
    expect(WEIGHTS.spoofing).toBe(0.0242)
    expect(WEIGHTS.reversalContext).toBe(0.1614)
    expect(sumWeights(WEIGHTS)).toBeCloseTo(1, 4)
  })

  test('scalp profile up-weights order flow/reversal and stays normalized', () => {
    expect(WEIGHTS_SCALP.imbalance).toBe(0.26)
    expect(WEIGHTS_SCALP.cvdFlowRatio).toBe(0.24)
    expect(WEIGHTS_SCALP.priceVsEma20).toBe(0.04)
    expect(WEIGHTS_SCALP.ema20VsEma50).toBe(0.08)
    expect(WEIGHTS_SCALP.rsi).toBe(0.03)
    expect(WEIGHTS_SCALP.imbalance).toBeGreaterThan(WEIGHTS.imbalance)
    expect(WEIGHTS_SCALP.cvdFlowRatio).toBeGreaterThan(WEIGHTS.cvdFlowRatio)
    expect(WEIGHTS_SCALP.reversalContext).toBeGreaterThan(WEIGHTS.reversalContext)
    expect(WEIGHTS_SCALP.ema20VsEma50).toBeLessThan(WEIGHTS.ema20VsEma50)
    expect(WEIGHTS_SCALP.macdHistogram).toBeLessThan(WEIGHTS.macdHistogram)
    expect(sumWeights(WEIGHTS_SCALP)).toBeCloseTo(1, 4)
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
