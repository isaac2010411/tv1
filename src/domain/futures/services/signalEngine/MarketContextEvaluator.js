'use strict'

/**
 * Domain Service: evaluates market context from backend data sources.
 *
 * Computes technical indicators (EMA, RSI, MACD, ATR) and market microstructure
 * signals (order book imbalance, walls, spoofing) for use by the signal engine.
 *
 * NOTE: Indicator values (EMA, RSI, MACD, ATR) are analytical outputs and use
 * native Number arithmetic intentionally. Price comparisons used for signal
 * generation (wall detection, imbalance) use Decimal via the OrderBook entity.
 */

const RECENT_SPOOFING_WINDOW_MS = 30_000   // 30 s lookback for spoofing detection

// ─── Indicator helpers ────────────────────────────────────────────────────────

/**
 * Simple EMA calculation.
 * @param {number[]} prices
 * @param {number}   period
 * @returns {number|null}
 */
function computeEMA(prices, period) {
  if (!prices || prices.length < period) return null
  const k     = 2 / (period + 1)
  let   ema   = prices.slice(0, period).reduce((a, b) => a + b, 0) / period
  for (let i = period; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k)
  }
  return ema
}

/**
 * Returns the full EMA series (one value per price after warmup).
 * @param {number[]} prices
 * @param {number}   period
 * @returns {number[]}
 */
function computeEMASeries(prices, period) {
  if (!prices || prices.length < period) return []
  const k      = 2 / (period + 1)
  const series = []
  let   ema    = prices.slice(0, period).reduce((a, b) => a + b, 0) / period
  series.push(ema)
  for (let i = period; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k)
    series.push(ema)
  }
  return series
}

/**
 * RSI-14 calculation.
 * @param {number[]} prices
 * @param {number}   [period=14]
 * @returns {number|null}
 */
function computeRSI(prices, period = 14) {
  if (!prices || prices.length < period + 1) return null
  let gains = 0
  let losses = 0
  for (let i = 1; i <= period; i++) {
    const diff = prices[i] - prices[i - 1]
    if (diff > 0) gains  += diff
    else          losses -= diff
  }
  let avgGain = gains  / period
  let avgLoss = losses / period
  for (let i = period + 1; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1]
    avgGain  = (avgGain  * (period - 1) + Math.max(0, diff))  / period
    avgLoss  = (avgLoss  * (period - 1) + Math.max(0, -diff)) / period
  }
  if (avgLoss === 0) return 100
  return 100 - 100 / (1 + avgGain / avgLoss)
}

/**
 * MACD (12/26/9) — returns the latest histogram value.
 * @param {number[]} prices
 * @param {number}   [fast=12]
 * @param {number}   [slow=26]
 * @param {number}   [signalPeriod=9]
 * @returns {number|null}
 */
function computeMACD(prices, fast = 12, slow = 26, signalPeriod = 9) {
  if (!prices || prices.length < slow + signalPeriod) return null
  const fastSeries = computeEMASeries(prices, fast)
  const slowSeries = computeEMASeries(prices, slow)
  if (!fastSeries.length || !slowSeries.length) return null

  // Align: slow series starts `slow - fast` candles after fast series
  const offset = slow - fast
  const macdLine = slowSeries.map((s, i) => fastSeries[i + offset] - s)
  const signal   = computeEMASeries(macdLine, signalPeriod)
  if (!signal.length) return null
  const histogram = macdLine[macdLine.length - 1] - signal[signal.length - 1]
  return histogram
}

/**
 * ATR-14 calculation.
 * @param {{ high: number|string, low: number|string, close: number|string }[]} candles
 * @param {number} [period=14]
 * @returns {number|null}
 */
function computeATR(candles, period = 14) {
  if (!candles || candles.length < period + 1) return null
  const trs = []
  for (let i = 1; i < candles.length; i++) {
    const h  = Number(candles[i].high)
    const l  = Number(candles[i].low)
    const pc = Number(candles[i - 1].close)
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)))
  }
  if (trs.length < period) return null
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period
  }
  return atr
}

