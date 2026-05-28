# Plan de mejoras Backend — tv1

## Objetivo

Convertir `tv1` en una capa backend confiable de **market microstructure** para Binance USDⓈ-M Futures.

El backend no debe ser solamente un passthrough de Binance. Debe normalizar, validar, reconstruir y enriquecer datos de mercado antes de entregarlos al frontend.

Problemas observados en la app:

- `midPrice` incorrecto.
- `spread` absurdo.
- `bestBid` y `bestAsk` calculados desde arrays no ordenados.
- `imbalance` inconsistente entre backend y frontend.
- `depth websocket` tratado como snapshot completo.
- Walls detectadas en precios irrelevantes.
- Spoofing detectado sin suficiente contexto temporal.
- CVD y footprint dependientes de trades, pero sin una capa clara de construcción.
- Falta de health/observabilidad del estado del libro local.

---

## 1. Corregir entidad `OrderBook`

### Archivos

```txt
src/domain/futures/entities/OrderBook.js
tests/unit/domain/entities/OrderBook.test.js
```

### Problema

`OrderBook` toma `bids[0]` y `asks[0]` como `bestBid` y `bestAsk`, pero el constructor no garantiza que los niveles estén ordenados ni que tengan cantidad válida.

Esto puede generar:

```txt
bestBid = 1000
bestAsk = 76814
spread = 75814
midPrice = 38907
```

### Mejora requerida

El constructor debe:

1. Normalizar price y qty con Decimal.js.
2. Eliminar niveles inválidos.
3. Eliminar niveles con `qty <= 0`.
4. Ordenar bids de mayor a menor precio.
5. Ordenar asks de menor a mayor precio.
6. Exponer validación de top of book.

### Implementación esperada

```js
constructor({ symbol, bids = [], asks = [] }) {
  this.symbol = symbol

  const toLevel = (level) => {
    const rawPrice = Array.isArray(level) ? level[0] : level.price
    const rawQty = Array.isArray(level) ? level[1] : (level.quantity ?? level.qty)

    return {
      price: new Decimal(rawPrice),
      qty: new Decimal(rawQty),
    }
  }

  const isValid = (level) =>
    level.price.isFinite() &&
    level.qty.isFinite() &&
    level.qty.greaterThan(0)

  this.bids = bids
    .map(toLevel)
    .filter(isValid)
    .sort((a, b) => b.price.cmp(a.price))

  this.asks = asks
    .map(toLevel)
    .filter(isValid)
    .sort((a, b) => a.price.cmp(b.price))
}
```

### Agregar getters

```js
get isValidTopOfBook() {
  return Boolean(
    this.bestBid &&
    this.bestAsk &&
    this.bestAsk.greaterThan(this.bestBid)
  )
}

get spreadPct() {
  if (!this.isValidTopOfBook || !this.midPrice || this.midPrice.isZero()) return null
  return this.spread.div(this.midPrice)
}
```

### Tests requeridos

- Bids desordenados quedan descendentes.
- Asks desordenados quedan ascendentes.
- Qty `0` se elimina.
- Qty negativa se elimina.
- `bestBid` correcto.
- `bestAsk` correcto.
- `spread` correcto.
- `midPrice` correcto.
- `isValidTopOfBook` false si `bestAsk <= bestBid`.

---

## 2. Estandarizar imbalance en rango `[-1, 1]`

### Archivos

```txt
src/domain/futures/entities/OrderBook.js
src/domain/futures/services/OrderBookMetrics.js
tests/unit/domain/entities/OrderBook.test.js
```

### Problema

Actualmente backend maneja imbalance como `[0, 1]`, donde `0.5` es neutral. El frontend trabaja más naturalmente con `[-1, 1]`, donde `0` es neutral.

### Regla estándar

```txt
imbalance = (bidVolume - askVolume) / (bidVolume + askVolume)
```

Interpretación:

```txt
-1 = presión vendedora máxima
 0 = neutral
+1 = presión compradora máxima
```

### Cambio requerido

```js
imbalanceTopN(n) {
  const bidVol = this.bidVolumeTopN(n)
  const askVol = this.askVolumeTopN(n)
  const total = bidVol.plus(askVol)

  if (total.isZero()) return new Decimal(0)

  return bidVol.minus(askVol).div(total)
}
```

