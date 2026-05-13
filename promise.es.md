# 从 Promises/A+ 到更接近原生 Promise：差的不是语法，而是两次微任务

我们已经手写了一个通过 Promises/A+ 测试的 `AplusPromise`。按理说，它在基础能力上已经“很像”原生 Promise 了。但真拿面试题去跑，结果还是会露馅。

---

## 先看第一道题

下面这段代码，分别用原生 `Promise` 和我们自己实现的 `AplusPromise` 执行：

```js
const P = Promise; // 或 AplusPromise

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
```

可运行示例：[`examples/resolve-promise-order.js`](./examples/resolve-promise-order.js)

**原生 Promise 的输出顺序是：**

```txt
promise2
promise3
promise1
promise4
```

**`AplusPromise` 的输出顺序却是：**

```txt
promise1
promise2
promise3
promise4
```

这说明一件事： **“通过 A+ 测试”和“在微任务调度行为上对齐原生 Promise”不是一回事。**

---

## 先给结论

如果只想抓住这篇文章的主线，可以先记住下面三点：

1. Promises/A+ 主要约束 `then` 返回值的解析过程。
2. ECMAScript 里的原生 Promise 还额外约束了 Job Queue，也就是微任务的调度时机。
3. 要在微任务调度行为上对齐原生 Promise，至少要补齐两处微任务：
   - 构造函数里的 `resolve(promise)`
   - `then` 回调返回 Promise 时的状态吸收

严格来说，原生 Promise 对 `resolve(thenable)` 也有一套规则；但它和本文这两道题想说明的核心矛盾不在同一个层面。所以下面先不展开，放到最后作为“补齐规范语义”的最后一步再说。

---

## `resolve(promise)` 不能把 Promise 当普通值

我们的 AplusPromise 实现里，构造函数内部的 `resolve` 长这样：

```js
const resolve = (value) => {
  if (this.state === 'pending') {
    this.state = 'fulfilled';
    this.value = value;
    this.onFulfilledCallbacks.forEach(cb => cb());
  }
};
```

这个写法对于普通值没有问题，但它默认做了一件事：

> 不管 value 是什么，都直接把它塞进 fulfilled.value

而原生 Promise 的 `resolve(promise)` 不是这个语义。

如果你写：

```js
new AplusPromise(resolve => {
  resolve(new AplusPromise(r => r(123)));
}).then(v => console.log(v));
```

一个只满足 A+ 的实现，完全可能打印出一个 `AplusPromise` 实例，而不是 `123`。

原因很简单：构造函数里的 `resolve` 不应该把 Promise 当普通值保存起来，而应该让当前 Promise **跟随它的最终状态**。

也就是说，`resolve(promise)` 的真实语义更接近：

> 当前 promise 接管另一个 promise 的最终结果

而不是：

> 当前 promise fulfilled，value 恰好是一个 promise

---

## 第一步：先补“状态接管”

先把“单纯敲定 fulfilled”这件事拆出来：

```js
const fulfillPromise = (value) => {
  if (this.state !== 'pending') return;
  this.state = 'fulfilled';
  this.value = value;
  this.onFulfilledCallbacks.forEach(cb => cb());
  this.onFulfilledCallbacks.length = 0;
  this.onRejectedCallbacks.length = 0;
};
```

然后把 `resolve` 改成“普通值直接 fulfilled，Promise 则继续跟随它”：

```js
const resolve = (value) => {
  if (value === this) {
    return reject(new TypeError('Chaining cycle detected'));
  }

  if (value instanceof AplusPromise) {
    return value.then(resolve, reject);
  }

  fulfillPromise(value);
};
```

到这里，我们修复的是“状态接管”本身。第一道题的输出会从：

```txt
promise1
promise2
promise3
promise4
```

变成：

```txt
promise2
promise1
promise3
promise4
```

这已经比 A+ 版本更接近原生 Promise 的表现了，但仍然**不是**原生 Promise 的 `2 3 1 4`。

---

## 为什么还差一次微任务

问题在于：原生 Promise 在执行 `resolve(promise)` 时，并不会立刻同步执行：

```js
value.then(resolve, reject)
```

规范会先创建一个 `PromiseResolveThenableJob`，把“继续接管这个 Promise 的状态”这件事延后到后续的微任务里。

如果直接同步执行 `value.then(resolve, reject)`，那么：

- Promise 状态接管会和普通 `then` 链挤在同一轮微任务里
- 它们的相对顺序就会和原生 Promise 对不上

所以构造函数里的 `resolve` **还要再补一层微任务**：

