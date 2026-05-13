# 从零手写 Promise：通过 Promises/A+ 官方 872 个测试用例

```javascript
// 回调：结果被困在函数里，外面拿不到
fetchData(url, (result) => {
  // 只能在这里用 result
});

// Promise：结果变成了一个值，你可以传递、返回、组合
const p = fetchData(url);     // 拿到"将来会有结果"的承诺
const p2 = p.then(transform); // 对结果做变换，返回新的承诺
return p2;                    // 还可以继续传给别人
```

回调是“把逻辑塞进函数”，Promise 是“把结果变成值”。

更进一步说，Promise 解决的并不只是“异步回调不好看”，而是经典的 **控制反转（Inversion of Control）** 问题。

在回调模式中：

```javascript
ajax(url, callback);
```

控制权完全在 `ajax` 手里。它可以：
- 调用多次 `callback`
- 永远不调用
- 提前调用
- 吞掉异常

调用方只能被动等待。

而 Promise 通过：
- 状态不可逆
- 单次决议
- `then` 行为统一
- 错误自动透传

把异步结果标准化成了一套可靠契约。

**你不再相信某个库会不会正确调用 callback，而是相信 Promise 规范本身。**

这才是 Promise 真正革命性的地方：

> 它把“将来会发生的结果”，从一段被第三方掌控的回调逻辑，提升为一种可以被传递、组合、返回的值。

会用的人很多，亲手写一遍的人，才真正看清它内部的精密设计。

本文将带你从零打造一个完全符合 **Promises/A+ 规范** 的 Promise，并跑通全部 872 个官方测试用例。过程中的每一个设计细节，都会对应到日常开发中的真实场景，让你不仅会写，更会用对。

> **前置知识**：你需要了解 Promise 的基本用法、微任务（microtask）、闭包与 `this`。

---

## 一、定下目标：规范核心与测试工具

### 1.1 锁定 Promises/A+ 规范

