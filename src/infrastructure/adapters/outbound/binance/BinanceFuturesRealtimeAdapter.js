'use strict'

const { performance } = require('perf_hooks')
const { FuturesRealtimePort } = require('../../../../domain/futures/ports/outbound/FuturesRealtimePort')
const { InfrastructureError } = require('../../../../shared/errors/InfrastructureError')
const { logger } = require('../../../../shared/utils/logger')

const LATENCY_DEBUG = process.env.LATENCY_DEBUG === '1'
const LATENCY_WARN_MS = Number(process.env.LATENCY_WARN_MS ?? 8)
// Phase 2 perf flag: the partial-depth stream is redundant with the locally
// reconstructed book emitted from diff-depth (book.local). Disable by default;
// set EMIT_BOOK_PARTIAL=true to fall back to publishing partialDepth too.
const EMIT_BOOK_PARTIAL = process.env.EMIT_BOOK_PARTIAL === 'true'

/**
 * Outbound adapter: implements FuturesRealtimePort using binance-api-node WebSocket.
 *
 * Design decisions:
 * – subscribeSymbol is idempotent (duplicate calls for the same symbol are ignored).
 * – Each stream cleanup function is stored so unsubscribeSymbol can close them all.
 * – Partial subscriptions are cleaned up if any stream fails to open.
 */
class BinanceFuturesRealtimeAdapter extends FuturesRealtimePort {
  /** @param {object} binanceClient – binance-api-node client instance */
  constructor(binanceClient) {
    super()
    this.client = binanceClient
    /** @type {Map<string, Array<() => void>>} symbol → array of close functions */
    this._subscriptions = new Map()
  }

  _probeStreamCallback(symbol, stream, fn) {
    return (data) => {
      const t0 = performance.now()
      try {
        fn(data)
      } finally {
        if (!LATENCY_DEBUG) return
        const ms = performance.now() - t0
        if (ms >= LATENCY_WARN_MS) {
          logger.warn(`[RealtimeAdapter] Slow stream callback ${stream} ${symbol}: ${ms.toFixed(2)}ms`)
        }
      }
    }
  }

  _normalizeCandlePayload(symbol, interval, candle) {
    // binance-api-node may deliver futures kline payload either flat or nested under k/kline.
    const kline = candle?.kline ?? candle?.k ?? candle ?? {}

    const openTime = Number(kline.startTime ?? kline.openTime ?? kline.t)
    const closeTime = Number(kline.closeTime ?? kline.T)
    const eventTime = Number(candle?.eventTime ?? candle?.E ?? kline.eventTime ?? kline.E)

    const finalRaw = kline.isFinal ?? kline.x
    const isFinal =
      typeof finalRaw === 'boolean'
        ? finalRaw
        : typeof finalRaw === 'number'
          ? finalRaw === 1
          : String(finalRaw ?? '').toLowerCase() === 'true'

    return {
      symbol: kline.symbol ?? kline.s ?? candle?.symbol ?? candle?.s ?? symbol,
      interval: kline.interval ?? kline.i ?? interval,
      openTime: Number.isFinite(openTime) ? openTime : kline.startTime ?? kline.openTime ?? kline.t ?? null,
      closeTime: Number.isFinite(closeTime) ? closeTime : kline.closeTime ?? kline.T ?? null,
      open: kline.open ?? kline.o ?? null,
      high: kline.high ?? kline.h ?? null,
      low: kline.low ?? kline.l ?? null,
      close: kline.close ?? kline.c ?? null,
      volume: kline.volume ?? kline.v ?? null,
      isFinal,
      eventTime: Number.isFinite(eventTime) ? eventTime : candle?.eventTime ?? candle?.E ?? kline.eventTime ?? kline.E ?? null,
    }
  }

  // ─── Port implementation ─────────────────────────────────────────────────────

