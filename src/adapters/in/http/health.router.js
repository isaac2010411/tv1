const { Router } = require('express')

const createHealthRouter = () => {
  const router = Router()

  router.get('/', (req, res) => {
    res.json({ status: 'ok' })
  })

  return router
}

module.exports = { createHealthRouter }
