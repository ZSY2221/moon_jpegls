# T.87 Annex E 与 M2 / M3-A / M3-B 独立验证结果

截至 **2026-11-26**，M3-B 交错候选 [25fadce](https://github.com/ZSY2221/moon_jpegls/commit/25fadceb8de039a76e749ff368993a30926176aa) 在 Native、JS、Wasm GC 对官方 **Annex E Table E.2 通过 10/12**，每条适用流在 HP 1.00 和 CharLS Wasm 0.10.0 下均通过两个方向。E.2-7/8 的 H/V 采样为下一阶段。完整 T.87 Part 1 目标及剩余能力见 [标准计划](T87_CONFORMANCE_PLAN.md)。[HP](../reports/t87-m3b-20261126/annex-e-hp.json) · [CharLS](../reports/t87-m3b-20261126/annex-e-charls.json)

## 1. 官方 Annex E Table E.2 逐项结果（全部 12 条流）

| 用例 | 官方码流 | P / NEAR | 数据路径与标准特征 | 编码（JS / Wasm GC / Native） | 解码（JS / Wasm GC / Native） | 里程碑状态 |
| --- | --- | --- | --- | --- | --- | --- |
| **E.2-1** | `T8C0E0.JLS` | 8 / 0 | 三分量、分离扫描（`ILV=0`） | **`passed`**（`102,248 B`，3 后端编码均与官方流 `8c564fbd...` 逐字节一致） | **`passed`**（`196,608` 样本与原图/参考完全一致，maxErr=0） | **M3-A 已验收** |
| **E.2-2** | `T8C1E0.JLS` | 8 / 0 | 三分量、行交错（`ILV=1`） | **`passed`**（`100,615 B`，三后端与官方流逐字节一致） | **`passed`**（`196,608` 样本与双参考一致，原图最大误差 0） | **M3-B 交错已验收** |
| **E.2-3** | `T8C2E0.JLS` | 8 / 0 | 三分量、样本交错（`ILV=2`） | **`passed`**（`99,734 B`，三后端与官方流逐字节一致） | **`passed`**（`196,608` 样本与双参考一致，原图最大误差 0） | **M3-B 交错已验收** |
| **E.2-4** | `T8C0E3.JLS` | 8 / 3 | 三分量、分离扫描（`ILV=0`） | **`passed`**（`63,645 B`，maxErr=3，3 后端编码均与官方流 `6356737d...` 逐字节一致） | **`passed`**（`196,608` 样本与参考一致，maxErr=3） | **M3-A 已验收** |
| **E.2-5** | `T8C1E3.JLS` | 8 / 3 | 三分量、行交错（`ILV=1`） | **`passed`**（`63,005 B`，三后端与官方流逐字节一致） | **`passed`**（`196,608` 样本与双参考一致，原图最大误差 3） | **M3-B 交错已验收** |
| **E.2-6** | `T8C2E3.JLS` | 8 / 3 | 三分量、样本交错（`ILV=2`） | **`passed`**（`62,300 B`，三后端与官方流逐字节一致） | **`passed`**（`196,608` 样本与双参考一致，原图最大误差 3） | **M3-B 交错已验收** |
| **E.2-7** | `T8SSE0.JLS` | 8 / 0 | 三分量、子采样与行交错 | `not_run` | 预期 `UnsupportedFeature` | **M3-B**（目标 2026-12-25） |
| **E.2-8** | `T8SSE3.JLS` | 8 / 3 | 三分量、子采样与行交错 | `not_run` | 预期 `UnsupportedFeature` | **M3-B**（目标 2026-12-25） |
| **E.2-9** | `T8NDE0.JLS` | 8 / 0 | `TEST8BS2`，`T1=T2=T3=9, RESET=31` | **`passed`**（`9,421 B`，maxErr=0，3 后端与官方流逐字节一致） | **`passed`**（`16,384` 样本与参考一致） | **M2/M3-A 已验收** |
| **E.2-10** | `T8NDE3.JLS` | 8 / 3 | `TEST8BS2`，`T1=T2=T3=9, RESET=31` | **`passed`**（`6,111 B`，maxErr=3，3 后端与官方流逐字节一致） | **`passed`**（`16,384` 样本与参考一致） | **M2/M3-A 已验收** |
| **E.2-11** | `T16E0.JLS` | 12 / 0 | `TEST16`，有效精度 12 位，默认预设 | **`passed`**（`60,077 B`，maxErr=0，3 后端与官方流逐字节一致） | **`passed`**（`65,536` 样本与参考一致） | **M2/M3-A 已验收** |
| **E.2-12** | `T16E3.JLS` | 12 / 3 | `TEST16`，有效精度 12 位，默认预设 | **`passed`**（`42,189 B`，maxErr=3，3 后端与官方流逐字节一致） | **`passed`**（`65,536` 样本与参考一致） | **M2/M3-A 已验收** |

## 2. 实跑细节、历史初次失败与 `lse-after-scan` 归类变更

- **§8.2 编码验收**使用官方 PGM/PPM 源样本。候选流经 HP 与 CharLS 各自独立解码，NEAR=0 与原图逐样本一致，NEAR>0 与同一参考对官方流的重建逐样本一致，再验证相对原图的误差界。10 条通过流的三后端候选均与官方文件逐字节一致（30 个后端与向量组合）。
- **§8.3 解码验收**直接解码经 SHA-256 核验的官方码流。10 条通过流均逐样本匹配双参考。E.2-7/8 三后端的解码检查均返回预期的 `UnsupportedFeature`，编码及采样参考验收为 `not_run`。
- 两套报告记录样本量、原图和重建哈希、候选流以及首个差异坐标。M3-A 的 6/12 结果已保留。 [本轮 HP](../reports/t87-m3b-20261126/annex-e-hp.json) · [本轮 CharLS](../reports/t87-m3b-20261126/annex-e-charls.json) · [M3-A 历史记录](../reports/t87-m3a-20261125/README.md)
- **`lse-after-scan` 归类说明（M2 `UnsupportedFeature` → M3-A `InvalidData`）**：M2 单扫描阶段尚未实现多扫描恢复，`tests/conformance/m2_golden` 中的 `lse-after-scan.jls`（在单分量最终扫描末尾之后附带 `LSE1` 却无后续 `SOS` 而直接 `EOI`）曾暂返 `UnsupportedFeature`。M3-A 实现真实扫描间标记与续扫后，扫描间 `LSE1` 本身合法但必须跟随另一条 `SOS`，若直接遇到 `EOI` 属非法的码流终止结构——这与 HP `nlocod.exe`（*"last marker must be EOI"*）和 CharLS Wasm（`Invalid JPEG-LS stream`）完全一致，故在 `tests/conformance/m2_golden/manifest.json` 与 `scripts/test_m2.py` 中诚实更新为 `InvalidData`（未删减用例）。
- **保留历史初次 HP 失败记录**：M2 初测自定义 `LSE1` 时编码器曾按 `MAXVAL=0` 写出而被 HP 1.00 误解析并导致 6 次参考解码失败（[初次失败归档](../reports/t87-m2-20261125/annex-e-hp-initial.json)）；修复 [`core/bits.mbt`](../core/bits.mbt) 写出明确解析值并保留解码端零字段兼容。

## 3. GitHub Actions CI vs. 本机完整复跑范围区分

- **GitHub Actions CI（[verification.yml](../.github/workflows/verification.yml)）每次运行**：
  - 三后端核心白盒测试（`--deny-warn`）、Native 行交付与多扫描边界交付回归（[`native_multiscan_delivery_regression.py`](../REVIEW_EVIDENCE/native_multiscan_delivery_regression.py)）、Native CLI 尾部矩阵、Worker/SDK/TS 严格检查；
  - `node scripts/validate_annex_e.mjs --check-manifest`（校验清单字段与哈希格式）；
  - `node scripts/verify_m2_golden.mjs --native-exe "$NATIVE_BINARY"`（12 组 M2 黄金 + 18 变体 + 7 非法 + 4 PGM）与 **`node scripts/verify_m3a_golden.mjs --native-exe "$NATIVE_BINARY"`**（7 组多分量/重排/多扫描 LSE1/间扫标记黄金正例 + 7 组负例）；
  - `scripts/validate.py --near-matrix`（640 组满量程 NEAR 双向互操作）。
- **本机**使用官方 ITU 附件（`jlsimgV100.zip` 和 `jlsrefV100.zip`）执行 Annex E 支持项的双向验收。388 组 M2 全量矩阵留待最终发布候选。

## 4. 本机复跑

当前候选的命令、工具版本、三后端产物哈希和未执行项见 [接力交接](CODEX_M3B_HANDOFF.md) 与 [回归记录](../reports/t87-m3b-20261126/regressions.json)。
