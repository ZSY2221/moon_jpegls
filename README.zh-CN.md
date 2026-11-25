# MoonJLS——纯 MoonBit JPEG-LS Part 1 编解码内核与符合性验证工具链

[English](README.md)

**MoonJLS** 面向高精度整数图像的数据交换，提供纯 MoonBit 编写的 **ITU-T T.87（06/1998）/ ISO/IEC 14495-1 JPEG-LS Part 1** 流式编解码核心、Native / JS / Wasm GC 三后端接入及可复现的符合性验证工具链。项目重点服务于高精度科研图像、遥感高程、工业灰度数据及 MoonBit 图像处理软件的无损与近无损交换，无需在核心内存缓冲整张图像。 [MoonBit 原生实现地图](docs/MOONBIT_IMPLEMENTATION_MAP.md) · [高精度图像接口](docs/HIGH_PRECISION_INTERFACES.md)

## 当前 M2 能力与最终 T.87 Part 1 目标

- **当前已交付版本（M2 — 2026-11-25 完成，不是最终标准范围）**：单帧、单分量、单扫描（`ILV=0`、`Pt=0`），支持已知尺寸（`1..65,535`）、**`P=2–16` 编码精度**、**独立 `MAXVAL`（`1..2^P−1`）**、**按有效 `MAXVAL` 约束的合法 `NEAR`（`0..min(255, floor(MAXVAL/2))`）**，以及 **`LSE ID=1` 默认或自定义 `T1/T2/T3/RESET`** 参数。流式编解码保持分块无关，并在 `EOI` 后严格拒绝尾随字节。 [当前支持范围](docs/SCOPE.md) · [两分钟评审指南](docs/REVIEWER_GUIDE.md)
- **最终标准目标（完整 ITU-T T.87 Part 1）**：**MoonJLS 的最终目标是完整实现 ITU-T T.87（06/1998）/ ISO/IEC 14495-1 JPEG-LS Part 1 的编码、解码和数据格式能力**，涵盖基础交换格式、多分量与多扫描、`ILV=0/1/2`、采样因子与边缘 MCU、点变换 `Pt`、`LSE ID=2/3` 映射表及续表、表规范数据与简略图像格式（`§7(b)(c)`）、`DRI/RST0–RST7`、`DNL`、`LSE ID=4` 扩展尺寸及剩余标记语法，并通过 `§8` 与 Annex E 逐阶段验收。**T.870 Part 2** 与 **DICOM 容器**属于独立扩展，**SPIFF**（`§4.8`/`Annex H.5`）按标准可选容器单独说明。 [T.87 能力矩阵与符合性计划](docs/T87_CONFORMANCE_PLAN.md)

## 构建与运行

实测工具链：Moon `0.1.20261119`（`moonc v0.10.22+124d61d05`）、Node `24.20.0`，Native 在 Ubuntu 22.04 WSL2（`clang 14`）运行。

```sh
# 1. 运行纯 MoonBit 核心单元测试（三后端各 15/15）
moon test core --target js --deny-warn
moon test core --target wasm-gc --deny-warn
CC=clang moon test core --target native --deny-warn

# 2. 构建 Native CLI、JS/Wasm GC SDK 与浏览器科学工作台
CC=clang moon build cmd/moonjls --target native --release
node sdk/build.mjs
node web/build.mjs
python -m http.server 8000 --bind 127.0.0.1 --directory web/dist
```

Native CLI 文件与流式管道示例（下载公开 NASA 16 位月面高程数据并编解码核验）：

```sh
python3 scripts/fetch_lunar_fixture.py .evidence/real/lola.pgm
moon run --target native cmd/moonjls -- encode-pgm 0 .evidence/real/lola.pgm lola.jls 4096
moon run --target native cmd/moonjls -- decode lola.jls recovered.pgm pgm 4096
moon run --target native cmd/moonjls -- inspect lola.jls
moon run --target native cmd/moonjls -- verify lola.jls 17
```

