const path = require('path')

const loadIndicatorsConfig = () => {
  return require(path.resolve(__dirname, 'indicators.config.json'))
}

module.exports = { loadIndicatorsConfig }
