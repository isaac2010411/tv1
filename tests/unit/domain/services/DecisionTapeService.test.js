'use strict'

const { DecisionTapeService } = require('../../../../src/domain/futures/services/DecisionTapeService')

describe('DecisionTapeService', () => {
  test('produces long bias when delta and imbalance agree', () => {
    const result = new DecisionTapeService().compute({
      symbol: 'BTCUSDT',
      interval: '1m',
      bookMetrics: {
        midPrice: '100',
        spreadPct: '0.0001',
        imbalanceTop10: '0.25',
        walls: {
          bidWalls: [{ price: '99', qty: '5' }],
          askWalls: [{ price: '105', qty: '5' }],
        },
      },
      cvdHistory: [{ delta: 2 }, { delta: 3 }],
      spoofingCandidates: [{}],
      liquidityShifts: [{}, {}],
    })

    expect(result).toMatchObject({
      symbol: 'BTCUSDT',
      interval: '1m',
      deltaRecent: 5,
      imbalance: 0.25,
      spreadState: 'ok',
      spoofingCount: 1,
      liquidityShiftCount: 2,
      decisionBias: 'long',
    })
    expect(result.nearestBidWall).toEqual({ price: '99', qty: '5' })
  })

  test('blocks directional bias on alert spread', () => {
    const result = new DecisionTapeService().compute({
      symbol: 'BTCUSDT',
      interval: '1m',
      bookMetrics: { spreadPct: '0.01', imbalanceTop10: '-0.30', walls: {} },
      cvdHistory: [{ delta: -10 }],
    })

    expect(result.spreadState).toBe('alert')
    expect(result.decisionBias).toBe('neutral')
  })
})
