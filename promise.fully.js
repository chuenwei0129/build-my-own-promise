const P = require('./promise.es.js')

// catch
P.prototype.catch = function (callback) {
  return this.then(undefined, callback)
}

P.resolve = function (value) {
}


module.exports = P
