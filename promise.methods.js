const P = require('./promise.es.js')

// catch
P.prototype.catch = function (callback) {
  return this.then(undefined, callback)
}

P.resolve = (value) => {
  // 如果传入的本来就是当前 Promise 实例，规范要求直接返回它本身。
  if (value instanceof P) return value

  // 其他值统一交给构造器内部的 resolve 逻辑处理。
  // 这样普通值、thenable、其他 Promise 实现都会复用同一套解析流程。
  return new P(resolve => resolve(value))
}

module.exports = P