/**
 * CVD flow ratio from recent CVD history.
 * Ratio = buyVolume / (buyVolume + sellVolume) over the last `windowSize` items.
 * Range [0,1]: >0.5 = net buying, <0.5 = net selling.
 * @param {{ side: 'buy'|'sell', qty: number }[]} cvdHistory
 * @param {number} [windowSize=20]
 * @returns {number|null}
 */
function computeCvdFlowRatio(cvdHistory, windowSize = 20) {
  if (!cvdHistory || cvdHistory.length < 3) return null
  const window = cvdHistory.slice(-windowSize)
  const totalBuy  = window.filter((t) => t.side === 'buy').reduce((a, t) => a + t.qty, 0)
  const totalSell = window.filter((t) => t.side === 'sell').reduce((a, t) => a + t.qty, 0)
  const total = totalBuy + totalSell
  if (total === 0) return null
  return totalBuy / total
}

/**
 * Build CVD flow ratio over a custom slice (used to compare recent vs prior flow).
 * @param {{ side: 'buy'|'sell', qty: number }[]} slice
 * @returns {number|null}
 */
function _cvdRatioOf(slice) {
  if (!slice || slice.length === 0) return null
  let buy = 0
  let sell = 0
  for (const t of slice) {
    if (t.side === 'buy')      buy  += t.qty
    else if (t.side === 'sell') sell += t.qty
  }
  const total = buy + sell
  if (total === 0) return null
  return buy / total
}

/**
 * Detect a technical rebound / exhaustion context.
 *
 * Triggers when:
 *  - price has been stretched ≥ `minDisplacementAtr` ATRs in the last
 *    `lookbackBars` candles (sharp run-up or run-down), AND
 *  - order flow (recent CVD slice) is flipping against the stretched move, AND
 *  - top-of-book imbalance is opposite to the stretched move OR there's an
 *    absorption wall on the opposite side of the move.
 *
 * Returns a context object with the proposed *rebound* direction (opposite to
 * the stretched move). Downstream services use this to skip trend filters and
 * weight order-flow more heavily.
 *
 * @param {object}   params
 * @param {object[]} params.candles            Recent candles (newest last).
 * @param {object[]} params.cvdHistory         Recent trades.
 * @param {number|null} params.atr             ATR over the same series.
 * @param {number}   params.imbalance          Top-of-book imbalance [-1,1].
 * @param {boolean}  params.bidWallNearMid
 * @param {boolean}  params.askWallNearMid
 * @param {number}   [params.lookbackBars=5]
 * @param {number}   [params.minDisplacementAtr=2]
 * @returns {{ active: boolean, direction: 'long'|'short'|null, strength: number,
 *             displacementAtr: number, reasons: string[] }}
 */