```js
const resolve = (value) => {
  if (value === this) {
    return reject(new TypeError('Chaining cycle detected'));
  }

  if (value instanceof AplusPromise) {
    queueMicrotask(() => {
      value.then(resolve, reject);
    });
    return;
  }

  fulfillPromise(value);
};
```

不过，把 `value.then(...)` 挪到微任务里之后，`resolve(promise)` 就不再是“调用完立刻落状态”了。

这会带出一个连带问题：为什么实现里还要多一把 `isResolved` 锁？

原因是，A+ 版本的 `resolve(value)` 一调用就会立刻把状态改成 fulfilled，所以只靠 `state !== 'pending'` 就已经能挡住后续的重复决议。

但在这里，`resolve(promise)` 不会立刻敲定当前 Promise，而是会先进入“后续微任务再继续接管”的流程。也就是说，在这一小段空窗期里：

- 当前 Promise 的 `state` 还停留在 `pending`
- 但语义上，“第一次决议”其实已经发生了

如果没有 `isResolved`，下面这种代码就会出错：

```js
new EsPromise((resolve, reject) => {
  resolve(otherPromise);
  reject('boom');
});
```

`resolve(otherPromise)` 已经决定“我要跟随它”，只是结果还没在当前这轮同步代码里落到 `state` 上；这时后面的 `reject('boom')` 就会趁着 `state` 还是 `pending`，把状态错误地改掉。

所以 `isResolved` 锁住的不是“状态已经 fulfilled / rejected 了”，而是：

> 第一次决议机会已经用掉了，哪怕最终状态还没真正落地。

代码上，最直接的补法就是把“接管状态”和“用掉第一次决议机会”拆开：

```js
let isResolved = false;

const resolvePromise = (value) => {
  if (value === this) {
    return rejectPromise(new TypeError('Chaining cycle detected'));
  }

  if (value instanceof AplusPromise) {
    queueMicrotask(() => {
      value.then(resolvePromise, rejectPromise);
    });
    return;
  }

  fulfillPromise(value);
};

const resolve = (value) => {
  if (isResolved) return;
  isResolved = true;
  resolvePromise(value);
};

const reject = (reason) => {
  if (isResolved) return;
  isResolved = true;
  rejectPromise(reason);
};
```

这里要注意两点：

- `resolvePromise` 负责“怎么接管 / 怎么落状态”
- `isResolved` 负责“第一次决议机会是不是已经被用掉了”

补上这一层之后，第一道题的微任务调度行为终于会对齐原生 Promise：

```txt
promise2
promise3
promise1
promise4
```

这里可以把它理解成一句话：

> 第一处不是“会不会接管状态”的问题，而是“接管状态这件事要不要再晚一轮微任务”的问题。

---

## 到这里，我们只有一个阶段版

修完上面这一点之后，我们只是得到一个**阶段性版本**的 `EsPromise`。

它已经修好了“构造函数里的 `resolve(promise)`”，但在微任务调度行为上还没有完全覆盖原生 Promise。下一道题会继续暴露问题。

---

## 再看第二道题

下面这段代码，分别用原生 `Promise` 和阶段版 `EsPromise` 执行：

```js
const P = Promise; // 或阶段版 EsPromise

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
```

可运行示例：[`examples/then-return-promise-order.js`](./examples/then-return-promise-order.js)

**阶段版 `EsPromise` 的输出是：**

```txt
0
1
2
4
3
5
6
```

**原生 Promise 的输出却是：**

```txt
0
1
2
3
4
5
6
```

---

## `then` 返回 Promise 时，吸收过程也必须异步

`then` 回调返回值的处理过程逻辑通常长这样：

```js
const returnValue = onFulfilled(this.value);
handleThenResult(promise2, returnValue, resolve, reject);
```

继续看 `handleThenResult`：

```js
then.call(
  value,
  resolvedValue => {
    handleThenResult(promise2, resolvedValue, resolve, reject);
  },
  reject
)
```

`then.call(...)` 是**同步执行**的。

也就是说，当回调里返回：

```js
return new P(r => r(4))
```

阶段版 `EsPromise` 会立刻做三件事：

1. 立刻把这个返回值当作 Promise 开始吸收
2. 立刻对它注册 `then`
3. 因为它本身已经 fulfilled，所以“打印 4”对应的微任务会立刻入队

于是 `4` 就被排到了 `3` 前面。

---

## 原生 Promise 的做法

在 ES 规范里，当 `then` 回调返回 Promise 时，不会立刻同步执行 `x.then(...)`。

它同样会先入队一个 `PromiseResolveThenableJob`，等当前这一轮微任务结束后，再去继续吸收这个返回值。

