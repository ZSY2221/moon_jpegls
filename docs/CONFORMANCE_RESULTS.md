# T.87 Annex E 与 M2 / M3-A / M3-B 独立验证结果

截至 **2026-11-26**，固定候选 [1b2d959](https://github.com/ZSY2221/moon_jpegls/commit/1b2d959015d15717b972c5a8bac35178b418d2d6) 在 Native、JS、Wasm GC 三后端完成官方 **Annex E Table E.2 12/12** 双向验收。HP 1.00 独立复验全部 12 条，CharLS Wasm 0.10.0 独立复验其中 10 条。E.2-7/8 的 CharLS 采样能力为 `reference_unsupported`。 [HP 全部用例](../reports/t87-m3b-20261126/annex-e-final-hp.json) · [CharLS 适用用例](../reports/t87-m3b-20261126/annex-e-final-charls.json) · [CharLS 采样能力](../reports/t87-m3b-20261126/annex-e-final-charls-sampling.json)

## 1. 官方 Annex E Table E.2 逐项结果（全部 12 条流）

| 用例 | 官方码流 | P / NEAR | 数据路径与标准特征 | 编码（JS / Wasm GC / Native） | 解码（JS / Wasm GC / Native） | 里程碑状态 |
| --- | --- | --- | --- | --- | --- | --- |
| **E.2-1** | `T8C0E0.JLS` | 8 / 0 | 三分量、分离扫描（`ILV=0`） | **`passed`**（`102,248 B`，3 后端编码均与官方流 `8c564fbd...` 逐字节一致） | **`passed`**（`196,608` 样本与原图/参考完全一致，maxErr=0） | **M3-A 已验收** |
| **E.2-2** | `T8C1E0.JLS` | 8 / 0 | 三分量、行交错（`ILV=1`） | **`passed`**（`100,615 B`，三后端与官方流逐字节一致） | **`passed`**（`196,608` 样本与双参考一致，原图最大误差 0） | **M3-B 交错已验收** |
| **E.2-3** | `T8C2E0.JLS` | 8 / 0 | 三分量、样本交错（`ILV=2`） | **`passed`**（`99,734 B`，三后端与官方流逐字节一致） | **`passed`**（`196,608` 样本与双参考一致，原图最大误差 0） | **M3-B 交错已验收** |
| **E.2-4** | `T8C0E3.JLS` | 8 / 3 | 三分量、分离扫描（`ILV=0`） | **`passed`**（`63,645 B`，maxErr=3，3 后端编码均与官方流 `6356737d...` 逐字节一致） | **`passed`**（`196,608` 样本与参考一致，maxErr=3） | **M3-A 已验收** |
| **E.2-5** | `T8C1E3.JLS` | 8 / 3 | 三分量、行交错（`ILV=1`） | **`passed`**（`63,005 B`，三后端与官方流逐字节一致） | **`passed`**（`196,608` 样本与双参考一致，原图最大误差 3） | **M3-B 交错已验收** |
| **E.2-6** | `T8C2E3.JLS` | 8 / 3 | 三分量、样本交错（`ILV=2`） | **`passed`**（`62,300 B`，三后端与官方流逐字节一致） | **`passed`**（`196,608` 样本与双参考一致，原图最大误差 3） | **M3-B 交错已验收** |
| **E.2-7** | `T8SSE0.JLS` | 8 / 0 | 三分量、H/V 采样与行交错 | **`passed`**（`51,781 B`，三后端与官方流逐字节一致） | **`passed`**（`98,304` 样本与 HP 一致，原图最大误差 0） | **M3-B 采样已验收** |
| **E.2-8** | `T8SSE3.JLS` | 8 / 3 | 三分量、H/V 采样与行交错 | **`passed`**（`32,231 B`，三后端与官方流逐字节一致） | **`passed`**（`98,304` 样本与 HP 一致，原图最大误差 3） | **M3-B 采样已验收** |
| **E.2-9** | `T8NDE0.JLS` | 8 / 0 | `TEST8BS2`，`T1=T2=T3=9, RESET=31` | **`passed`**（`9,421 B`，maxErr=0，3 后端与官方流逐字节一致） | **`passed`**（`16,384` 样本与参考一致） | **M2/M3-A 已验收** |
| **E.2-10** | `T8NDE3.JLS` | 8 / 3 | `TEST8BS2`，`T1=T2=T3=9, RESET=31` | **`passed`**（`6,111 B`，maxErr=3，3 后端与官方流逐字节一致） | **`passed`**（`16,384` 样本与参考一致） | **M2/M3-A 已验收** |
| **E.2-11** | `T16E0.JLS` | 12 / 0 | `TEST16`，有效精度 12 位，默认预设 | **`passed`**（`60,077 B`，maxErr=0，3 后端与官方流逐字节一致） | **`passed`**（`65,536` 样本与参考一致） | **M2/M3-A 已验收** |
| **E.2-12** | `T16E3.JLS` | 12 / 3 | `TEST16`，有效精度 12 位，默认预设 | **`passed`**（`42,189 B`，maxErr=3，3 后端与官方流逐字节一致） | **`passed`**（`65,536` 样本与参考一致） | **M2/M3-A 已验收** |

## 2. 实跑细节、历史初次失败与 `lse-after-scan` 归类变更

- **§8.2** 以官方 PGM/PPM 原图编码，独立解码每份候选流。NEAR=0 比对原图。NEAR>0 比对同一参考对官方流的重建，并核对与原图的误差界。36 份候选码流均与对应官方文件逐字节一致。
- **§8.3** 直接解码 SHA-256 核验后的官方码流。三后端逐样本匹配 HP，CharLS 在其支持的十条用例中得出相同结果。E.2-7/8 均有 448 个有效分量行、98,304 个有效样本。
- **覆盖范围**。Annex E 全部使用 Pt=0。映射表、简略和表规范格式、重启、DNL、扩展尺寸等阶段仍由 [标准计划](T87_CONFORMANCE_PLAN.md) 跟踪。早期 10/12 和 6/12 保留原始记录。 [M3-B 交错候选](../reports/t87-m3b-20261126/annex-e-hp.json) · [M3-A 历史记录](../reports/t87-m3a-20261125/README.md)
- **`lse-after-scan` 归类说明（M2 `UnsupportedFeature` → M3-A `InvalidData`）**：M2 单扫描阶段尚未实现多扫描恢复，`tests/conformance/m2_golden` 中的 `lse-after-scan.jls`（在单分量最终扫描末尾之后附带 `LSE1` 却无后续 `SOS` 而直接 `EOI`）曾暂返 `UnsupportedFeature`。M3-A 实现真实扫描间标记与续扫后，扫描间 `LSE1` 本身合法但必须跟随另一条 `SOS`，若直接遇到 `EOI` 属非法的码流终止结构——这与 HP `nlocod.exe`（*"last marker must be EOI"*）和 CharLS Wasm（`Invalid JPEG-LS stream`）完全一致，故在 `tests/conformance/m2_golden/manifest.json` 与 `scripts/test_m2.py` 中诚实更新为 `InvalidData`（未删减用例）。
- **保留历史初次 HP 失败记录**：M2 初测自定义 `LSE1` 时编码器曾按 `MAXVAL=0` 写出而被 HP 1.00 误解析并导致 6 次参考解码失败（[初次失败归档](../reports/t87-m2-20261125/annex-e-hp-initial.json)）；修复 [`core/bits.mbt`](../core/bits.mbt) 写出明确解析值并保留解码端零字段兼容。

## 3. GitHub Actions CI vs. 本机完整复跑范围区分

- **GitHub Actions CI（[verification.yml](../.github/workflows/verification.yml)）每次运行**：
  - 三后端核心白盒测试（`--deny-warn`）、Native 行交付与多扫描边界交付回归（[`native_multiscan_delivery_regression.py`](../REVIEW_EVIDENCE/native_multiscan_delivery_regression.py)）、Native CLI 尾部矩阵、Worker/SDK/TS 严格检查；
  - `node scripts/validate_annex_e.mjs --check-manifest`（校验清单字段与哈希格式）；
  - `node scripts/verify_m2_golden.mjs --native-exe "$NATIVE_BINARY"`（12 组 M2 黄金 + 18 变体 + 7 非法 + 4 PGM）与 **`node scripts/verify_m3a_golden.mjs --native-exe "$NATIVE_BINARY"`**（7 组多分量/重排/多扫描 LSE1/间扫标记黄金正例 + 7 组负例）；
  - `scripts/validate.py --near-matrix`（640 组满量程 NEAR 双向互操作）。
- **本机**使用官方附件完成全部 Annex E、388 组 M2、640 组 NEAR、Chrome 工作台和固定 NASA LOLA 复跑。新增 Native 采样测试证实 47 个有效样本在 EOI 前全部交付，终结后拒绝晚到尾随。 [原始运行索引与摘要](../reports/t87-m3b-20261126/sampling-release-regressions.json)

## 4. 本机复跑

[接力交接](CODEX_M3B_HANDOFF.md) 给出本机命令、工具版本、产物哈希及参考限制。
