# T.87 Annex E 与 M2 / M3-A 独立验证结果

状态日期：**2026-11-25**。受测 M3-A 产品源码固定为 [`36bb9e6a77bd38db6806a0cc5047885b694276b5`](https://github.com/ZSY2221/moon_jpegls/commit/36bb9e6a77bd38db6806a0cc5047885b694276b5)（M2 历史受测源码 [`fc43bc2`](https://github.com/ZSY2221/moon_jpegls/commit/fc43bc2b4ed69cad9d967e63c2019ff1e8f3be44)）。截至 M3-A 交付，**官方 Annex E Table E.2 已验收 6/12 条官方码流**（从 M2 的 4/12 推进至 **`E.2-1`、`E.2-4`、`E.2-9`–`E.2-12`**），其余 6/12（`E.2-2, 3, 5, 6, 7, 8` 涉及交错与子采样）仍属后续 `M3-B` 目标，明确不宣称完整 T.87 Part 1 达成。

## 1. 官方 Annex E Table E.2 逐项结果（全部 12 条流）

| 用例 | 官方码流 | P / NEAR | 数据路径与标准特征 | 编码（JS / Wasm GC / Native） | 解码（JS / Wasm GC / Native） | 里程碑状态 |
| --- | --- | --- | --- | --- | --- | --- |
| **E.2-1** | `T8C0E0.JLS` | 8 / 0 | 三分量、分离扫描（`ILV=0`） | **`passed`**（`102,248 B`，3 后端编码均与官方流 `8c564fbd...` 逐字节一致） | **`passed`**（`196,608` 样本与原图/参考完全一致，maxErr=0） | **M3-A 已验收** |
| **E.2-2** | `T8C1E0.JLS` | 8 / 0 | 三分量、行交错（`ILV=1`） | `not_run` | 预期 `UnsupportedFeature` | **M3-B**（目标 2026-12-25） |
| **E.2-3** | `T8C2E0.JLS` | 8 / 0 | 三分量、样本交错（`ILV=2`） | `not_run` | 预期 `UnsupportedFeature` | **M3-B**（目标 2026-12-25） |
| **E.2-4** | `T8C0E3.JLS` | 8 / 3 | 三分量、分离扫描（`ILV=0`） | **`passed`**（`63,645 B`，maxErr=3，3 后端编码均与官方流 `6356737d...` 逐字节一致） | **`passed`**（`196,608` 样本与参考一致，maxErr=3） | **M3-A 已验收** |
| **E.2-5** | `T8C1E3.JLS` | 8 / 3 | 三分量、行交错（`ILV=1`） | `not_run` | 预期 `UnsupportedFeature` | **M3-B**（目标 2026-12-25） |
| **E.2-6** | `T8C2E3.JLS` | 8 / 3 | 三分量、样本交错（`ILV=2`） | `not_run` | 预期 `UnsupportedFeature` | **M3-B**（目标 2026-12-25） |
| **E.2-7** | `T8SSE0.JLS` | 8 / 0 | 三分量、子采样与行交错 | `not_run` | 预期 `UnsupportedFeature` | **M3-B**（目标 2026-12-25） |
| **E.2-8** | `T8SSE3.JLS` | 8 / 3 | 三分量、子采样与行交错 | `not_run` | 预期 `UnsupportedFeature` | **M3-B**（目标 2026-12-25） |
| **E.2-9** | `T8NDE0.JLS` | 8 / 0 | `TEST8BS2`，`T1=T2=T3=9, RESET=31` | **`passed`**（`9,421 B`，maxErr=0，3 后端与官方流逐字节一致） | **`passed`**（`16,384` 样本与参考一致） | **M2/M3-A 已验收** |
| **E.2-10** | `T8NDE3.JLS` | 8 / 3 | `TEST8BS2`，`T1=T2=T3=9, RESET=31` | **`passed`**（`6,111 B`，maxErr=3，3 后端与官方流逐字节一致） | **`passed`**（`16,384` 样本与参考一致） | **M2/M3-A 已验收** |
| **E.2-11** | `T16E0.JLS` | 12 / 0 | `TEST16`，有效精度 12 位，默认预设 | **`passed`**（`60,077 B`，maxErr=0，3 后端与官方流逐字节一致） | **`passed`**（`65,536` 样本与参考一致） | **M2/M3-A 已验收** |
| **E.2-12** | `T16E3.JLS` | 12 / 3 | `TEST16`，有效精度 12 位，默认预设 | **`passed`**（`42,189 B`，maxErr=3，3 后端与官方流逐字节一致） | **`passed`**（`65,536` 样本与参考一致） | **M2/M3-A 已验收** |

## 2. 实跑细节、历史初次失败与 `lse-after-scan` 归类变更

- **§8.2 编码验收**：以官方 PGM/PPM 原图经 MoonJLS 编码后交由独立参考解码；`NEAR=0` 比对原图，`NEAR>0` 比对同一参考解码器对官方 `.JLS` 的重建，并验证相对原图的整数误差界。`E.2-1`、`E.2-4` 与 `E.2-9`–`E.2-12` 在 JS、Wasm GC、Native 产生的全部 **18 次候选编码均与官方 `.JLS` 文件逐字节一致**。
- **§8.3 解码验收**：直接输入 SHA-256 核验后的官方 `.JLS` 码流，`E.2-1`、`E.2-4` 与 `E.2-9`–`E.2-12` 在三后端各匹配全部参考样本；`E.2-2, 3, 5, 6, 7, 8` 因交错/子采样属 `M3-B` 范围，按预期返回 `UnsupportedFeature`。
- **双独立参考核对**：官方 HP JPEG-LS Reference Software 1.00（`locod.exe` / `nlocod.exe` / `loco16d.exe` / `nloco16d.exe`）与 `@team-charls/charls-wasm@0.10.0` 在上述 **6/12** 适用官方流上得出完全一致的编码与解码结论。 [M3-A HP 实跑记录](../reports/t87-m3a-20261125/annex-e-hp.json) · [M3-A CharLS 实跑记录](../reports/t87-m3a-20261125/annex-e-charls.json) · [M2 历史归档](../reports/t87-m2-20261125/annex-e-hp.json)
- **`lse-after-scan` 归类说明（M2 `UnsupportedFeature` → M3-A `InvalidData`）**：M2 单扫描阶段尚未实现多扫描恢复，`tests/conformance/m2_golden` 中的 `lse-after-scan.jls`（在单分量最终扫描末尾之后附带 `LSE1` 却无后续 `SOS` 而直接 `EOI`）曾暂返 `UnsupportedFeature`。M3-A 实现真实扫描间标记与续扫后，扫描间 `LSE1` 本身合法但必须跟随另一条 `SOS`，若直接遇到 `EOI` 属非法的码流终止结构——这与 HP `nlocod.exe`（*"last marker must be EOI"*）和 CharLS Wasm（`Invalid JPEG-LS stream`）完全一致，故在 `tests/conformance/m2_golden/manifest.json` 与 `scripts/test_m2.py` 中诚实更新为 `InvalidData`（未删减用例）。
- **保留历史初次 HP 失败记录**：M2 初测自定义 `LSE1` 时编码器曾按 `MAXVAL=0` 写出而被 HP 1.00 误解析并导致 6 次参考解码失败（[初次失败归档](../reports/t87-m2-20261125/annex-e-hp-initial.json)）；修复 [`core/bits.mbt`](../core/bits.mbt) 写出明确解析值并保留解码端零字段兼容。

## 3. GitHub Actions CI vs. 本机完整复跑范围区分

- **GitHub Actions CI（[verification.yml](../.github/workflows/verification.yml)）每次运行**：
  - 三后端 **18/18** 核心白盒测试（`--deny-warn`）、Native 行交付与多扫描边界交付回归（[`native_multiscan_delivery_regression.py`](../REVIEW_EVIDENCE/native_multiscan_delivery_regression.py)）、Native CLI 尾部矩阵、Worker/SDK/TS 严格检查；
  - `node scripts/validate_annex_e.mjs --check-manifest`（校验清单字段与哈希格式）；
  - `node scripts/verify_m2_golden.mjs --native-exe "$NATIVE_BINARY"`（12 组 M2 黄金 + 18 变体 + 7 非法 + 4 PGM）与 **`node scripts/verify_m3a_golden.mjs --native-exe "$NATIVE_BINARY"`**（7 组多分量/重排/多扫描 LSE1/间扫标记黄金正例 + 7 组负例）；
  - `scripts/validate.py --near-matrix`（640 组满量程 NEAR 双向互操作）。
- **需在本机获取官方 ITU 附件后复跑**：完整 12 条官方 Annex E 编解码（`jlsimgV100.zip` + `jlsrefV100.zip`）与 388 组 M2 全量矩阵（`scripts/test_m2.py`）。

## 4. 本机完整复跑命令（Windows PowerShell + WSL2）

```powershell
node sdk/build.mjs
wsl -d Ubuntu-22.04 --exec bash -lc 'CC=clang ~/.moon/bin/moon build cmd/moonjls --target native --release --deny-warn'
node scripts/validate_annex_e.mjs --check-manifest
node scripts/verify_m2_golden.mjs --native-exe _build/native/release/build/cmd/moonjls/moonjls.exe --native-wsl Ubuntu-22.04
node scripts/verify_m3a_golden.mjs --native-exe _build/native/release/build/cmd/moonjls/moonjls.exe --native-wsl Ubuntu-22.04 --with-oracle
node scripts/validate_annex_e.mjs --fixtures .tools/annex-e --hp-reference .tools/annex-e-hp --native-wsl Ubuntu-22.04 --native-exe _build/native/release/build/cmd/moonjls/moonjls.exe
```
