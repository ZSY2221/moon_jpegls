# 高精度验证工具链实跑

产品与 Antigravity 接口固定在 [da0b52d](https://github.com/ZSY2221/moon_jpegls/commit/da0b52d9992c956608039ce0d29060b5eeed2e84)。本目录的浏览器和 CLI 报告来自该提交的干净源码。安装验证单独固定到已公开的 P1 `9667375`，验证的是现有 codec 公开 API。相关源码、测试数据和产物的哈希记录在各自回执中。

| 入口 | 实跑结果 |
| --- | --- |
| Windows Node SDK CLI | JS 编码与 Wasm GC 严格解码，逐字节验证原始 16 位 raw 与重建一致。另测 JS 尾随失败，报告保留 4 行暂定数据和原文件哈希。 [CLI 报告](cli-reports.json) |
| WSL Native | JSON telemetry 定向检查 22 项。验证适配器的 inspect、verify 成功和尾随、截断失败均写统一报告。Native 交付 12/12、尾部矩阵 20 项及晚到尾随通过。 [CLI 报告](cli-reports.json) · [telemetry](native-telemetry-probe.json) · [行交付](native-row-delivery.json) · [尾部矩阵](native-tail-matrix.json) |
| Windows Chrome 158.0.8127.37 | 六份真实报告覆盖 NASA 往返、独立 JLS 解码、普通 PGM、同尺寸一字节改动、取消和非法尾随。另跑 DOM 预览、焦点、下载、暂停恢复和取消重启。两后端的 Worker 峰值均为 112 B，成功终态队列为 0 B。 [导出报告](chrome-report-receipt.json) · [工作台日志](chrome-smoke.log) · [页面资产 SHA-256](chrome-build-receipt.json) · [Worker 轨迹](chrome-worker.log) · [预览和焦点](chrome-preview.log) |
| NASA 独立参照 | Chrome 下载的 NEAR=3 JLS 在固定 CharLS Wasm 0.10.0 上同码流逐样本一致，共 1,036,800 个值。该比较由测试驱动执行，常规页面导出中的 `reference.status` 仍反映页面自身。 [运行日志](chrome-smoke.log) |
| WSL / Node 正确性 | WSL Native 核心 11/11。JS/Wasm GC 核心及 bridge 产物与 P1 一致，沿用该版本既有核心结果。报告单测 2/2、Worker 协议 19/19、实际 Node Worker 4/4、网页单测 11/11。TypeScript 7.0.2 严格声明检查通过。 |
| 独立消费者 | 12/16 位、NEAR 0/255 的四个用例在 JS、Wasm GC 和 Native 上逐样本核验。临时模块从回环 registry 安装 P1 固定源码的真实包归档。 [独立消费记录](../review-consumer-20261125/README.md) |

复跑入口见[报告契约](../../docs/VERIFICATION_REPORT.md)、[Web 测试说明](../../web/README.md)及 [NASA 实测](../lunar-budget-20261125/README.md)。运行环境为 Moon 0.1.20261119、moonc v0.10.22+124d61d05、Node 24.20.0，Native 使用 Ubuntu 22.04 WSL2 和 clang 14。浏览器覆盖本机无头 Chrome。本轮复用 P1 的 640 组合法 NEAR 测试，完整 Part 1 验收、新性能测量和浏览器总内存测量留在各自范围。