众多 Promise 规范中，**[Promises/A+](https://promisesaplus.com/)** 专注定义了 `then` 方法的行为（不涉及 `Promise.all` 等）。它短小精悍，却是检验实现是否正确的金标准。

核心规则简记如下：

- **状态**：仅 `pending`、`fulfilled`、`rejected` 三种，且只能从 `pending` 转变到其他状态，不可逆。
- **`then` 方法**：接收 `onFulfilled` 和 `onRejected` 两个可选参数。
  - 参数如果不是函数就忽略（即**值穿透**）。
  - `then` **必须返回一个新 Promise**（称为 `promise2`）。
  - 回调必须异步执行，且每个回调最多调用一次。
- **Promise 解析过程**：抽象操作 `[[Resolve]](promise, x)` 定义了如何处理 `then` 回调的返回值 `x`，包括循环引用检测、thenable 递归解包、防多次调用等关键规则。

需要注意的是：

> Promises/A+ 规范要求的是 **异步执行**，并不强制必须使用微任务（microtask）。

理论上：

```javascript
setTimeout(fn, 0)
```

也能满足 A+ 规范。

但现代 JavaScript 引擎中的原生 Promise 都基于微任务队列实现，因此本文也会使用 `queueMicrotask` 来模拟原生 Promise 的行为。

### 1.2 安装官方测试包

[promises-aplus-tests](https://github.com/promises-aplus/promises-tests) 提供了数百个边界用例，确保实现滴水不漏。

```bash
pnpm i promises-aplus-tests -D
```

在 `package.json` 中添加脚本：

```json
{
  "scripts": {
    "test:aplus": "promises-aplus-tests promise.aplus.js"
  }
}
```

为了让官方测试包运作，我们需要按规范导出 `deferred` 接口：

```javascript
AplusPromise.defer = AplusPromise.deferred = function () {
  const dfd = {};
  dfd.promise = new AplusPromise((resolve, reject) => {
    dfd.resolve = resolve;
    dfd.reject = reject;
  });
  return dfd;
};

module.exports = AplusPromise;
```

每完成一步，我们都可以跑 `pnpm test:aplus`，向 872 个全通过的里程碑前进。

---

## 二、搭建骨架：状态机与回调队列

先从构造函数开始，搭建 Promise 最基础的静态结构。

```javascript
class AplusPromise {
  constructor(executor) {
    this.state = 'pending';
    this.value = undefined;
    this.reason = undefined;

    this.onFulfilledCallbacks = [];
    this.onRejectedCallbacks = [];

    const resolve = (value) => {
      if (this.state === 'pending') {
        this.state = 'fulfilled';
        this.value = value;

        this.onFulfilledCallbacks.forEach(cb => cb());

        // 释放引用
        this.onFulfilledCallbacks.length = 0;
        this.onRejectedCallbacks.length = 0;
      }
    };

    const reject = (reason) => {
      if (this.state === 'pending') {
        this.state = 'rejected';
        this.reason = reason;

        this.onRejectedCallbacks.forEach(cb => cb());

        // 释放引用
        this.onFulfilledCallbacks.length = 0;
        this.onRejectedCallbacks.length = 0;
      }
    };

    try {
      executor(resolve, reject);
    } catch (error) {
      reject(error);
    }
  }
}
```

### 关键设计解读

**1. 状态锁**

```javascript
if (this.state === 'pending')
```

状态只能从 `pending → fulfilled` 或 `pending → rejected`。一旦敲定，就永远不可逆。

这也解释了为什么：

```javascript
const p = new MyPromise((resolve, reject) => {
  resolve('第一次');
  resolve('第二次');
  reject('失败');
  throw new Error('异常');
});

p.then(v => console.log(v));
```

输出永远是：第一次，后续所有决议都会被忽略。

**2. executor 错误捕获**

```javascript
try {
  executor(resolve, reject);
} catch (error) {
  reject(error);
}
```

同步抛错会自动转为 rejected：

```javascript
const p = new MyPromise(() => {
  throw new Error('同步错误');
});

p.catch(err => console.log(err.message));
```

输出：同步错误

但需要注意：

> executor 内部的 `try...catch` 只能捕获当前同步调用栈中的错误。

例如：

```javascript
const p = new MyPromise(() => {
  setTimeout(() => {
    throw new Error('异步错误');
  }, 0);
});
```

这里的错误不会进入 Promise。

原因并不是“Promise 无法处理异步错误”，而是：

> `setTimeout` 的回调发生在未来的事件循环中，此时 executor 的 `try...catch` 早已退出调用栈。

因此异常直接逃逸。

正确做法是在异步回调内部手动 `reject`：

```javascript
const p = new MyPromise((resolve, reject) => {
  setTimeout(() => {
    try {
      throw new Error('异步错误');
    } catch (error) {
      reject(error);
    }
  }, 0);
});
```

---

## 三、then 方法：链式调用的基石

`then` 是 Promise 的灵魂。

先看完整结构：

```javascript
then(onFulfilled, onRejected) {
  if (typeof onFulfilled !== 'function') {
    onFulfilled = value => value;
  }

  if (typeof onRejected !== 'function') {
    onRejected = reason => {
      throw reason;
    };
  }

  const promise2 = new AplusPromise((resolve, reject) => {
    const scheduleFulfilled = () => {
      queueMicrotask(() => {
        try {
          const returnValue = onFulfilled(this.value);

          handleThenResult(
            promise2,
            returnValue,
            resolve,
            reject
          );
        } catch (error) {
          reject(error);
        }
      });
    };

    const scheduleRejected = () => {
      queueMicrotask(() => {
        try {
          const returnValue = onRejected(this.reason);

          handleThenResult(
            promise2,
            returnValue,
            resolve,
            reject
          );
        } catch (error) {
          reject(error);
        }
      });
    };

    if (this.state === 'fulfilled') {
      scheduleFulfilled();
    } else if (this.state === 'rejected') {
      scheduleRejected();
    } else {
      this.onFulfilledCallbacks.push(scheduleFulfilled);
      this.onRejectedCallbacks.push(scheduleRejected);
    }
  });

  return promise2;
}
```

### 3.1 为什么 `then` 必须返回新 Promise

链式调用的本质：

```javascript
p.then(v => v + 1)
 .then(v => v * 2)
 .then(v => console.log(v));
```

并不是“一个 Promise 被不断修改”，而是**每次 `then` 都创建了一个全新的 Promise**。即 `p1 -> p2 -> p3 -> p4`。每个 Promise 都拥有自己的状态、值和回调队列，因此链路才能独立流动。

### 3.2 为什么 `then` 回调必须异步执行

这里隐藏着一个关键依赖：

```javascript
const promise2 = new AplusPromise(...)
```

回调执行时需要访问 `promise2`，但如果同步执行，`promise2` 还没赋值完成，链式调用会直接崩溃。所以必须先同步创建并返回 `promise2`，再异步执行回调。

```javascript
queueMicrotask(() => {
  ...
});
```

### 3.3 值穿透

规范要求 `.then(null)` 不能中断链路。因此：

```javascript
if (typeof onFulfilled !== 'function') {
  onFulfilled = value => value;
}
```

本质上是在做 **恒等映射**（identity）：

```javascript
Promise.resolve(100)
  .then(null)        // p1
  .then(v => console.log(v));  // p2，输出：100
```

**执行流程追踪：**
1.  `p1.then(null)` → `null` 不是函数，替换为 `value => value`。
2.  微任务调度执行该恒等函数，入参 `this.value = 100`，返回值 `100`。
3.  `handleThenResult(p1, 100, resolve, reject)` → `100` 不是对象或函数 → `resolve(p1, 100)`。
4.  `p1` 敲定为 `fulfilled`，值为 `100`，触发 `p1.onFulfilledCallbacks`。
5.  `p1` 的回调 `v => console.log(v)` 执行，输出 `100`。

**结论：值 `100` 像穿过透明管道一样，原封不动地流向下游。**

### 3.4 错误透传

默认 rejected handler：

```javascript
reason => {
  throw reason;
}
```

这意味着：如果当前层没有处理错误，就继续向后抛。因此：

```javascript
Promise.reject('boom')
  .then(v => v)
  .then(v => v)
  .catch(err => console.log(err));
```

最终仍然能被链尾捕获。

### 3.5 `.catch()` vs `.then` 的第二个参数

**❌ 写法 A（捕获不到）：**
```javascript
Promise.resolve()
  .then(
    () => { throw new Error('boom'); },
    err => { console.log('捕获不到'); }
  );
```

**✅ 写法 B（正确捕获）：**
```javascript
// catch 等价于 ，这里相当于两个 then
Promise.resolve()
  .then(() => { throw new Error('boom'); })
  .catch(err => { console.log(err.message); });
```

`then` 的第二个参数只能处理**前一个 Promise** 的 rejected，而 `.catch()` 位于链尾，可以捕获整条链中所有未处理的错误。

### 3.6 pending 阶段的回调队列

Promise 支持多个消费者：

```javascript
const p = new AplusPromise(resolve => {
  setTimeout(() => resolve('完成'), 100);
});
p.then(v => console.log('A:', v));
p.then(v => console.log('B:', v));
p.then(v => console.log('C:', v));
// 输出 A/B/C: 完成
```

原因是通过 `this.onFulfilledCallbacks = []` 暂存所有回调，等状态敲定后统一触发。

---

## 四、核心解析器：handleThenResult

这是整个 Promise 实现最复杂的部分，负责**把 then 回调的返回值，解析成 promise2 的最终状态**。

```javascript
const handleThenResult = (
  promise2,
  value,
  resolve,
  reject
) => {
  if (promise2 === value) {
    return reject(new TypeError('Chaining cycle detected'));
  }

  if ((typeof value === 'object' && value !== null) || typeof value === 'function') {
    let isCalled = false;
    try {
      const then = value.then;
      if (typeof then === 'function') {
        then.call(value,
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
      } else {
        return resolve(value);
      }
    } catch (error) {
      if (isCalled) return;
      isCalled = true;
      reject(error);
    }
  } else {
    return resolve(value);
  }
};
```

### 4.1 循环引用检测

试想：`const p = Promise.resolve('ok'); const p2 = p.then(() => p2);`，这会形成死锁——你永远在等自己。规范要求抛出 `TypeError`：

```javascript
if (promise2 === value) {
  return reject(new TypeError('Chaining cycle detected'));
}
```

### 4.2 为什么访问 `then` 属性也要 `try...catch`

Proxy 可以拦截属性访问并抛错：

```javascript
const obj = new Proxy({}, {
  get() { throw new Error('boom'); }
});
```

因此 `const then = value.then;` 本身就可能出错，必须用 `try...catch` 兜底。

### 4.3 为什么必须 `then.call(value)`

很多 thenable 内部依赖 `this`：

```javascript
const tricky = {
  data: 123,
  then(resolve) { resolve(this.data); }
};
```

直接调用 `then(resolve)` 会丢失 `this` 上下文（严格模式下为 `undefined`），必须用 `then.call(value)` 保证 `this` 指向正确。

### 4.4 `isCalled` 的作用：防多次决议

`isCalled` 保证**每次解析过程只被决议一次**。下面用两个不守规矩的 thenable 展示其必要性。

**场景 A：thenable 多次调用 resolve / reject**

```javascript
const badThenableMultipleCalls = {
  then(resolve, reject) {
    resolve(new Promise(res => res(42))); // ①
    resolve('第二次');                     // ②
    reject('第三次');                      // ③
  }
};
```

运行流程：
1. ① `resolve(new Promise(...))` 触发成功回调，**`isCalled` 设为 `true`**，递归调用 `handleThenResult`。
2. **递归创建独立的新锁**：递归调用会创建一个全新的 `isCalled`（初始 `false`），独立于外层。
   - 外层的 `isCalled` → 已锁死 → ② ③ 被拦截。
   - 内层的 `isCalled` → 独立变量 → 继续解包 `newPromise42`。
3. ② `resolve('第二次')` → 外层 `isCalled` 为 `true` → **被拦截、丢弃**。
4. ③ `reject('第三次')` → 同样被拦截。

**场景 B：thenable 先 resolve 再抛同步错误**

```javascript
const badThenableThrowAfterResolve = {
  then(resolve, reject) {
    resolve(42);                       // ①
    throw new Error('then threw');     // ②
  }
};
```

运行流程：
1. ① `resolve(42)` 触发回调，`isCalled` 变为 `true`。
2. ② `throw` 被外层 `catch` 捕获，**`catch` 分支检查 `if (isCalled) return;`**，发现已决议，直接返回。
3. 若无此检查，`catch` 会再次 `reject(error)`，导致已敲定的 `fulfilled` 状态被篡改为 `rejected`。

---

## 五、再往下看一层：为什么 Promise 能”流动”？

Promise 真正厉害的地方不是 `.then()` 这些 API，而是 **它把异步结果，变成了一种可以在链路中持续流动的数据**。

### 5.1 Promise 本质上是”单向数据流”

```javascript
new AplusPromise(resolve => resolve(1))
  .then(v => v + 1)
  .then(v => v * 2)
  .then(v => console.log(v)); // 输出 4
```

执行流：

```
1
↓ + 1
2
↓ * 2
4
```

数据像管道一样一级一级向后传递。

### 5.2 `return`：继续 fulfilled 流

```javascript
new AplusPromise(resolve => resolve(1))
  .then(v => { return v + 1; })
  .then(v => { console.log(v); });
```

`return` 的返回值通过 `handleThenResult` 被 `resolve`，将 fulfilled 数据继续向后传递。

### 5.3 `throw`：切换到 rejected 流

```javascript
new AplusPromise(resolve => resolve(1))
  .then(v => { throw new Error('boom'); })
  .catch(err => { console.log(err.message); });
```

关键在微任务内的 `try...catch`：`throw` 被捕获后调用 `reject(error)`，Promise 从 fulfilled 通道切换到 rejected 通道。因此，**Promise 本质上维护了两条通道**：`return` 走 fulfilled 通道，`throw` 走 rejected 通道。

### 5.4 为什么 Promise 不会出现 `Promise<Promise<T>>`

看代码：

```javascript
new AplusPromise(resolve => resolve(1))
  .then(v => {
    return new AplusPromise(resolve => resolve(v + 1));
  })
  .then(v => console.log(v)); // 输出 2，而非 Promise 对象
```

因为 `handleThenResult` 会**递归解包**。如果返回值还是 Promise（或 thenable），就会继续等待、继续解包，直到拿到普通值。这就是著名的 **Promise flattening**（展平），即 `Promise<Promise<T>>` 自动展开为 `Promise<T>`。

---

## 六、手写 Promise 细节复盘

一个完整的 Promise 实现，本质上在解决四件事：**状态怎么锁住、链路怎么串起来、异常怎么兜住、不可信 thenable 怎么防住**。15 个设计细节全部归属于这四个功能域。

### 6.1 状态管理：保证结果唯一且不可篡改

| 设计细节 | 作用 |
| --- | --- |
| 状态锁 | `pending` → 其他状态，不可逆 |
| pending 回调队列 | 状态敲定前暂存多个消费者回调 |
| 清空回调数组 | 状态敲定后释放引用，避免内存滞留 |

状态机是 Promise 的地基。没有不可逆的状态锁，后续所有设计都无从谈起。

### 6.2 链式调用：让数据持续流动

| 设计细节 | 作用 |
| --- | --- |
| `then` 返回新 Promise | 每次调用产生独立节点，链路才能分叉和组合 |
| 微任务异步化 | 回调执行时 `promise2` 已就绪 |
| 值穿透默认函数 | `.then(null)` 不中断数据流 |
| 错误透传默认函数 | `rejected` 能沿链传播到 `.catch()` |
| `handleThenResult` 递归解包 | `Promise<Promise<T>>` 自动展平 |

这五个细节共同保证了 Promise 链的**单向流动性**。

### 6.3 异常兜底：任何环节抛错都不丢失

| 设计细节 | 作用 |
| --- | --- |
| executor `try...catch` | 同步抛错自动转为 `rejected`，不逃逸 |
| 回调内部 `try...catch` | `then` 回调抛错自动 `reject`，不逃逸 |
| 循环引用检测 | `p.then(() => p)` 抛 `TypeError`，不死锁 |
| `then` 属性 `try...catch` | `value.then` 是 Proxy 也能安全捕获 |

Promise 的错误处理哲学是”**宁可多兜一层，不可漏掉一个**”。

### 6.4 thenable 防御：面对不可信对象仍稳定

| 设计细节 | 作用 |
| --- | --- |
| `then.call(value)` | 保证 thenable 内部 `this` 指向正确 |
| `isCalled` 锁 | 同一解析过程只接受第一次决议 |
| 每层递归独立 `isCalled` | 多层 thenable 递归解包互不干扰 |

`isCalled` 保证了：**无论 thenable 多么不守规矩，Promise 的状态永远只由第一次有效决议决定。**

### 四个功能域的关系

```
状态管理（地基）
  ├── 链式调用（流动）    ← 日常开发最常感受到的
  ├── 异常兜底（安全）    ← 保证不丢错误
  └── thenable 防御（鲁棒）← 保证与任何第三方互操作安全
```

最核心的两个设计是**微任务异步化**（链式调用成立的前提）和 **`isCalled` 锁**（面对不可信 thenable 仍稳定可靠的前提）。它们分别位于”链式调用”和”thenable 防御”两个域中，是各自域里最关键的一环。

---

## 七、完整代码

```javascript
const handleThenResult = (promise2, value, resolve, reject) => {
  if (promise2 === value) {
    return reject(new TypeError('Chaining cycle detected'));
  }

  if ((typeof value === 'object' && value !== null) || typeof value === 'function') {
    let isCalled = false;
    try {
      const then = value.then;
      if (typeof then === 'function') {
        then.call(value,
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
      } else {
        return resolve(value);
      }
    } catch (error) {
      if (isCalled) return;
      isCalled = true;
      reject(error);
    }
  } else {
    return resolve(value);
  }
};

class AplusPromise {
  constructor(executor) {
    this.state = 'pending';
    this.value = undefined;
    this.reason = undefined;
    this.onFulfilledCallbacks = [];
    this.onRejectedCallbacks = [];

    const resolve = (value) => {
      if (this.state === 'pending') {
        this.state = 'fulfilled';
        this.value = value;
        this.onFulfilledCallbacks.forEach(cb => cb());
        this.onFulfilledCallbacks.length = 0;
        this.onRejectedCallbacks.length = 0;
      }
    };

    const reject = (reason) => {
      if (this.state === 'pending') {
        this.state = 'rejected';
        this.reason = reason;
        this.onRejectedCallbacks.forEach(cb => cb());
        this.onFulfilledCallbacks.length = 0;
        this.onRejectedCallbacks.length = 0;
      }
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

    const promise2 = new AplusPromise((resolve, reject) => {
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

AplusPromise.defer = AplusPromise.deferred = function () {
  const dfd = {};
  dfd.promise = new AplusPromise((resolve, reject) => {
    dfd.resolve = resolve;
    dfd.reject = reject;
  });
  return dfd;
};

module.exports = AplusPromise;
```

---

## 八、总结

通过从零手写一个符合 Promises/A+ 规范的 Promise，我们实际上走过了三层认知：

**第一层：从回调到 Promise——控制反转**
回调的本质问题是把控制权交给了第三方。Promise 通过状态不可逆、单次决议、错误自动透传，把异步结果标准化成了一套可靠契约。**你不再相信某个库，而是相信规范本身。**

**第二层：从 API 到机制——14 个设计细节的精密咬合**
手写过程让我们看清，每一个看似简单的 API 背后都有精确的工程考量：
- 状态锁保证不可逆
- 微任务异步化保证链式调用成立
- `isCalled` 锁保证面对不可信 thenable 时仍然安全
- 值穿透和错误透传让数据在链路中不中断

这些细节**缺一不可**，少任何一个，Promise 链都会在某个边界场景下崩溃。

**第三层：从机制到底层模型——单向数据流**
Promise 最本质的设计不是 `.then()` 这个 API，而是它建立了一套**单向、可组合的数据流模型**：
- `return` 继续 fulfilled 流
- `throw` 切换到 rejected 流
- `handleThenResult` 递归解包，保证 `Promise<Promise<T>>` 自动展平

> Promise 不是”更好的回调”，而是**把异步结果变成了一种可以被传递、组合、返回的值**。这才是它真正的革命性所在。