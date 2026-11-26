# MoonJLS — T.87 Part 1 最终目标、能力矩阵与验收基准

> 本文档是 MoonJLS 标准能力范围、分阶段兼容状态与验收退出条件的**唯一权威定义来源（Single Source of Truth）**。状态核对日期：2026-11-25。

## 1. 赛事初审反馈回应与标准终点

针对 2026 年 11 月黑客松初审提出的审核意见（认可高位深科研图像应用价值、纯 MoonBit 编解码及流式状态管理贡献，但指出此前仅确立受限 JPEG-LS 子集、后续计划未明确完整 T.87 符合性目标），项目正式明确如下最终标准承诺：

**MoonJLS 的最终目标是完整实现 ITU-T T.87（06/1998）/ ISO/IEC 14495-1 JPEG-LS Part 1 的编码、解码和数据格式能力，并通过 T.87 §8、Annex E 及独立参考实现逐项验收。**

**当前 M3-B 在 M2 和 M3-A 基础上交付 `ILV=1/2`、H/V 采样和边缘 MCU。完整 Part 1 的剩余能力及其退出条件列在下方矩阵。**

标准条款基线为 ITU-T T.87（06/1998）英文正文，ISO 对应版本为 ISO/IEC 14495-1:1999 第 1 版（含 2000-09 更正版）。后续若纳入勘误或后续标准补充，将逐项记录差异及影响。[ITU-T T.87 官方文本](https://www.itu.int/rec/T-REC-T.87-199806-I/en) · [ISO 标准条目](https://www.iso.org/standard/22397.html)

### 1.1 完整 T.87 Part 1 最终目标拆解

1. **A. 基础交换格式（Interchange Format）**：
   - 完整 JPEG-LS 帧、分量、扫描与码流组织（单扫描与多扫描混合组织）；
   - `SOI`、`SOF55`、`SOS`、`EOI` 及标准允许位置的其他标记语法（`APPn`、`COM`、填充与结构校验）；
   - 标准允许的全部编码精度 `P=2–16` 与独立 `MAXVAL`（`1..2^P−1`）；
   - 常规模式（Regular）、游程模式（Run）、游程中断模式（Run interruption）；
   - Golomb-Rice 熵编解码与 `0xFF` 后一位填充；
   - `LSE ID=1` 预设参数（默认值、零字段与合法自定义 `MAXVAL/T1/T2/T3/RESET` 跨扫描语义）；
   - 多分量与多扫描（`SOF55` 分量集、独立 `SOS`、重复/遗漏/错序检查）；
   - 全部三种交错模式 `ILV=0`（非交错）、`ILV=1`（行交错）、`ILV=2`（样本交错）；
   - 水平/垂直采样因子（`H/V`）与边缘 MCU 处理；
   - 点变换（Point transform `Pt`）正逆变换与误差尺度语义；
   - `LSE ID=2` 映射表与 `LSE ID=3` 映射表续表；
   - 重启间隔 `DRI` 与 `RST0–RST7` 标记与状态复位；
   - 延后行数 `DNL`（`C.2.6`）；
   - 扩展图像尺寸 `LSE ID=4`（`C.2.4.1.4`）。
2. **B. 简略格式与表规范数据（Abbreviated Formats & Table-Specification Data）**：
   - `LSE ID=2` 映射表定义与重定义；
   - `LSE ID=3` 映射表续表拼接、缺失与生命周期管理；
   - 仅含表规范数据的简略流（`§7(b)`、`C.3`）；
   - 引用外部已装载映射表的简略图像格式（`§7(c)`、`C.4`）；
   - 解码器外部表加载、保持与校验生命周期；
   - 对应的编码输出与解码还原能力（满足 `§6` 交换/简略双格式支持与 `§7(a)(b)(c)` 解码器全部三项义务）。
3. **C. 最终符合性验收（Final Conformance）**：
   - T.87 `§8.2` 编码符合性测试（`NEAR=0` 逐样本相等、`NEAR>0` 与参考解码器同配置重建一致，及熵编码数据段校验）；
   - T.87 `§8.3` 解码符合性测试（逐样本核对官方重建或源图）；
   - Annex E Table E.2 全部 12 项适用官方测试（`E.2-1` 至 `E.2-12`）；
   - 能力经核实的独立参考实现（HP JPEG-LS 1.00、固定版本 CharLS 与独立 Annex A 推导向量）；
   - JS、Wasm GC、Native 三后端输出及重建逐字节/逐样本一致性；
   - 非法码流、截断码流、越界参数与边界条件（含极大/极小 `MAXVAL`、`RESET=65535` 等）；
   - 流式终结、`EOI` 精确消费位置与严格尾随字节拒绝。

### 1.2 标准边界严格区分（不混淆 Part 1 与扩展容器）

| 规范名称 | 与本项目的关系 | 说明 |
| --- | --- | --- |
| **ITU-T T.87 / ISO/IEC 14495-1（JPEG-LS Part 1）** | **本项目最终必须完整实现的标准目标** | 涵盖上述 A、B、C 全部核心编解码、交换格式、简略/表格式与符合性 |
| **ITU-T T.870 / ISO/IEC 14495-2（JPEG-LS Part 2）** | **独立后续扩展，不属于 Part 1 必需范围** | 算术扩展、改进游程等属于 Part 2 扩展，不混称为 Part 1 必需项 |
| **DICOM 容器封装** | **应用层独立扩展，不属于 Part 1 必需范围** | 传输语法封装与医疗标签由上层应用扩展负责 |
| **SPIFF（T.87 §4.8 & Annex H.5）** | **标准推荐的可选容器格式，单独说明与规划** | Part 1 核心矩阵验证 Annex C 基础码流与标记；SPIFF 作为独立可选容器在后续按需评估 |

---

## 2. 当前 M3-A 已交付基线与证据边界

- **已完成阶段**：M0（基础引擎、三后端与 3 处正确性修复）、M1（满量程 8/12/16 位合法 `NEAR` 扩展）、M2（`P=2–16`、独立 `MAXVAL`、合法 `NEAR`、`LSE ID=1` 自定义预设）、**M3-A**（多分量非交错多扫描 `ILV=0, Ns=1, H=V=1, Pt=0`：支持 `2/3/4+` 分量、非连续 ID 与合法扫描重排、跨扫描 `LSE1` 零默认重载、Native planar 流式与多通道工作台/扫描结构检查器）。
- **最新核心受测与归档修订**：[`36bb9e6a77bd38db6806a0cc5047885b694276b5`](https://github.com/ZSY2221/moon_jpegls/commit/36bb9e6a77bd38db6806a0cc5047885b694276b5)（完整复测收据归档于 `reports/t87-m3a-20261125/`；历史 M2 受测基线 `fc43bc2b4ed69cad9d967e63c2019ff1e8f3be44` 与证据冻结提交 `a7d8c39` 完整保留）。
- **核心验证与历史回归边界（严禁混淆口径）**：
  1. 三后端核心 MoonBit 白盒测试各 **18/18** 通过（Native WSL `--deny-warn` 0 警告 / JS / Wasm GC）；Worker 协议 **20/20**、Node 测试 **21/21**、SDK 类型检查 `tsc --noEmit` 全部通过。
  2. M3-A 独立黄金回归（[`scripts/verify_m3a_golden.mjs`](../scripts/verify_m3a_golden.mjs)，`tests/conformance/m3a_golden/` 共 21 个冻结文件）：**7 正例 + 7 负例** 在三后端与 CharLS Wasm（`21 backendChecks + 2 oracleChecks`）全部通过，覆盖 2/3/4 分量、非连续 ID/重排、跨扫描 `LSE1` 零默认重解析、逐扫描 `NEAR` 变化及错序/重复/缺漏/未知/早 EOF 拒收。
  3. M2 本机独立合成矩阵：**388 组 M2 新增正例**（HP JPEG-LS 1.00 及 `MAXVAL=1/2` 独立 Annex A 推导向量）+ **18 个 LSE 码流变体**（5 有效 + 13 拒绝）+ **7 个非法编码用例** + **6 项 Native PGM 检查**，三后端通过（`826 SDK / 413 Native / 388 reciprocal`）。
  4. GitHub Actions CI 固定黄金回归（[`scripts/verify_m2_golden.mjs`](../scripts/verify_m2_golden.mjs) 与 `verify_m3a_golden.mjs`）：每次 push/PR 实跑 M2 冻结黄金回归（**12 正例 + 18 LSE 变体 + 7 非法编码 + 4 Native PGM**；注：`lse-after-scan` 已依据 HP `nlocod.exe` 与 CharLS Wasm 实际行为校准为 `InvalidData`）及 M3-A **7+7** 黄金回归（注：黄金回归不等同于官方 Annex E 12 项全部通过）。
  5. **640 组 NEAR 回归口径澄清**：[`scripts/validate.py`](../scripts/validate.py) `--near-matrix`（`imagecodecs 2026.11.11 / CharLS 2.4.5` 与 `@team-charls/charls-wasm 0.10.0`）**640/640** 双向回归仅覆盖**单分量满量程 8 位（`NEAR=0–127`）与 12/16 位（`NEAR=0–255`）**的合法 `NEAR` 组合（`5,120 SDK + 3,200 Native = 8,320` 核对），**不是** `P=2–16 × 任意 MAXVAL × 多分量 × 自定义 LSE1` 全部参数空间的完整笛卡尔积。
  6. **Annex E Table E.2 口径澄清**：[`scripts/validate_annex_e.mjs`](../scripts/validate_annex_e.mjs) 对 HP 1.00 与 CharLS Wasm 实测 **6/12 通过**（`E.2-1`、`E.2-4` 与 `E.2-9` 至 `E.2-12`，18 次候选编码与官方 `.JLS` 逐字节一致）；其余 6 项（`E.2-2/3/5/6/7/8`，涉及 `ILV=1/2` 与子采样）解码按预期返回 `expected_unsupported`、`encode_status = not_run`。
  7. **Native 流式与工作台实测**：Native 逐行交付、多扫描分块交付（`96x48` 16 位 3 分量与 `64x16` 8 位 4 分量，含扫描尾部合法性拒收）及 Chrome `158.0.8127.37` 对 `web/dist/` 无报错冒烟与 1,036,800 样本 NASA LOLA 核对均归档于 `reports/t87-m3a-20261125/`。

---

## 3. T.87 Part 1 逐项能力与退出条件矩阵（唯一权威矩阵）

状态取值规则（无独立验证证据时，绝不标为 `passed`）：
- `passed`：已实现且具备独立参考或规范向量复跑证据，并附带真实测试编号与报告路径。
- `partially_supported`：仅覆盖子集、单边能力或尚缺完整独立证据。
- `recognized_only`：解析器可识别标记语法并按范围拒绝（返回 `UnsupportedFeature` 等明确错误），尚未支持编解码路径。
- `unsupported`：当前拒绝或未实现。
- `not_run`：尚未执行对应验证用例。
- `planned`：已纳入分阶段路线目标，尚未实现。

| 能力 | 标准条款 | 编码状态 | 解码状态 | 数据格式状态 | 对应测试编号 | 参考实现 | 独立证据 | 三后端执行结果 | 未解决问题 / 目标阶段与提交 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 单分量基础熵编解码（常规、游程、游程中断、位填充） | Annex A；C.2 | `passed` | `passed` | `passed` | `core/*_wbtest.mbt`（15 项）、`P1-640`、`E.2-11`、`E.2-12` | HP V.1.00；CharLS 2.4.5 & Wasm 0.10.0 | [VALIDATION](VALIDATION.md) · [M1 证据](../reports/review-near-20261125/README.md) · [Annex E](CONFORMANCE_RESULTS.md) | JS / Wasm GC / Native 全部通过 | M0/M1 已完成；受测核心 [`fc43bc2`](https://github.com/ZSY2221/moon_jpegls/commit/fc43bc2b4ed69cad9d967e63c2019ff1e8f3be44) |
| 样本编码精度 `P=2–16` | §4.3.2；C.2.2 | `passed` | `passed` | `passed` | `scripts/test_m2.py`（388 组）；`scripts/verify_m2_golden.mjs`（CI 12 组） | HP V.1.00（适用范围）及独立 Annex A 向量（`MAXVAL=1,2`） | [M2 合成矩阵](../reports/t87-m2-20261125/synthetic-matrix.md) · [CI 黄金夹具](../tests/conformance/m2_golden/README.md) | JS / Wasm GC / Native 编码逐字节一致、重建一致 | M2 已完成；受测核心 `fc43bc2`，CI 固定回归见本分支 |
| 显式独立 `MAXVAL`（`1..2^P−1`）与非法值拒绝 | C.2.3；C.2.4.1.1、Table C.1 | `passed` | `passed` | `passed` | `scripts/test_m2.py`；`scripts/verify_m2_golden.mjs`；7 个非法编码用例 | HP V.1.00（`MAXVAL≥3`）及独立 Annex A 向量（`MAXVAL=1,2`） | [M2 合成矩阵](../reports/t87-m2-20261125/synthetic-matrix.md) | JS / Wasm GC / Native 全部通过 | M2 已完成；HP 工具不支持 `MAXVAL 1/2`，由 Annex A 独立推导向量覆盖 |
| 满量程 8/12/16 位合法 `NEAR`（8 位 0–127；12/16 位 0–255） | Annex A；C.2.3 | `passed` | `passed` | `passed` | `P1-640`（历史 640/640 回归） | CharLS 2.4.5 & CharLS Wasm 0.10.0 | [640 组实跑](../reports/review-near-20261125/README.md) · [M2 复跑汇总](../reports/t87-m2-20261125/p1-near-regression.json) | JS / Wasm GC / Native 全部通过 | M1 已完成、M2 复跑通过（仅限满量程 8/12/16 位，非 M2 全笛卡尔积） |
| 按有效 `MAXVAL` 约束 `NEAR`（`0..min(255, floor(MAXVAL/2))`） | Annex A；C.2.3 | `passed` | `passed` | `passed` | `scripts/test_m2.py`；`scripts/verify_m2_golden.mjs`；`lse-near-over-maxval` | HP V.1.00 及 Annex A 向量 | [M2 合成矩阵](../reports/t87-m2-20261125/synthetic-matrix.md) | JS / Wasm GC / Native 全部通过 | M2 已完成；`fc43bc2` |
| `LSE ID=1` 默认/零字段与自定义 `T1/T2/T3/RESET` | C.2.4.1.1、Tables C.1–C.2 | `passed` | `passed` | `passed` | `E.2-9`、`E.2-10`、`scripts/test_m2.py`、`scripts/verify_m2_golden.mjs`、`scripts/verify_m3a_golden.mjs` | 官方 HP 1.00、CharLS Wasm 0.10.0 | [Annex E 结果](CONFORMANCE_RESULTS.md) · [M3-A 汇总](../reports/t87-m3a-20261125/README.md) | JS / Wasm GC / Native 全部通过 | M2 单扫描与 M3-A 跨扫描继承/零重置均已验收 |
| 多分量与非交错多扫描（`ILV=0`, `Ns=1`, `H=V=1`, `Pt=0`） | Annexes B、C、D | `passed` | `passed` | `passed` | `E.2-1`、`E.2-4`、`scripts/verify_m3a_golden.mjs`（7+7）、`multiscan_wbtest.mbt`、`native_multiscan_delivery_regression.py` | HP 1.00 & CharLS Wasm 0.10.0（E.2-1/4 及 3 通道黄金流） | [Annex E 结果](CONFORMANCE_RESULTS.md) · [M3-A 验收](../reports/t87-m3a-20261125/README.md) · [能力清单](../tests/conformance/manifest.json) | JS / Wasm GC / Native 全部通过（E.2-1/4 逐字节一致；首分量不等待后续 SOS/EOI） | **M3-A 已完成（`36bb9e6`）**；支持 1–255 分量、非连续 ID、重排扫描、严格负拓扑 |
| 交错模式 `ILV=1`（行交错）与 `ILV=2`（样本交错），`H=V=1, Pt=0` | Annex B.1–B.3；C.2.3；C.2.4.1.1 | `passed` | `passed` | `passed` | `E.2-2/3/5/6` | HP 1.00 和 CharLS Wasm 0.10.0 | [Annex E 结果](CONFORMANCE_RESULTS.md) | JS / Wasm GC / Native 双向逐样本符合双参考，每条候选与官方流逐字节一致 | **M3-B 已验收** |
| 采样因子（`H/V`）与边缘 MCU | §4.3.1、Annex B.2/B.4、C.2、Annex E | `passed` | `passed` | `passed` | E.2-7/8 与奇数尺寸、短行组、补行字面量 | HP 1.00 验收 E.2-7/8。CharLS Wasm 0.10.0 的采样模式为 `reference_unsupported` | [Annex E 结果](CONFORMANCE_RESULTS.md) | 三后端双向逐样本匹配适用参考。奇数尺寸和末组补行另有定向用例 | **M3-B 已验收** |
| 无映射点变换 `Pt`（正逆变换与双尺度误差） | §4.3.2；C.2.3；T.81 B.2.3 | `passed` | `passed` | `passed` | `verify_point_transform.mjs`、`verify_sampled_point_transform.mjs`、Native 与浏览器宽输出 | FFmpeg 适用单分量，CharLS 编码域，官方采样向量校准的独立 Python 参考 | [Pt 专项](POINT_TRANSFORM_RESULTS.md) | 三后端通过，混合扫描 Native CLI 编码范围单列 | 窄输出超限显式拒绝。非零 Pt 的映射选择器为零，Annex E 全部使用 Pt=0 |
| `LSE ID=2` 映射表与 `LSE ID=3` 映射表续表 | C.2.4.1.2–3 | `unsupported` | `unsupported` | `recognized_only` | 待建有效与截断/缺失续表用例 | 待确定适用参考工具与独立向量 | 无运行证据 | `not_run` | 解析器仅识别分段长度后拒绝；缺表结构、条目宽度与重定义管理；目标 **M4（2027-01-10）** |
| 表规范数据与简略图像格式 | §7(b)(c)；C.3、C.4 | `unsupported` | `unsupported` | `planned` | 待建跨流外部表生命周期用例 | 待确定适用参考工具与独立向量 | 无运行证据 | `not_run` | 需实现无帧表加载、保持、校验与简略图像编码/解码；目标 **M4（2027-01-10）** |
| 重启间隔 `DRI` 与 `RST0–RST7` 标记 | C.2.5；Annex D | `unsupported` | `unsupported` | `recognized_only` | 待建重启间隔与错序/损坏用例 | 需按间隔与交错模式核实参考库 | 无运行证据 | `not_run` | 解码仅接受 `DRI=0`；非零 `DRI`、编号循环及上下文复位待实现；目标 **M4（2027-01-10）** |
| 延后行数 `DNL` | C.2.2；C.2.6 | `unsupported` | `unsupported` | `recognized_only` | 待建 `height=0 + DNL` 用例 | 待确定适用参考工具 | 无运行证据 | `not_run` | 尚未支持未知高度帧与扫描后 `DNL` 定界；目标 **M4（2027-01-10）** |
| 扩展尺寸 `LSE ID=4` | C.2.2；C.2.4.1.4 | `unsupported` | `unsupported` | `recognized_only` | 待建 `LSE4` 正常、溢出与资源上限用例 | 待确定独立向量 | 无运行证据 | `not_run` | 需区分配额资源上限与标准合法尺寸；目标 **M4（2027-01-10）** |
| 剩余标准标记位置与尾随/填充语法（`APPn`、`COM`、`FF` 填充） | Annex C 及所引 T.81 | `partially_supported` | `partially_supported` | `partially_supported` | `core/stream_wbtest.mbt`、`lse-after-scan`、`lse-after-eoi` | 定向标记与截断夹具 | [M2 合成矩阵](../reports/t87-m2-20261125/synthetic-matrix.md) | JS / Wasm GC / Native 已测当前已支持位置 | 多扫描间/表流/重启位置标记将在 M3-A/M3-B/M4 补全；目标 **M4（2027-01-10）** |
| 完整 Part 1 符合性闭环验收 | §§6–8；Annex E | `partially_supported` | `partially_supported` | `partially_supported` | `E.2-1` 至 `E.2-12` + §8 补充矩阵 | 官方 Annex E + 经核实参考工具 | [Annex E 结果](CONFORMANCE_RESULTS.md) · [能力清单](../tests/conformance/manifest.json) | 12/12 官方流三后端双向通过，Part 1 补充矩阵待完成 | 目标 **M5（2027-01-20）** 完成全矩阵闭环；在此之前最终完整标签保持未达成 |

> 上表 **M3-A（非交错多分量/多扫描，已于 2026-11-25 提前交付）** 与后续 **M3-B（交错与采样已验收）** 与 [分阶段兼容路线](ROADMAP.md) 及 [机器可读能力清单](../tests/conformance/manifest.json) 保持完全一致。

---

## 4. 完整标准下不能沿用的简化承诺

### 4.1 原始数值误差（引入 `Pt` 与映射表后）

当前 `Pt=0`、无映射表的 profile 可直接按原始无符号整数样本验证 `|reconstructed − original| ≤ NEAR`。

Pt 专项分别核验变换编码域与原始样本尺度。对于无映射表路径，记步长 `s = 2^Pt`，样本 `x = s·q + r`（`0 ≤ r < s`）；若编码域满足 `|q̂ − q| ≤ NEAR`，则重建回原始尺度后保守误差界为 **`s · NEAR + s − 1`**（此为数学推导上界，存在映射表时不适用；`Pt > 0` 即使 `NEAR=0` 也因量化截断而不保持原始样本绝对无损）。

### 4.2 流式输出与内存核算

多分量模式需按分量行或 MCU 定义行交付粒度。对于 `ILV=0` 的连续多扫描码流，第 1 分量与第 2/3 分量先后到达；若宿主（例如浏览器）需要合成为完整像素行再展示，必须单独统计宿主或外部拼接缓存，不能继续将所有模式简称为“仅持有两条灰度预测行”。`core.workspace_bytes()`、宿主预览缓存、Worker 中转队列与外部表存储需始终分离记账。

系统可声明有界配置资源上限（`Limits`）。当合法超大图超出配置上限时，返回明确的资源受限错误（`ResourceLimit`），不得将其伪报为非法标准码流（`InvalidData`），也不将“按资源上限拒绝”计为完成该扩展尺寸格式的验收。

---

## 5. 符合性证据与通过规则

1. **逐项证据原则**：绝不用测试总数、单次覆盖率或单一版本标签替代整个 T.87 标准范围。
2. **官方数据与满量程覆盖**：§8 与 Annex E 官方测试需固定用例编号与 SHA-256。官方 `TEST16.PGM` 有效精度为 12 位，真正满量程 16 位需保留独立合成全量程用例。
3. **参考库能力界定**：CharLS（2.4.5 / Wasm 0.10.0）与 HP 1.00 各自存在已记录的实现限制（例如 HP 拒绝 `MAXVAL 1/2` 且低 `MAXVAL` 隐式默认阈值偏离 T.87 公式；CharLS 对部分自定义 `MAXVAL` 与满量程耦合）。参考库支持的配置执行双向互操作，其不支持或有差异的配置须采用经推导或另一合格独立参考，严禁以“参考库不支持”代指本项目已通过。
4. **§8.2 / §8.3 判定口径**：§8.2 编码测试由独立参考解码器解码 MoonJLS 输出，要求 `NEAR=0` 等于原图、`NEAR>0` 等于参考解码器对官方压缩流的重建，并核对编码段；§8.3 解码测试直接输入官方流并与官方参考重建逐样本比对。
5. **三后端与流式契约**：所有已声明支持项需持续在 JS、Wasm GC、Native 三后端验证，并覆盖分块切分、`EOI` 精确消费、严格尾随拒绝、背压 ACK 与取消语义。
6. **单边通过标注**：仅编码或仅解码通过时必须分列状态，不得整行标注 `passed`；只要存在未完成项，完整 Part 1 最终符合性保持未达成。

---

## 6. 参考来源

- ITU-T T.87 官方目录与参考材料：https://www.itu.int/rec/T-REC-T.87-199806-I/en
- ISO/IEC 14495-1 标准记录：https://www.iso.org/standard/22397.html
- JPEG 委员会 JPEG-LS 标准工作分工：https://jpeg.org/jpegls/workplan.html
- CharLS 官方仓库及实现说明：https://github.com/team-charls/charls
- DICOM JPEG-LS 封装规范：https://dicom.nema.org/medical/dicom/current/output/chtml/part05/sect_F.2.html
- 本项目 M2 实际产品范围：[`SCOPE.md`](SCOPE.md) · [`CONFORMANCE_RESULTS.md`](CONFORMANCE_RESULTS.md)
