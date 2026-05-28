'use strict'

const mongoose = require('mongoose')
const { logger } = require('../../shared/utils/logger')

let _connected = false

async function connectMongo({ uri, dbName } = {}) {
  if (_connected) return true
  if (!uri) {
    logger.warn('[Mongo] MONGO_URI not configured. Persistence is disabled.')
    return false
  }

  try {
    await mongoose.connect(uri, {
      dbName,
      maxPoolSize: 20,
      serverSelectionTimeoutMS: 5_000,
      heartbeatFrequencyMS: 10_000,
    })
    _connected = true
    logger.info(`[Mongo] Connected${dbName ? ` db=${dbName}` : ''}`)
    return true
  } catch (err) {
    logger.error(`[Mongo] Connection failed: ${err.message}`)
    throw err
  }
}

async function disconnectMongo() {
  if (!_connected) return
  await mongoose.disconnect()
  _connected = false
  logger.info('[Mongo] Disconnected')
}

function isMongoConnected() {
  return _connected && mongoose.connection.readyState === 1
}

module.exports = {
  connectMongo,
  disconnectMongo,
  isMongoConnected,
}
