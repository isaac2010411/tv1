'use strict'

const { TradingRules } = require('../../../../src/domain/futures/entities/TradingRules')
const { DomainError }  = require('../../../../src/shared/errors/DomainError')

const makeRules = (overrides = {}) =>
  new TradingRules({
    symbol:          'BTCUSDT',
    tickSize:        '0.10',
    stepSize:        '0.001',
    minQty:          '0.001',
    maxQty:          '1000',
    minNotional:     '5',
    marketStepSize:  '0.001',
    marketMinQty:    '0.001',
    marketMaxQty:    '1000',
    multiplierUp:    '1.15',
    multiplierDown:  '0.85',
    allowedOrderTypes: ['LIMIT', 'MARKET'],
    ...overrides,
  })

describe('TradingRules', () => {
  describe('normalizePrice', () => {
    test('floors price to nearest tickSize increment', () => {
      const rules = makeRules({ tickSize: '0.10' })
      // 30000.123 / 0.10 = 300001.23 → floor = 300001 → × 0.10 = 30000.1
      expect(rules.normalizePrice('30000.123').toFixed()).toBe('30000.1')
    })

    test('leaves an already-aligned price unchanged', () => {
      const rules = makeRules({ tickSize: '0.10' })
      expect(rules.normalizePrice('30000.1').toFixed()).toBe('30000.1')
    })
  })

  describe('normalizeQuantity', () => {
    test('floors quantity to nearest stepSize increment', () => {
      const rules = makeRules({ stepSize: '0.001' })
      // 1.0019 / 0.001 = 1001.9 → floor = 1001 → × 0.001 = 1.001
      expect(rules.normalizeQuantity('1.0019').toFixed()).toBe('1.001')
    })

    test('leaves an already-aligned quantity unchanged', () => {
      const rules = makeRules({ stepSize: '0.001' })
      expect(rules.normalizeQuantity('1.001').toFixed()).toBe('1.001')
    })
  })

  describe('validateMinNotional', () => {
    test('passes when notional meets the minimum', () => {
      const rules = makeRules({ minNotional: '5' })
      // 30000 × 0.001 = 30 ≥ 5 → OK
      expect(() => rules.validateMinNotional('30000', '0.001')).not.toThrow()
    })

    test('throws DomainError when notional is below minimum', () => {
      const rules = makeRules({ minNotional: '5' })
      // 1 × 0.001 = 0.001 < 5
      expect(() => rules.validateMinNotional('1', '0.001')).toThrow(DomainError)
      expect(() => rules.validateMinNotional('1', '0.001')).toThrow('below minimum')
    })
  })

  describe('validatePriceTick', () => {
    test('passes when price is aligned to tickSize', () => {
      const rules = makeRules({ tickSize: '0.10' })
      expect(() => rules.validatePriceTick('30000.0')).not.toThrow()
    })

    test('throws DomainError when price is not aligned to tickSize', () => {
      const rules = makeRules({ tickSize: '0.10' })
      expect(() => rules.validatePriceTick('30000.05')).toThrow(DomainError)
      expect(() => rules.validatePriceTick('30000.05')).toThrow('tickSize')
    })
  })

  describe('validateQuantityStep', () => {
    test('passes when quantity is aligned to stepSize', () => {
      const rules = makeRules({ stepSize: '0.001' })
      expect(() => rules.validateQuantityStep('0.001')).not.toThrow()
    })

    test('throws DomainError when quantity is not aligned to stepSize', () => {
      const rules = makeRules({ stepSize: '0.001' })
      expect(() => rules.validateQuantityStep('1.0001')).toThrow(DomainError)
      expect(() => rules.validateQuantityStep('1.0001')).toThrow('stepSize')
    })
  })
})
