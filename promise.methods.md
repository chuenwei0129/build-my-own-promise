# Promise 全部实例方法和静态方法的模拟实现

前两篇我们已经把 Promise 的核心跑通了：

- `promise.aplus.js` 负责通过 Promises/A+ 测试
- `promise.es.js` 负责把微任务时序拉到更接近原生 Promise

接下来这一篇，我们开始在这个核心之上继续补 Promise 的实例方法和静态方法。

当前代码入口是 [`promise.methods.js`](./promise.methods.js)。

---

## 先补最容易落地的两个入口

这一版我们先补两个最基础的方法：

- 实例方法：`Promise.prototype.catch`
- 静态方法：`Promise.resolve`

原因很简单，它们都可以直接复用前面已经写好的 `then` 和内部 `resolvePromise` 逻辑，不需要重新发明一套状态机。

---

## `Promise.prototype.catch`

`catch` 本质上只是 `then(undefined, onRejected)` 的语法糖。

实现非常直接：

```js
P.prototype.catch = function (callback) {
  return this.then(undefined, callback)
}
```

这段代码为什么成立？

- `then` 的第二个参数本来就是 rejected 分支的处理函数
- fulfilled 的情况我们不关心，所以第一个参数传 `undefined`
- 返回值依然是一个新的 Promise，因此链式调用天然保留

也就是说，`catch` 没有引入新的语义，它只是把一个常见调用方式封装成了更好读的 API。

---

## `Promise.resolve` 不能只会包普通值

很多人第一次写 `Promise.resolve`，都会从这个版本开始：

```js
P.resolve = (value) => new P(resolve => resolve(value))
```

这句看起来已经很像原生实现了，但真正关键的问题是：

> 这里的 `value` 不一定是普通值，它也可能是 thenable，甚至可能是一个会不断 resolve 自己的 thenable。

所以我们这里保留一个很重要的分支：

```js
P.resolve = (value) => {
  if (value instanceof P) return value
  return new P(resolve => resolve(value))
}
```

第一行的含义是：

- 如果传进来的本来就是当前 Promise 实例，直接返回它本身

第二行的含义是：

- 其他值统一交给构造器内部的 `resolve` 去解析
- 普通值会直接 fulfilled
- thenable 会继续走内部的吸收逻辑
- 嵌套 thenable 也会继续展开

换句话说，`Promise.resolve` 自己不要重复写一套 thenable 解析规则，直接复用底层那套已经更稳的逻辑就好。

可运行示例：[`examples/promise-resolve-test.js`](./examples/promise-resolve-test.js)

```js
const x = {
  then(resolve) {
    resolve({ then(r) { r(1) } })
    resolve(2)
  }
}

P.resolve(x).then(v => {
  console.log(v) // 1
})
```

这里最后会打印 `1`，因为 thenable 只认第一次决议，后面的 `resolve(2)` 会被忽略。

---

## `Promise.resolve(thenable)` 的一个容易卡住的边界例子

真正容易让人困惑的是下面这个例子：

```js
const thenable = {
  then(resolve) {
    resolve(thenable)
  }
}

Promise.resolve(thenable)
```

很多人看到这里第一反应是：

> 这会不会被自动识别成循环引用，然后直接 rejected？

答案是：**不会。**

它不是“Promise 自己 resolve 自己”，而是“一个 thenable 不断把自己再次交出来”。这两件事不是同一类循环。

在我们当前的实现里，内部只会拦截这种情况：

```js
if (value === this) {
  return rejectPromise(new TypeError('Chaining cycle detected'))
}
```

这里拦住的是：

- 当前 Promise 实例最终又试图 resolve 成它自己

但 `thenable !== this`，所以这个保护不会生效。结果就是：

- `resolvePromise` 读到它是 thenable
- 调用它的 `then`
- `then` 又把同一个 `thenable` 交回来
- 下一轮继续重复

于是微任务会被持续占满，Promise 会一直 pending，看起来就像“卡住了”。

这个行为不只是我们自己的实现会出现，原生 `Promise.resolve(thenable)` 遇到这种自解析 thenable 也会持续展开。

示例文件：[`examples/promise-resolve-self-thenable.js`](./examples/promise-resolve-self-thenable.js)

```js
const thenable = {
  then(resolve) {
    resolve(thenable)
  }
}

P.resolve(thenable)
```

这个例子运行后不会正常结束，主要用于观察和理解这个边界情况。

---

## 这一篇先搭骨架，后面继续补全

完整的原生 Promise API 还包括很多常见入口，比如：

- `finally`
- `reject`
- `all`
- `race`
- `allSettled`
- `any`

它们并不需要重写 Promise 的底层状态机，更多是在现有 `then`、`resolve`、`reject` 能力之上做组合。前两篇把“核心解析”和“微任务时序”补齐之后，这一层实现就顺很多了。

这也是为什么第三篇教程要放在这里开始写：从现在起，我们终于可以在一个足够稳的 Promise 核心之上，继续往外扩 API 了。
