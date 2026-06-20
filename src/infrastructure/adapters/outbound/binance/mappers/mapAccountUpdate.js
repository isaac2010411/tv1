'use strict'

const toNumber = (value, fallback = 0) => {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

const directionFromAmount = (amount) => {
  const n = toNumber(amount)
  if (n > 0) return 'LONG'
  if (n < 0) return 'SHORT'
  return 'FLAT'
}

const mapAccountUpdate = (payload = {}) => {
  const account = payload.accountUpdate ?? payload.a ?? {}
  const balances = account.balances ?? account.B ?? []
  const positions = account.positions ?? account.P ?? []

  return {
    eventTime: payload.eventTime ?? payload.E ?? null,
    transactionTime: payload.transactionTime ?? payload.T ?? account.eventTime ?? account.m ?? null,
    reason: account.reason ?? account.m ?? null,
    balances: balances.map((balance) => ({
      asset: balance.asset ?? balance.a ?? null,
      walletBalance: toNumber(balance.walletBalance ?? balance.wb),
      crossWalletBalance: toNumber(balance.crossWalletBalance ?? balance.cw),
      balanceChange: toNumber(balance.balanceChange ?? balance.bc),
    })),
    positions: positions.map((position) => {
      const positionAmt = toNumber(position.positionAmt ?? position.pa)
      return {
        symbol: position.symbol ?? position.s ?? null,
        positionAmt,
        direction: directionFromAmount(positionAmt),
        entryPrice: toNumber(position.entryPrice ?? position.ep),
        breakEvenPrice: toNumber(position.breakEvenPrice ?? position.bep),
        accumulatedRealized: toNumber(position.accumulatedRealized ?? position.cr),
        unrealizedPnl: toNumber(position.unrealizedPnl ?? position.up),
        marginType: position.marginType ?? position.mt ?? null,
        isolatedWallet: toNumber(position.isolatedWallet ?? position.iw),
        positionSide: position.positionSide ?? position.ps ?? 'BOTH',
      }
    }),
  }
}

module.exports = { mapAccountUpdate }