### Actualizar `OrderBookMetrics`

```js
return {
  spread: orderBook.spread?.toFixed() ?? null,
  spreadPct: orderBook.spreadPct?.toFixed() ?? null,
  midPrice: orderBook.midPrice?.toFixed() ?? null,
  imbalance: imbalance.toFixed(4),
  bidVolumeTop: bidVol.toFixed(),
  askVolumeTop: askVol.toFixed(),
  bidDominance: imbalance.greaterThan(0),
  askDominance: imbalance.lessThan(0),
  walls,
}
```

### Tests requeridos

- Bid 10 / Ask 10 => `0`.
- Bid 20 / Ask 10 => positivo.
- Bid 10 / Ask 20 => negativo.
- Bid 0 / Ask 0 => `0`, nunca `NaN`.

---

## 3. Separar snapshot, partial depth y diff depth

### Archivos

```txt
src/infrastructure/adapters/outbound/binance/BinanceFuturesMarketDataAdapter.js
src/infrastructure/adapters/outbound/binance/BinanceFuturesRealtimeAdapter.js
src/infrastructure/adapters/inbound/websocket/FuturesAssetSocketAdapter.js
```

### Problema

El stream de depth se está propagando como si fuera un libro completo. Para trading cuantitativo esto es riesgoso porque un delta no representa todo el book.

### Diseño requerido

Separar flujos:

```txt
REST /fapi/v1/depth
  -> snapshot inicial

WebSocket partial depth20
  -> DOM visible / lectura rápida

WebSocket diff depth
  -> reconstrucción de libro local

WebSocket aggTrade
  -> tape reader / CVD / footprint
```

### Eventos internos sugeridos

```txt
BOOK_SNAPSHOT
BOOK_PARTIAL
BOOK_DELTA
BOOK_LOCAL
AGG_TRADE
CVD_UPDATE
FOOTPRINT_UPDATE
LIQUIDITY_SHIFT
SPOOFING_CANDIDATE
```

### Eventos Socket.IO sugeridos

```txt
futures:book:snapshot
futures:book:partial
futures:book:local
futures:trade:agg
futures:orderflow:cvd
futures:orderflow:footprint
futures:liquidity:shift
futures:spoofing:candidate
```

---

## 4. Crear `LocalOrderBookEngine`

### Nuevo archivo sugerido

```txt
src/domain/futures/services/LocalOrderBookEngine.js
```

O, si se prefiere dejar la reconstrucción cerca de infraestructura:

```txt
src/infrastructure/marketdata/LocalOrderBookEngine.js
```

### Responsabilidad

Mantener un libro local correcto por símbolo.

Debe:

1. Recibir snapshot REST.
2. Recibir deltas WebSocket.
3. Aplicar updates por precio.
4. Eliminar nivel cuando `qty = 0`.
5. Mantener `lastUpdateId`.
6. Detectar gaps.
7. Resincronizar si hay inconsistencia.
8. Emitir book normalizado.

### Estado interno

```js
{
  symbol,
  lastUpdateId,
  bids: Map<price, qty>,
  asks: Map<price, qty>,
  synced: boolean,
  lastSyncAt,
  resyncCount,
  gapCount,
}
```

### Salida esperada

```json
{
  "symbol": "BTCUSDT",
  "lastUpdateId": 123456,
  "bestBid": "76810.10",
  "bestAsk": "76810.20",
  "spread": "0.10",
  "midPrice": "76810.15",
  "bids": [],
  "asks": [],
  "metrics": {
    "imbalance": "0.2314",
    "bidVolumeTop": "10.5",
    "askVolumeTop": "6.5"
  }
}
```

---

## 5. Mejorar detección de liquidity walls

### Archivos

```txt
src/domain/futures/entities/OrderBook.js
src/domain/futures/services/OrderBookMetrics.js
```

### Problema

La app puede detectar walls en niveles muy lejanos del precio actual, por ejemplo `1000`, `26310`, `50000` cuando BTCUSDT cotiza cerca de `76800`.

Eso no sirve para lectura táctica.

### Mejora requerida

`detectWalls` debe aceptar configuración:

