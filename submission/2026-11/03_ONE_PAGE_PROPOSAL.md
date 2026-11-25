# MoonJLS——纯 MoonBit JPEG-LS Part 1 编解码内核与符合性验证工具链

> **内部参考文档标识**：本文档（及历史版式归档 [`04_ONE_PAGE_PROPOSAL.pdf`](04_ONE_PAGE_PROPOSAL.pdf)）仅作为参赛者核对技术事实与结构的**内部参考材料**保留，**不作为满足飞书报名表字段 11“不要使用 AI 编写”要求的直接上传成稿**。正式上传的一页 Markdown 申报书请由参赛者本人独立撰写。

## 1. 项目名称
**MoonJLS**（`MoonJLS: MoonBit-Native JPEG-LS Part 1 Codec and Conformance Verification Toolkit`）

## 2. 项目简介与最终标准目标
MoonJLS 面向高精度整数图像的数据交换，提供**纯 MoonBit** 编写的 JPEG-LS 流式编解码核心、Native / JS / Wasm GC 接入以及可复现的符合性验证工具链。  
- **最终标准目标**：**完整实现 ITU-T T.87（06/1998）/ ISO/IEC 14495-1 JPEG-LS Part 1 的编码、解码和数据格式能力**，涵盖基础交换格式、多分量与多扫描、`ILV=0/1/2`、采样因子与边缘 MCU、点变换 `Pt`、`LSE ID=2/3` 映射表及续表、表规范与简略图像格式（`§7(b)(c)`）、`DRI/RST`、`DNL`、`LSE ID=4` 及 `§8` / Annex E 验收（T.870 Part 2 与 DICOM 属独立扩展，SPIFF 按可选容器单列）。  
- **当前阶段边界**：已交付的 **M2** 支持单帧、单分量、单扫描（`ILV=0`、`Pt=0`）的 `P=2–16`、独立 `MAXVAL`、基于有效 `MAXVAL` 约束的合法 `NEAR`（`0..min(255, floor(MAXVAL/2))`）及自定义 `LSE ID=1`（`T1/T2/T3/RESET`），**是演进路线上的阶段版本，不是最终标准范围**。

## 3. 项目方向与通用性说明
参赛方向：**基础软件 / 开源编解码工具库与科学数据处理**。JPEG-LS 是无损及近无损高精度静态图像标准；MoonJLS 以单一纯 MoonBit 内核编译至 Native、JS 与 Wasm GC，可供命令行管道、浏览器科学工作台与 MoonBit 应用直接复用，无须重复维护多语言实现。

## 4. 三个预期使用场景
1. **科研与遥感高精度数据保存**：对 16 位月面高程图（如 NASA LOLA 1,036,800 样本实测）或工业灰度栅格做无损/有界近无损压缩，解码后按原始整数样本及物理标尺逐点核验误差上界（`≤ NEAR`）。
2. **大图有界流式管道处理**：通过 Native CLI（`encode`/`encode-pgm`/`decode`/`inspect`/`verify`）或 Web Worker 分块读写，在慢消费背压下按行交付、不缓存整图，并在 `EOI` 后严格拒绝尾随字节。
3. **MoonBit 图像应用生态集成**：通过 `ZSY2221/moon_jpegls` 包依赖及示例 `MoonImage Gray16` 适配器，使实际有效位数低于容器位宽（如 12 位存于 16 位容器）的图像按真实精度与 `MAXVAL` 编码交换。

## 5. 拟实现核心功能、现状与分阶段兼容路线
- **纯 MoonBit 核心模块（4,528 行 `.mbt`，100% 编解码数学与状态机位于 MoonBit）**：`core/{parameters,model,bits,markers,encoder,decoder,image}.mbt` + `cmd/{moonjls,bridge}` + 15 项三后端白盒测试。
- **已完成阶段（M0–M2）与实证**：M0（三后端基线与 3 处正确性修复）、M1（满量程 8/12/16 位 NEAR 640/640 互操作，非 M2 全参数穷举）、M2（2026-11-25 完成，`P=2–16`/独立 `MAXVAL`/自定义 `LSE1` 与科学工作台 3 大 Lab；核心两条预测行内存结论仅适用于当前单分量 profile）。三后端核心测试各 15/15；固定受测源码 `fc43bc2` 归档证据含 M2 独立合成矩阵 388 正例 + 18 LSE 变体 + 7 非法编码 + 6 Native PGM、Annex E `E.2-9`–`12` 三后端双向通过（12 次编码逐字节一致，`E.2-1`–`8` 对应未实现多分量返回 `UnsupportedFeature`）、NASA 1,036,800 样本与 Chrome 158 验收；CI 每次运行 12 组独立合成 HP/Annex A 黄金用例（不等同于官方 Annex E 12 项全部通过）及 640 历史回归；`0.1.0` 本地回环 registry 消费通过不等于 Mooncakes 公开发布（线上仍为 404）。
- **后续分阶段兼容路线（内部开发目标，赛事最终节点待组委会确认）**：
  - **M3-A（目标 2026-12-10）**：多分量与 `ILV=0` 多扫描、跨扫描 LSE 继承（验收 `E.2-1`、`E.2-4`）。
  - **M3-B（目标 2026-12-25）**：`ILV=1/2`、合法采样与边缘 MCU、`Pt` 及双尺度误差（验收 `E.2-2/3/5–8`）。
  - **M4（目标 2027-01-10）**：`LSE2/3` 映射表及续表、表规范与简略格式、`DRI/RST`、`DNL`、`LSE4` 与剩余标记。
  - **M5（目标 2027-01-20）**：完整 Part 1 符合性验收（Annex E 12/12、`§8.2`/`§8.3`、三后端一致、干净环境复现）。

## 6. 原创性与 AI 协作说明
本项目依托 ITU-T T.87 标准自行构建，**AI 编程助手（早期 Codex 与当前 Antigravity）直接参与了纯 MoonBit 编解码核心（`core/*.mbt`）、Native CLI、JS/Wasm GC 桥接、SDK、Worker、科学工作台、测试与验证脚本及文档的编写**。参赛者（`ZSY2221`）确定项目目标与标准路线，并对提交的最终成果承担质量责任；其中本人尚未逐项独立复核的代码细节与测试日志，待本人核对确认，不提前宣称已全部逐项人工审毕（详见 `submission/2026-11/07_AI_DEVELOPMENT_DISCLOSURE.md`）。

## 7. 参考来源与开源许可证
以 **ITU-T T.87（06/1998）** 英文正文为规范基线；外部独立验证采用 ITU 附件 **HP JPEG-LS 1.00**（`jlsrefV100.zip`）与 **CharLS 2.4.5 / Wasm 0.10.0**（仅测试对拍，运行时不链接 CharLS）。项目采用 **`BSD-3-Clause`** 许可证，详见 `LICENSE` 与 `THIRD_PARTY_NOTICES`。

## 8. GitHub 公开仓库、有效提交与复审入口
- 公开仓库（`main`）与审查 PR #1：`https://github.com/ZSY2221/moon_jpegls` · `https://github.com/ZSY2221/moon_jpegls/pull/1`（保留连续可追踪提交历史，远超 10 个有效 commits）
- 评审指南与标准矩阵：`docs/REVIEWER_GUIDE.md` · `docs/T87_CONFORMANCE_PLAN.md` · `docs/CONFORMANCE_RESULTS.md` · `docs/MOONBIT_IMPLEMENTATION_MAP.md`
