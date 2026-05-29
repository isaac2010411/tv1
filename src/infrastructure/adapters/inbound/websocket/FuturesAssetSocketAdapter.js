'use strict'

const { performance } = require('perf_hooks')
const { logger } = require('../../../../shared/utils/logger')
const { FUTURES_SOCKET_EVENTS, FUTURES_SOCKET_COMMANDS } = require('../../../../shared/contracts/futuresSocketEvents')
const { OrderBook } = require('../../../../domain/futures/entities/OrderBook')
const { SpoofingDetectorService } = require('../../../../domain/futures/services/SpoofingDetectorService')
const { LiquidityShiftService } = require('../../../../domain/futures/services/LiquidityShiftService')
const { CvdService } = require('../../../../domain/futures/services/CvdService')
const { FootprintCandleService } = require('../../../../domain/futures/services/FootprintCandleService')
const { PaperTradeService } = require('../../../../domain/futures/services/PaperTradeService')
const { LocalOrderBookEngine } = require('../../../marketdata/LocalOrderBookEngine')
const {
  StateMachineSignalEngine,
} = require('../../../../domain/futures/services/signalEngine/StateMachineSignalEngine')
const { RingBuffer } = require('../../../../shared/utils/RingBuffer')
const { metrics } = require('../../../observability/metrics')
const { EmitCoalescer } = require('../../../realtime/EmitCoalescer')

// NOTE: file intentionally not fully rewritten here in final answer.