- raw 编码使用 `encode WIDTH HEIGHT BITS NEAR INPUT OUTPUT [raw-le|raw-be] [CHUNK] [--maxval N] [--t1 N --t2 N --t3 N --reset N]`（`P<=8` 每样本 1 字节，以上每样本 2 字节）；`encode-pgm` 从 `P5` 头读取实际 `MAXVAL`（>255 采用大端）。`-` 表示标准输入/输出。 [流式管道示例](examples/stream_pipeline.sh) · [SDK 指南](sdk/README.md) · [MoonImage Gray16 消费者](examples/consumer/README.md)
- 打开 [本机科学工作台](http://127.0.0.1:8000/web/) 可试运行 Precision Lab、Streaming Lab 与 Compatibility Lab。 [浏览器验证](web/README.md) · [运行报告 v1](docs/VERIFICATION_REPORT.md)

## 验证方法与真实证据口径

```sh
# 快速复跑三后端独立 M2 黄金回归 + Annex E 清单检查（CI 每次自动执行）
node scripts/validate_annex_e.mjs --check-manifest
node scripts/verify_m2_golden.mjs --native-exe _build/native/release/build/cmd/moonjls/moonjls.exe
```

- **三后端核心测试**：Native、JS、Wasm GC 各通过 **15/15** 项 MoonBit 核心白盒回归。
- **GitHub Actions CI 自动执行**（[CI 配置](.github/workflows/verification.yml)）：运行三后端 15/15 核心测试、Native 逐行交付与尾部矩阵、Worker/SDK/TS 严格类型检查、Annex E 清单检查、**12 组独立 HP/Annex A 黄金正例 + 18 个 LSE 变体 + 7 个非法编码边界 + 4 项 Native PGM 检查**（`scripts/verify_m2_golden.mjs`）以及**历史 640 组满量程 NEAR 矩阵**（`scripts/validate.py --near-matrix`）。说明：CI 的 `--check-manifest` 仅检查清单完整性，**不会**在云端运行全部 12 条 ITU Annex E 官方流。
- **本机完整 M2 独立验收**（受测产品源码 [`fc43bc2`](https://github.com/ZSY2221/moon_jpegls/commit/fc43bc2b4ed69cad9d967e63c2019ff1e8f3be44)，M2 冻结证据 [`a7d8c39`](https://github.com/ZSY2221/moon_jpegls/commit/a7d8c391b7af0d88bc5c912ed62c78eaf4c79565)）：
  - **388 组 M2 新增正例** + **18 个 LSE 码流变体**（5 有效 / 13 拒绝）+ **7 个非法编码用例** + **6 项 Native PGM 检查**在三后端完成 HP JPEG-LS V.1.00 与独立 Annex A 向量（`MAXVAL=1,2`）对照。 [M2 合成矩阵](reports/t87-m2-20261125/synthetic-matrix.md)
  - **官方 Annex E Table E.2**：**`E.2-9` 至 `E.2-12`** 在三后端通过编码与解码验收，12 次 MoonJLS 候选编码与官方流逐字节一致；**`E.2-1` 至 `E.2-8`**（多分量/交错/子采样）解码按预期返回 `UnsupportedFeature`，对应编码尚未运行。 [Annex E 逐项结果](docs/CONFORMANCE_RESULTS.md)
  - **历史 M1 满量程 NEAR 回归**：**640/640**（满量程 8 位 `NEAR=0–127`、12/16 位 `NEAR=0–255`；**明确说明：这不是当前 M2 `P=2–16` × 任意 `MAXVAL` × 所有自定义预设的完整笛卡尔积**）。 [独立验证说明](docs/VALIDATION.md) · [M1 NEAR 报告](reports/review-near-20261125/README.md)
  - **NASA LOLA 与 Chrome 实测**：**1,036,800** 个 16 位月面高程样本在 JS/Wasm GC（`NEAR=0–3`）及 Chrome 工作台完成真实逐样本核对、下载与取消重启检查。 [NASA 误差预算实测](reports/lunar-budget-20261125/README.md)
  - **包消费与发布状态**：`0.1.0` 归档在本地回环 registry 通过三后端消费验证；Mooncakes 在线查询返回 HTTP 404（尚未执行线上发布）。 [Mooncakes 发布准备](docs/MOONCAKES_RELEASE.md)

## 分阶段兼容路线（已完成 M0–M2 与后续开发目标）

| 阶段 | 状态 / 内部目标日期* | 交付范围与退出验收条件 |
| --- | --- | --- |
| **M0** | **已完成** | 纯 MoonBit 核心、Native/JS/Wasm GC、流式状态机、CLI/Worker/工作台及 3 处正确性修复（`16a7b49`）。 |
| **M1** | **已完成** | 满量程 8/12/16 位合法 `NEAR` 扩展（`640/640` CharLS 双向互操作通过）。 |
| **M2** | **已完成（2026-11-25）** | `P=2–16`、独立 `MAXVAL`、合法 `NEAR`、`LSE ID=1` 自定义预设，Precision/Streaming/Compatibility Labs（`fc43bc2`）。 |
| **M3-A** | 开发目标 **2026-12-10** | 多分量帧、多 `SOS`、`ILV=0` 多扫描状态与跨扫描 LSE 参数继承、重复/遗漏/错序检查。首要验收：**Annex E `E.2-1`、`E.2-4`**。 |
| **M3-B** | 开发目标 **2026-12-25** | 行交错 `ILV=1`、样本交错 `ILV=2`、合法 `H/V` 采样因子与边缘 MCU、点变换 `Pt` 及双尺度误差分离。首要验收：**Annex E `E.2-2`、`E.2-3`、`E.2-5`–`E.2-8`**。 |
| **M4** | 开发目标 **2027-01-10** | `LSE ID=2/3` 映射表与续表、表规范与简略格式（`§7(b)(c)`）及外部表生命周期、`DRI/RST0–RST7`、`DNL`、`LSE ID=4` 扩展尺寸与剩余标记语法。 |
| **M5** | 开发目标 **2027-01-20** | 完整 Part 1 符合性闭环：官方 Annex E（`12/12`）、T.87 `§8.2`/`§8.3`、适用独立参考实现、三后端完整能力矩阵与干净环境复现。 |

*\*M3-A 至 M5 日期为项目内部开发目标，不代表组委会已认可最终验收日期。* [完整兼容路线](docs/ROADMAP.md) · [项目工程状态](PROJECT_STATUS.md) · [性能基准](docs/BENCHMARK.md)