整个过程可以粗略理解成：

> then callback 执行
> ↓
> 得到 returnValue
> ↓
> EnqueueJob(PromiseResolveThenableJob)
> ↓
> 当前微任务结束
> ↓
> 下一轮微任务再执行 returnValue.then(...)

所以这里真正该改的不是 `then` 主体，而是 `handleThenResult` 里这一句：

```js
then.call(value, ...)
```

它不能同步执行，而应该改成：

```js
queueMicrotask(() => {
  then.call(value, ...)
})
```

补上这一层之后，第二道题的微任务调度顺序就会和原生 Promise 对齐：

```txt
0
1
2
3
4
5
6
```

---

## 最后再补一步：`resolve(thenable)`

到这里，两道题的输出顺序已经对齐原生 Promise 了。

不过如果目标不是“跑通这两道题”，而是“让构造函数里的 `resolve(x)` 更像原生 Promise”，还差最后一步：**不能只认 Promise 实例，还要认 thenable。**

也就是说，下面这种值：

```js
const x = {
  then(resolve) {
    resolve(1);
  }
};
```

在原生 Promise 里：

```js
Promise.resolve(x).then(v => console.log(v)); // 1
```

它不会把 `x` 当普通对象直接 fulfilled，而是会把它当作 thenable 继续吸收。

所以构造函数里的 `resolvePromise` 不能只写：

```js
if (value instanceof EsPromise) {
  queueMicrotask(() => {
    value.then(resolvePromise, rejectPromise);
  });
  return;
}
```

还要升级成“只要是对象或函数，就尝试取 `then`”：

```js
if ((typeof value === 'object' && value !== null) || typeof value === 'function') {
  let then;
  try {
    then = value.then;
  } catch (e) {
    return rejectPromise(e);
  }

  if (typeof then === 'function') {
    queueMicrotask(() => {
      let isCalled = false;
      try {
        then.call(
          value,
          resolvedValue => {
            if (isCalled) return;
            isCalled = true;
            resolvePromise(resolvedValue);
          },
          reason => {
            if (isCalled) return;
            isCalled = true;
            rejectPromise(reason);
          }
        );
      } catch (e) {
        if (isCalled) return;
        isCalled = true;
        rejectPromise(e);
      }
    });
    return;
  }
}
```

这里会顺手补上一个容易漏掉的语义：**first-call-wins**。

也就是说，thenable 一旦先调用了 `resolve` 或 `reject`，后面的同步抛错、第二次调用，都必须失效。比如：

```js
const x = {
  then(resolve) {
    resolve(1);
    throw new Error('boom');
  }
};
```

原生 Promise 的结果是 fulfilled，值为 `1`，而不是 rejected。上面这段 `isCalled` 保护，补的就是这个边角行为。

这一步不会再改变前面两道题的输出顺序，但会让 `resolve(x)` 的吸收范围和边角语义更接近原生 Promise。

---

## 真正难的，其实不是解析规则，而是调度时机

很多人第一次手写 Promise 时，会把注意力都放在 Promise Resolution Procedure 上。

这当然没错，因为 A+ 测试主要就在验证这部分。但如果目标是“尽量在微任务调度行为上对齐原生 Promise”，真正棘手的往往不是“会不会递归解析返回值”，而是：

**这次吸收应该现在做，还是下一轮微任务再做？**

只要入队时机差了一轮微任务，最终输出顺序就可能完全不同。

这也是为什么：

- 写一个通过 A+ 的 Promise，没有想象中那么难
- 写一个在微任务调度行为上尽量贴近原生 Promise 的实现，会明显更难

根本原因就在于：**A+ 不约束 Job Queue，而 ECMAScript 会约束。**

---

## 最终实现

下面这版代码保留了 A+ 里 `then` 返回值的解析逻辑，同时也把构造函数里的 `resolve(thenable)` 一并补齐了。

