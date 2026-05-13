// const P = Promise; // 2 3 1 4
// const P = require('../../promise.aplus.js') // 1 2 3 4
const P = require('../promise.es.js') // 2 3 1 4

new P(resolve => resolve(new P(r => r())))
  .then(() => {
    console.log('promise1')
  })

new P(resolve => resolve())
  .then(() => {
    console.log('promise2')
  })
  .then(() => {
    console.log('promise3')
  })
  .then(() => {
    console.log('promise4')
  })
