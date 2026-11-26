# T.87 Annex E 与 M2 / M3-A / M3-B 独立验证结果

复审前冻结产品 `e32c9161b4679656aa1aba7f01374150a1a9951a` 已再次以本机 HP 1.00 实跑 12 条官方向量，Native、JS、Wasm GC 的 36 份编码均与官方字节一致，36 次官方流解码均匹配参考重建。候选 CI 即时使用 CharLS Wasm 核对十条，E.2-7/8 使用官方字节和归档 HP 重建哈希。全部官方向量均为 Pt=0。[本轮逐条哈希与回归](../reports/november-release-20261126/release-regressions.json) · [候选 CI](https://github.com/ZSY2221/moon_jpegls/actions/runs/45823530089)

截至 **2026-11-26**，固定候选 [8c5882f](https://github.com/ZSY2221/moon_jpegls/commit/8c5882f292327393d36763450c886359bd6aa224) 在 Native、JS、Wasm GC 三后端完成官方 **Annex E Table E.2 12/12** 双向验收。HP 1.00 独立复验全部 12 条，CharLS Wasm 0.10.0 独立复验其中 10 条。E.2-7/8 的 CharLS 采样能力为 `reference_unsupported`。 [HP 全部用例](../reports/t87-m3b-20261126/public-delivery/annex-e-hp.json) · [CharLS 适用用例](../reports/t87-m3b-20261126/public-delivery/annex-e-charls.json) · [CharLS 采样能力](../reports/t87-m3b-20261126/public-delivery/annex-e-charls-sampling.json)

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

## 3. GitHub Actions CI 与本机参考

- GitHub Actions 校验待测 SHA，从固定 ITU-T 附件取出并核对官方输入。CI 实跑全部 12 条的三后端编解码。E.2-1–6、9–12 在 CI 即时调用 CharLS Wasm 0.10.0。E.2-7/8 比对官方码流逐字节和固定 HP 重建 SHA-256。本机独立运行 HP 1.00 参考解码全部 12 条。[`verification.yml`](../.github/workflows/verification.yml) · [官方向量获取器](../scripts/fetch_annex_e.py)
- CI 还执行核心测试、M2/M3-A 黄金流与 M3-B 核心和 Native 采样黄金、Native 行交付和尾部、SDK/Worker、TypeScript、Web 构建、真实 Chrome 与 640 组 NEAR。`--check-manifest` 单独校验清单字段及哈希格式。
- 388 组 M2 与固定 NASA LOLA 独立参考复验保留采样候选的结果。Native 采样黄金证实 47 个有效样本在 EOI 前全部交付，终结后拒绝晚到尾随。[采样候选原始回归](../reports/t87-m3b-20261126/sampling-release-regressions.json)

## 4. 本机复跑

[接力交接](CODEX_M3B_HANDOFF.md) 给出本机命令、工具版本、产物哈希及参考限制。
