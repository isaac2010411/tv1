'use strict'

const { TradingRulesValidator } = require('../../../../src/domain/futures/services/TradingRulesValidator')
const { TradingRules }          = require('../../../../src/domain/futures/entities/TradingRules')
const { DomainError }           = require('../../../../src/shared/errors/DomainError')

const makeRules = () =>
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
    multiplierUp:    null,
    multiplierDown:  null,
    allowedOrderTypes: ['LIMIT', 'MARKET'],
  })

describe('TradingRulesValidator', () => {
  let validator

  beforeEach(() => {
    validator = new TradingRulesValidator()
  })

  test('returns true for a valid LIMIT order', () => {
    const rules = makeRules()
    const result = validator.validate(rules, {
      type:     'LIMIT',
      quantity: '0.001',
      price:    '30000.0',
    })
    expect(result).toBe(true)
  })

  test('returns true for a valid MARKET order (no price needed)', () => {
    const rules = makeRules()
    expect(validator.validate(rules, { type: 'MARKET', quantity: '0.001' })).toBe(true)
  })

  test('throws when price is missing for LIMIT order', () => {
    const rules = makeRules()
    expect(() =>
      validator.validate(rules, { type: 'LIMIT', quantity: '0.001', price: null }),
    ).toThrow('Price is required')
  })

  test('throws when price is not aligned to tickSize', () => {
    const rules = makeRules()
    expect(() =>
      validator.validate(rules, { type: 'LIMIT', quantity: '0.001', price: '30000.05' }),
    ).toThrow('tickSize')
  })

  test('throws when quantity is not aligned to stepSize', () => {
    const rules = makeRules()
    expect(() =>
      validator.validate(rules, { type: 'LIMIT', quantity: '0.0001', price: '30000.0' }),
    ).toThrow('stepSize')
  })

  test('throws for an unsupported order type', () => {
    const rules = makeRules()
    expect(() =>
      validator.validate(rules, { type: 'UNSUPPORTED', quantity: '0.001' }),
    ).toThrow('not supported')
  })

  test('accumulates multiple violations in a single DomainError', () => {
    const rules = makeRules()
    // Both price and qty are misaligned
    let caughtError
    try {
      validator.validate(rules, { type: 'LIMIT', quantity: '0.0001', price: '30000.05' })
    } catch (err) {
      caughtError = err
    }
    expect(caughtError).toBeInstanceOf(DomainError)
    expect(caughtError.code).toBe('ORDER_VALIDATION_FAILED')
    // Both messages should be joined
    expect(caughtError.message).toMatch(/stepSize/)
    expect(caughtError.message).toMatch(/tickSize/)
  })
})