function detectReversalContext({
  candles,
  cvdHistory,
  atr,
  imbalance,
  bidWallNearMid,
  askWallNearMid,
  lookbackBars = 5,
  minDisplacementAtr = 2,
}) {
  const inactive = { active: false, direction: null, strength: 0, displacementAtr: 0, reasons: [] }
  if (!candles || candles.length < lookbackBars + 1) return inactive
  if (!Number.isFinite(atr) || atr <= 0) return inactive

  const last     = Number(candles[candles.length - 1].close)
  const anchor   = Number(candles[candles.length - 1 - lookbackBars].close)
  if (!Number.isFinite(last) || !Number.isFinite(anchor)) return inactive

  const displacementAtr = (last - anchor) / atr
  const absDisp = Math.abs(displacementAtr)
  if (absDisp < minDisplacementAtr) return inactive

  // Stretched UP → potential SHORT rebound; stretched DOWN → potential LONG rebound.
  const stretchedUp = displacementAtr > 0
  const reboundDir  = stretchedUp ? 'short' : 'long'

  // Order flow flip: compare last 25% vs prior 75% of the recent trade window.
  const reasons = []
  let flowFlip = false
  if (Array.isArray(cvdHistory) && cvdHistory.length >= 20) {
    const tail   = cvdHistory.slice(-Math.max(40, Math.min(cvdHistory.length, 80)))
    const split  = Math.max(5, Math.floor(tail.length * 0.25))
    const recent = tail.slice(-split)
    const prior  = tail.slice(0, tail.length - split)
    const rRec   = _cvdRatioOf(recent)
    const rPri   = _cvdRatioOf(prior)
    if (rRec !== null && rPri !== null) {
      // stretchedUp → need recent flow turning SELL (rRec < 0.45) vs prior BUY-heavy
      if (stretchedUp && rRec < 0.48 && (rPri - rRec) > 0.07) {
        flowFlip = true
        reasons.push(`CVD flip SELL (recent ${(rRec * 100).toFixed(0)}% vs prior ${(rPri * 100).toFixed(0)}%)`)
      } else if (!stretchedUp && rRec > 0.52 && (rRec - rPri) > 0.07) {
        flowFlip = true
        reasons.push(`CVD flip BUY (recent ${(rRec * 100).toFixed(0)}% vs prior ${(rPri * 100).toFixed(0)}%)`)
      }
    }
  }

  // Order-book confirmation: imbalance opposing the move OR absorption wall.
  let obOppose = false
  if (Number.isFinite(imbalance)) {
    if (stretchedUp && imbalance < -0.15) {
      obOppose = true
      reasons.push(`OB imbalance opposes move (${(imbalance * 100).toFixed(0)}%)`)
    } else if (!stretchedUp && imbalance > 0.15) {
      obOppose = true
      reasons.push(`OB imbalance opposes move (${(imbalance * 100).toFixed(0)}%)`)
    }
  }
  let wallOppose = false
  if (stretchedUp && askWallNearMid) {
    wallOppose = true
    reasons.push('Ask wall absorbing rally')
  } else if (!stretchedUp && bidWallNearMid) {
    wallOppose = true
    reasons.push('Bid wall absorbing sell-off')
  }

  // Require flow flip AND (OB oppose OR absorption wall). This keeps the
  // detector quiet during clean trend continuations.
  const confirmed = flowFlip && (obOppose || wallOppose)
  if (!confirmed) return inactive

  // Strength: scale displacement into [0,1] (cap at 5 ATR), boosted slightly
  // when both OB confirmations agree.
  let strength = Math.min(1, (absDisp - minDisplacementAtr) / 3 + 0.4)
  if (obOppose && wallOppose) strength = Math.min(1, strength + 0.15)

  reasons.unshift(`Price stretched ${displacementAtr.toFixed(2)}× ATR in last ${lookbackBars} bars`)

  return {
    active:          true,
    direction:       reboundDir,
    strength:        +strength.toFixed(3),
    displacementAtr: +displacementAtr.toFixed(3),
    reasons,
  }
}

// ─── Main evaluator ───────────────────────────────────────────────────────────

/**
 * Evaluate market context from backend data sources.
 *
 * @param {object} ctx
 * @param {import('../../entities/OrderBook').OrderBook|null} ctx.orderBook
 * @param {Map<string, object[]>} ctx.candleHistory  interval → candle[] (newest last)
 * @param {{ side: 'buy'|'sell', qty: number, time: number }[]} ctx.cvdHistory
 * @param {{ side: string, detectedAt: number, confidence: number }[]} ctx.spoofingCandidates
 * @param {number|null} ctx.markPrice
 * @param {string} ctx.interval  primary interval for indicators
 * @param {{ direction: string, entryPrice: number|null, takeProfit: number|null, stopLoss: number|null }|null} [ctx.positionContext]
 *
 * @returns {object} MarketFactors
 */
