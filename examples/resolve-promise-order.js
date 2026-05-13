const P = require('../promise.aplus.js') // 0 1 2 4 3 5 6
// const P = require('../../promise.es.js') // 0 1 2 3 4 5 6
// const P = Promise; // 0 1 2 3 4 5 6

new P(r => r())
  .then(() => {
    console.log(0)
    return new P(r => r(4))
  })
  .then(v => {
    console.log(v)
  })

new P(r => r())
  .then(() => {
    console.log(1)
  })
  .then(() => {
    console.log(2)
  })
  .then(() => {
    console.log(3)
  })
  .then(() => {
    console.log(5)
  })
  .then(() => {
    console.log(6)
  })
