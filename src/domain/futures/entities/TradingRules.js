'use strict'

const { Decimal } = require('../../../shared/utils/decimal')
const { DomainError } = require('../../../shared/errors/DomainError')

/**
 * Entity: precision and quantity constraints extracted from Binance exchangeInfo
 * filters.  All critical trading validations live here – not in controllers.
 *
 * Filters consumed:
 *   PRICE_FILTER   → tickSize
 *   LOT_SIZE       → stepSize, minQty, maxQty
 *   MARKET_LOT_SIZE→ marketStepSize, marketMinQty, marketMaxQty
 *   MIN_NOTIONAL   → minNotional
 *   PERCENT_PRICE  → multiplierUp, multiplierDown
 */
class TradingRules {
  constructor({
    symbol,
    tickSize,
    stepSize,
    minQty,
    maxQty,
    minNotional,
    marketStepSize,
    marketMinQty,
    marketMaxQty,
    multiplierUp,
    multiplierDown,
    allowedOrderTypes,
  }) {
    this.symbol          = symbol
    this.tickSize        = new Decimal(tickSize)
    this.stepSize        = new Decimal(stepSize)
    this.minQty          = new Decimal(minQty)
    this.maxQty          = new Decimal(maxQty)
    this.minNotional     = new Decimal(minNotional)
    this.marketStepSize  = new Decimal(marketStepSize)
    this.marketMinQty    = new Decimal(marketMinQty)
    this.marketMaxQty    = new Decimal(marketMaxQty)
    this.multiplierUp    = multiplierUp   ? new Decimal(multiplierUp)   : null
    this.multiplierDown  = multiplierDown ? new Decimal(multiplierDown) : null
    this.allowedOrderTypes = allowedOrderTypes || []
  }

  // ─── Normalisation ──────────────────────────────────────────────────────────

  /**
   * Floors a raw price to the nearest tickSize increment.
   * @param {string|number|Decimal} price
   * @returns {Decimal}
   */
  normalizePrice(price) {
    const p = new Decimal(price)
    return p.div(this.tickSize).floor().mul(this.tickSize)
  }

  /**
   * Floors a raw quantity to the nearest stepSize increment.
   * @param {string|number|Decimal} quantity
   * @returns {Decimal}
   */
  normalizeQuantity(quantity) {
    const q = new Decimal(quantity)
    return q.div(this.stepSize).floor().mul(this.stepSize)
  }

  // ─── Validation ─────────────────────────────────────────────────────────────

  /**
   * Throws DomainError when price × quantity is below minNotional.
   * @param {string|number|Decimal} price
   * @param {string|number|Decimal} quantity
   */
  validateMinNotional(price, quantity) {
    const notional = new Decimal(price).mul(new Decimal(quantity))

    if (notional.lessThan(this.minNotional)) {
      throw new DomainError(
        `Notional ${notional.toFixed()} is below minimum ${this.minNotional.toFixed()} for ${this.symbol}`,
        'MIN_NOTIONAL_VIOLATION',
      )
    }
  }

  /**
   * Throws DomainError when price is not aligned to tickSize.
   * @param {string|number|Decimal} price
   */
  validatePriceTick(price) {
    const p = new Decimal(price)
    const remainder = p.mod(this.tickSize)

    if (!remainder.isZero()) {
      throw new DomainError(
        `Price ${p.toFixed()} does not respect tickSize ${this.tickSize.toFixed()} for ${this.symbol}`,
        'TICK_SIZE_VIOLATION',
      )
    }
  }

  /**
   * Throws DomainError when quantity is not aligned to stepSize.
   * @param {string|number|Decimal} quantity
   */
  validateQuantityStep(quantity) {
    const q = new Decimal(quantity)
    const remainder = q.mod(this.stepSize)

    if (!remainder.isZero()) {
      throw new DomainError(
        `Quantity ${q.toFixed()} does not respect stepSize ${this.stepSize.toFixed()} for ${this.symbol}`,
        'STEP_SIZE_VIOLATION',
      )
    }
  }

  toJSON() {
    return {
      symbol:           this.symbol,
      tickSize:         this.tickSize.toFixed(),
      stepSize:         this.stepSize.toFixed(),
      minQty:           this.minQty.toFixed(),
      maxQty:           this.maxQty.toFixed(),
      minNotional:      this.minNotional.toFixed(),
      marketStepSize:   this.marketStepSize.toFixed(),
      marketMinQty:     this.marketMinQty.toFixed(),
      marketMaxQty:     this.marketMaxQty.toFixed(),
      multiplierUp:     this.multiplierUp?.toFixed()   ?? null,
      multiplierDown:   this.multiplierDown?.toFixed() ?? null,
      allowedOrderTypes: this.allowedOrderTypes,
    }
  }
}

module.exports = { TradingRules }
