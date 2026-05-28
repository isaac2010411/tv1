# Plan TV1 — Risk, Order & Portfolio Managers

Implementación incremental de tres gestores sobre la arquitectura hexagonal existente. Los puertos inbound (`RiskGuardPort`, `OrderManagerPort`, `PortfolioManagerPort`) y los eventos socket (`RISK_DECISION`, `ORDER_LIFECYCLE`, `PORTFOLIO_SNAPSHOT`) ya están definidos como stubs/contratos. Falta su implementación, persistencia, rutas HTTP y wiring en el composition root.

## Fases

### Fase 0 — Preparación
- Rama: `feature/tv1-managers`.
- Añadir errores `RiskViolationError` y `OrderRejectedError` en `src/shared/errors/` (extienden `ApplicationError`).
- Verificar puertos existentes: `src/domain/futures/ports/inbound/{RiskGuardPort,OrderManagerPort,PortfolioManagerPort}.js`.

### Fase 1 — RiskManager (3-4 d) — *paralelizable con Fase 2 tras 1.1*
1. `src/application/futures/risk/RiskManager.js` extiende `RiskGuardPort.evaluate(order, portfolio)`. Reglas iniciales (env): `maxOrderQty`, `maxNotionalPerSymbol`, `maxOpenPositions`, `maxDailyLoss`.
2. `src/application/futures/risk/RiskRulesConfig.js` lee vars de `runtimeConfig.js` (añadir `RISK_*`).
3. `src/infrastructure/adapters/inbound/http/RiskController.js` + `riskRoutes.js`: `GET /api/futures/risk/limits`, `POST /api/futures/risk/check`.
4. Wiring en `composition-root/futuresContainer.js`: reemplaza `NoopRiskGuard` por la instancia real e inyecta en `ValidateFuturesOrder` y `OrderManager`.
5. Tests: `tests/unit/application/risk/RiskManager.test.js`.

### Fase 2 — OrderManager / OMS (5-6 d) — *depende de Fase 1.1*
1. Puerto outbound `src/domain/futures/ports/outbound/OrderRepositoryPort.js` (`save`, `findById`, `findOpen`, `updateStatus`).
2. Modelo Mongoose `src/infrastructure/persistence/mongoose/models/OrderModel.js`: `orderId`, `userId?`, `symbol`, `side`, `type`, `quantity`, `price?`, `status` (NEW/PARTIAL/FILLED/CANCELED/REJECTED), `createdAt`, `executedAt?`, `fills[]`, `riskDecision`.
3. `src/infrastructure/persistence/MongoOrderRepository.js` implementa el puerto.
4. Adaptador outbound de ejecución:
   - `src/infrastructure/adapters/outbound/paper/PaperFuturesOrderClient.js` (fill simulado al precio de mercado en `TRADING_MODE=paper`).
   - `BinanceFuturesOrderClient.js` queda como TODO (modo live).
5. `src/application/futures/orders/OrderManager.js` extiende `OrderManagerPort`: `submit` → risk → persist NEW → exchange → status FILLED/REJECTED → emit `ORDER_LIFECYCLE` → notifica `PortfolioManager.applyFill`.
6. `src/infrastructure/adapters/inbound/http/OrderController.js` + `orderRoutes.js`: `POST /api/futures/orders`, `GET /api/futures/orders/:id`, `PUT /api/futures/orders/:id/cancel`, `GET /api/futures/orders/open`.
7. Extender `FuturesAssetSocketAdapter` con `emitRiskDecision`, `emitOrderLifecycle`, `emitPortfolioSnapshot`.
8. Wiring + registro en `src/app.js`.
9. Tests: `tests/unit/application/orders/OrderManager.test.js` (happy, riesgo BLOCK, cancel, fallo exchange).

