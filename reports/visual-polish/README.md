# MoonJLS 视觉与交互精修验收记录

2026-11-24（Asia/Singapore）。工作分支：`antigravity/visual-polish-20261124`。

## 版本与冻结范围

| 项 | 记录 |
| --- | --- |
| RC3 后端冻结基线 | `2feb00b8ef657b7259ba70bccf1ff0ceaf08765b` |
| Presentation 基线 | `60befa604287d941dc75ffde03a4c52ab80a93ad`（受测源码 `65261da`） |
| 视觉精修源码提交 | `04538ed19d520efef812e4214235aa0fc939165f` |
| 冻结路径复核 | `core/**`、`cmd/**`、`sdk/**`、`moon.mod`、`web/pgm.mjs`、`web/transport.mjs` 与 `2feb00b8` 差异为空 |

运行工具链：Windows 11，AMD Ryzen 9 8945HX（电源方案 `8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c` 高性能），Node `v24.20.0`，Chrome `158.0.8127.37`，Playwright Core `1.65.1`，Python `3.12.10`，Moon `0.1.20261119`。

## 实拍截图与输入数据

| 截图 | 视口与语言 | 真实输入 | 状态 / 视图 / 关键读数 |
| --- | --- | --- | --- |
| [desktop-zh-1440.png](screens/desktop-zh-1440.png) | 1440×900 中文 | `lola.pgm` (1440×720 16-bit) | NEAR=3 对照完成，图台起于 `188.7 px`，点读 `(603, 258)`：`17,051` / `17,049` / 误差 `2`，`999,459 B` (`2.07×`)，最大误差 `3` |
| [desktop-en-1366.png](screens/desktop-en-1366.png) | 1366×768 英文 | `lola.pgm` (1440×720 16-bit) | NEAR=3 对照首屏，控制区、双图舞台、整数检查器与 4 项 KPI 全部位于 `768 px` 首屏内，无截断 |
| [desktop-zh-error-mode.png](screens/desktop-zh-error-mode.png) | 1440×900 中文 | `lola.pgm` (1440×720 16-bit) | NEAR=3 误差主视图，离散 `0/1/2/3` 图例与 `最大误差 3 / 允许 ≤ 3`，点读 `(603, 255)` 误差 `1` |
| [desktop-zh-near0.png](screens/desktop-zh-near0.png) | 1440×900 中文（全页） | `ripple-16.pgm` (400×260 16-bit) | NEAR=0 对照完成，键盘移动至 `(1, 0)` 显示 `65,535 / 65,535 / 0`；展开流式资源区分实测载荷与 `64 KiB` / `64 MiB` 配置上限 |
| [narrow-390.png](screens/narrow-390.png) | 390×844 中文（全页） | `ripple-16.pgm` (400×260 16-bit) | NEAR=0 运行后参数抽屉自动折叠，单视图重建紧接整数检查器与两列 KPI，横向零溢出 (`scrollWidth = 390`) |
| [finalizing.png](screens/finalizing.png) | 1440×900 英文 | `ripple-16.pgm` | 受控 writer 暂扣 `sink.close()`：260/260 行已到齐，仍为琥珀色 `Finalizing` / `Provisional`，无下载入口 |
| [failed.png](screens/failed.png) | 1440×900 英文 | `ripple-16.pgm` | 受控 writer 拒绝 `close()`：呈现 `NotAllowedError · Controlled output-close failure` 与红色 `Incomplete`，标注 `Task unfinished · not verified` |
| [jls-no-reference.png](screens/jls-no-reference.png) | 1440×900 中文 | `ripple-16-near3.jls` | 单独 JLS 解码完成：自动隐藏对照/原图标签，最大误差与原样本点读均标 `未比较` |

详细布局度量与加载资产哈希见 [capture-receipt.json](capture-receipt.json) 与 [smoke-receipt.json](smoke-receipt.json)。

## 已执行的验证

- 构建：`npm.cmd ci --prefix web`、`node sdk/build.mjs`、`node web/build.mjs` 成功。
- 单元与取消隔离：`node --test web/pgm.test.mjs web/preview.test.mjs`（10/10 通过，含离散误差色阶单调性/超界着色与同步十字线几何单测）；`node REVIEW_EVIDENCE/web_cancel_probe.mjs .` 通过（新样本保留 `4000`，旧 Worker 已终止）。
- Chrome 烟测（`node web/smoke.mjs`）：通过，零 `pageerror` 与 `console.error`。涵盖 `ripple-16.pgm` NEAR 0/3、无参考 JLS 解码与无参考误差占位校验、截断/不支持错误、1 B 暂停恢复、`read`/`write`/`close` 挂起取消重启、EOI 暂扣、输出 `close` 挂起成功/失败计时与 `lola.pgm` 下载 1,036,800 样本与 CharLS Wasm 裁判完全一致（`maxError = 3`）。
- Chrome 预览几何（`node web/preview-browser.mjs`）：通过。验证 `128×16` 横图、`512×4096` 高图（`40×320` 采样上限）、`390×840` 窄屏下同步十字线落在图像内容区、键盘巡检及留白点击忽略。

## 性能防回退（对比 Presentation `60befa6`）

使用 `node web/bench-presentation.mjs`（512×4096、16 位、Wasm GC、NEAR=0、有界验证、4096 块，交替 2 次预跑 + 5 次正式），完整原始试次见 [paired.json](paired.json)：

| 版本 | 5 次正式总时 (ms) | 总时中位数 | 首 Canvas 中位数 |
| --- | --- | ---: | ---: |
| Presentation (`60befa6`) | 963.4, 910.7, 939.2, 987.0, 1007.5 | 963.4 ms | 14.4 ms |
| Visual Polish (`04538ed`) | 962.3, 930.7, 1003.6, 992.5, 841.8 | 962.3 ms | 16.2 ms |

门禁判定：`wallRegressionPercent = -0.11%`（`stableWallRegression = false`），`firstCanvasDeltaMs = +1.80 ms`（`<= 2.00 ms` 门槛），**`pass = true`**。

## 未测项

本轮未测：Firefox / Safari 等其他浏览器、系统 `showSaveFilePicker` 原生保存弹窗实机交互、Native CLI 本轮重跑、浏览器进程 RSS 实测以及 RC2/RC3 全量压力矩阵重跑；未执行远端推送、包发布或赛事提交。