function evaluateMarketContext({ orderBook, candleHistory, cvdHistory, spoofingCandidates, markPrice, interval, positionContext = null }) {
  const missing = []

  // ── Order book ──────────────────────────────────────────────────────────────
  let price        = markPrice ?? null
  let spread       = null
  let spreadPct    = null
  let spreadOk     = false
  let imbalance    = 0
  let bidWallNearMid = false
  let askWallNearMid = false

  if (orderBook && orderBook.isValidTopOfBook) {
    price      = price ?? orderBook.midPrice.toNumber()
    spread     = orderBook.spread.toNumber()
    spreadPct  = orderBook.spreadPct.toNumber()
    spreadOk   = spreadPct < 0.002  // < 0.2% spread is acceptable
    imbalance  = orderBook.imbalanceTopN(20).toNumber()

    const walls = orderBook.detectWalls({ multiplier: 3, maxDistancePct: 0.005, depth: 50 })
    if (Array.isArray(walls)) {
      bidWallNearMid = walls.some((w) => w.side === 'bid' && w.type === 'TACTICAL_WALL')
      askWallNearMid = walls.some((w) => w.side === 'ask' && w.type === 'TACTICAL_WALL')
    }
  } else {
    missing.push('orderBook')
  }

  // ── Candles / indicators ────────────────────────────────────────────────────
  const candles = candleHistory?.get(interval) ?? []
  const closes  = candles.map((c) => Number(c.close))

  const ema20 = computeEMA(closes, 20)
  const ema50 = computeEMA(closes, 50)
  const rsi   = computeRSI(closes)
  const macdHistogram = computeMACD(closes)
  const atr   = computeATR(candles)

  if (closes.length < 50) missing.push('candles')

  // ── CVD flow ────────────────────────────────────────────────────────────────
  const cvdFlowRatio = computeCvdFlowRatio(cvdHistory)
  if (cvdFlowRatio === null) missing.push('cvd')

  // ── Spoofing ────────────────────────────────────────────────────────────────
  const now = Date.now()
  const recentSpoof = (spoofingCandidates ?? []).filter(
    (c) => now - c.detectedAt < RECENT_SPOOFING_WINDOW_MS,
  )
  const recentSpoofingBid = recentSpoof.some((c) => c.side === 'bid')
  const recentSpoofingAsk = recentSpoof.some((c) => c.side === 'ask')

  // ── Position-aware exit factors ─────────────────────────────────────────────
  // These are only meaningful when a position is open and price data is available.
  let nearTakeProfit   = false
  let nearInvalidation = false

  if (positionContext && price !== null) {
    const { direction, entryPrice, takeProfit, stopLoss } = positionContext

    // nearTakeProfit: price has travelled ≥ 80% of the way from entry to TP
    if (takeProfit !== null && entryPrice !== null) {
      const tpDist  = Math.abs(takeProfit - entryPrice)
      const curDist = Math.abs(price - entryPrice)
      if (tpDist > 0 && curDist / tpDist >= 0.80) {
        nearTakeProfit = true
      }
    }

    // nearInvalidation: price has moved adversely by more than 0.5× ATR from entry
    if (entryPrice !== null && atr !== null && atr > 0) {
      const adverse = direction === 'long'
        ? entryPrice - price   // how far price dropped below entry
        : price - entryPrice   // how far price rose above entry (for short)
      if (adverse > atr * 0.5) {
        nearInvalidation = true
      }
    }
  }

  return {
    price,
    spread,
    spreadPct,
    spreadOk,
    imbalance,
    cvdFlowRatio,
    ema20,
    ema50,
    rsi,
    macdHistogram,
    atr,
    bidWallNearMid,
    askWallNearMid,
    recentSpoofingBid,
    recentSpoofingAsk,
    nearTakeProfit,
    nearInvalidation,
    // Volatility measure for dynamic threshold scaling downstream
    atrPct: atr !== null && price !== null && price > 0 ? atr / price : null,
    // Order-flow-driven rebound/exhaustion detector (used by scoring + risk
    // policy to bypass trend filters when price has been stretched in a short
    // window and flow + OB are flipping against the move).
    reversalContext: detectReversalContext({
      candles,
      cvdHistory,
      atr,
      imbalance,
      bidWallNearMid,
      askWallNearMid,
    }),
    missingContext: missing,
  }
}

module.exports = {
  evaluateMarketContext,
  computeEMA,
  computeEMASeries,
  computeRSI,
  computeMACD,
  computeATR,
  computeCvdFlowRatio,
  detectReversalContext,
}
