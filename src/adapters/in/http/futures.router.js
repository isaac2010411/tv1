const { Router } = require('express')
const { GetFuturePairsUseCase } = require('../../../application/futures/GetFuturePairsUseCase')

const createFuturesRouter = (futuresRepository) => {
  const router = Router()
  const getFuturePairs = new GetFuturePairsUseCase(futuresRepository)

  router.get('/pairs', async (req, res) => {
    try {
      const pairs = await getFuturePairs.execute()
      res.json({ count: pairs.length, pairs })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  return router
}

module.exports = { createFuturesRouter }
