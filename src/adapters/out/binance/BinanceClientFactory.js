const Binance = require('binance-api-node').default
const dotenv = require('dotenv')

dotenv.config()

const createBinanceClient = () => {
  return Binance({
    apiKey: process.env.BINANCE_API_KEY,
    apiSecret: process.env.BINANCE_SECRET_KEY,
    
  })
}

module.exports = { createBinanceClient }
