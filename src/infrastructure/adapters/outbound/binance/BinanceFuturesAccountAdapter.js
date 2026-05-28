'use strict'

const { FuturesAccountPort }  = require('../../../../domain/futures/ports/outbound/FuturesAccountPort')
const { Position }            = require('../../../../domain/futures/entities/Position')
const { OpenOrder }           = require('../../../../domain/futures/entities/OpenOrder')
const { InfrastructureError } = require('../../../../shared/errors/InfrastructureError')

/**
 * Outbound adapter: implements FuturesAccountPort using binance-api-node.
 *
 * NOTE: API keys are required for all methods.  Ensure BINANCE_API_KEY and
 * BINANCE_SECRET_KEY are set in the environment.
 */
class BinanceFuturesAccountAdapter extends FuturesAccountPort {
  /** @param {object} binanceClient – binance-api-node client instance */
  constructor(binanceClient) {
    super()
    this.client = binanceClient
  }

  async getAccountContext(symbol) {
    try {
      const [balance, positions, openOrders] = await Promise.all([
        this.getAvailableBalance(),
        this.getOpenPositions(symbol),
        this.getOpenOrders(symbol),
      ])
      return { balance, positions, openOrders }
    } catch (err) {
      if (err.name === 'InfrastructureError') throw err
      throw new InfrastructureError(
        `getAccountContext failed: ${err.message}`,
        'BINANCE_ACCOUNT_CONTEXT_ERROR',
      )
    }
  }

  async getOpenPositions(symbol) {
    try {
      const raw = await this.client.futuresPositionRisk({ symbol })
      return raw
        .filter((p) => parseFloat(p.positionAmt) !== 0)
        .map((p) => new Position({
          symbol:        p.symbol,
          side:          p.positionSide,
          entryPrice:    p.entryPrice,
          positionAmt:   p.positionAmt,
          unrealizedPnl: p.unRealizedProfit,
          leverage:      p.leverage,
          marginType:    p.marginType,
        }))
    } catch (err) {
      throw new InfrastructureError(`getOpenPositions failed: ${err.message}`, 'BINANCE_POSITIONS_ERROR')
    }
  }

  async getOpenOrders(symbol) {
    try {
      const raw = await this.client.futuresOpenOrders({ symbol })
      return raw.map((o) => new OpenOrder({
        orderId:      o.orderId,
        symbol:       o.symbol,
        side:         o.side,
        type:         o.type,
        price:        o.price,
        origQty:      o.origQty,
        executedQty:  o.executedQty,
        status:       o.status,
        reduceOnly:   o.reduceOnly,
        timeInForce:  o.timeInForce,
      }))
    } catch (err) {
      throw new InfrastructureError(`getOpenOrders failed: ${err.message}`, 'BINANCE_OPEN_ORDERS_ERROR')
    }
  }

  async getAvailableBalance() {
    try {
      const balances = await this.client.futuresAccountBalance()
      const usdt     = balances.find((b) => b.asset === 'USDT') ?? {}
      return {
        asset:               'USDT',
        balance:             usdt.balance             ?? '0',
        availableBalance:    usdt.availableBalance    ?? '0',
        crossWalletBalance:  usdt.crossWalletBalance  ?? '0',
      }
    } catch (err) {
      throw new InfrastructureError(`getAvailableBalance failed: ${err.message}`, 'BINANCE_BALANCE_ERROR')
    }
  }
}

module.exports = { BinanceFuturesAccountAdapter }
