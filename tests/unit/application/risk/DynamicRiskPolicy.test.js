'use strict'

const {
  evaluateSignal,
  evaluateActivePosition,
  computePositionSize,
  computeNetEdgeBps,
  SIGNAL_MODE,
  POSITION_ACTION,
  DEFAULT_COSTS,
} = require('../../../../src/application/futures/risk/DynamicRiskPolicy')

describe('computePositionSize', () => {
  test('sizes for 0.5% risk on $10k equity with $1 stop distance', () => {
    const r = computePositionSize({
      equity: 10_000,
      riskPerTradePct: 0.005,
      entryPrice: 100,
      stopLoss: 99,
    })
    expect(r.riskAmount).toBe(50)
    expect(r.stopDistance).toBe(1)
    expect(r.quantity).toBe(50)
  })

  test('caps quantity by maxNotional', () => {
    const r = computePositionSize({
      equity: 10_000,
      riskPerTradePct: 0.01,
      entryPrice: 100,
      stopLoss: 99,
      maxNotional: 1_000,
    })
    // unconstrained would be 100; cap = 1000/100 = 10
    expect(r.quantity).toBe(10)
  })

  test('returns 0 quantity when stop distance is zero', () => {
    const r = computePositionSize({ equity: 10_000, entryPrice: 100, stopLoss: 100 })
    expect(r.quantity).toBe(0)
  })

  test('returns 0 quantity when equity missing', () => {
    expect(computePositionSize({ entryPrice: 100, stopLoss: 99 }).quantity).toBe(0)
  })
})

describe('computeNetEdgeBps', () => {
  test('returns positive edge when TP move exceeds round-trip cost', () => {
    const r = computeNetEdgeBps({ entryPrice: 100, takeProfit: 100.5 }) // 50 bps move
    expect(r.expectedTpBps).toBe(50)
    expect(r.roundTripCostBps).toBe(2 * (DEFAULT_COSTS.feeBps + DEFAULT_COSTS.slippageBps))
    expect(r.netEdgeBps).toBeGreaterThan(0)
  })

  test('negative edge for tiny TP moves at default costs', () => {
    const r = computeNetEdgeBps({ entryPrice: 100, takeProfit: 100.05 }) // 5 bps move
    expect(r.netEdgeBps).toBeLessThan(0)
  })
})

describe('evaluateSignal — cost-aware gate & sizing', () => {
  const baseFactors = {
    atrPct: 0.002, // NORMAL regime
    atr: 0.5, // ATR=0.5 on a $100 asset → tpAtrMult≈1.85×1.2=2.22 → tpDist≈1.1 → ~110 bps
    price: 100,
    spreadPct: 0.0005,
  }
  const baseSignal = (overrides = {}) => ({
    symbol: 'BTCUSDT',
    direction: 'long',
    confidence: 80,
    risk: { entryPrice: 100, stopLoss: 99, takeProfit: 102, riskReward: '2:1' },
    ...overrides,
  })

  test('REJECTS with rule=costEdge when expected TP is too small vs round-trip cost', () => {
    const result = evaluateSignal({
      signal: baseSignal(),
      factors: { ...baseFactors, atr: 0.005 }, // ~tpDist ~ 0.01 → ~1bps → way below required
    })
    expect(result.mode).toBe(SIGNAL_MODE.REJECT)
    expect(result.rule).toBe('costEdge')
    expect(result.adjustedRisk.netEdgeBps).toBeLessThan(0)
  })

  test('attaches recommendedQuantity when accountState.equity is supplied', () => {
    const result = evaluateSignal({
      signal: baseSignal(),
      factors: baseFactors,
      accountState: { equity: 10_000, riskPerTradePct: 0.005 },
    })
    expect(result.adjustedRisk).not.toBeNull()
    expect(result.adjustedRisk.recommendedQuantity).toBeGreaterThan(0)
    expect(result.adjustedRisk.riskAmount).toBe(50)
  })

  test('does NOT attach recommendedQuantity when equity is absent', () => {
    const result = evaluateSignal({ signal: baseSignal(), factors: baseFactors })
    expect(result.adjustedRisk).not.toBeNull()
    expect(result.adjustedRisk.recommendedQuantity).toBeUndefined()
  })

  test('exposes expectedTpBps / netEdgeBps in adjustedRisk', () => {
    const result = evaluateSignal({ signal: baseSignal(), factors: baseFactors })
    expect(result.adjustedRisk.expectedTpBps).toBeGreaterThan(0)
    expect(result.adjustedRisk.roundTripCostBps).toBe(12)
  })

  test('allows aligned rebound when TP covers cost but not the configured multiple', () => {
    const result = evaluateSignal({
      signal: baseSignal(),
      factors: {
        ...baseFactors,
        atr: 0.021,
        reversalContext: { active: true, direction: 'long', strength: 1 },
      },
      accountState: {
        costs: { feeBps: 1.5, slippageBps: 0.6, edgeMultiple: 2 },
      },
    })
    expect(result.rule).not.toBe('costEdge')
    expect(result.adjustedRisk.expectedTpBps).toBeGreaterThanOrEqual(result.adjustedRisk.roundTripCostBps)
    expect(result.adjustedRisk.expectedTpBps).toBeLessThan(result.adjustedRisk.roundTripCostBps * 2)
  })

  test('uses a smaller cost buffer for scalp horizon', () => {
    const result = evaluateSignal({
      signal: baseSignal(),
      factors: { ...baseFactors, atr: 0.022 },
      accountState: {
        horizon: 'scalp',
        costs: { feeBps: 1.5, slippageBps: 0.6, edgeMultiple: 2 },
      },
    })
    expect(result.rule).not.toBe('costEdge')
    expect(result.adjustedRisk.expectedTpBps).toBeGreaterThanOrEqual(result.adjustedRisk.roundTripCostBps * 1.1)
    expect(result.adjustedRisk.expectedTpBps).toBeLessThan(result.adjustedRisk.roundTripCostBps * 2)
  })

  test('expands scalp TP from recent candle range when ATR target is too small', () => {
    const result = evaluateSignal({
      signal: baseSignal(),
      factors: { ...baseFactors, atr: 0.01, recentRangeBps: 60 },
      accountState: {
        horizon: 'scalp',
        costs: { feeBps: 1.5, slippageBps: 0.6, edgeMultiple: 2 },
      },
    })
    expect(result.rule).not.toBe('costEdge')
    expect(result.adjustedRisk.expectedTpBps).toBeGreaterThanOrEqual(15)
    expect(result.adjustedRisk.recentRangeBps).toBe(60)
  })
})

