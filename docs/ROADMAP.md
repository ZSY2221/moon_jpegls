# MoonJLS 分阶段兼容路线（向完整 T.87 Part 1 演进）

本文档定义 MoonJLS 迈向完整 **ITU-T T.87（06/1998）/ ISO/IEC 14495-1 JPEG-LS Part 1** 的分阶段开发与验收路线，与 [T.87 标准能力矩阵与符合性计划](T87_CONFORMANCE_PLAN.md) 严格对齐。

> **重要说明**：下文 M3-A 至 M5 的日期均为项目内部工程开发目标，**不代表黑客松组委会已经认可或指定的最终赛事验收日期**；赛事评审节点与要求以组委会官方公告及沟通答复为准。

## 1. 最终标准目标

**MoonJLS 的最终目标是完整实现 ITU-T T.87（06/1998）/ ISO/IEC 14495-1 JPEG-LS Part 1 的编码、解码和数据格式能力**，涵盖基础交换格式（`§6`、`Annex A–D`）、表规范数据与简略图像格式（`§7(b)(c)`、`C.3–C.4`），并通过 `§8.2`/`§8.3` 与 Annex E 全部适用测试及三后端一致性验收。T.870 Part 2 与 DICOM 容器为独立扩展，SPIFF（`§4.8`/`Annex H.5`）按可选容器单独跟踪。

---

## 2. 已完成里程碑（M0 / M1 / M2 / M3-A）

### M0：初始工程与正确性基线 — **已完成**

- **交付物**：纯 MoonBit 核心编解码状态机、Native/JS/Wasm GC 三后端、流式 CLI、SDK 与 Worker 背压协议、科学工作台 UI，以及复审前 `16a7b49` 纳入的三处正确性修复（Native EOI 前逐行交付、Worker 输出载荷统计、核心 `q_lut` 载荷计数）。
- **验证证据**：三后端核心测试通过、Native 行交付与尾部矩阵通过、Chrome Worker 112 B 峰值 / 终态 0 B 通过。详见 [review-fix-20261125](../reports/review-fix-20261125/README.md) · [RC3 实测](../reports/rc3/README.md)。

### M1：合法 NEAR 扩展 — **已完成**

- **交付物**：在满量程 8/12/16 位、单分量单扫描灰度 profile 下，将合法 `NEAR` 扩展至 8 位 `0–127`、12/16 位 `0–255`。
- **验证证据**：原有满量程 8/12/16 位全部 **640 个 NEAR 组合** 在 Native、JS、Wasm GC 三后端完成固定版本 CharLS（2.4.5 / Wasm 0.10.0）双向互操作与逐样本比对（**640/640**）；浏览器工作台验证高 NEAR 样本读数、误差热图、下载与取消重启。详见 [review-near-20261125](../reports/review-near-20261125/README.md)。
- **范围注记**：该 640 组属于满量程 8/12/16 位 NEAR 回归，不等同于 M2/M3-A 全部参数空间的完整笛卡尔积。

### M2：完整数值域与预置参数 — **已完成（2026-11-25）**

- **交付物**：在单帧、单分量、单扫描、`ILV=0`、`Pt=0` 下支持 **`P=2–16` 编码精度、独立 `MAXVAL`（`1..2^P−1`）、基于有效 `MAXVAL` 约束的合法 `NEAR`（`0..min(255, floor(MAXVAL/2))`）、以及真正参与编解码的 `LSE ID=1` 自定义 `T1/T2/T3/RESET`**；Native/SDK/Worker/工作台（Precision Lab、Streaming Lab、Compatibility Lab）与验证工具链全链路透传解析后的实际参数。详见 [M2 验收总结](../reports/t87-m2-20261125/README.md) · [合成矩阵说明](../reports/t87-m2-20261125/synthetic-matrix.md)。

### M3-A：多分量与非交错多扫描 — **已完成（2026-11-25，受测源码 `36bb9e6`）**

