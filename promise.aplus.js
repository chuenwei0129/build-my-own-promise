const handleThenResult = (promise2, value, resolve, reject) => {
  // ============================================
  // 循环引用检测：防止 Promise 返回自身
  // ============================================
  // 示例：
  //   const p = Promise.resolve('ok');
  //   const p2 = p.then(() => {
  //     return p2;  // p2 在同步代码中已被赋值，回调在微任务中执行时 p2 已存在，从而形成循环引用
  //   });
  //   p2.catch(err => console.log(err)); // TypeError: Chaining cycle detected
  //
  if (promise2 === value) {
  // 注意：必须在判断之后 return，否则会继续执行后续逻辑，导致 Promise 状态混乱。
    return reject(new TypeError('Chaining cycle detected'));
  }

  // 如果返回值是对象或函数，尝试判断其是否为类 promise
  if ((typeof value === 'object' && value !== null) || typeof value === 'function') {
    // 反例（badThenable）：
    //   {
    //     then(resolve, reject) {
    //       resolve(new Promise(res => res(42))); // 触发递归的 handleThenResult，内部重新声明了 isCalled
    //       resolve('外部再次调用，外部 isCalled 已经是 true，会被忽略');
    //     }
    //   }
    let isCalled = false;

    try {
      const then = value.then; // 获取 then 时可能抛错（例如 Proxy），会进入 catch
      // then 是函数 → 按 thenable 处理，将 value 视为一个“类 Promise”对象
      if (typeof then === 'function') {
        // 示例：
        //   const badThenable = {
        //     data: 123,
        //     then(resolve) { resolve(this.data); }
        //   };
        then.call(
          value,
          resolvedValue => {
             // 防止 thenable 的 then 方法中多次调用 resolve/reject，或 resolve 后又抛出错误，
            // 确保 promise2 只会被敲定一次，符合 Promise A+ 规范。
            // thenable 内部多次调用 resolve 的反例：
            //   {
            //     then(resolve, reject) {
            //       resolve('第一次');
            //       resolve('第二次'); // isCalled 已为 true，忽略
            //       reject('第三次');  // 同样被忽略
            //     }
            //   };
            if (isCalled) return;
            isCalled = true;
            // resolvedValue 可能仍是 thenable，例：
            //   new AplusPromise().then(() => ({
            //     then(resolve) { resolve(new AplusPromise(res => res(42))); }
            //   }))
            // → resolvedValue 是 new AplusPromise(res => res(42))，handleThenResult 递归展开，最终 resolve(42)
            handleThenResult(promise2, resolvedValue, resolve, reject);
          },
          reason => {
            if (isCalled) return;
            isCalled = true;
            reject(reason);
          }
        );
      } else {
        // then 属性存在但不是函数 → 视为普通对象，直接用 value 敲定 promise2
        return resolve(value);
      }
    } catch (error) {
      // 示例（catch 中必须检查 isCalled）：
      //   {
      //     then(resolve, reject) {
      //       resolve(42);
      //       throw new Error('then threw after resolve'); // 若不加锁，会让 promise2 先 fulfilled 再 rejected，状态被错误覆盖
      //     }
      //   };
      if (isCalled) return;
      isCalled = true;
      reject(error);
    }
  } else {
    // value 是普通值（非对象非函数）→ 直接 resolve
    // 此处加上 return 使终止更明确，避免未来修改代码时意外穿透。
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
        // 执行所有已注册的 onFulfilled 回调，完成后清空数组帮助 GC
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
      // 如果 executor 执行过程中抛出同步错误，直接 reject
      reject(error);
    }
  }

  then(onFulfilled, onRejected) {
    // 值穿透：如果未传函数，则用默认行为传递值或抛出错误
    if (typeof onFulfilled !== 'function') {
      // 对于 fulfilled 状态，默认将 value 原样向后传递
      onFulfilled = value => value;
    }
    if (typeof onRejected !== 'function') {
      // 对于 rejected 状态，默认将 reason 继续抛出，让后续 catch 捕获
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
        // 状态仍为 pending 时，将回调挂载到队列中，等待 resolve/reject 执行
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