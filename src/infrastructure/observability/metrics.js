'use strict'

/**
 * Lightweight in-memory metrics registry. JSON-exposed at /metrics.
 *
 * Designed to avoid adding `prom-client` as a runtime dependency. Migrate to
 * Prometheus later by replacing this module's surface; consumers only call
 * inc/observe/setGauge with stable names + label objects.
 *
 * Histogram implementation: fixed bucket boundaries + count/sum + p50/p95/p99
 * approximated from a bounded reservoir (last N samples). Reservoir is small
 * (256 samples per series) to keep memory predictable across many series.
 */

const RESERVOIR_SIZE = 256

class Counter {
  constructor(name, help) {
    this.name = name
    this.help = help
    this._values = new Map()
  }

  inc(labels = {}, value = 1) {
    const key = labelKey(labels)
    this._values.set(key, (this._values.get(key) ?? 0) + value)
  }

  snapshot() {
    const out = []
    for (const [key, value] of this._values) out.push({ labels: parseKey(key), value })
    return out
  }
}

class Gauge {
  constructor(name, help) {
    this.name = name
    this.help = help
    this._values = new Map()
  }

  set(labels = {}, value) {
    this._values.set(labelKey(labels), value)
  }

  snapshot() {
    const out = []
    for (const [key, value] of this._values) out.push({ labels: parseKey(key), value })
    return out
  }
}

class Histogram {
  constructor(name, help) {
    this.name = name
    this.help = help
    this._series = new Map()
  }

  observe(labels = {}, value) {
    const key = labelKey(labels)
    let s = this._series.get(key)
    if (!s) {
      s = { count: 0, sum: 0, max: 0, reservoir: new Float64Array(RESERVOIR_SIZE), cursor: 0, filled: 0 }
      this._series.set(key, s)
    }
    s.count += 1
    s.sum += value
    if (value > s.max) s.max = value
    s.reservoir[s.cursor] = value
    s.cursor = (s.cursor + 1) % RESERVOIR_SIZE
    if (s.filled < RESERVOIR_SIZE) s.filled += 1
  }

  snapshot() {
    const out = []
    for (const [key, s] of this._series) {
      const sample = Array.from(s.reservoir.slice(0, s.filled)).sort((a, b) => a - b)
      const pick = (q) => (sample.length === 0 ? 0 : sample[Math.min(sample.length - 1, Math.floor(q * sample.length))])
      out.push({
        labels: parseKey(key),
        count: s.count,
        sum: s.sum,
        avg: s.count > 0 ? s.sum / s.count : 0,
        max: s.max,
        p50: pick(0.5),
        p95: pick(0.95),
        p99: pick(0.99),
      })
    }
    return out
  }
}

function labelKey(labels) {
  const keys = Object.keys(labels).sort()
  if (keys.length === 0) return ''
  return keys.map((k) => `${k}=${labels[k]}`).join(',')
}

function parseKey(key) {
  if (!key) return {}
  const out = {}
  for (const pair of key.split(',')) {
    const idx = pair.indexOf('=')
    if (idx > 0) out[pair.slice(0, idx)] = pair.slice(idx + 1)
  }
  return out
}

class Registry {
  constructor() {
    this._counters = new Map()
    this._gauges = new Map()
    this._histograms = new Map()
  }

  counter(name, help = '') {
    let c = this._counters.get(name)
    if (!c) {
      c = new Counter(name, help)
      this._counters.set(name, c)
    }
    return c
  }

  gauge(name, help = '') {
    let g = this._gauges.get(name)
    if (!g) {
      g = new Gauge(name, help)
      this._gauges.set(name, g)
    }
    return g
  }

  histogram(name, help = '') {
    let h = this._histograms.get(name)
    if (!h) {
      h = new Histogram(name, help)
      this._histograms.set(name, h)
    }
    return h
  }

  snapshot() {
    const out = { counters: {}, gauges: {}, histograms: {}, capturedAt: Date.now() }
    for (const [name, c] of this._counters) out.counters[name] = { help: c.help, series: c.snapshot() }
    for (const [name, g] of this._gauges) out.gauges[name] = { help: g.help, series: g.snapshot() }
    for (const [name, h] of this._histograms) out.histograms[name] = { help: h.help, series: h.snapshot() }
    return out
  }
}

const registry = new Registry()

// ── Pre-declared metric handles (stable names) ────────────────────────────────
const metrics = {
  // process
  heapBytes: registry.gauge('process_heap_bytes', 'Heap used (bytes) sampled periodically'),
  rssBytes: registry.gauge('process_rss_bytes', 'Resident set size (bytes)'),
  externalBytes: registry.gauge('process_external_bytes', 'External memory (bytes)'),
  arrayBuffersBytes: registry.gauge('process_array_buffers_bytes', 'ArrayBuffers memory (bytes)'),
  gcPauseMs: registry.histogram('gc_pause_ms', 'GC pause duration (ms) by kind'),

  // socket.io
  socketEmits: registry.counter('socketio_emit_total', 'Socket.IO emits {event,symbol}'),
  socketEmitLatencyMs: registry.histogram('socketio_emit_latency_ms', 'Emit duration (ms)'),

  // order book
  orderBookLevels: registry.gauge('orderbook_levels', 'Levels in local book {symbol,side}'),
  orderBookEmitLatencyMs: registry.histogram('orderbook_emit_latency_ms', 'OrderBook emit duration (ms)'),
  orderBookResyncs: registry.counter('orderbook_resync_total', 'Resyncs triggered {symbol}'),
  orderBookGaps: registry.counter('orderbook_gap_total', 'Gaps detected {symbol}'),

  // depth queue
  depthQueueDepth: registry.gauge('depth_queue_depth', 'Pending depth deltas {symbol}'),
  depthDrops: registry.counter('depth_drops_total', 'Depth deltas dropped {symbol,reason}'),

  // signal engine
  signalCycleMs: registry.histogram('signal_engine_cycle_ms', 'Signal engine cycle duration (ms) {symbol}'),

  // mongo
  mongoWriteMs: registry.histogram('mongo_write_ms', 'Mongo write latency (ms) {op}'),
  mongoErrors: registry.counter('mongo_errors_total', 'Mongo write errors {op}'),

  // active subscriptions
  activeSymbols: registry.gauge('active_symbols', 'Number of refcounted symbol bundles'),
  activeRooms: registry.gauge('active_rooms', 'Number of active Socket.IO rooms'),
}

// ── Periodic process memory sampler ───────────────────────────────────────────
let _samplerInterval = null
function startMemorySampler({ intervalMs = 5_000 } = {}) {
  if (_samplerInterval) return
  _samplerInterval = setInterval(() => {
    const m = process.memoryUsage()
    metrics.heapBytes.set({}, m.heapUsed)
    metrics.rssBytes.set({}, m.rss)
    metrics.externalBytes.set({}, m.external)
    metrics.arrayBuffersBytes.set({}, m.arrayBuffers ?? 0)
  }, intervalMs)
  // Don't keep the event loop alive for metrics alone
  if (_samplerInterval.unref) _samplerInterval.unref()
}

function stopMemorySampler() {
  if (_samplerInterval) {
    clearInterval(_samplerInterval)
    _samplerInterval = null
  }
}

module.exports = {
  registry,
  metrics,
  startMemorySampler,
  stopMemorySampler,
}