- **交付物**：在单帧、`H=V=1`、`ILV=0`（每扫描 `Ns=1`）、`Pt=0` 下完整实现纯 MoonBit **多分量（1–255）非交错多扫描 JPEG-LS**：帧级 `FrameInfo` 与扫描级 `ScanSpec`/`ScanInfo`/上下文及位流状态完全隔离；按 ID 分量表与合法重排扫描次序支持（拒绝重复、遗漏、未知分量、提前 `EOI` 及终扫描后无后续 `SOS` 的 `lse-after-scan` 归类为 `InvalidData`）；跨扫描保留原始 `LSE1` 与零默认字段语义并按每扫描 `NEAR`/`MAXVAL` 重算默认阈值；打通 Native 零宿主缓冲 planar 流式入口（`encode-planar`/`encode-pgms`/`decode-pgms`）与显式计费 P6 PPM 转换、SDK `encodePlanarImage`/`decodePlanarImage`/`inspectStream`、Worker `scanComplete`/`structure`/`rowMeta` 及科学工作台多通道视图与 Scan Structure Inspector。
- **验证证据**：
  1. 三后端核心 MoonBit 测试各 **18/18** 通过（`--deny-warn`）；
  2. 官方 Annex E **`E.2-1`**（`T8C0E0.JLS`）、**`E.2-4`**（`T8C0E3.JLS`）及 **`E.2-9`–`E.2-12`**（共 **6/12** 适用官方流）在 Native、JS、Wasm GC 三后端通过 HP JPEG-LS 1.00 与 CharLS Wasm 0.10.0 双独立参考双向验收，全部 18 次候选编码与官方 `.JLS` 逐字节一致（`E.2-2, 3, 5, 6, 7, 8` 交错/子采样流按范围返回 `UnsupportedFeature`）；
  3. M3-A 独立合成多扫描黄金矩阵（[`scripts/verify_m3a_golden.mjs`](../scripts/verify_m3a_golden.mjs)：7 正例 + 7 负例 + CharLS Wasm 交叉核对）、M2 黄金回归（[`scripts/verify_m2_golden.mjs`](../scripts/verify_m2_golden.mjs)：12 正例 + 18 变体 + 7 非法编码 + 4 PGM）、388 组 M2 全量矩阵及 Native 跨扫描首分量实时行交付回归（[`native_multiscan_delivery_regression.py`](../REVIEW_EVIDENCE/native_multiscan_delivery_regression.py)）全部通过；
  4. Chrome 158 科学工作台多通道/Scan Inspector 验证与 Worker/TS 检查通过。
  详见 [M3-A 验收汇总](../reports/t87-m3a-20261125/README.md) · [Annex E 逐项结果](CONFORMANCE_RESULTS.md)。

---

## 3. 后续开发路线（内部开发目标，含退出条件与风险说明）

| 阶段 | 状态 / 内部目标日期 | 核心交付范围 | 首要验收与退出条件 | 风险与替代方案 |
| --- | --- | --- | --- | --- |
| **M3-B：交错与采样** | **2026-11-26 已验收** | `ILV=1/2`、H/V 采样、边缘 MCU、分量几何及流式交付 | 同一候选通过 Annex E 12/12 三后端双向验收。完整旧回归及浏览器 smoke 已通过 | CharLS Wasm 对 E.2-7/8 的采样模式为 `reference_unsupported`。官方采样流由 HP 1.00 独立验收 |
| **Pt 专项** | 独立分支，部分验收 | 实现非零 `Pt` 的正逆变换。分别报告变换域 NEAR 与原始域误差 | 通过独立 `Pt>0` 向量。官方 Annex E 全部使用 `Pt=0` | 若现有参考缺少支持，使用可审计的标准短向量或第二实现 |
| **M4：完整码流格式和状态扩展** | 规划中<br>目标：**2027-01-10** | `LSE ID=2` 映射表与 `LSE ID=3` 续表；表规范数据流（`§7(b)`、`C.3`）；简略图像格式（`§7(c)`、`C.4`）与解码器外部表生命周期；`DRI` 与 `RST0–RST7` 重启状态复位；`DNL` 延后高度；`LSE ID=4` 扩展尺寸与溢出/配额分离；剩余位置标准标记语法 | 编码状态、解码状态、数据格式状态均具备可复跑测试：包括正常与缺失/错配 `TID/Wt` 续表、重定义表、跨重启区间分块断点、延后 `DNL` 与扩展尺寸合法/超限区分 | 表规范/简略流与 `LSE4` 可能缺乏现成 Wasm 裁判，需以官方 HP 工具适用子集 + 独立构造 Annex C 向量验证，并在必要时将 `DRI/DNL` 与 `LSE2/3` 拆批冻结 |
| **M5：完整 Part 1 符合性验收** | 规划中<br>目标：**2027-01-20** | 官方 Annex E `E.2-1` 至 `E.2-12` 全部双向通过；T.87 `§8.2` 编码与 `§8.3` 解码全覆盖；适用独立参考实现与跨后端一致；全量能力矩阵无未完成项；独立干净环境全流程复现；发布候选与文档定稿 | [T.87 能力矩阵](T87_CONFORMANCE_PLAN.md) 中所有 Part 1 必选条目的编码、解码、格式状态均达到 `passed`，CI 与独立环境零人工修补可复现；如届时仍有单项缺口，严格保留阶段标签而不提前宣称完整 Part 1 达成 | 若组委会正式验收节点早于或晚于 2027-01-20，将在收到官方确认后第一时间按剩余矩阵工作量同步重排并在仓库公开标注 |

---

## 4. 工程协作与分工机制

- **当前执行助手（Codex）**：接续 Antigravity 的 M3-A 和首版行交错工作，完成样本交错、采样、验证和公开交付。[开发记录](../submission/2026-11/07_AI_DEVELOPMENT_DISCLOSURE.md)
- **项目负责人（参赛者 `ZSY2221`）**：负责最终技术决策、标准边界确认、Pull Request 审核合并、GitHub 仓库治理、正式包发布授权以及赛事报名与复审最终提交。
- **工程防线**：每进入新阶段先建立独立期望与失败用例再改动核心；前端与 SDK 严格仅暴露已实测支持的能力，绝不伪造未实现能力的结果或状态。
