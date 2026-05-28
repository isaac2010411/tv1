'use strict'

class RingBuffer {
  constructor(capacity) {
    const n = Number(capacity)
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error('RingBuffer capacity must be a positive integer')
    }

    this._capacity = n
    this._buf = new Array(n)
    this._start = 0
    this._size = 0
  }

  push(value) {
    if (this._size < this._capacity) {
      const idx = (this._start + this._size) % this._capacity
      this._buf[idx] = value
      this._size += 1
      return
    }

    this._buf[this._start] = value
    this._start = (this._start + 1) % this._capacity
  }

  clear() {
    this._start = 0
    this._size = 0
  }

  get size() {
    return this._size
  }

  toArray() {
    if (this._size === 0) return []

    const out = new Array(this._size)
    for (let i = 0; i < this._size; i++) {
      out[i] = this._buf[(this._start + i) % this._capacity]
    }
    return out
  }
}

module.exports = { RingBuffer }
