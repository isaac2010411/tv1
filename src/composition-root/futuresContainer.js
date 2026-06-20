'use strict'

const {
  BinanceFuturesTradingRulesAdapter,
} = require('../infrastructure/adapters/outbound/binance/BinanceFuturesTradingRulesAdapter')
const {
  BinanceFuturesMarketDataAdapter,
} = require('../infrastructure/adapters/outbound/binance/BinanceFuturesMarketDataAdapter')
const {
  BinanceFuturesAccountAdapter,
} = require('../infrastructure/adapters/outbound/binance/BinanceFuturesAccountAdapter')
const {
  BinanceFuturesRealtimeAdapter,
} = require('../infrastructure/adapters/outbound/binance/BinanceFuturesRealtimeAdapter')

const { GetFuturesAssetContext } = require('../application/futures/use-cases/GetFuturesAssetContext')
const { AssetContextManager } = require('../application/futures/context/AssetContextManager')
const { ValidateFuturesOrder } = require('../application/futures/use-cases/ValidateFuturesOrder')
const { SubscribeFuturesAsset } = require('../application/futures/use-cases/SubscribeFuturesAsset')
const { UnsubscribeFuturesAsset } = require('../application/futures/use-cases/UnsubscribeFuturesAsset')

const { RiskManager } = require('../application/futures/risk/RiskManager')
const { OrderManager } = require('../application/futures/orders/OrderManager')
const { PortfolioManager } = require('../application/futures/portfolio/PortfolioManager')
const { ExecutionModeRouter } = require('../application/futures/execution/ExecutionModeRouter')
const { LiveAccountSynchronizer } = require('../application/futures/live/LiveAccountSynchronizer')
const { LiveTradingSupervisor } = require('../application/futures/live/LiveTradingSupervisor')
const { PaperTradeService } = require('../domain/futures/services/PaperTradeService')

const { MongoOrderRepository } = require('../infrastructure/persistence/MongoOrderRepository')
const { PaperFuturesOrderClient } = require('../infrastructure/adapters/outbound/paper/PaperFuturesOrderClient')
const {
  BinanceFuturesOrderClient,
} = require('../infrastructure/adapters/outbound/binance/BinanceFuturesOrderClient')
const {
  BinanceUserDataStreamAdapter,
} = require('../infrastructure/adapters/outbound/binance/BinanceUserDataStreamAdapter')

const { FuturesAssetController } = require('../infrastructure/adapters/inbound/http/FuturesAssetController')
const { createFuturesAssetRouter } = require('../infrastructure/adapters/inbound/http/futuresRoutes')
const { FuturesAssetSocketAdapter } = require('../infrastructure/adapters/inbound/websocket/FuturesAssetSocketAdapter')

const { RiskController } = require('../infrastructure/adapters/inbound/http/RiskController')
const { createRiskRouter } = require('../infrastructure/adapters/inbound/http/riskRoutes')
const { OrderController } = require('../infrastructure/adapters/inbound/http/OrderController')
const { createOrderRouter } = require('../infrastructure/adapters/inbound/http/orderRoutes')
const { PortfolioController } = require('../infrastructure/adapters/inbound/http/PortfolioController')
const { createPortfolioRouter } = require('../infrastructure/adapters/inbound/http/portfolioRoutes')

/**
 * Composition root for the futures trading context.
 *
 * Wires all ports ↔ adapters ↔ use cases.  Nothing outside this file should
 * know which concrete adapter backs a given port.
 *
 * @param {{
 *  binanceClient: object,
 *  io: import('socket.io').Server,
 *  tradingPersistence?: object | null,
 * }} deps
 * @returns {{
 *  futuresRouter: import('express').Router,
 *  riskRouter: import('express').Router,
 *  orderRouter: import('express').Router,
 *  portfolioRouter: import('express').Router,
 *  socketAdapter: FuturesAssetSocketAdapter,
 *  realtimePort: object,
 *  riskManager: RiskManager,
 *  orderManager: OrderManager,
 *  portfolioManager: PortfolioManager,
 * }}
 */
