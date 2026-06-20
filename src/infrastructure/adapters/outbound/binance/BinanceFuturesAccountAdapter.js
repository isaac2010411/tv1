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
      const query = symbol ? { symbol } : undefined
      const raw = await this.client.futuresPositionRisk(query)
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
      const query = symbol ? { symbol } : undefined
      const raw = await this.client.futuresOpenOrders(query)
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
      if (typeof this.client.futuresAccountInfo === 'function') {
        const accountInfo = await this.client.futuresAccountInfo()
        const balancesConvertidos = (accountInfo.assets ?? []).map((balance) => Object.assign({}, balance))
        const usdtBalance = balancesConvertidos.find((balance) => balance.asset === 'USDT')
        return this._normalizeUsdtBalance(usdtBalance)
      }
      const balances = await this.client.futuresAccountBalance()
      const usdt     = balances.find((b) => b.asset === 'USDT') ?? {}
      return this._normalizeUsdtBalance(usdt)
    } catch (err) {
      throw new InfrastructureError(`getAvailableBalance failed: ${err.message}`, 'BINANCE_BALANCE_ERROR')
    }
  }

  _normalizeUsdtBalance(balance = {}) {
    const availableBalance = parseFloat(balance.availableBalance ?? 0)
    const walletBalance = parseFloat(balance.walletBalance ?? balance.balance ?? balance.marginBalance ?? availableBalance)
    const marginBalance = parseFloat(balance.marginBalance ?? balance.walletBalance ?? balance.balance ?? availableBalance)
    const crossWalletBalance = parseFloat(balance.crossWalletBalance ?? balance.walletBalance ?? balance.balance ?? 0)
    const unrealizedProfit = parseFloat(balance.unrealizedProfit ?? 0)

    return {
      asset: 'USDT',
      balance: Number.isFinite(walletBalance) ? walletBalance : 0,
      walletBalance: Number.isFinite(walletBalance) ? walletBalance : 0,
      marginBalance: Number.isFinite(marginBalance) ? marginBalance : 0,
      availableBalance: Number.isFinite(availableBalance) ? availableBalance : 0,
      crossWalletBalance: Number.isFinite(crossWalletBalance) ? crossWalletBalance : 0,
      unrealizedProfit: Number.isFinite(unrealizedProfit) ? unrealizedProfit : 0,
    }
  }

  async getAllOpenPositions() {
    return this.getOpenPositions()
  }

  async getAllOpenOrders() {
    return this.getOpenOrders()
  }

  async getAccountSnapshot() {
    try {
      const [balance, positions, openOrders] = await Promise.all([
        this.getAvailableBalance(),
        this.getAllOpenPositions(),
        this.getAllOpenOrders(),
      ])
      return {
        balances: [balance],
        positions,
        openOrders,
        timestamp: Date.now(),
      }
    } catch (err) {
      if (err.name === 'InfrastructureError') throw err
      throw new InfrastructureError(`getAccountSnapshot failed: ${err.message}`, 'BINANCE_ACCOUNT_SNAPSHOT_ERROR')
    }
  }
}

module.exports = { BinanceFuturesAccountAdapter }
