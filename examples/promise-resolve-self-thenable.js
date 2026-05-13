const P = require('../promise.methods.js')

let count = 0

const thenable = {
  then(resolve) {
    count += 1

    if (count <= 5) {
      console.log(`thenable.then #${count}`)
    }

    resolve(thenable)
  }
}

P.resolve(thenable)

setTimeout(() => {
  console.log('这行不会执行，因为微任务队列会被不断占满')
}, 0)
