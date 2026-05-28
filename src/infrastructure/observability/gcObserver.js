'use strict'

const { PerformanceObserver, constants } = require('perf_hooks')
const { metrics } = require('./metrics')

const KIND_NAMES = {
  [constants?.NODE_PERFORMANCE_GC_MAJOR ?? 2]: 'major',
  [constants?.NODE_PERFORMANCE_GC_MINOR ?? 1]: 'minor',
  [constants?.NODE_PERFORMANCE_GC_INCREMENTAL ?? 4]: 'incremental',
  [constants?.NODE_PERFORMANCE_GC_WEAKCB ?? 8]: 'weakcb',
}

let _observer = null

function startGcObserver() {
  if (_observer) return
  try {
    _observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const kind = KIND_NAMES[entry.detail?.kind ?? entry.kind] ?? 'unknown'
        metrics.gcPauseMs.observe({ kind }, entry.duration)
      }
    })
    _observer.observe({ entryTypes: ['gc'], buffered: false })
  } catch {
    // GC entries may not be available on every runtime; degrade silently
    _observer = null
  }
}

function stopGcObserver() {
  if (_observer) {
    try {
      _observer.disconnect()
    } catch {
      /* noop */
    }
    _observer = null
  }
}

module.exports = { startGcObserver, stopGcObserver }
