# MoonJLS 科学验证工作台交接

从 [固定源码提交 `da0b52d`](https://github.com/ZSY2221/moon_jpegls/commit/da0b52d9992c956608039ce0d29060b5eeed2e84) 检出，使用报告中的 `source.revision` 和 `artifact.sha256` 核对实际构建。标准兼容基线为 [P1 9667375](https://github.com/ZSY2221/moon_jpegls/commit/9667375c42dd5d20aba832c1c07ebcd0fdfad214)。[当前范围](SCOPE.md) 与 [T.87 验收路线](T87_CONFORMANCE_PLAN.md) 记录各项能力的状态。

## M2 交接基线

从 [M2 产品源码 `fc43bc2`](https://github.com/ZSY2221/moon_jpegls/commit/fc43bc2b4ed69cad9d967e63c2019ff1e8f3be44) 开始。Precision Lab 显示实际 P、MAXVAL、NEAR、T1/T2/T3/RESET，并以有界预览网格采样 7×7 放大区域。Streaming Lab 使用宿主实际 ACK 以及已交付和暂定行计数。Compatibility Lab 从 [能力清单](../tests/conformance/manifest.json) 读取实际状态。下一阶段 M3 将扩展分量和扫描组织，需要分别定义 SOF 组件布局、活动扫描参数与逐扫描 LSE 继承。Gray16 接入和旧灰度行 API 仍是现有消费者入口。 [M2 运行证据](../reports/t87-m2-20261125/README.md)

## 可用数据

| 入口 | 字段及用途 |
| --- | --- |
| [报告 v1](VERIFICATION_REPORT.md) | 从 `status`、`stages`、`reference.status` 取得终态和执行范围。用 `frame`、`samples`、`physical` 展示精度、误差和单位。 |
| [NASA 元数据](../sdk/lunar.mjs) | `lunarMetadataFor` 依据实际输入 SHA-256、长度和 PGM 格式识别固定样本。高程为 `(sample − 20000) × 0.5 m`，相对半径 1,737,400 m 的参考球。差值与误差界只乘 0.5。 |
| [实测候选](../reports/lunar-budget-20261125/README.md) | 固定输入在 JS 与 Wasm GC 的 NEAR 0–3 实测字节数、最大误差、耗时边界和运行报告。曲线连接实际测点。预算内最小文件从这些实际候选比较，并保留选择依据。 |
| [Worker 事件](../sdk/worker-client.d.mts) | `row`、`rows`、`bytes`、`progress` 带有实测统计、行号或帧信息。独立打开 JLS 时，原图比对和独立参考均为 `not_run`。 |

普通 PGM 仅显示整数样本单位。NASA 派生 PGM 通过文件哈希后才显示米。高程误差只指当前 Pt=0、无映射、无重采样路径由编解码新增的误差。窗宽窗位、颜色和显示降采样属于预览层。点读和全样本误差使用原始整数。

## 修改边界

Antigravity 可修改 [web/index.html](../web/index.html)、[web/style.css](../web/style.css)、[web/labels.mjs](../web/labels.mjs) 以组织精度实验、流式过程和兼容证据视图。[web/preview.mjs](../web/preview.mjs) 负责有界像素取样、Canvas 和坐标联动。剖面从同一路径的真实样本取得并说明取样间距及单位。需要更密取样时先约定有界读取和回收方式。

状态机、报告采集和接口语义由 Codex 维护，入口为 [web/app.mjs](../web/app.mjs)、[web/run-report.mjs](../web/run-report.mjs)、[web/transport.mjs](../web/transport.mjs) 和 SDK Worker。新数据需求先说明字段与生命周期，由同一负责人接入。

## 流式验收

- Worker 一次处理一个待确认请求。消费回调完成后发送 ACK。UI 合并绘制时保留事件顺序和既有字节消费顺序。
- RowReady 和批量行可能早于 EOI，呈现为暂定预览。严格流终结和输出关闭都成功后显示最终成功。取消立即结束当前任务的可见生命周期，旧读取、写入、关闭或 ACK 的完成事件不能更新新任务。
- Worker 峰值包含持有的输出 backing buffer，以及复制时同时存在的源行。Core、bridge、宿主下载、预览和浏览器分配器有不同边界。报告分别记录实测计数。
- 复验实际 Chrome 的 NASA 与普通 PGM、下载样本及报告、暂停恢复、严格尾随失败和取消重启。入口见 [Web 测试说明](../web/README.md)。截图和结果注明提交、输入、后端与实际浏览器。历史与未执行项分别标明。

固定源码的 [CLI 与 Chrome 运行证据](../reports/verification-toolkit-20261125/README.md) 可核对导出报告、资产指纹、取消和尾随终态。
