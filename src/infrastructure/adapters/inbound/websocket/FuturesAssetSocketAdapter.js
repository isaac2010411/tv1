'use strict'

const { performance } = require('perf_hooks')
const { logger } = require('../../../../shared/utils/logger')
const { FUTURES_SOCKET_EVENTS, FUTURES_SOCKET_COMMANDS } = require('../../../../shared/contracts/futuresSocketEvents')
const { OrderBook } = require('../../../../domain/futures/entities/OrderBook')
const { SpoofingDetectorService } = require('../../../../domain/futures/services/SpoofingDetectorService')
const { LiquidityShiftService } = require('../../../../domain/futures/services/LiquidityShiftService')
const { CvdService } = require('../../../../domain/futures/services/CvdService')
const { FootprintCandleService } = require('../../../../domain/futures/services/FootprintCandleService')
const { PaperTradeService } = require('../../../../domain/futures/services/PaperTradeService')
const { LocalOrderBookEngine } = require('../../../marketdata/LocalOrderBookEngine')
const {
  StateMachineSignalEngine,
} = require('../../../../domain/futures/services/signalEngine/StateMachineSignalEngine')
const { RingBuffer } = require('../../../../shared/utils/RingBuffer')
const { metrics } = require('../../../observability/metrics')
const { EmitCoalescer } = require('../../../realtime/EmitCoalescer')

/** Max closed candles kept per interval in the signal engine's candle history. */
const MAX_CANDLE_HISTORY = 500
/** Max CVD history entries kept for the signal engine. */
const MAX_CVD_HISTORY = 200
/** Max spoofing candidates kept for the signal engine. */
const MAX_SPOOF_CANDIDATES = 100
/** Minimum ms between signal engine runs (throttle). */
const SIGNAL_ENGINE_THROTTLE_MS = 2_000
const LATENCY_DEBUG = process.env.LATENCY_DEBUG === '1'
const LATENCY_WARN_MS = Number(process.env.LATENCY_WARN_MS ?? 8)
const DEPTH_QUEUE_MAX = Number(process.env.DEPTH_QUEUE_MAX ?? 400)
const DEPTH_DRAIN_BATCH = Number(process.env.DEPTH_DRAIN_BATCH ?? 50)
const DEPTH_DRAIN_TIME_BUDGET_MS = Number(process.env.DEPTH_DRAIN_TIME_BUDGET_MS ?? 6)
const DEPTH_COALESCE_THRESHOLD = Number(process.env.DEPTH_COALESCE_THRESHOLD ?? 120)
const DEPTH_COALESCE_WINDOW = Number(process.env.DEPTH_COALESCE_WINDOW ?? 20)
const DEPTH_MAX_AGE_MS = Number(process.env.DEPTH_MAX_AGE_MS ?? 300)
const DEPTH_DROP_CHUNK_PCT = Number(process.env.DEPTH_DROP_CHUNK_PCT ?? 0.25)
const DEPTH_BACKPRESSURE_SKIP_SERVICES_THRESHOLD = Number(
  process.env.DEPTH_BACKPRESSURE_SKIP_SERVICES_THRESHOLD ?? 180,
)
const TRADE_OUT_OF_ORDER_TOLERANCE_MS = Number(process.env.TRADE_OUT_OF_ORDER_TOLERANCE_MS ?? 150)
// Phase 2.B — Opt-in coalescer for high-frequency events. Disabled by default
// to keep wire-format BC; enable with EMIT_BATCH_MODE=true.
const EMIT_BATCH_MODE = process.env.EMIT_BATCH_MODE === 'true'
const EMIT_BATCH_WINDOW_MS = Number(process.env.EMIT_BATCH_WINDOW_MS ?? 50)

function intervalToMs(interval) {
  const m = /^(\d+)([smhdw])$/.exec(interval ?? '')
  if (!m) return 0
  const n = parseInt(m[1], 10)
  const units = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }
  return n * (units[m[2]] ?? 0)
}