describe('evaluateActivePosition — time-stop', () => {
  const basePosition = {
    status: 'OPEN',
    direction: 'long',
    entryPrice: 100,
    takeProfit: 101,
    stopLoss: 99,
    openedAt: 1_000,
  }

  test('disabled by default (no timeStopMs) → HOLD', () => {
    const r = evaluateActivePosition({
      position: basePosition,
      markPrice: 100.1,
      now: 1_000 + 90_000,
    })
    expect(r.action).toBe(POSITION_ACTION.HOLD)
  })

  test('CLOSE with TIME_STOP when elapsed ≥ timeStopMs and progress < 30%', () => {
    const r = evaluateActivePosition({
      position: basePosition,
      markPrice: 100.1, // 10% of TP distance
      now: 1_000 + 60_000,
      config: { timeStopMs: 60_000, minTpProgress: 0.3 },
    })
    expect(r.action).toBe(POSITION_ACTION.CLOSE)
    expect(r.closeReason).toBe('TIME_STOP')
  })

  test('does NOT time-stop when progress already ≥ 30%', () => {
    const r = evaluateActivePosition({
      position: basePosition,
      markPrice: 100.5, // 50% of TP distance
      now: 1_000 + 60_000,
      config: { timeStopMs: 60_000, minTpProgress: 0.3 },
    })
    // either HOLD or ADJUST_SL, never TIME_STOP CLOSE
    expect(r.closeReason).not.toBe('TIME_STOP')
  })

  test('signal-driven exits still take priority over time-stop', () => {
    // price below entry (atLoss) + 2 consecutive ticks → close
    const r = evaluateActivePosition({
      position: basePosition,
      markPrice: 99.5,
      now: 1_000 + 60_000,
      signalState: 'LONG_EXIT_SIGNAL',
      consecutiveExitTicks: 2,
      config: { timeStopMs: 60_000 },
    })
    expect(r.action).toBe(POSITION_ACTION.CLOSE)
    expect(r.closeReason).toBe('SIGNAL_EXIT')
  })

  test('EXIT_SIGNAL does NOT close on first tick even at a loss', () => {
    const r = evaluateActivePosition({
      position: basePosition,
      markPrice: 99.5,
      signalState: 'LONG_EXIT_SIGNAL',
      consecutiveExitTicks: 1,
    })
    expect(r.action).not.toBe(POSITION_ACTION.CLOSE)
  })

  test('EXIT_SIGNAL does NOT close when position is in profit and no other conditions met', () => {
    const r = evaluateActivePosition({
      position: basePosition,
      markPrice: 100.5,
      now: 1_000 + 1_000,
      signalState: 'LONG_EXIT_SIGNAL',
      consecutiveExitTicks: 3,
    })
    expect(r.action).not.toBe(POSITION_ACTION.CLOSE)
  })

  test('EXIT_SIGNAL closes when time-guard elapsed (≥ 2 ticks)', () => {
    const r = evaluateActivePosition({
      position: basePosition,
      markPrice: 100.5,
      signalIssuedAt: 0,
      now: 20_000,
      signalState: 'LONG_EXIT_SIGNAL',
      consecutiveExitTicks: 2,
      config: { exitGuardMs: 15_000 },
    })
    expect(r.action).toBe(POSITION_ACTION.CLOSE)
    expect(r.closeReason).toBe('SIGNAL_EXIT')
  })

  test('EXIT_SIGNAL closes when opposing score exceeds threshold (≥ 2 ticks)', () => {
    const r = evaluateActivePosition({
      position: basePosition,
      markPrice: 100.5,
      signalState: 'LONG_EXIT_SIGNAL',
      netScore: -0.7,
      consecutiveExitTicks: 2,
      config: { exitOpposingScoreThreshold: 0.55 },
    })
    expect(r.action).toBe(POSITION_ACTION.CLOSE)
    expect(r.closeReason).toBe('SIGNAL_EXIT')
  })
})
