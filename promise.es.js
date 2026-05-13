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
    if (typeof executor !== 'function') {
      throw new TypeError(`Promise resolver ${executor} is not a function`);
    }

    this.state = 'pending';
    this.value = undefined;
    this.reason = undefined;
    this.onFulfilledCallbacks = [];
    this.onRejectedCallbacks = [];
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
      if (this.state === 'pending') {
        this.state = 'rejected';
        this.reason = reason;
        this.onRejectedCallbacks.forEach(cb => cb());
        this.onFulfilledCallbacks.length = 0;
        this.onRejectedCallbacks.length = 0;
      }
    };

    const resolvePromise = (value) => {
      // 防止自己 resolve 自己
      if (value === this) {
        return rejectPromise(new TypeError('Chaining cycle detected'));
      }

      // 本文主线只展开到 resolve(promise)
      if (value instanceof EsPromise) {
        queueMicrotask(() => {
          value.then(resolvePromise, rejectPromise);
        });
        return;
      }

      // 普通值直接 fulfilled
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
