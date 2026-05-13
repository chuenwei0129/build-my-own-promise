# Build My Own Promise

手写 Promise 实现，从 Promises/A+ 规范到 ES6+ 完整 API。

## 项目结构

- **[promise.aplus.js](./promise.aplus.js)** — Promise 核心实现，通过 Promises/A+ 全部 872 个测试用例
- **[promise.es.js](./promise.es.js)** — 在 A+ 基础上对齐原生 Promise 行为
- **[promise.fully.js](./promise.fully.js)** — 在 `promise.es.js` 基础上继续补齐原生 Promise API 的入口
- **[examples/](./examples)** — `promise.es.md` 文中的可运行示例题

## 教程

- [从零手写 Promise：通过 Promises/A+ 官方 872 个测试用例](./promise.aplus.md)
- [从 Promises/A+ 到更接近原生 Promise：差的不是语法，而是两次微任务](./promise.es.md)

## 运行示例

```bash
node ./examples/resolve-promise-order.js
node ./examples/then-return-promise-order.js
```

## 运行测试

```bash
# 安装依赖
pnpm install

# 跑 Promises/A+ 官方测试（872 个用例）
pnpm test:aplus
```