function extractExchangeEventTime(payload) {
  const raw = payload?.eventTime ?? payload?.time ?? payload?.timestamp ?? payload?.ts ?? null
  if (raw == null) return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

function withRealtimeMeta(
  payload,
  {
    stream,
    symbol,
    backendReceivedAt = Date.now(),
    backendProcessedAt = Date.now(),
    exchangeEventTime,
    ...metaExtras
  } = {},
) {
  const backendEmittedAt = Date.now()
  const resolvedExchangeEventTime = exchangeEventTime ?? extractExchangeEventTime(payload)
  const hasExchangeTime = Number.isFinite(Number(resolvedExchangeEventTime))
  const exchangeToBackendReceiveMs = hasExchangeTime
    ? Math.max(0, backendReceivedAt - Number(resolvedExchangeEventTime))
    : null
  const exchangeToBackendProcessMs = hasExchangeTime
    ? Math.max(0, backendProcessedAt - Number(resolvedExchangeEventTime))
    : null
  const exchangeToBackendEmitMs = hasExchangeTime
    ? Math.max(0, backendEmittedAt - Number(resolvedExchangeEventTime))
    : null

  return {
    ...payload,
    _meta: {
      ...(payload?._meta ?? {}),
      ...metaExtras,
      source: payload?._meta?.source ?? 'tv1-backend',
      stream,
      symbol: symbol ?? payload?.symbol ?? null,
      exchangeEventTime: hasExchangeTime ? Number(resolvedExchangeEventTime) : null,
      backendReceivedAt,
      backendProcessedAt,
      backendEmittedAt,
      backendProcessingMs: backendProcessedAt - backendReceivedAt,
      exchangeToBackendReceiveMs,
      exchangeToBackendProcessMs,
      exchangeToBackendEmitMs,
    },
  }
}

/**
 * Inbound Socket.IO adapter: bridges WebSocket events to application use cases
 * and microstructure domain services.
 */
class FuturesAssetSocketAdapter {
  constructor({
    io,
    getAssetContextUseCase,
    subscribeFuturesAssetUseCase,
    unsubscribeFuturesAssetUseCase,
    marketDataPort,
    tradingPersistence = null,
    riskManager = null,
    portfolioManager = null,
    scalpConfig = null,
  }) {
    this.io = io
    this.getAssetContextUseCase = getAssetContextUseCase
    this.subscribeFuturesAssetUseCase = subscribeFuturesAssetUseCase
    this.unsubscribeFuturesAssetUseCase = unsubscribeFuturesAssetUseCase
    this.marketDataPort = marketDataPort
    this._roomRefs = new Map()
    this._symbolServices = new Map()
    this.paperTradeService = new PaperTradeService()
    this.tradingPersistence = tradingPersistence
    this.riskManager = riskManager
    this.portfolioManager = portfolioManager
    // Scalp / micro-operation runtime config. May be null when running with
    // the default (legacy) horizon — in that case scoring & risk behave as
    // before. See `loadScalpConfig` in src/config/runtimeConfig.js.
    this.scalpConfig = scalpConfig
    if (scalpConfig?.horizon === 'scalp') {
      logger.info(
        `[SocketAdapter] Scalp horizon ENABLED — equity=$${scalpConfig.account.equity} ` +
        `risk/trade=${(scalpConfig.account.riskPerTradePct * 100).toFixed(2)}% ` +
        `costs=${scalpConfig.costs.feeBps}+${scalpConfig.costs.slippageBps}bps ` +
        `timeStop=${scalpConfig.position.timeStopMs}ms`,
      )
    }

    // Phase 2.B — Coalescer fronts high-frequency events when EMIT_BATCH_MODE
    // is enabled. The coalescer calls `_emitRaw` (raw passthrough) so we don't
    // recurse through the interceptor.
    this._coalescer = null
    if (EMIT_BATCH_MODE) {
      const batchMap = new Map([
        [FUTURES_SOCKET_EVENTS.TRADE_AGG, FUTURES_SOCKET_EVENTS.TRADE_AGG_BATCH],
        [FUTURES_SOCKET_EVENTS.MARKET_MARK_PRICE, FUTURES_SOCKET_EVENTS.MARKET_MARK_PRICE_BATCH],
        [FUTURES_SOCKET_EVENTS.ORDERFLOW_CVD, FUTURES_SOCKET_EVENTS.ORDERFLOW_CVD_BATCH],
      ])
      this._coalescer = new EmitCoalescer({
        emit: (room, event, payload) => this._emitRaw(room, event, payload, { stream: event }),
        batchEventMap: batchMap,
        windowMs: EMIT_BATCH_WINDOW_MS,
      })
      logger.info(`[SocketAdapter] EmitCoalescer enabled (window=${EMIT_BATCH_WINDOW_MS}ms)`)
    }
  }

  dispose() {
    if (this._coalescer) {
      this._coalescer.dispose()
      this._coalescer = null
    }
  }

  register(socket) {
    socket.on('futures:asset:subscribe', (data) => this._onSubscribe(socket, data))
    socket.on('futures:asset:unsubscribe', (data) => this._onUnsubscribe(socket, data))
    socket.on('disconnect', () => this._onDisconnect(socket))
    socket.on(FUTURES_SOCKET_COMMANDS.SIGNAL_POSITION_ACCEPT, (data) => this._onSignalPositionAccept(socket, data))
    socket.on(FUTURES_SOCKET_COMMANDS.SIGNAL_POSITION_CLOSE, (data) => this._onSignalPositionClose(socket, data))
  }

  _emitToRoom(room, eventName, payload, meta = {}) {
    // Route through coalescer for batchable events (TRADE_AGG / MARK_PRICE /
    // CVD) when EMIT_BATCH_MODE=true. The coalescer flushes via _emitRaw.
    if (this._coalescer && this._coalescer.enqueue(room, eventName, payload)) {
      return
    }
    this._emitRaw(room, eventName, payload, meta)
  }

  _emitRaw(room, eventName, payload, meta = {}) {
    const t0 = performance.now()
    const symbol = meta?.symbol ?? 'unknown'
    this.io.to(room).emit(eventName, withRealtimeMeta(payload, this._withStreamSequenceMeta(meta)))
    const ms = performance.now() - t0
    metrics.socketEmits.inc({ event: eventName, symbol })
    metrics.socketEmitLatencyMs.observe({ event: eventName }, ms)
    if (LATENCY_DEBUG && ms >= LATENCY_WARN_MS) {
      logger.warn(`[SocketAdapter] Slow room emit ${eventName} ${room}: ${ms.toFixed(2)}ms`)
    }
  }

  _emitToSocket(socket, eventName, payload, meta = {}) {
    socket.emit(eventName, withRealtimeMeta(payload, this._withStreamSequenceMeta(meta)))
  }

  // ── Phase 6: Risk / Order / Portfolio broadcast helpers ───────────────────
  // Broadcast globally (not per-symbol room) because portfolio / risk /
  // lifecycle events are account-scoped, not market-scoped.

  emitRiskDecision(payload) {
    if (!payload) return
    this.io.emit(FUTURES_SOCKET_EVENTS.RISK_DECISION, payload)
  }

  emitOrderLifecycle(order) {
    if (!order) return
    this.io.emit(FUTURES_SOCKET_EVENTS.ORDER_LIFECYCLE, order)
  }

  emitPortfolioSnapshot(snapshot) {
    if (!snapshot) return
    this.io.emit(FUTURES_SOCKET_EVENTS.PORTFOLIO_SNAPSHOT, snapshot)
  }

  _nextStreamSequence(symbol, stream) {
    const bundle = this._symbolServices.get(symbol)
    if (!bundle || !stream) return null
    const current = bundle._streamSequences.get(stream) ?? 0
    const next = current + 1
    bundle._streamSequences.set(stream, next)
    return next
  }

  _withStreamSequenceMeta(meta = {}) {
    const symbol = meta?.symbol
    const stream = meta?.stream
    if (!symbol || !stream) return meta
    const streamSequence = this._nextStreamSequence(symbol, stream)
    if (streamSequence == null) return meta
    return {
      ...meta,
      streamSequence,
    }
  }

  _initSymbolServices(symbol, tickSize, intervals, room) {
    const footprints = new Map()
    for (const interval of intervals) {
      footprints.set(interval, new FootprintCandleService({ symbol, interval, tickSize }))
    }

    const localBook = new LocalOrderBookEngine({
      symbol,
      onBook: (ob) => {
        const backendReceivedAt = Date.now()
        const bookPayload = ob.toJSON()
        const backendProcessedAt = Date.now()
        this._emitToRoom(room, FUTURES_SOCKET_EVENTS.BOOK_LOCAL, bookPayload, {
          stream: 'book.local',
          symbol,
          backendReceivedAt,
          backendProcessedAt,
        })

        const bundle = this._symbolServices.get(symbol)
        if (!bundle) return

        const nowMs = Date.now()
        if (!bundle._lastHealthEmitAt || nowMs - bundle._lastHealthEmitAt >= 1_000) {
          bundle._lastHealthEmitAt = nowMs
          try {
            this._emitToRoom(
              room,
              FUTURES_SOCKET_EVENTS.BOOK_HEALTH,
              {
                ...bundle.localBook.getHealth(),
                depthQueueBacklog: bundle._depthDeltaQueue.length,
                depthDropped: bundle._droppedDepthDeltas,
                depthStaleDropped: bundle._staleDepthDeltas,
                depthCoalesced: bundle._coalescedDepthDeltas,
                tradeOutOfOrderDropped: bundle._droppedOutOfOrderTrades,
              },
              {
              stream: 'book.health',
              symbol,
              },
            )
          } catch (err) {
            logger.warn(`[SocketAdapter] health emit error for ${symbol}: ${err.message}`)
          }
        }

        const depthBacklog = bundle._depthDeltaQueue?.length ?? 0
        if (depthBacklog >= DEPTH_BACKPRESSURE_SKIP_SERVICES_THRESHOLD) {
          // When diff-depth backlog is high, skip heavy derived services for this
          // frame so trade/ticker/candle emissions don't get delayed.
          return
        }

        // Cache last book so the signal-engine interval can read it without
        // forcing the engine to re-emit. Shared context (walls + median) is
        // computed once per emit and consumed by both Spoofing and Liquidity
        // services to avoid two O(N log N) passes on the same book.
        bundle._lastOrderBook = ob
        const sharedCtx = buildSharedOrderBookContext(ob)

        try {
          for (const ev of bundle.spoof.update(ob, sharedCtx)) {
            const plain = ev.toPlainObject()
            this._emitToRoom(room, FUTURES_SOCKET_EVENTS.SPOOFING_CANDIDATE, plain, {
              stream: 'spoofing.candidate',
              symbol,
              backendReceivedAt,
            })
            bundle._recentSpoofingCandidates.push(plain)
          }
          for (const ev of bundle.shift.update(ob, sharedCtx)) {
            this._emitToRoom(room, FUTURES_SOCKET_EVENTS.LIQUIDITY_SHIFT, ev.toPlainObject(), {
              stream: 'liquidity.shift',
              symbol,
              backendReceivedAt,
            })
          }
        } catch (err) {
          logger.warn(`[SocketAdapter] localBook service error for ${symbol}: ${err.message}`)
        }
        // Signal engine no longer runs from this callback; see _initSymbolServices
        // for the per-symbol setInterval that drives it on a fixed cadence.
      },
      onResync: async (sym) => {
        logger.warn(`[SocketAdapter] Resyncing local book for ${sym}`)
        await this._resyncLocalBook(sym)
      },
    })

    this._symbolServices.set(symbol, {
      spoof: new SpoofingDetectorService({ symbol, tickSize }),
      shift: new LiquidityShiftService({ symbol }),
      cvd: new CvdService({ symbol }),
      footprints,
      localBook,
      signalEngine: new StateMachineSignalEngine({
        interval: intervals[0] ?? '1m',
        horizon: this.scalpConfig?.horizon ?? 'default',
        // In semi-manual mode the human must approve each soft-fail signal;
        // extend the entry signal expiry floor so the popup doesn't expire
        // before they can react.
        minEntryExpiryMs:
          (this.scalpConfig?.executionMode === 'semi'
            ? Number(this.scalpConfig?.manualReviewExpiryMs ?? 0)
            : 0) || 0,
      }),
      _candleHistory: new Map(),
      _recentCvdHistory: new RingBuffer(MAX_CVD_HISTORY),
      _recentSpoofingCandidates: new RingBuffer(MAX_SPOOF_CANDIDATES),
      _depthDeltaQueue: [],
      _depthDrainScheduled: false,
      _droppedDepthDeltas: 0,
      _coalescedDepthDeltas: 0,
      _staleDepthDeltas: 0,
      _lastMarkPrice: null,
      lastResyncAt: null,
      _lastHealthEmitAt: null,
      _lastSignalEngineRunAt: 0,
      _lastMissingContextKey: '',
      _streamSequences: new Map(),
      _lastTradeEventTime: null,
      _droppedOutOfOrderTrades: 0,
      _lastOrderBook: null,
      _signalEngineTimer: null,
    })

    // Drive the signal engine on a fixed cadence per symbol, decoupled from
    // the order-book emission callback. This eliminates the per-emit throttle
    // check and lets us reason about signal-engine cost independently of book
    // update frequency.
    const bundle = this._symbolServices.get(symbol)
    bundle._signalEngineTimer = setInterval(() => {
      const b = this._symbolServices.get(symbol)
      if (!b || !b._lastOrderBook) return
      this._runSignalEngine(symbol, room, b._lastOrderBook)
    }, SIGNAL_ENGINE_THROTTLE_MS)
    if (bundle._signalEngineTimer.unref) bundle._signalEngineTimer.unref()

    metrics.activeSymbols.set({}, this._symbolServices.size)
    metrics.activeRooms.set({}, this._roomRefs.size)

    logger.debug(`[SocketAdapter] Services initialised for ${symbol} intervals=[${intervals}]`)
  }

  _cleanupSymbolServices(symbol) {
    const bundle = this._symbolServices.get(symbol)
    if (!bundle) return
    if (bundle._signalEngineTimer) {
      clearInterval(bundle._signalEngineTimer)
      bundle._signalEngineTimer = null
    }
    bundle.spoof.reset()
    bundle.shift.reset()
    bundle.cvd.reset()
    bundle.localBook.reset()
    bundle.signalEngine.reset()
    bundle._candleHistory.clear()
    bundle._recentCvdHistory.clear()
    bundle._recentSpoofingCandidates.clear()
    bundle._depthDeltaQueue.length = 0
    bundle._depthDrainScheduled = false
    bundle._droppedDepthDeltas = 0
    bundle._coalescedDepthDeltas = 0
    bundle._staleDepthDeltas = 0
    bundle._streamSequences.clear()
    bundle._lastTradeEventTime = null
    bundle._droppedOutOfOrderTrades = 0
    bundle._lastOrderBook = null
    for (const svc of bundle.footprints.values()) svc.reset()
    this._symbolServices.delete(symbol)
    // Drop closed-position history for this symbol (open positions are kept so
    // that an unsubscribe + resubscribe within a session doesn't lose state).
    if (this.paperTradeService?.clearSymbolHistory) {
      this.paperTradeService.clearSymbolHistory(symbol)
    }
    metrics.activeSymbols.set({}, this._symbolServices.size)
    metrics.activeRooms.set({}, this._roomRefs.size)
    logger.debug(`[SocketAdapter] Services cleaned up for ${symbol}`)
  }

  _mergeDepthDeltas(entries) {
    const first = entries[0].delta
    const last = entries[entries.length - 1].delta
    const bids = []
    const asks = []

    for (const entry of entries) {
      const delta = entry.delta
      if (Array.isArray(delta.bids)) bids.push(...delta.bids)
      if (Array.isArray(delta.asks)) asks.push(...delta.asks)
    }

    return {
      symbol: last.symbol ?? first.symbol,
      firstUpdateId: first.firstUpdateId,
      finalUpdateId: last.finalUpdateId,
      prevFinalUpdateId: first.prevFinalUpdateId,
      bids,
      asks,
    }
  }

  _scheduleDepthDrain(symbol) {
    const bundle = this._symbolServices.get(symbol)
    if (!bundle || bundle._depthDrainScheduled) return
    bundle._depthDrainScheduled = true
    setImmediate(() => this._drainDepthQueue(symbol))
  }

  _enqueueDepthDelta(symbol, delta) {
    const bundle = this._symbolServices.get(symbol)
    if (!bundle) return

    if (bundle._depthDeltaQueue.length >= DEPTH_QUEUE_MAX) {
      const toDrop = Math.max(1, Math.floor(DEPTH_QUEUE_MAX * DEPTH_DROP_CHUNK_PCT))
      const dropped = Math.min(toDrop, bundle._depthDeltaQueue.length)
      bundle._depthDeltaQueue.splice(0, dropped)
      bundle._droppedDepthDeltas += dropped
      metrics.depthDrops.inc({ symbol, reason: 'backpressure' }, dropped)
      if (bundle._droppedDepthDeltas % 100 === 0) {
        logger.warn(
          `[SocketAdapter] Dropped ${bundle._droppedDepthDeltas} depth deltas for ${symbol} ` +
            `(queue=${bundle._depthDeltaQueue.length}/${DEPTH_QUEUE_MAX})`,
        )
      }
    }

    bundle._depthDeltaQueue.push({ delta, enqueuedAt: Date.now() })
    metrics.depthQueueDepth.set({ symbol }, bundle._depthDeltaQueue.length)
    this._scheduleDepthDrain(symbol)
  }

  _drainDepthQueue(symbol) {
    const bundle = this._symbolServices.get(symbol)
    if (!bundle) return

    bundle._depthDrainScheduled = false

    const t0 = performance.now()
    let processed = 0

    while (bundle._depthDeltaQueue.length > 0 && processed < DEPTH_DRAIN_BATCH) {
      if (DEPTH_DRAIN_TIME_BUDGET_MS > 0) {
        const elapsedMs = performance.now() - t0
        if (elapsedMs >= DEPTH_DRAIN_TIME_BUDGET_MS) break
      }

      const now = Date.now()
      while (bundle._depthDeltaQueue.length > 0 && now - bundle._depthDeltaQueue[0].enqueuedAt > DEPTH_MAX_AGE_MS) {
        bundle._depthDeltaQueue.shift()
        bundle._staleDepthDeltas += 1
        metrics.depthDrops.inc({ symbol, reason: 'stale' })
      }
      if (bundle._staleDepthDeltas > 0 && bundle._staleDepthDeltas % 100 === 0) {
        logger.warn(
          `[SocketAdapter] Dropped ${bundle._staleDepthDeltas} stale depth deltas for ${symbol} ` +
            `(age>${DEPTH_MAX_AGE_MS}ms, backlog=${bundle._depthDeltaQueue.length})`,
        )
      }
      if (bundle._depthDeltaQueue.length === 0) break

      const remainingBudget = DEPTH_DRAIN_BATCH - processed
      const shouldCoalesce = bundle._depthDeltaQueue.length >= DEPTH_COALESCE_THRESHOLD && remainingBudget > 1

      let delta
      let consumed = 1

      if (shouldCoalesce) {
        consumed = Math.min(DEPTH_COALESCE_WINDOW, bundle._depthDeltaQueue.length, remainingBudget)
        const chunk = bundle._depthDeltaQueue.splice(0, consumed)
        delta = this._mergeDepthDeltas(chunk)
        bundle._coalescedDepthDeltas += consumed - 1
        if (bundle._coalescedDepthDeltas > 0 && bundle._coalescedDepthDeltas % 200 === 0) {
          logger.warn(
            `[SocketAdapter] Coalesced ${bundle._coalescedDepthDeltas} depth deltas for ${symbol} ` +
              `(backlog=${bundle._depthDeltaQueue.length})`,
          )
        }
      } else {
        delta = bundle._depthDeltaQueue.shift().delta
      }

      try {
        bundle.localBook.applyDelta(delta)
      } catch (err) {
        logger.warn(`[SocketAdapter] localBook delta error for ${symbol}: ${err.message}`)
      }
      processed += consumed
    }

    if (LATENCY_DEBUG) {
      const ms = performance.now() - t0
      if (ms >= LATENCY_WARN_MS) {
        logger.warn(
          `[SocketAdapter] Slow depth drain for ${symbol}: ${ms.toFixed(2)}ms ` +
            `(processed=${processed}, backlog=${bundle._depthDeltaQueue.length})`,
        )
      }
    }

    metrics.depthQueueDepth.set({ symbol }, bundle._depthDeltaQueue.length)

    if (bundle._depthDeltaQueue.length > 0) {
      this._scheduleDepthDrain(symbol)
    }
  }

  async _resyncLocalBook(symbol) {
    if (!this.marketDataPort) return
    const bundle = this._symbolServices.get(symbol)
    if (!bundle) return
    const now = Date.now()
    if (bundle.lastResyncAt && now - bundle.lastResyncAt < 2000) return
    bundle.lastResyncAt = now
    try {
      await new Promise((r) => setTimeout(r, 500))
      const raw = await this.marketDataPort.getOrderBookRaw(symbol, 1000)
      bundle.localBook.applySnapshot(raw)
    } catch (err) {
      logger.error(`[SocketAdapter] Failed to resync local book for ${symbol}: ${err.message}`)
    }
  }

  async _seedCandleHistory(symbol, intervals) {
    if (!this.marketDataPort) return
    const bundle = this._symbolServices.get(symbol)
    if (!bundle) return
    const SEED_LIMIT = 100
    await Promise.all(
      intervals.map(async (interval) => {
        try {
          const candles = await this.marketDataPort.getCandles(symbol, interval, SEED_LIMIT)
          if (!Array.isArray(candles) || candles.length === 0) return
          const closedCandles = candles.slice(0, -1)
          if (closedCandles.length === 0) return
          if (!bundle._candleHistory.has(interval)) bundle._candleHistory.set(interval, [])
          const hist = bundle._candleHistory.get(interval)
          if (hist.length === 0) hist.push(...closedCandles.slice(-MAX_CANDLE_HISTORY))
          logger.debug(`[SocketAdapter] Seeded ${hist.length} ${interval} candles for ${symbol}`)
        } catch (err) {
          logger.warn(`[SocketAdapter] Failed to seed ${interval} candle history for ${symbol}: ${err.message}`)
        }
      }),
    )
  }

  async _onSubscribe(socket, payload) {
    // Frontend (tv3) now always sends the explicit intervals it needs (union
    // of every active feature). Keep a sane fallback for legacy callers.
    const { symbol, intervals = ['1m', '5m', '15m', '1h', '4h'] } = payload ?? {}
    if (!symbol) {
      this._emitToSocket(
        socket,
        FUTURES_SOCKET_EVENTS.ASSET_ERROR,
        { error: 'symbol is required' },
        { stream: 'asset.error' },
      )
      return
    }
    const normalizedSymbol = symbol.trim().toUpperCase()
    const room = `futures:${normalizedSymbol}`
    if (socket._futuresSymbol === normalizedSymbol) {
      logger.debug(`[SocketAdapter] ${socket.id} already subscribed to ${normalizedSymbol}, ignoring`)
      return
    }
    const previousSymbol = socket._futuresSymbol
    socket._futuresSymbol = normalizedSymbol
    if (previousSymbol && previousSymbol !== normalizedSymbol) {
      socket.leave(`futures:${previousSymbol}`)
      await this._decrementRef(previousSymbol)
    }
    try {
      const context = await this.getAssetContextUseCase.execute({ symbol: normalizedSymbol })
      this._emitToSocket(socket, FUTURES_SOCKET_EVENTS.ASSET_CONTEXT, context, {
        stream: 'asset.context',
        symbol: normalizedSymbol,
      })
      socket.join(room)
      const refCount = (this._roomRefs.get(normalizedSymbol) ?? 0) + 1
      this._roomRefs.set(normalizedSymbol, refCount)
      if (refCount === 1) {
        const tickSize = context.tradingRules?.tickSize?.toString() ?? '0.01'
        this._initSymbolServices(normalizedSymbol, tickSize, intervals, room)
        await this.subscribeFuturesAssetUseCase.execute({
          symbol: normalizedSymbol,
          intervals,
          handlers: this._buildHandlers(normalizedSymbol, room),
        })
        await new Promise((r) => setTimeout(r, 500))
        await this._resyncLocalBook(normalizedSymbol)
        await this._seedCandleHistory(normalizedSymbol, intervals)
        await this._restoreOpenPositions(normalizedSymbol)
      }
      this._emitFootprintInit(socket, normalizedSymbol)
      logger.info(`[SocketAdapter] ${socket.id} subscribed to ${normalizedSymbol} (refs: ${refCount})`)
    } catch (err) {
      logger.error(`[SocketAdapter] subscribe error for ${normalizedSymbol}: ${err.message}`)
      this._emitToSocket(
        socket,
        FUTURES_SOCKET_EVENTS.ASSET_ERROR,
        { error: err.message, code: err.code },
        { stream: 'asset.error', symbol: normalizedSymbol },
      )
      socket._futuresSymbol = previousSymbol
    }
  }

  async _onUnsubscribe(socket, payload) {
    const { symbol } = payload ?? {}
    if (!symbol) return
    const normalizedSymbol = symbol.trim().toUpperCase()
    socket.leave(`futures:${normalizedSymbol}`)
    if (socket._futuresSymbol === normalizedSymbol) socket._futuresSymbol = undefined
    await this._decrementRef(normalizedSymbol)
  }

  async _onDisconnect(socket) {
    const symbol = socket._futuresSymbol
    if (symbol) await this._decrementRef(symbol)
  }

  async _decrementRef(symbol) {
    const current = this._roomRefs.get(symbol) ?? 0
    if (current <= 0) return
    const newCount = current - 1
    if (newCount === 0) {
      this._roomRefs.delete(symbol)
      this._cleanupSymbolServices(symbol)
      try {
        await this.unsubscribeFuturesAssetUseCase.execute({ symbol })
        logger.info(`[SocketAdapter] Closed streams for ${symbol} (no more subscribers)`)
      } catch (err) {
        logger.warn(`[SocketAdapter] Error closing streams for ${symbol}: ${err.message}`)
      }
    } else {
      this._roomRefs.set(symbol, newCount)
    }
  }

  _buildHandlers(symbol, room) {
    return {
      onTicker: (data) => {
        const backendReceivedAt = Date.now()
        this._emitToRoom(room, FUTURES_SOCKET_EVENTS.MARKET_TICKER, data, {
          stream: 'market.ticker',
          symbol,
          backendReceivedAt,
        })
      },
      onMarkPrice: (data) => {
        const backendReceivedAt = Date.now()
        this._emitToRoom(room, FUTURES_SOCKET_EVENTS.MARKET_MARK_PRICE, data, {
          stream: 'market.markPrice',
          symbol,
          backendReceivedAt,
        })
        const bundle = this._symbolServices.get(symbol)
        if (bundle && data.markPrice != null) bundle._lastMarkPrice = parseFloat(data.markPrice)

        if (data.markPrice != null) {
          this._processPaperTradeTick(symbol, room, Number(data.markPrice), backendReceivedAt)
        }
      },
      onOrderBook: (data) => {
        const backendReceivedAt = Date.now()
        this._emitToRoom(room, FUTURES_SOCKET_EVENTS.BOOK_PARTIAL, data, {
          stream: 'book.partial',
          symbol,
          backendReceivedAt,
        })
      },
      onDiffDepth: (data) => {
        const bundle = this._symbolServices.get(symbol)
        if (!bundle) return
        const t0 = LATENCY_DEBUG ? performance.now() : 0
        this._enqueueDepthDelta(symbol, data)
        if (LATENCY_DEBUG) {
          const ms = performance.now() - t0
          if (ms >= LATENCY_WARN_MS) {
            logger.warn(`[SocketAdapter] Slow onDiffDepth enqueue for ${symbol}: ${ms.toFixed(2)}ms`)
          }
        }
      },
      onCandle: (data) => {
        const backendReceivedAt = Date.now()
        this._emitToRoom(room, FUTURES_SOCKET_EVENTS.MARKET_CANDLE, data, {
          stream: `market.candle.${data.interval}`,
          symbol,
          backendReceivedAt,
          exchangeEventTime: extractExchangeEventTime(data),
        })
        const bundle = this._symbolServices.get(symbol)
        if (!bundle) return
        if (data.isFinal) {
          if (!bundle._candleHistory.has(data.interval)) bundle._candleHistory.set(data.interval, [])
          const hist = bundle._candleHistory.get(data.interval)
          hist.push(data)
          if (hist.length > MAX_CANDLE_HISTORY) hist.shift()
        }
        const svc = bundle.footprints.get(data.interval)
        if (!svc) return
        try {
          svc.updateFromCandle(data)
          const current = svc.getCurrent()
          const payload = current ? current.toPlainObject() : (svc.getHistory(1)[0]?.toPlainObject() ?? null)
          if (payload) {
            this._emitToRoom(
              room,
              FUTURES_SOCKET_EVENTS.ORDERFLOW_FOOTPRINT,
              { symbol, interval: data.interval, footprint: payload },
              {
                stream: `orderflow.footprint.${data.interval}`,
                symbol,
                backendReceivedAt,
              },
            )
          }
        } catch (err) {
          logger.warn(`[SocketAdapter] footprint candle error for ${symbol}/${data.interval}: ${err.message}`)
        }
      },
      onTrade: (data) => {
        const t0 = LATENCY_DEBUG ? performance.now() : 0
        const backendReceivedAt = Date.now()
        this._emitToRoom(room, FUTURES_SOCKET_EVENTS.TRADE_AGG, data, {
          stream: 'trade.agg',
          symbol,
          backendReceivedAt,
          exchangeEventTime: extractExchangeEventTime(data),
        })
        const bundle = this._symbolServices.get(symbol)
        if (!bundle) return

        const tradeEventTime = extractExchangeEventTime(data)
        const hasTradeEventTime = Number.isFinite(Number(tradeEventTime))
        const isOutOfOrderTrade =
          hasTradeEventTime &&
          Number.isFinite(Number(bundle._lastTradeEventTime)) &&
          Number(tradeEventTime) + TRADE_OUT_OF_ORDER_TOLERANCE_MS < Number(bundle._lastTradeEventTime)

        if (isOutOfOrderTrade) {
          bundle._droppedOutOfOrderTrades += 1
          if (bundle._droppedOutOfOrderTrades % 100 === 0) {
            logger.warn(
              `[SocketAdapter] Dropped ${bundle._droppedOutOfOrderTrades} out-of-order trades for ${symbol} ` +
                `(last=${bundle._lastTradeEventTime}, current=${tradeEventTime})`,
            )
          }
          return
        }

        if (hasTradeEventTime) {
          bundle._lastTradeEventTime = Number(tradeEventTime)
        }

        try {
          const cvdUpdate = bundle.cvd.addTrade(data)
          const processedAt = Date.now()
          this._emitToRoom(
            room,
            FUTURES_SOCKET_EVENTS.ORDERFLOW_CVD,
            { symbol, ...cvdUpdate },
            {
              stream: 'orderflow.cvd',
              symbol,
              backendReceivedAt,
              backendProcessedAt: processedAt,
              exchangeEventTime: extractExchangeEventTime(data),
            },
          )
          bundle._recentCvdHistory.push({
            side: cvdUpdate.side,
            qty: parseFloat(data.qty),
            time: data.time ?? Date.now(),
          })
          for (const svc of bundle.footprints.values()) svc.updateFromTrade(data)

          if (LATENCY_DEBUG) {
            const ms = performance.now() - t0
            if (ms >= LATENCY_WARN_MS) {
              logger.warn(`[SocketAdapter] Slow onTrade handler for ${symbol}: ${ms.toFixed(2)}ms`)
            }
          }
        } catch (err) {
          logger.warn(`[SocketAdapter] trade service error for ${symbol}: ${err.message}`)
        }
      },
    }
  }

  _runSignalEngine(symbol, room, orderBook = null) {
    const bundle = this._symbolServices.get(symbol)
    if (!bundle) return
    // Cadence is enforced by the setInterval that calls us; no per-emit
    // throttle check is needed anymore. We still record _lastSignalEngineRunAt
    // for diagnostics.
    const now = Date.now()
    bundle._lastSignalEngineRunAt = now
    const backendReceivedAt = now
    const t0 = performance.now()
    try {
      const result = bundle.signalEngine.process(symbol, {
        orderBook: orderBook ?? null,
        candleHistory: bundle._candleHistory,
        cvdHistory: bundle._recentCvdHistory.toArray(),
        spoofingCandidates: bundle._recentSpoofingCandidates.toArray(),
        markPrice: bundle._lastMarkPrice,
      })
      const backendProcessedAt = Date.now()

      // ── Dynamic Risk Manager hook ────────────────────────────────────────
      // 1) Entry signals: ask the policy whether the bot can auto-execute.
      // 2) Active auto-managed position: run the autonomous management
      //    decision (trailing SL / break-even / forced close on warnings).
      let autoExecution = null
      const incoming = result.signal
      const isEntrySignal = incoming?.type === 'ENTRY'
      const currentOpenPosition = this.paperTradeService.getOpenPositionForSymbol(symbol)
      // Rules in effect right now (regime, thresholds…) — surfaced to the UI
      // on every signal update so the user always knows what the RM enforces.
      const activeRules = this.riskManager?.summarizeActiveRules
        ? this.riskManager.summarizeActiveRules({
            factors: result.factors,
            position: currentOpenPosition,
          })
        : []
      if (this.riskManager && isEntrySignal && !currentOpenPosition) {
        try {
          const accountState = {
            dailyPnl: this.paperTradeService.getDailyPnl?.() ?? 0,
            executionMode: this.scalpConfig?.executionMode ?? 'auto',
          }
          if (this.scalpConfig?.account) {
            // Equity is the running paper-account cap (starting $10k +
            // cumulative realized PnL across restarts) so position sizing
            // shrinks after losses and grows after wins. Falls back to the
            // static config value if the PortfolioManager isn't wired.
            accountState.equity =
              this.portfolioManager?.getPaperEquity?.() ?? this.scalpConfig.account.equity
            accountState.riskPerTradePct = this.scalpConfig.account.riskPerTradePct
            if (Number.isFinite(this.scalpConfig.account.maxNotional)) {
              accountState.maxNotional = this.scalpConfig.account.maxNotional
            }
            accountState.contractMultiplier = this.scalpConfig.account.contractMultiplier
          }
          if (this.scalpConfig?.costs) {
            accountState.costs = this.scalpConfig.costs
          }
          const decision = this.riskManager.evaluateSignal({
            signal: incoming,
            factors: result.factors,
            position: null,
            accountState,
          })
          autoExecution = {
            scope: 'ENTRY',
            mode: decision.mode,
            approved: decision.approved,
            regime: decision.regime,
            reasons: decision.reasons,
            minConfidence: decision.minConfidence,
            minRiskReward: decision.minRiskReward,
            rule: decision.rule,
            adjustedRisk: decision.adjustedRisk,
            executionMode: decision.executionMode ?? (this.scalpConfig?.executionMode ?? 'auto'),
            activeRules,
          }
          if (decision.approved && decision.mode === 'AUTO') {
            this._autoOpenPosition(symbol, room, incoming, decision, bundle)
          }
        } catch (err) {
          logger.warn(`[SocketAdapter] risk evaluateSignal error for ${symbol}: ${err.message}`)
        }
      }
      if (this.riskManager && currentOpenPosition?.autoManaged) {
        try {
          const action = this.riskManager.evaluateActivePosition({
            position: currentOpenPosition,
            factors: result.factors,
            signalState: result.state,
            markPrice: bundle._lastMarkPrice,
            config: this.scalpConfig?.position ?? undefined,
          })
          // Surface the autonomous management decision to the UI so the popup
          // never has to ask the user about warnings/exits on auto positions.
          autoExecution = autoExecution || {
            scope: 'POSITION',
            mode: 'AUTO',
            approved: true,
            regime: currentOpenPosition.autoExecutionMeta?.regime ?? null,
            reasons: [
              action?.reason
                ? `Risk Manager · ${action.action}: ${action.reason}`
                : `Risk Manager · ${action?.action ?? 'HOLD'}`,
            ],
            rule: action?.action ?? 'HOLD',
            action: action?.action ?? 'HOLD',
            newStopLoss: Number.isFinite(action?.newStopLoss) ? action.newStopLoss : null,
            closeReason: action?.closeReason ?? null,
            adjustedRisk: null,
            executionMode: this.scalpConfig?.executionMode ?? 'auto',
            activeRules,
          }
          this._applyAutoManagementAction(symbol, room, currentOpenPosition, action, bundle)
        } catch (err) {
          logger.warn(`[SocketAdapter] risk evaluateActivePosition error for ${symbol}: ${err.message}`)
        }
      }

      const missingContextKey = result.missingContext.join(',')
      const missingContextChanged = missingContextKey !== bundle._lastMissingContextKey
      if (result.stateChanged || result.signal !== null || missingContextChanged) {
        bundle._lastMissingContextKey = missingContextKey
        const signalPayload = {
          symbol,
          state: result.state,
          prevState: result.prevState,
          stateChanged: result.stateChanged,
          netScore: result.netScore,
          confidence: result.confidence,
          signal: result.signal,
          activeSignal: result.activeSignal,
          hasPosition: result.hasPosition,
          positionDirection: result.positionDirection,
          reasons: result.reasons,
          missingContext: result.missingContext,
          autoExecution,
          timestamp: now,
        }
        this._emitToRoom(room, FUTURES_SOCKET_EVENTS.SIGNAL_UPDATE, signalPayload, {
          stream: 'signal.update',
          symbol,
          backendReceivedAt,
          backendProcessedAt,
        })

        this._persistSignalHistory({
          ...signalPayload,
          interval: bundle.signalEngine.interval,
          decision: autoExecution?.mode === 'AUTO' ? 'AUTO_EXECUTED' : 'SIGNAL_UPDATE',
          activeSignalId: signalPayload.activeSignal?.id ?? null,
        })
      }

      if (LATENCY_DEBUG) {
        const ms = performance.now() - t0
        if (ms >= LATENCY_WARN_MS) {
          logger.warn(`[SocketAdapter] Slow signal engine run for ${symbol}: ${ms.toFixed(2)}ms`)
        }
      }
    } catch (err) {
      logger.warn(`[SocketAdapter] signal engine error for ${symbol}: ${err.message}`)
    } finally {
      metrics.signalCycleMs.observe({ symbol }, performance.now() - t0)
    }
  }

  /**
   * Auto-open a paper position based on a RiskManager AUTO decision. Mirrors
   * the manual `_onSignalPositionAccept` flow.
   */
  _autoOpenPosition(symbol, room, signal, decision, bundle) {
    const direction = String(signal.direction || '').toUpperCase()
    if (direction !== 'LONG' && direction !== 'SHORT') return
    const risk = decision.adjustedRisk ?? signal.risk ?? {}
    const entryPrice = Number(risk.entryPrice ?? bundle._lastMarkPrice)
    if (!Number.isFinite(entryPrice)) return
    try {
      const opened = this.paperTradeService.openPosition({
        symbol,
        userId: 'risk-manager',
        direction,
        entryPrice,
        stopLoss: risk.stopLoss ?? null,
        takeProfit: risk.takeProfit ?? null,
        sourceSignalId: signal.id,
        autoManaged: true,
        autoExecutionMeta: {
          mode: decision.mode,
          regime: decision.regime,
          rule: decision.rule,
          minConfidence: decision.minConfidence,
          minRiskReward: decision.minRiskReward,
          reasons: decision.reasons,
        },
      })
      this._emitToRoom(`futures:${symbol}`, FUTURES_SOCKET_EVENTS.PAPER_TRADE_OPENED, opened, {
        stream: 'paperTrade.opened',
        symbol,
      })
      this._persistPaperPosition(opened)
      this._persistSignalHistory({
        timestamp: Date.now(),
        symbol,
        interval: bundle.signalEngine.interval,
        state: bundle.signalEngine.getState(),
        prevState: bundle.signalEngine.getState(),
        netScore: signal.score ?? 0,
        confidence: signal.confidence ?? 0,
        reasons: decision.reasons ?? [],
        missingContext: [],
        decision: 'AUTO_ACCEPTED',
        activeSignalId: signal.id,
        positionId: opened.id,
      })
      bundle.signalEngine.notifyPositionAccepted({
        entryPrice,
        takeProfit: risk.takeProfit ?? null,
        stopLoss: risk.stopLoss ?? null,
      })
      logger.info(
        `[SocketAdapter] [RISK-AUTO] opened ${direction} ${symbol} @ ${entryPrice} ` +
          `(regime=${decision.regime}, conf=${signal.confidence}%, rule=${decision.rule})`,
      )
    } catch (err) {
      if (err?.code !== 'POSITION_ALREADY_OPEN') {
        logger.warn(`[SocketAdapter] auto-open failed for ${symbol}: ${err.message}`)
      }
    }
  }

  /**
   * Apply a RiskManager decision against an OPEN auto-managed position:
   * either close it or move its stop-loss.
   */
  _applyAutoManagementAction(symbol, room, position, action, bundle) {
    if (!action || action.action === 'HOLD') return
    if (action.action === 'CLOSE') {
      const closed = this.paperTradeService.closePosition({
        symbol,
        positionId: position.id,
        closePrice: bundle._lastMarkPrice,
        closeReason: action.closeReason || 'RISK_MANAGER',
      })
      if (!closed) return
      this._emitToRoom(`futures:${symbol}`, FUTURES_SOCKET_EVENTS.PAPER_TRADE_CLOSED, closed, {
        stream: 'paperTrade.closed',
        symbol,
      })
      this._persistPaperPosition(closed)
      this.portfolioManager?.recordPaperClose(closed)
      this._persistSignalHistory({
        timestamp: Date.now(),
        symbol,
        interval: bundle.signalEngine.interval,
        state: bundle.signalEngine.getState(),
        prevState: bundle.signalEngine.getState(),
        netScore: 0,
        confidence: 0,
        reasons: [action.reason || ''],
        missingContext: [],
        decision: 'AUTO_CLOSED',
        activeSignalId: position.sourceSignalId ?? null,
        positionId: position.id,
      })
      bundle.signalEngine.notifyPositionClosed()
      logger.info(`[SocketAdapter] [RISK-AUTO] closed ${symbol} reason=${action.closeReason}`)
      return
    }
    if (action.action === 'ADJUST_SL' && Number.isFinite(action.newStopLoss)) {
      const updated = this.paperTradeService.updateStops({
        symbol,
        positionId: position.id,
        stopLoss: action.newStopLoss,
      })
      if (!updated) return
      this._emitToRoom(`futures:${symbol}`, FUTURES_SOCKET_EVENTS.PAPER_TRADE_UPDATED, updated, {
        stream: 'paperTrade.updated',
        symbol,
      })
      this._persistPaperPosition(updated)
      logger.debug(
        `[SocketAdapter] [RISK-AUTO] adjusted SL ${symbol} → ${action.newStopLoss} (${action.reason})`,
      )
    }
  }

  _onSignalPositionAccept(socket, data) {
    const symbol = socket._futuresSymbol
    if (!symbol) return
    const bundle = this._symbolServices.get(symbol)
    if (!bundle) return

    const state = bundle.signalEngine.getState()
    const activeSignal = bundle.signalEngine.getActiveSignal()
    const directionFromPayload = typeof data?.direction === 'string' ? data.direction.toUpperCase() : null
    const directionFromSignal =
      typeof activeSignal?.direction === 'string' ? activeSignal.direction.toUpperCase() : null
    const directionFromState =
      typeof data?.signalState === 'string'
        ? data.signalState.startsWith('SHORT')
          ? 'SHORT'
          : data.signalState.startsWith('LONG')
            ? 'LONG'
            : null
        : state.startsWith('SHORT')
          ? 'SHORT'
          : state.startsWith('LONG')
            ? 'LONG'
            : null
    const direction =
      directionFromPayload === 'LONG' || directionFromPayload === 'SHORT'
        ? directionFromPayload
        : directionFromSignal === 'LONG' || directionFromSignal === 'SHORT'
          ? directionFromSignal
          : directionFromState === 'LONG' || directionFromState === 'SHORT'
            ? directionFromState
            : null
    const signalId = data?.signalId ?? activeSignal?.id ?? null
    const fallbackPrice = bundle._lastMarkPrice
    const entryPrice = data?.entryPrice != null ? Number(data.entryPrice) : fallbackPrice
    if (entryPrice != null && Number.isFinite(entryPrice) && direction) {
      try {
        const opened = this.paperTradeService.openPosition({
          symbol,
          userId: socket.id,
          direction,
          entryPrice,
          quantity: data?.quantity ?? null,
          stopLoss: data?.stopLoss ?? null,
          takeProfit: data?.takeProfit ?? null,
          sourceSignalId: signalId,
        })
        this._emitToRoom(`futures:${symbol}`, FUTURES_SOCKET_EVENTS.PAPER_TRADE_OPENED, opened, {
          stream: 'paperTrade.opened',
          symbol,
        })

        this._persistPaperPosition(opened)
        this._persistSignalHistory({
          timestamp: Date.now(),
          symbol,
          interval: bundle.signalEngine.interval,
          state,
          prevState: state,
          netScore: 0,
          confidence: 0,
          reasons: [],
          missingContext: [],
          decision: 'POSITION_ACCEPTED',
          activeSignalId: signalId,
          positionId: opened.id,
        })
      } catch (err) {
        logger.warn(`[SocketAdapter] paper trade open failed for ${symbol}: ${err.message}`)
      }
    } else if (!direction) {
      logger.warn(`[SocketAdapter] paper trade open skipped for ${symbol}: missing direction`)
    }

    bundle.signalEngine.notifyPositionAccepted({
      entryPrice: data?.entryPrice != null ? Number(data.entryPrice) : null,
      takeProfit: data?.takeProfit != null ? Number(data.takeProfit) : null,
      stopLoss: data?.stopLoss != null ? Number(data.stopLoss) : null,
    })
    const room = `futures:${symbol}`
    bundle._lastSignalEngineRunAt = 0
    this._runSignalEngine(symbol, room)
    logger.debug(`[SocketAdapter] Signal position accepted for ${symbol}`)
  }

  _onSignalPositionClose(socket, data) {
    const symbol = socket._futuresSymbol
    if (!symbol) return
    const bundle = this._symbolServices.get(symbol)
    if (!bundle) return

    const closed = this.paperTradeService.closeLatestOpenPosition({
      symbol,
      closePrice: bundle._lastMarkPrice,
      closeReason: 'MANUAL',
    })
    if (closed) {
      this._emitToRoom(`futures:${symbol}`, FUTURES_SOCKET_EVENTS.PAPER_TRADE_CLOSED, closed, {
        stream: 'paperTrade.closed',
        symbol,
      })
      this._persistPaperPosition(closed)
      this.portfolioManager?.recordPaperClose(closed)
      this._persistSignalHistory({
        timestamp: Date.now(),
        symbol,
        interval: bundle.signalEngine.interval,
        state: bundle.signalEngine.getState(),
        prevState: bundle.signalEngine.getState(),
        netScore: 0,
        confidence: 0,
        reasons: [],
        missingContext: [],
        decision: 'POSITION_CLOSED',
        activeSignalId: null,
        positionId: closed.id,
      })
    }

    bundle.signalEngine.notifyPositionClosed()
    const room = `futures:${symbol}`
    bundle._lastSignalEngineRunAt = 0
    this._runSignalEngine(symbol, room)
    logger.debug(`[SocketAdapter] Signal position closed for ${symbol}`)
  }

  _processPaperTradeTick(symbol, room, price, backendReceivedAt = Date.now()) {
    const events = this.paperTradeService.onPriceTick({ symbol, price, now: Date.now() })
    if (!events.length) return

    for (const event of events) {
      if (event.type === 'UPDATED') {
        this._emitToRoom(room, FUTURES_SOCKET_EVENTS.PAPER_TRADE_UPDATED, event.position, {
          stream: 'paperTrade.updated',
          symbol,
          backendReceivedAt,
        })
        this._persistPaperPosition(event.position)
        continue
      }

      if (event.type === 'CLOSED') {
        this._emitToRoom(room, FUTURES_SOCKET_EVENTS.PAPER_TRADE_CLOSED, event.position, {
          stream: 'paperTrade.closed',
          symbol,
          backendReceivedAt,
        })
        this._persistPaperPosition(event.position)
        this.portfolioManager?.recordPaperClose(event.position)
        const bundle = this._symbolServices.get(symbol)
        this._persistSignalHistory({
          timestamp: Date.now(),
          symbol,
          interval: bundle?.signalEngine.interval ?? '1m',
          state: bundle?.signalEngine.getState() ?? 'UNKNOWN',
          prevState: bundle?.signalEngine.getState() ?? 'UNKNOWN',
          netScore: 0,
          confidence: 0,
          reasons: [event.position?.closeReason || ''],
          missingContext: [],
          decision: 'PAPER_TRADE_CLOSED',
          activeSignalId: event.position?.sourceSignalId ?? null,
          positionId: event.position?.id ?? null,
        })
        // Sync state machine: TP/SL fired autonomously, the engine must exit
        // LONG_OPEN/SHORT_OPEN so new entry signals can be generated.
        if (bundle) {
          bundle.signalEngine.notifyPositionClosed()
          bundle._lastSignalEngineRunAt = 0
          this._runSignalEngine(symbol, room)
        }
        logger.info(`[SocketAdapter] Paper position auto-closed for ${symbol} reason=${event.position?.closeReason}`)
      }
    }
  }

  async _restoreOpenPositions(symbol) {
    if (!this.tradingPersistence) return
    try {
      const result = await this.tradingPersistence.listPaperPositions({ symbol, status: 'OPEN', limit: 100 })
      const positions = result?.items ?? []
      // Enforce 1-op-per-symbol on restore: keep only the most recently opened
      // and close the rest defensively (paper book only).
      const sorted = positions.slice().sort((a, b) => (b.openedAt ?? 0) - (a.openedAt ?? 0))
      const keeper = sorted[0]
      if (keeper) {
        this.paperTradeService.importPosition({
          id: keeper.positionId,
          userId: keeper.userId ?? null,
          symbol: keeper.symbol,
          direction: keeper.direction,
          entryPrice: keeper.entryPrice,
          quantity: keeper.quantity ?? null,
          stopLoss: keeper.stopLoss ?? null,
          takeProfit: keeper.takeProfit ?? null,
          openedAt: keeper.openedAt,
          closedAt: null,
          status: 'OPEN',
          sourceSignalId: keeper.sourceSignalId ?? null,
          currentPrice: keeper.currentPrice ?? keeper.entryPrice,
          unrealizedPnl: keeper.unrealizedPnl ?? 0,
          realizedPnl: null,
          closeReason: null,
          autoManaged: keeper.autoManaged ?? false,
          autoExecutionMeta: keeper.autoExecutionMeta ?? null,
        })

        // Re-broadcast the restored position so the (re)connecting frontend
        // can hydrate its store and resume PnL updates immediately.
        const restored = this.paperTradeService.getOpenPositionForSymbol(symbol)
        if (restored) {
          this._emitToRoom(`futures:${symbol}`, FUTURES_SOCKET_EVENTS.PAPER_TRADE_OPENED, restored, {
            stream: 'paperTrade.opened',
            symbol,
          })

          // If the restored position was auto-managed, also notify the state
          // machine so its transitions stay coherent.
          const bundle = this._symbolServices.get(symbol)
          if (bundle?.signalEngine) {
            bundle.signalEngine.notifyPositionAccepted({
              entryPrice: restored.entryPrice,
              takeProfit: restored.takeProfit,
              stopLoss: restored.stopLoss,
            })
          }
        }
      }
      if (positions.length > 0) {
        logger.info(`[SocketAdapter] Restored ${positions.length} open position(s) for ${symbol}`)
      }
    } catch (err) {
      logger.warn(`[SocketAdapter] Failed to restore open positions for ${symbol}: ${err.message}`)
    }
  }

  _persistPaperPosition(position) {
    if (!this.tradingPersistence || !position) return
    this.tradingPersistence
      .savePaperPosition(position)
      .catch((err) => this.tradingPersistence.logPersistError('savePaperPosition', err))
  }

  _persistSignalHistory(entry) {
    if (!this.tradingPersistence || !entry) return
    this.tradingPersistence
      .saveSignalHistory({
        ...entry,
        reasons: Array.isArray(entry.reasons)
          ? entry.reasons.map((reason) => (typeof reason === 'string' ? reason : (reason?.label ?? String(reason))))
          : [],
      })
      .catch((err) => this.tradingPersistence.logPersistError('saveSignalHistory', err))
  }

  _emitFootprintInit(socket, symbol) {
    const bundle = this._symbolServices.get(symbol)
    if (!bundle) return
    const footprints = {}
    for (const [interval, svc] of bundle.footprints) {
      footprints[interval] = svc.getHistory(100).map((c) => c.toPlainObject())
    }
    this._emitToSocket(
      socket,
      FUTURES_SOCKET_EVENTS.ORDERFLOW_FOOTPRINT_INIT,
      { symbol, footprints },
      { stream: 'orderflow.footprint.init', symbol },
    )
  }

  getSymbolHealth(symbol) {
    const bundle = this._symbolServices.get(symbol.trim().toUpperCase())
    return bundle ? bundle.localBook.getHealth() : null
  }
}

/**
 * Precompute the OrderBook-derived state that both Spoofing and LiquidityShift
 * need. Today the only shareable piece is the book-wide median quantity
 * (Spoofing uses it as the confidence denominator; LiquidityShift uses it as
 * the wall threshold base). Computing it once per emit and sharing the result
 * avoids two independent O(N log N) sorts over the same book.
 *
 * @param {import('../../../../domain/futures/entities/OrderBook').OrderBook} ob
 * @returns {{ medianQty: import('decimal.js').Decimal | null }}
 */
function buildSharedOrderBookContext(ob) {
  const n = ob.bids.length + ob.asks.length
  if (n === 0) return { medianQty: null }
  const allQtys = new Array(n)
  let i = 0
  for (const l of ob.bids) allQtys[i++] = l.qty
  for (const l of ob.asks) allQtys[i++] = l.qty
  allQtys.sort((a, b) => a.cmp(b))
  const mid = Math.floor(allQtys.length / 2)
  const medianQty = allQtys.length % 2 === 0
    ? allQtys[mid - 1].plus(allQtys[mid]).div(2)
    : allQtys[mid]
  return { medianQty }
}

module.exports = { FuturesAssetSocketAdapter }
