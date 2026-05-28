const { createBinanceClient } = require('./src/adapters/out/binance/BinanceClientFactory')
const { BinanceFuturesRepository } = require('./src/adapters/out/binance/BinanceFuturesRepository')
const { createFuturesRouter } = require('./src/adapters/in/http/futures.router')
const { createHealthRouter } = require('./src/adapters/in/http/health.router')
const { createServer } = require('./src/infrastructure/http/server')

const PORT = process.env.PORT || 5000

// Composition root
const binanceClient = createBinanceClient()
const futuresRepository = new BinanceFuturesRepository(binanceClient)

const healthRouter = createHealthRouter()
const futuresRouter = createFuturesRouter(futuresRepository)

const app = createServer({ healthRouter, futuresRouter })

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)
})

module.exports = { app }
