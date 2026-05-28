'use strict'

class InfrastructureError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'InfrastructureError'
    this.code = code
  }
}

module.exports = { InfrastructureError }