```js
{
  multiplier: 5,
  maxDistancePct: 0.01,
  depth: 100,
}
```

### Regla recomendada

```txt
wall si:
qty >= medianQty * multiplier
AND abs(price - midPrice) / midPrice <= maxDistancePct
```

### Categorías sugeridas

```txt
TACTICAL_WALL -> cerca del precio, útil para scalping
MACRO_WALL    -> lejos del precio, útil como referencia estructural
```

---

## 6. Mejorar SpoofingDetectorService

### Archivo

```txt
src/domain/futures/services/SpoofingDetectorService.js
```

### Problema

Una orden grande no es spoofing por sí sola. Debe observarse comportamiento temporal.

### Criterios mínimos

Un spoofing candidate debería requerir:

1. Aparece una wall grande.
2. Está cerca del precio actual.
3. Dura menos de X segundos.
4. Se cancela sin ejecución significativa.
5. El precio se mueve luego en sentido contrario.

### Evento sugerido

```json
{
  "symbol": "BTCUSDT",
  "side": "BID",
  "price": "76800.10",
  "qty": "50.2",
  "lifetimeMs": 1200,
  "executedQtyNearLevel": "0.3",
  "cancelledQty": "49.9",
  "confidence": 0.78,
  "reason": "large wall cancelled before touch"
}
```

### Naming importante

No emitirlo como verdad absoluta. Usar:

```txt
SPOOFING_CANDIDATE
```

---

## 7. Mejorar LiquidityShiftService

### Archivo

```txt
src/domain/futures/services/LiquidityShiftService.js
```

### Objetivo

Detectar cambios relevantes de liquidez cerca del precio.

### Métricas por ventana

```txt
liquidityAdded
liquidityRemoved
bidLiquidityDelta
askLiquidityDelta
imbalanceDelta
nearPriceShift
```

### Evento sugerido

```json
{
  "symbol": "BTCUSDT",
  "windowMs": 5000,
  "side": "BID",
  "priceBand": "mid-0.5%",
  "liquidityBefore": "120.5",
  "liquidityAfter": "80.3",
  "delta": "-40.2",
  "type": "LIQUIDITY_REMOVED",
  "severity": "HIGH"
}
```

---

## 8. Crear CVD Service

### Nuevo archivo sugerido

```txt
src/domain/futures/services/CvdService.js
```

### Fuente

`aggTrade`.

### Regla Binance

```txt
isBuyerMaker = true  -> agresor vendedor
isBuyerMaker = false -> agresor comprador
```

### Cálculo

```txt
delta = buyAggressiveVolume - sellAggressiveVolume
cvd = previousCvd + delta
```

### Buckets sugeridos

```txt
1s  -> lectura ultra corta
1m  -> footprint / scalping
5m  -> contexto
15m -> estructura intradía
```

### Evento de salida

```json
{
  "symbol": "BTCUSDT",
  "time": 1710000000000,
  "buyVolume": "3.5",
  "sellVolume": "1.2",
  "delta": "2.3",
  "cvd": "123.7"
}
```

---

## 9. Crear FootprintBuilderService

### Nuevo archivo sugerido

```txt
src/domain/futures/services/FootprintBuilderService.js
```

### Problema

Footprint no debe construirse solo con klines. Debe construirse con trades.

### Agrupación correcta

```txt
symbol
interval
candleStartTime
priceBucket usando tickSize
buyAggressiveVolume
sellAggressiveVolume
delta
totalVolume
tradeCount
```

### Estructura sugerida

```json
{
  "symbol": "BTCUSDT",
  "interval": "1m",
  "openTime": 1710000000000,
  "levels": [
    {
      "price": "76810.10",
      "buyVolume": "1.25",
      "sellVolume": "0.80",
      "delta": "0.45",
      "total": "2.05",
      "tradeCount": 12
    }
  ]
}
```

---

## 10. Agregar persistencia de microhistoria

### Objetivo

No perder contexto al recargar la pantalla.

Heatmap, spoofing, liquidity shifts, CVD y footprint necesitan historia propia.

### Persistencia inicial

```txt
MongoDB o PostgreSQL
```

### Persistencia escalable

```txt
TimescaleDB o ClickHouse
```

### Tablas/colecciones sugeridas

