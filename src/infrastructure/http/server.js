const express = require('express')
const cors = require('cors')

const createServer = ({ healthRouter, futuresRouter }) => {
  const app = express()

  app.use(cors())
  app.use(express.json())

  app.use('/', healthRouter)
  app.use('/futures', futuresRouter)

  return app
}

module.exports = { createServer }