### Fase 3 — PortfolioManager (3-4 d)
1. `src/application/futures/portfolio/PortfolioManager.js` extiende `PortfolioManagerPort`: `applyFill`, `getSnapshot`, `getPosition`, `listPositions`. Reutiliza `MongoTradingPersistenceService.savePaperPosition` / `listPaperPositions`.
2. Snapshot calcula `realizedPnl`, `unrealizedPnl`, `exposure`, `totalNotional` por símbolo y agregado.
3. `src/infrastructure/adapters/inbound/http/PortfolioController.js` + `portfolioRoutes.js`: `GET /api/futures/portfolio/positions`, `GET /api/futures/portfolio/positions/:id`, `GET /api/futures/portfolio/exposure`, `GET /api/futures/portfolio/performance`.
4. Emisión socket `PORTFOLIO_SNAPSHOT` al `applyFill` (y opcionalmente cada N s vía coalescer).
5. Tests: `tests/unit/application/portfolio/PortfolioManager.test.js` (LONG/SHORT PnL, cierre, snapshot).

### Fase 4 — Integración & Calidad (2-3 d)
- Tests de integración con `mongodb-memory-server`: flujo `POST /orders` → posición creada → `GET /portfolio/positions`.
- Métricas: `orders_total`, `orders_rejected_total{reason}`, `risk_violations_total{rule}`, gauges `portfolio_exposure`, `portfolio_pnl`.
- Sanitización inputs en cada controller.
- Cobertura ≥80% en módulos nuevos.

## Archivos

**Crear**
- `src/application/futures/risk/RiskManager.js`, `RiskRulesConfig.js`
- `src/application/futures/orders/OrderManager.js`
- `src/application/futures/portfolio/PortfolioManager.js`
- `src/domain/futures/ports/outbound/OrderRepositoryPort.js`
- `src/infrastructure/persistence/mongoose/models/OrderModel.js`
- `src/infrastructure/persistence/MongoOrderRepository.js`
- `src/infrastructure/adapters/outbound/paper/PaperFuturesOrderClient.js`
- `src/infrastructure/adapters/inbound/http/RiskController.js`, `riskRoutes.js`
- `src/infrastructure/adapters/inbound/http/OrderController.js`, `orderRoutes.js`
- `src/infrastructure/adapters/inbound/http/PortfolioController.js`, `portfolioRoutes.js`
- `src/shared/errors/RiskViolationError.js`, `OrderRejectedError.js`
- Tests: `tests/unit/application/{risk,orders,portfolio}/*.test.js`

**Modificar**
- `src/composition-root/futuresContainer.js` — instanciar y exponer los 3 managers + nuevos routers.
- `src/app.js` — `app.use('/api/futures/risk', riskRouter)` etc.
- `src/config/runtimeConfig.js` — nuevas vars `RISK_*`.
- `src/infrastructure/adapters/inbound/websocket/FuturesAssetSocketAdapter.js` — `emitRiskDecision`, `emitOrderLifecycle`, `emitPortfolioSnapshot`.

**Reutilizar**
- `src/shared/contracts/futuresSocketEvents.js`
- `src/infrastructure/persistence/mongoose/models/PaperPositionModel.js`
- `src/infrastructure/persistence/MongoTradingPersistenceService.js`

## Verificación
- `npm test` verde; cobertura ≥80% en carpetas nuevas.
- Smoke local con `TRADING_MODE=paper`:
  - `POST /api/futures/orders { symbol, side, quantity, type }` → 200 con `orderId` y `status`.
  - Mismo con qty fuera de límite → 400 `RISK_BLOCKED`.
  - `GET /api/futures/portfolio/positions` lista la posición creada.
  - `PUT /api/futures/orders/:id/cancel` → `CANCELED`.
- Cliente `socket.io-client` recibe `ORDER_LIFECYCLE`, `PORTFOLIO_SNAPSHOT`, `RISK_DECISION`.

## Decisiones
- Stack inalterado: Node.js + Express + MongoDB + Socket.IO. Monolito modular.
- `paper` por defecto; `live` queda detrás de `TRADING_MODE=live` + `ENABLE_LIVE_TRADING=true`.
- Order ↔ Position: 1 Order → N Fills, agregados en 1 Position por `(symbol, direction)` OPEN.
- `RiskEventModel`: fuera de alcance MVP (basta con logs estructurados).
- Sin multi-usuario en MVP; `userId` modelado pero por defecto `null`.

**Fuera de alcance**: OCO/bracket, multi-cuenta, rebalanceo automático, stops dinámicos avanzados.