```txt
market_trades
orderbook_snapshots
orderbook_deltas
cvd_buckets
footprint_candles
liquidity_events
spoofing_candidates
```

### Retención sugerida

```txt
trades raw: 24h a 7 días
depth deltas: 1h a 24h
snapshots: cada 1s o 5s
footprint: 30 a 90 días
cvd buckets: 30 a 90 días
```

---

## 11. Definir contratos Socket.IO estables

### Archivos

```txt
src/infrastructure/adapters/inbound/websocket/FuturesAssetSocketAdapter.js
src/infrastructure/adapters/outbound/binance/BinanceFuturesRealtimeAdapter.js
```

### Problema

Eventos genéricos como `futures:asset:orderbook` no indican si el dato es snapshot, delta, partial o libro reconstruido.

### Contrato sugerido

```txt
futures:asset:context
futures:market:ticker
futures:market:markPrice
futures:book:top
futures:book:partial
futures:book:local
futures:trade:agg
futures:orderflow:cvd
futures:orderflow:footprint
futures:liquidity:heatmap
futures:liquidity:wall
futures:liquidity:shift
futures:spoofing:candidate
futures:marketdata:health
```

---

## 12. Agregar health endpoint de market data

### Nuevo endpoint

```txt
GET /api/futures/assets/:symbol/health
```

### Respuesta esperada

```json
{
  "symbol": "BTCUSDT",
  "bookSynced": true,
  "lastUpdateAgeMs": 120,
  "spread": "0.10",
  "midPrice": "76810.15",
  "invalidBookCount": 0,
  "resyncCount": 1,
  "gapCount": 0,
  "wsReconnectCount": 2
}
```

### Métricas internas

```txt
bookSynced
lastDepthUpdateAt
depthGapCount
resyncCount
wsReconnectCount
invalidBookCount
avgLatencyMs
eventsPerSecond
```

---

## 13. Mejorar tests unitarios y de integración

### Tests domain

```txt
OrderBook.test.js
OrderBookMetrics.test.js
CvdService.test.js
FootprintBuilderService.test.js
LiquidityShiftService.test.js
SpoofingDetectorService.test.js
```

### Tests adapter

```txt
BinanceFuturesMarketDataAdapter.test.js
BinanceFuturesRealtimeAdapter.test.js
```

### Casos mínimos

- Order book desordenado.
- Qty cero.
- Spread negativo.
- Imbalance sin NaN.
- Delta de depth elimina nivel.
- Delta de depth actualiza nivel.
- Gap de depth dispara resync.
- CVD interpreta `isBuyerMaker` correctamente.
- Footprint bucketiza por tickSize.
- Spoofing candidate no se dispara solo por wall grande.

---

## 14. Prioridad de implementación

```txt
P0 - Crítico
1. Corregir OrderBook sorting/filtering.
2. Estandarizar imbalance [-1, 1].
3. Blindar spread/mid/top of book.

P1 - Muy importante
4. Separar snapshot/partial/diff depth.
5. Crear LocalOrderBookEngine.
6. Actualizar contratos Socket.IO.

P2 - Order flow
7. Crear CvdService.
8. Crear FootprintBuilderService.
9. Mejorar tape reader event model.

P3 - Microestructura avanzada
10. Mejorar walls.
11. Mejorar spoofing candidates.
12. Mejorar liquidity shifts.

P4 - Escalabilidad
13. Persistir microhistoria.
14. Health endpoint.
15. Métricas y observabilidad.
```

---

## Definition of Done

El backend se considera corregido cuando:

- `bestBid`, `bestAsk`, `spread` y `midPrice` son correctos aunque Binance entregue arrays desordenados.
- No existe `NaN` en ninguna métrica.
- El imbalance usa el mismo rango que frontend: `[-1, 1]`.
- El depth websocket no se trata como snapshot completo.
- Existe separación clara entre snapshot, partial depth, diff depth y local book.
- Walls se filtran por distancia al mid.
- Spoofing se emite como candidato, no como certeza.
- CVD se calcula desde `aggTrade` usando correctamente `isBuyerMaker`.
- Footprint se construye desde trades y `tickSize`.
- Hay tests para los casos críticos.
- Existe health endpoint para validar el estado del market data engine.