const buildFuturesContainer = ({
  binanceClient,
  io,
  tradingPersistence = null,
  scalpConfig = null,
  runtimeConfig = {},
}) => {
  const tradingMode = runtimeConfig.tradingMode ?? 'paper'
  // ── Outbound adapters ─────────────────────────────────────────────────────
  const tradingRulesPort = new BinanceFuturesTradingRulesAdapter(binanceClient)
  const marketDataPort = new BinanceFuturesMarketDataAdapter(binanceClient)
  const accountPort = new BinanceFuturesAccountAdapter(binanceClient)
  const realtimePort = new BinanceFuturesRealtimeAdapter(binanceClient)

  // ── Phase 6: Risk / Orders / Portfolio managers ──────────────────────────
  // Built before the use cases that need them. The realtimeNotifier slot on
  // each is back-filled after the socket adapter exists (cyclic dependency).
  const riskManager = new RiskManager()
  const portfolioManager = new PortfolioManager({
    tradingPersistence,
    marketDataPort,
    realtimeNotifier: null,
    startingEquity: scalpConfig?.account?.equity ?? 10_000,
  })
  const orderRepository = new MongoOrderRepository()
  const exchangeClient =
    tradingMode === 'live'
      ? new BinanceFuturesOrderClient({
          binanceClient,
          dryRun: runtimeConfig.liveDryRun,
        })
      : new PaperFuturesOrderClient({ marketDataPort })
  const orderManager = new OrderManager({
    orderRepository,
    riskGuard: riskManager,
    exchangeClient,
    portfolioManager,
    realtimeNotifier: null,
  })
  const paperTradeService = new PaperTradeService()
  const liveAccountSynchronizer =
    tradingMode === 'live'
      ? new LiveAccountSynchronizer({
          portfolioManager,
          orderRepository,
          realtimeNotifier: null,
          assetContextManager: null,
        })
      : null
  const userDataStreamAdapter =
    tradingMode === 'live' ? new BinanceUserDataStreamAdapter({ binanceClient }) : null
  const liveTradingSupervisor =
    tradingMode === 'live'
      ? new LiveTradingSupervisor({
          accountPort,
          userDataStreamAdapter,
          synchronizer: liveAccountSynchronizer,
          portfolioManager,
          realtimeNotifier: null,
          requireUserStream: runtimeConfig.liveRequireUserStream,
        })
      : null
  const executionModeRouter = new ExecutionModeRouter({
    tradingMode,
    liveTradingEnabled: runtimeConfig.liveTradingEnabled,
    paperTradeService,
    orderManager,
    portfolioManager,
    liveTradingSupervisor,
    tradingRulesPort,
    liveSymbolAllowlist: runtimeConfig.liveSymbolAllowlist ?? [],
    liveMaxOpenPositions: runtimeConfig.liveMaxOpenPositions,
    liveMaxNotionalPerOrder: runtimeConfig.liveMaxNotionalPerOrder,
    liveMaxDailyLoss: runtimeConfig.liveMaxDailyLoss,
  })

  // ── Application use cases ─────────────────────────────────────────────────
  const assetContextManager = new AssetContextManager({
    tradingRulesPort,
    marketDataPort,
    accountPort,
    riskManager,
    portfolioManager,
  })
  if (liveAccountSynchronizer) liveAccountSynchronizer.assetContextManager = assetContextManager
  const getAssetContextUseCase = new GetFuturesAssetContext({ assetContextManager })
  const validateOrderUseCase = new ValidateFuturesOrder({ tradingRulesPort, riskGuard: riskManager })
  const subscribeFuturesAssetUseCase = new SubscribeFuturesAsset({ realtimePort, marketDataPort })
  const unsubscribeFuturesAssetUseCase = new UnsubscribeFuturesAsset({ realtimePort })

  // ── Inbound adapters ──────────────────────────────────────────────────────
  const socketAdapter = new FuturesAssetSocketAdapter({
    io,
    assetContextManager,
    getAssetContextUseCase,
    subscribeFuturesAssetUseCase,
    unsubscribeFuturesAssetUseCase,
    marketDataPort,
    tradingPersistence,
    riskManager,
    portfolioManager,
    tradingMode,
    paperTradeService,
    executionModeRouter,
    scalpConfig,
  })

  // Back-fill the realtime notifier now that the adapter exists.
  portfolioManager.realtimeNotifier = socketAdapter
  orderManager.realtimeNotifier = socketAdapter
  if (liveAccountSynchronizer) liveAccountSynchronizer.realtimeNotifier = socketAdapter
  if (liveTradingSupervisor) liveTradingSupervisor.realtimeNotifier = socketAdapter

  const controller = new FuturesAssetController({
    getAssetContextUseCase,
    validateOrderUseCase,
    marketDataPort,
    socketAdapter,
    tradingPersistence,
  })
  const futuresRouter = createFuturesAssetRouter(controller)

  const riskController = new RiskController({ riskManager, portfolioManager })
  const riskRouter = createRiskRouter(riskController)

  const orderController = new OrderController({ orderManager })
  const orderRouter = createOrderRouter(orderController)

  const portfolioController = new PortfolioController({ portfolioManager })
  const portfolioRouter = createPortfolioRouter(portfolioController)

  return {
    futuresRouter,
    riskRouter,
    orderRouter,
    portfolioRouter,
    socketAdapter,
    realtimePort,
    riskManager,
    orderManager,
    portfolioManager,
    executionModeRouter,
    liveTradingSupervisor,
  }
}

module.exports = { buildFuturesContainer }
