'use strict'

class FuturesExecutionPort {
  // eslint-disable-next-line no-unused-vars
  async submit(order) {
    throw new Error('FuturesExecutionPort.submit not implemented')
  }

  // eslint-disable-next-line no-unused-vars
  async cancel(orderId) {
    throw new Error('FuturesExecutionPort.cancel not implemented')
  }

  // eslint-disable-next-line no-unused-vars
  async getOrder(query) {
    throw new Error('FuturesExecutionPort.getOrder not implemented')
  }
}

module.exports = { FuturesExecutionPort }
