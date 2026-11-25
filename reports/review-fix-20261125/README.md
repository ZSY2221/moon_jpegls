# 2026-11-25 本机正确性回归

实跑源码为 `e3a3e5c` 加三处修复，与 [16a7b49](https://github.com/ZSY2221/moon_jpegls/commit/16a7b492242cf3c85c133e0c4ae311acee0463e7) 的运行源码一致。工具链为 Moon 0.1.20261119、moonc v0.10.22+124d61d05、Node 24.20.0。Native 使用 Ubuntu 22.04 WSL2 与 Clang 14，浏览器使用 Windows Google Chrome 158.0.8127.37 无头模式。

| 检查 | 本机结果 |
| --- | --- |
| Native 交付及背压 | 12/12。4096 B 分块下 1×4 样例在 EOI 前交付四行，EOF 后无残留；慢消费恢复后 131,072 B 输出完全一致 |
| Native 严格尾部 | 20 项矩阵及独立晚到尾随用例通过 |
| 核心 | Native、JS、Wasm GC 各 9/9，含 `q_lut` 实际载荷计数 |
| Worker 与页面单测 | 协议 19/19、Node 实际生成的 JS/Wasm GC codec 4/4、PGM 与预览 10/10 |
| Chrome | 两个 Web Worker 后端的批次峰值均为 112 B，终态队列均为 0 B，共 12 行且 96 个样本逐一一致；挂起 ACK 后取消与重启通过 |
| Chrome 工作台 | 下载、像素核对、暂停与恢复、取消重启及未完成输出收尾通过 |
| 类型声明 | TypeScript 7.0.2 严格编译通过 |

[Native 实跑 JSON](native-row-delivery.json) · [Chrome Worker 轨迹](chrome-worker.log) · [Chrome 工作台产物收据](chrome-smoke.json)

原始浏览器探针随补件前材料被引用，本机使用 [等效探针](chrome-worker-probe.mjs)。构建 SDK 和 Web，按 README 启动静态服务后，从仓库根运行：

```sh
node web/smoke.mjs
node reports/review-fix-20261125/chrome-worker-probe.mjs .
```

本组记录覆盖修复本身，当前标准范围仍以 [SCOPE.md](../../docs/SCOPE.md) 为准。三处修复的测试使用当时的 `NEAR=0–3` 子集。