  async subscribeSymbol(
    symbol,
    { onTicker, onMarkPrice, onOrderBook, onDiffDepth, onCandle, onTrade, intervals = ['1m'] },
  ) {
    if (this._subscriptions.has(symbol)) {
      logger.info(`[RealtimeAdapter] Already subscribed to ${symbol} — skipping duplicate`)
      return
    }

    const cleanups = []

    try {
      if (onMarkPrice) {
        const close = this.client.ws.futuresMarkPrice(
          symbol,
          this._probeStreamCallback(symbol, 'markPrice', (data) => {
            onMarkPrice({
              symbol: data.symbol,
              markPrice: data.markPrice,
              indexPrice: data.indexPrice,
              fundingRate: data.fundingRate,
              nextFundingRate: data.nextFundingRate,
            })
          }),
        )
        cleanups.push(close)
      }

      if (onTicker) {
        const close = this.client.ws.futuresTicker(
          symbol,
          this._probeStreamCallback(symbol, 'ticker', (data) => {
            onTicker({
              symbol: data.symbol,
              close: data.curDayClose,
              open: data.open,
              high: data.high,
              low: data.low,
              volume: data.volume,
              quoteVolume: data.volumeQuote,
              eventTime: data.eventTime ?? data.E ?? null,
            })
          }),
        )
        cleanups.push(close)
      }

      if (onOrderBook && EMIT_BOOK_PARTIAL) {
        const close = this.client.ws.futuresPartialDepth(
          { symbol, level: 20 },
          this._probeStreamCallback(symbol, 'partialDepth', (data) => {
            onOrderBook({
              symbol,
              bids: data.bidDepth,
              asks: data.askDepth,
              eventTime: data.eventTime ?? data.E ?? null,
            })
          }),
        )
        cleanups.push(close)
      }

      if (onDiffDepth) {
        // futuresDepth emits incremental diff depth updates for local book reconstruction
        const close = this.client.ws.futuresDepth(
          symbol,
          this._probeStreamCallback(symbol, 'diffDepth', (data) => {
            onDiffDepth({
              symbol,
              firstUpdateId: data.firstUpdateId,
              finalUpdateId: data.finalUpdateId,
              prevFinalUpdateId: data.prevFinalUpdateId, // pu — Futures continuity field
              bids: (data.bidDepth ?? []).map((l) => [l.price, l.quantity]),
              asks: (data.askDepth ?? []).map((l) => [l.price, l.quantity]),
              eventTime: data.eventTime ?? data.E ?? null,
            })
          }),
        )
        cleanups.push(close)
      }

      if (onCandle && intervals.length > 0) {
        for (const interval of intervals) {
          const close = this.client.ws.futuresCandles(
            symbol,
            interval,
            this._probeStreamCallback(symbol, `candle.${interval}`, (candle) => {
              onCandle(this._normalizeCandlePayload(symbol, interval, candle))
            }),
          )
          cleanups.push(close)
        }
      }

      if (onTrade) {
        const close = this.client.ws.futuresAggTrades(
          symbol,
          this._probeStreamCallback(symbol, 'aggTrade', (trade) => {
            onTrade({
              symbol: trade.symbol,
              price: trade.price,
              qty: trade.quantity,
              time: trade.timestamp,
              isBuyerMaker: trade.isBuyerMaker,
              tradeId: trade.tradeId ?? trade.id ?? null,
              aggregateTradeId: trade.aggregateTradeId ?? trade.aggId ?? trade.a ?? null,
              firstTradeId: trade.firstTradeId ?? trade.f ?? null,
              lastTradeId: trade.lastTradeId ?? trade.l ?? null,
              eventTime: trade.eventTime ?? trade.E ?? trade.timestamp ?? null,
            })
          }),
        )
        cleanups.push(close)
      }

      this._subscriptions.set(symbol, cleanups)
      logger.info(`[RealtimeAdapter] Subscribed to streams for ${symbol} (${cleanups.length} streams)`)
    } catch (err) {
      // Roll back any streams that opened successfully
      for (const fn of cleanups) {
        try {
          fn()
        } catch (_) {
          /* ignore cleanup errors */
        }
      }
      throw new InfrastructureError(
        `subscribeSymbol failed for ${symbol}: ${err.message}`,
        'BINANCE_WS_SUBSCRIBE_ERROR',
      )
    }
  }

  async unsubscribeSymbol(symbol) {
    const cleanups = this._subscriptions.get(symbol)
    if (!cleanups) {
      logger.warn(`[RealtimeAdapter] No active subscription for ${symbol}`)
      return
    }

    for (const fn of cleanups) {
      try {
        fn()
      } catch (err) {
        logger.warn(`[RealtimeAdapter] Error closing stream for ${symbol}: ${err.message}`)
      }
    }

    this._subscriptions.delete(symbol)
    logger.info(`[RealtimeAdapter] Unsubscribed from streams for ${symbol}`)
  }

  /**
   * Close every active stream for every symbol. Idempotent; safe to call
   * during shutdown.
   */
  async disposeAll() {
    const symbols = Array.from(this._subscriptions.keys())
    for (const symbol of symbols) {
      try {
        await this.unsubscribeSymbol(symbol)
      } catch (err) {
        logger.warn(`[RealtimeAdapter] disposeAll error for ${symbol}: ${err.message}`)
      }
    }
  }

  async subscribeUserData({ onAccountUpdate, onOrderUpdate } = {}) {
    try {
      this.client.ws.futuresUser((data) => {
        if (data.eventType === 'ACCOUNT_UPDATE' && onAccountUpdate) {
          onAccountUpdate(data)
        }
        if (data.eventType === 'ORDER_TRADE_UPDATE' && onOrderUpdate) {
          onOrderUpdate(data)
        }
      })
      logger.info('[RealtimeAdapter] Subscribed to user data stream')
    } catch (err) {
      throw new InfrastructureError(`subscribeUserData failed: ${err.message}`, 'BINANCE_WS_USER_ERROR')
    }
  }

  /** @param {string} symbol @returns {boolean} */
  isSubscribed(symbol) {
    return this._subscriptions.has(symbol)
  }
}

module.exports = { BinanceFuturesRealtimeAdapter }
