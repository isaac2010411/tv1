'use strict'

const SPREAD_WARN_PCT = 0.0005
const SPREAD_ALERT_PCT = 0.002
const DELTA_LOOKBACK = 10

function toNumber(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function sumRecentDelta(cvdHistory = [], limit = DELTA_LOOKBACK) {
  return cvdHistory.slice(-limit).reduce((acc, item) => {
    const delta = toNumber(item?.delta ?? item?.qty)
    if (delta == null) return acc
    if (item?.delta != null) return acc + delta
    return acc + (item?.side === 'sell' ? -delta : delta)
  }, 0)
}

function nearestWall(walls = [], midPrice) {
  const mid = toNumber(midPrice)
  if (!Array.isArray(walls) || walls.length === 0 || mid == null) return null
  return walls.reduce((best, wall) => {
    if (!best) return wall
    return Math.abs(toNumber(wall.price) - mid) < Math.abs(toNumber(best.price) - mid) ? wall : best
  }, null)
}

function spreadState(spreadPct) {
  const value = toNumber(spreadPct)
  if (value == null) return 'unknown'
  if (value > SPREAD_ALERT_PCT) return 'alert'
  if (value > SPREAD_WARN_PCT) return 'warn'
  return 'ok'
}

class DecisionTapeService {
  compute({
    symbol,
    interval,
    bookMetrics = null,
    cvdHistory = [],
    spoofingCandidates = [],
    liquidityShifts = [],
  }) {
    const deltaRecent = sumRecentDelta(cvdHistory)
    const imbalance = toNumber(bookMetrics?.imbalanceTop10 ?? bookMetrics?.imbalance)
    const spread = toNumber(bookMetrics?.spreadPct)
    const state = spreadState(spread)
    const nearestBidWall = nearestWall(bookMetrics?.walls?.bidWalls, bookMetrics?.midPrice)
    const nearestAskWall = nearestWall(bookMetrics?.walls?.askWalls, bookMetrics?.midPrice)

    let decisionBias = 'neutral'
    if (state !== 'alert') {
      if (deltaRecent > 0 && imbalance != null && imbalance > 0.15) decisionBias = 'long'
      else if (deltaRecent < 0 && imbalance != null && imbalance < -0.15) decisionBias = 'short'
    }

    return {
      symbol,
      interval,
      deltaRecent,
      imbalance,
      nearestBidWall,
      nearestAskWall,
      spreadPct: spread,
      spreadState: state,
      spoofingCount: Array.isArray(spoofingCandidates) ? spoofingCandidates.length : 0,
      liquidityShiftCount: Array.isArray(liquidityShifts) ? liquidityShifts.length : 0,
      decisionBias,
      updatedAt: Date.now(),
    }
  }
}

module.exports = { DecisionTapeService }
