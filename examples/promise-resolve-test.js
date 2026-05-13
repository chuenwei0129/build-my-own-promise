const P = require('../promise.methods.js')

const x = {
  then(resolve) {
    resolve({ then(r) { r(1) } })
    resolve(2)
  }
}

P.resolve(x).then(v => {
  console.log(v)
})
