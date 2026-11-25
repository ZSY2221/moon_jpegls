# MoonJLS 科学验证工作台交接与维护说明

从 [固定受测源码提交 `fc43bc2`](https://github.com/ZSY2221/moon_jpegls/commit/fc43bc2b4ed69cad9d967e63c2019ff1e8f3be44) 检出，使用运行报告中的 `source.revision` 和 `artifact.sha256` 核对实际构建。[当前支持范围](SCOPE.md) 与 [T.87 权威能力矩阵](T87_CONFORMANCE_PLAN.md) 记录各项能力状态。

> **维护角色更新（2026-11-25）**：项目当前由 **Antigravity** 担任唯一主力 AI 维护助手（覆盖核心状态机、SDK/Worker 协议、科学工作台 UI 与验证工具链），项目负责人（`ZSY2221`）负责最终技术决策与代码审核。原交接文中“状态机与报告采集由 Codex 维护”的临时双工具分工已废止。

## M2 已交付基线

- **工作台能力**：Precision Lab 显示实际解析后的 `P`、`MAXVAL`、`NEAR`、`T1/T2/T3/RESET`，并以有界预览网格采样 7×7 放大区域；Streaming Lab 展示宿主实际 ACK 以及已交付和暂定行计数；Compatibility Lab 从 [能力清单](../tests/conformance/manifest.json) 读取与测试脚本同源的实际状态与阶段（`M1`、`M2`、`M3-A`、`M3-B`、`M4`、`M5`）。
- **后续阶段对齐（M3-A / M3-B）**：下一阶段 `M3-A`（目标 2026-12-10）扩展多分量与 `ILV=0` 多扫描，`M3-B`（目标 2026-12-25）扩展交错、采样与 `Pt`，需分别定义 `SOF55` 分量布局、活动扫描参数与逐扫描 `LSE1` 继承，并按 [T.87 符合性计划](T87_CONFORMANCE_PLAN.md) 第 4 节严格区分变换编码域与原始样本尺度误差。Gray16 接入和旧灰度行 API 仍是现有消费者入口。 [M2 运行证据](../reports/t87-m2-20261125/README.md)

## 可用数据与接口契约

| 入口 | 字段及用途 |
| --- | --- |
| [报告 v1](VERIFICATION_REPORT.md) | 从 `status`、`stages`、`reference.status` 取得终态和执行范围。用 `frame`、`samples`、`physical` 展示精度、误差和单位。 |
| [NASA 元数据](../sdk/lunar.mjs) | `lunarMetadataFor` 依据实际输入 SHA-256、长度和 PGM 格式识别固定样本。高程为 `(sample − 20000) × 0.5 m`，相对半径 1,737,400 m 的参考球。差值与误差界只乘 0.5。 |
| [实测候选](../reports/lunar-budget-20261125/README.md) | 固定输入在 JS 与 Wasm GC 的 NEAR 0–3 实测字节数、最大误差、耗时边界和运行报告。曲线连接实际测点。预算内最小文件从这些实际候选比较，并保留选择依据。 |
| [Worker 事件](../sdk/worker-client.d.mts) | `row`、`rows`、`bytes`、`progress` 带有实测统计、行号或帧信息。独立打开 JLS 时，原图比对和独立参考均为 `not_run`。 |

普通 PGM 仅显示整数样本单位。NASA 派生 PGM 通过文件哈希后才显示米。高程误差只指当前 `Pt=0`、无映射、无重采样路径由编解码新增的误差。窗宽窗位、颜色和显示降采样属于预览层。点读和全样本误差使用原始整数。

## 模块边界与流式验收

- UI 视图、样式与双语词条位于 [web/index.html](../web/index.html)、[web/style.css](../web/style.css)、[web/labels.mjs](../web/labels.mjs)；[web/preview.mjs](../web/preview.mjs) 负责有界像素取样、Canvas 和坐标联动；状态机、报告采集、传输与清单渲染位于 [web/app.mjs](../web/app.mjs)、[web/run-report.mjs](../web/run-report.mjs)、[web/transport.mjs](../web/transport.mjs)、[web/compatibility.mjs](../web/compatibility.mjs) 和 SDK Worker。
- Worker 一次处理一个待确认请求。消费回调完成后发送 ACK。UI 合并绘制时保留事件顺序和既有字节消费顺序。
- `RowReady` 和批量行可能早于 `EOI`，呈现为暂定预览。严格流终结和输出关闭都成功后显示最终成功。取消立即结束当前任务的可见生命周期，旧读取、写入、关闭或 ACK 的完成事件不能更新新任务。
- Worker 峰值包含持有的输出 backing buffer，以及复制时同时存在的源行。Core、bridge、宿主下载、预览和浏览器分配器有不同边界，报告分别记录实测计数。
- 复验实际 Chrome 的 NASA 与普通 PGM、下载样本及报告、暂停恢复、严格尾随失败和取消重启。入口见 [Web 测试说明](../web/README.md)。固定源码的 [CLI 与 Chrome 运行证据](../reports/verification-toolkit-20261125/README.md) 可核对导出报告、资产指纹、取消和尾随终态。
