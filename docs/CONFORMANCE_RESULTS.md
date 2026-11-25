# T.87 Annex E 与 M2 独立验证结果

状态日期：**2026-11-25**。受测 M2 产品源码固定为 [`fc43bc2b4ed69cad9d967e63c2019ff1e8f3be44`](https://github.com/ZSY2221/moon_jpegls/commit/fc43bc2b4ed69cad9d967e63c2019ff1e8f3be44)（M2 证据冻结提交 [`a7d8c39`](https://github.com/ZSY2221/moon_jpegls/commit/a7d8c391b7af0d88bc5c912ed62c78eaf4c79565)）。下文完整列示官方 Annex E Table E.2 全部 12 条测试流、历史失败与修复记录，以及本机全量运行与 GitHub Actions CI 自动运行的准确区别。

## 1. 官方 Annex E Table E.2 逐项结果（全部 12 条流）

| 用例 | 官方码流 | P / NEAR | 数据路径与标准特征 | 编码（JS / Wasm GC / Native） | 解码（JS / Wasm GC / Native） | 后续目标阶段 |
| --- | --- | --- | --- | --- | --- | --- |
| **E.2-1** | `T8C0E0.JLS` | 8 / 0 | 三分量、分离扫描（`ILV=0`） | `not_run` | 预期 `UnsupportedFeature` | **M3-A**（2026-12-10） |
| **E.2-2** | `T8C1E0.JLS` | 8 / 0 | 三分量、行交错（`ILV=1`） | `not_run` | 预期 `UnsupportedFeature` | **M3-B**（2026-12-25） |
| **E.2-3** | `T8C2E0.JLS` | 8 / 0 | 三分量、样本交错（`ILV=2`） | `not_run` | 预期 `UnsupportedFeature` | **M3-B**（2026-12-25） |
| **E.2-4** | `T8C0E3.JLS` | 8 / 3 | 三分量、分离扫描（`ILV=0`） | `not_run` | 预期 `UnsupportedFeature` | **M3-A**（2026-12-10） |
| **E.2-5** | `T8C1E3.JLS` | 8 / 3 | 三分量、行交错（`ILV=1`） | `not_run` | 预期 `UnsupportedFeature` | **M3-B**（2026-12-25） |
| **E.2-6** | `T8C2E3.JLS` | 8 / 3 | 三分量、样本交错（`ILV=2`） | `not_run` | 预期 `UnsupportedFeature` | **M3-B**（2026-12-25） |
| **E.2-7** | `T8SSE0.JLS` | 8 / 0 | 三分量、子采样与行交错 | `not_run` | 预期 `UnsupportedFeature` | **M3-B**（2026-12-25） |
| **E.2-8** | `T8SSE3.JLS` | 8 / 3 | 三分量、子采样与行交错 | `not_run` | 预期 `UnsupportedFeature` | **M3-B**（2026-12-25） |
| **E.2-9** | `T8NDE0.JLS` | 8 / 0 | `TEST8BS2`，`T1=T2=T3=9, RESET=31` | **`passed`**（最大误差 0，3 后端编码均与官方流逐字节一致） | **`passed`**（16,384 样本与参考一致） | **M2 已验收** |
| **E.2-10** | `T8NDE3.JLS` | 8 / 3 | `TEST8BS2`，`T1=T2=T3=9, RESET=31` | **`passed`**（最大误差 3，3 后端编码均与官方流逐字节一致） | **`passed`**（16,384 样本与参考一致） | **M2 已验收** |
| **E.2-11** | `T16E0.JLS` | 12 / 0 | `TEST16`，有效精度 12 位，默认预设 | **`passed`**（最大误差 0，3 后端编码均与官方流逐字节一致） | **`passed`**（65,536 样本与参考一致） | **M2 已验收** |
| **E.2-12** | `T16E3.JLS` | 12 / 3 | `TEST16`，有效精度 12 位，默认预设 | **`passed`**（最大误差 3，3 后端编码均与官方流逐字节一致） | **`passed`**（65,536 样本与参考一致） | **M2 已验收** |

## 2. 实跑细节、历史初次失败与工具限制

- **§8.2 编码验收**：以官方 PGM 原图经 MoonJLS 编码后交由独立参考解码；`NEAR=0` 比对原图，`NEAR>0` 比对同一参考解码器对官方 `.JLS` 的重建，并验证相对原图的整数误差界。`E.2-9` 至 `E.2-12` 在 JS、Wasm GC、Native 产生的全部 **12 次候选编码均与官方 `.JLS` 文件逐字节一致**。
- **§8.3 解码验收**：直接输入 SHA-256 核验后的官方 `.JLS` 码流，`E.2-9` 至 `E.2-12` 在三后端各匹配 **163,840 个样本**。`E.2-1` 至 `E.2-8` 的拒绝仅代表 M2 单分量范围边界已正确守住，**不**表示已支持多分量功能。
- **双独立参考核对**：官方 HP JPEG-LS Reference Software 1.00（32 位 Windows 程序 `locod.exe` / `nlocod.exe` / `loco16d.exe` / `nloco16d.exe`）与 `@team-charls/charls-wasm@0.10.0` 各自得出完全一致的编码与解码结论。 [HP 实跑记录](../reports/t87-m2-20261125/annex-e-hp.json) · [CharLS 实跑记录](../reports/t87-m2-20261125/annex-e-charls.json)
- **保留历史初次 HP 失败记录**：初次测试自定义 `LSE1` 时，编码器按 `MAXVAL=0`（Annex C 哨兵默认值）输出 `LSE1` 字段，HP 1.00 将 `0` 误解析为字母表大小 `1`，导致 `E.2-9` 与 `E.2-10` 共 **6 个参考解码请求失败**（见 [初次失败归档](../reports/t87-m2-20261125/annex-e-hp-initial.json)）。将 [`core/bits.mbt`](../core/bits.mbt) 改为写出 `LSE1` 时明示解析后的实际 `MAXVAL/T1/T2/T3/RESET` 后全部通过；同时 MoonJLS 解码器仍保留对 Annex C 允许的零默认字段的完整兼容。
- **其他非 Annex E 独立证据与局限**：
  - **M2 本机合成矩阵（388 正例 + 18 LSE 变体 + 7 非法编码 + 6 Native PGM）**：由于 HP 1.00 拒绝 `MAXVAL=1,2` 且低 `MAXVAL` 默认阈值与 T.87 公式有差异，而 CharLS 2.4.5 部分参数路径与满量程耦合，因此本机矩阵综合采用 HP 1.00（原样或保持熵段的等效头部适配）与 T.87 Annex A 独立推导 `1×1` 位流向量。详见 [synthetic-matrix.md](../reports/t87-m2-20261125/synthetic-matrix.md)。
  - **历史满量程 NEAR 640 组回归**：固定二进制复跑 **640/640** 通过，但仅限满量程 8/12/16 位 NEAR，不是 M2 全参数空间笛卡尔积。 [p1-near-regression.json](../reports/t87-m2-20261125/p1-near-regression.json)

## 3. GitHub Actions CI vs. 本机完整复跑范围区分

- **GitHub Actions CI（[verification.yml](../.github/workflows/verification.yml)）每次运行**：
  - 三后端 15/15 核心白盒测试、Native 行交付与尾部矩阵、Worker/SDK/TS 严格类型检查；
  - `node scripts/validate_annex_e.mjs --check-manifest`（**仅校验清单字段与哈希格式，不在 CI 上运行 ITU 12 条官方流编解码**）；
  - `node scripts/verify_m2_golden.mjs --native-exe "$NATIVE_BINARY"`（在三后端实际运行固定 SHA-256 的 **12 组独立 HP/Annex A 黄金正例 + 18 个 LSE 变体 + 7 个非法编码 + 4 项 Native PGM 检查**，夹具来源 [`tests/conformance/m2_golden/`](../tests/conformance/m2_golden/README.md)）；
  - `scripts/validate.py --near-matrix`（历史 **640 组**满量程 NEAR 双向互操作）。
- **需在本机额外获取 ITU 官方附件后复跑**：
  - 完整 12 条官方 Annex E 编解码验证（需要从 [ITU-T T.87 页面](https://www.itu.int/rec/T-REC-T.87-199806-I/en) 下载的 `jlsimgV100.zip` 与 `jlsrefV100.zip`）；
  - 完整 **388 组** M2 合成矩阵（`scripts/test_m2.py`）。

## 4. 本机完整复跑命令（Windows PowerShell + WSL2）

将官方 `jlsimgV100.zip` 和 `jlsrefV100.zip` 分别解压至 `.tools/annex-e` 和 `.tools/annex-e-hp`（SHA-256 均在 [manifest.json](../tests/conformance/manifest.json) 登记）：

```powershell
node sdk/build.mjs
wsl -d Ubuntu-22.04 --exec bash -lc 'CC=clang ~/.moon/bin/moon build cmd/moonjls --target native --release --target-dir .tools/wsl-build'
node scripts/validate_annex_e.mjs --check-manifest
node scripts/verify_m2_golden.mjs --native-exe .tools/wsl-build/native/release/build/cmd/moonjls/moonjls.exe --native-wsl Ubuntu-22.04
node scripts/validate_annex_e.mjs --fixtures .tools/annex-e --hp-reference .tools/annex-e-hp --native-wsl Ubuntu-22.04 --native-exe .tools/wsl-build/native/release/build/cmd/moonjls/moonjls.exe
```