```js
const handleThenResult = (promise2, value, resolve, reject) => {
  if (promise2 === value) {
    return reject(new TypeError('Chaining cycle detected'));
  }

  if ((typeof value === 'object' && value !== null) || typeof value === 'function') {
    let then;
    try {
      then = value.then;
    } catch (e) {
      return reject(e);
    }

    if (typeof then === 'function') {
      let isCalled = false;
      queueMicrotask(() => {
        try {
          then.call(
            value,
            resolvedValue => {
              if (isCalled) return;
              isCalled = true;
              handleThenResult(promise2, resolvedValue, resolve, reject);
            },
            reason => {
              if (isCalled) return;
              isCalled = true;
              reject(reason);
            }
          );
        } catch (error) {
          if (isCalled) return;
          isCalled = true;
          reject(error);
        }
      });
      return;
    } else {
      return resolve(value);
    }
  } else {
    return resolve(value);
  }
};

class EsPromise {
  constructor(executor) {
    this.state = 'pending';
    this.value = undefined;
    this.reason = undefined;
    this.onFulfilledCallbacks = [];
    this.onRejectedCallbacks = [];
    // 锁住 executor 的首次决议，防止异步接管空窗期被二次决议钻进去
    let isResolved = false;

    // 辅助函数：直接敲定 fulfilled 状态
    const fulfillPromise = (value) => {
      if (this.state !== 'pending') return;
      this.state = 'fulfilled';
      this.value = value;
      this.onFulfilledCallbacks.forEach(cb => cb());
      this.onFulfilledCallbacks.length = 0;
      this.onRejectedCallbacks.length = 0;
    };

    const rejectPromise = (reason) => {
      if (this.state !== 'pending') return;
      this.state = 'rejected';
      this.reason = reason;
      this.onRejectedCallbacks.forEach(cb => cb());
      this.onFulfilledCallbacks.length = 0;
      this.onRejectedCallbacks.length = 0;
    };

    const resolvePromise = (value) => {
      // 防止自己 resolve 自己
      if (value === this) {
        return rejectPromise(new TypeError('Chaining cycle detected'));
      }

      if ((typeof value === 'object' && value !== null) || typeof value === 'function') {
        let then;
        try {
          then = value.then;
        } catch (e) {
          return rejectPromise(e);
        }

        if (typeof then === 'function') {
          queueMicrotask(() => {
            let isCalled = false;
            try {
              then.call(
                value,
                resolvedValue => {
                  if (isCalled) return;
                  isCalled = true;
                  resolvePromise(resolvedValue);
                },
                reason => {
                  if (isCalled) return;
                  isCalled = true;
                  rejectPromise(reason);
                }
              );
            } catch (e) {
              if (isCalled) return;
              isCalled = true;
              rejectPromise(e);
            }
          });
          return;
        }
      }

      fulfillPromise(value);
    };

    const resolve = (value) => {
      if (isResolved) return;
      isResolved = true;
      resolvePromise(value);
    };

    const reject = (reason) => {
      if (isResolved) return;
      isResolved = true;
      rejectPromise(reason);
    };

    try {
      executor(resolve, reject);
    } catch (error) {
      reject(error);
    }
  }

  then(onFulfilled, onRejected) {
    if (typeof onFulfilled !== 'function') {
      onFulfilled = value => value;
    }
    if (typeof onRejected !== 'function') {
      onRejected = reason => { throw reason; };
    }

    const promise2 = new EsPromise((resolve, reject) => {
      const scheduleFulfilled = () => {
        queueMicrotask(() => {
          try {
            const returnValue = onFulfilled(this.value);
            handleThenResult(promise2, returnValue, resolve, reject);
          } catch (error) {
            reject(error);
          }
        });
      };

      const scheduleRejected = () => {
        queueMicrotask(() => {
          try {
            const returnValue = onRejected(this.reason);
            handleThenResult(promise2, returnValue, resolve, reject);
          } catch (error) {
            reject(error);
          }
        });
      };

      if (this.state === 'fulfilled') {
        scheduleFulfilled();
      } else if (this.state === 'rejected') {
        scheduleRejected();
      } else if (this.state === 'pending') {
        this.onFulfilledCallbacks.push(scheduleFulfilled);
        this.onRejectedCallbacks.push(scheduleRejected);
      }
    });

    return promise2;
  }
}

EsPromise.defer = EsPromise.deferred = function () {
  const dfd = {};
  dfd.promise = new EsPromise((resolve, reject) => {
    dfd.resolve = resolve;
    dfd.reject = reject;
  });
  return dfd;
};

module.exports = EsPromise;
```

---

## 总结

从 Promises/A+ 走到在微任务调度行为上更接近原生 Promise，至少还要补齐四件事：

1. **`resolve(promise)` 不能把 Promise 当普通值**，而要接管它的状态。
2. **这次状态接管不能同步发生**，而要再晚一轮微任务。
3. **`then` 回调返回 Promise 或 thenable 时**，它的吸收过程也要再晚一轮微任务。
4. **构造函数里的 `resolve(x)` 还要覆盖 thenable**，并保证 first-call-wins。

所以这篇文章真正想讲的不是“Promise 很难写”，而是：

> 手写 Promise 最容易漏掉的，不是 `then` 的递归解析，而是那些看起来只差“一点点”的微任务调度时机。
