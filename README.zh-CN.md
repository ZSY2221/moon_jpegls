# MoonJLS——纯 MoonBit JPEG-LS Part 1 编解码内核与符合性验证工具链

[English](README.md)

**MoonJLS** 面向高精度整数图像的数据交换，提供纯 MoonBit 编写的 **ITU-T T.87（06/1998）/ ISO/IEC 14495-1 JPEG-LS Part 1** 流式编解码核心、Native / JS / Wasm GC 三后端接入及可复现的符合性验证工具链。项目重点服务于高精度科研图像、遥感高程、工业灰度数据及 MoonBit 图像处理软件的无损与近无损交换，无需在核心内存缓冲整张图像。 [MoonBit 原生实现地图](docs/MOONBIT_IMPLEMENTATION_MAP.md) · [高精度图像接口](docs/HIGH_PRECISION_INTERFACES.md)

## 当前 M3-A 能力与最终 T.87 Part 1 目标

- **① 最终目标**：完整实现 **ITU-T T.87（06/1998）/ ISO/IEC 14495-1 JPEG-LS Part 1** 的编码、解码和数据格式能力（基础交换格式、表规范与简略格式、`§8` 与 Annex E 符合性），并按标准要求分阶段验证；**T.870 Part 2** 与 **DICOM 容器**属于独立扩展，**SPIFF**（`§4.8` / `Annex H.5`）按可选容器单列。 [T.87 能力矩阵与符合性计划](docs/T87_CONFORMANCE_PLAN.md)
- **② 当前已完成（M3-A 阶段版本，非最终范围）**：单帧灰度与**多分量非交错多扫描（`1..255` 分量、`ILV=0`、每扫描 `Ns=1`、`H=V=1`、`Pt=0`）**，支持 **`P=2–16`**、**独立 `MAXVAL`（`1..2^P−1`）**、**合法 `NEAR`（`0..min(255, floor(MAXVAL/2))`）**、**跨扫描 `LSE ID=1`（`T1/T2/T3/RESET`）参数继承与零字段默认重算**、非连续分量 ID 与合法重排扫描次序、重复/遗漏/未知分量及提前 `EOI` 拒绝、Native planar CLI（`encode-planar`/`encode-pgms`/`encode-ppm`/`decode-pgms`/`inspect --json`）、SDK/Worker 多扫描协议及**科学工作台多通道视图与 Scan Structure Inspector**。受测核心/CLI/SDK 提交：[`36bb9e6`](https://github.com/ZSY2221/moon_jpegls/commit/36bb9e6a77bd38db6806a0cc5047885b694276b5)。 [当前支持范围](docs/SCOPE.md) · [两分钟评审指南](docs/REVIEWER_GUIDE.md)
- **③ 后续实现路径**：交错、采样和点变换（`M3-B`）→ 映射表、`DRI/RST`、`DNL`、`LSE4` 与简略/表规范格式（`M4`）→ 完整符合性验收（`M5`）。下表未来日期均为内部开发目标，不代表赛事已认可的期限。 [完整兼容路线](docs/ROADMAP.md)

## 构建与运行

实测工具链：Moon `0.1.20261119`（`moonc v0.10.22+124d61d05`）、Node `24.20.0`，Native 在 Ubuntu 22.04 WSL2（`clang 14`）运行。

```sh
# 1. 运行纯 MoonBit 核心单元测试（三后端各 18/18）
moon test core --target js --deny-warn
moon test core --target wasm-gc --deny-warn
CC=clang moon test core --target native --deny-warn

# 2. 构建 Native CLI、JS/Wasm GC SDK 与浏览器科学工作台
CC=clang moon build cmd/moonjls --target native --release --deny-warn
node sdk/build.mjs
node web/build.mjs
python -m http.server 8000 --bind 127.0.0.1 --directory web/dist
```

Native CLI 文件与流式管道示例（单分量与多分量 `ILV=0`）：

```sh
python3 scripts/fetch_lunar_fixture.py .evidence/real/lola.pgm
moon run --target native cmd/moonjls -- encode-pgm 0 .evidence/real/lola.pgm lola.jls 4096
moon run --target native cmd/moonjls -- decode lola.jls recovered.pgm pgm 4096
moon run --target native cmd/moonjls -- encode-planar 64 32 16 3 0 planes.raw out.jls raw-le 4096 --comp-ids 10,42,7 --scan-order 42,7,10
moon run --target native cmd/moonjls -- decode-pgms out.jls c0.pgm c1.pgm c2.pgm
moon run --target native cmd/moonjls -- encode-ppm 0 rgb.ppm rgb.jls
moon run --target native cmd/moonjls -- inspect out.jls --json
```

- `encode` / `encode-pgm` 流式处理单分量原料（`P<=8` 1 字节/样本，以上 2 字节）；`encode-planar` / `encode-pgms` / `decode-pgms` 以零整图宿主缓存方式按平面/PGM 流式编解码；`encode-ppm` / `decode ppm` 提供显式计费的 P6 RGB 转换。`-` 表示标准输入/输出。 [流式管道示例](examples/stream_pipeline.sh) · [SDK 指南](sdk/README.md) · [MoonImage Gray16 消费者](examples/consumer/README.md)
- 打开 [本机科学工作台](http://127.0.0.1:8000/web/) 可试运行 Precision Lab、Multicomponent View、Scan Structure Inspector、Streaming Lab 与 Compatibility Lab。 [浏览器验证](web/README.md) · [M3-A 实测汇总](reports/t87-m3a-20261125/README.md)

## 验证方法与真实证据口径

```sh
# 快速复跑三后端独立 M2 & M3-A 黄金回归 + Annex E 清单检查（CI 每次自动执行）
node scripts/validate_annex_e.mjs --check-manifest
node scripts/verify_m2_golden.mjs --native-exe _build/native/release/build/cmd/moonjls/moonjls.exe
node scripts/verify_m3a_golden.mjs --native-exe _build/native/release/build/cmd/moonjls/moonjls.exe
```

- **三后端核心测试**：Native、JS、Wasm GC 各通过 **18/18** 项 MoonBit 核心白盒回归（`--deny-warn` 0 警告）。
- **GitHub Actions CI 自动执行**（[CI 配置](.github/workflows/verification.yml)）：运行三后端 18/18 核心测试、Native 逐行交付/多扫描跨扫描交付（`native_multiscan_delivery_regression.py`）/尾部矩阵、Worker/SDK/TS 严格类型检查、Annex E 清单检查、**M2 黄金回归（`verify_m2_golden.mjs`）**、**M3-A 多扫描黄金回归（`verify_m3a_golden.mjs`：7 正例 + 7 负例）** 以及 **640 组满量程 NEAR 矩阵**（`scripts/validate.py --near-matrix`）。
- **M3-A 受测基线实测记录**（固定受测核心/CLI/SDK [`36bb9e6`](https://github.com/ZSY2221/moon_jpegls/commit/36bb9e6a77bd38db6806a0cc5047885b694276b5)，汇总 [reports/t87-m3a-20261125/README.md](reports/t87-m3a-20261125/README.md)）：
  - **官方 Annex E Table E.2（6/12 通过）**：**`E.2-1`（`T8C0E0.JLS`，三分量无损）**、**`E.2-4`（`T8C0E3.JLS`，三分量 `NEAR=3`）** 及 **`E.2-9`–`E.2-12`** 在 JS、Wasm GC、Native 均通过 **HP JPEG-LS 1.00** 与 **CharLS Wasm 0.10.0** 双参考双向验收（全部 **18 次**候选编码与官方 `.JLS` 逐字节一致）；**`E.2-2, 3, 5, 6, 7, 8`**（交错/子采样）解码按预期返回 `UnsupportedFeature`。**通过 6/12 属于 M3-A 阶段进展，不宣称完整 Part 1 达成或“完成 50% 标准”。** [Annex E 逐项结果](docs/CONFORMANCE_RESULTS.md)
  - **M2 与 M3-A 本机合成矩阵**：**388 组 M2 正例 + 18 变体 + 7 非法编码 + 6 项 Native PGM**（`lse-after-scan` 因已支持多扫描恢复，与 HP/CharLS 一致归类为 `InvalidData`）及 **7 正例 + 7 负例 M3-A 黄金夹具**全部通过。
  - **满量程 NEAR 矩阵**：**640/640** 三后端复跑通过（特定满量程 8/12/16 位 NEAR 回归，**非**任意 `P`/`MAXVAL`/多扫描全参数笛卡尔积）。 [独立验证说明](docs/VALIDATION.md)
  - **Chrome 158 工作台与包边界**：在 Chrome 158 完成 `#sample-rgb8`、`#sample-multi16`（高位深 `>255` 整型读数）、独立 `.jls`（`C0/C1/C2` 与 Scan Inspector 联动）与 CharLS 复核；`moon package --frozen` 打包无警告通过，Mooncakes 在线查询返回 HTTP 404 / `not found`（未经授权不线上发布）。 [Mooncakes 发布准备](docs/MOONCAKES_RELEASE.md) · [性能基准](docs/BENCHMARK.md)

## 分阶段兼容路线（已完成 M0–M3-A 与后续开发目标）

| 阶段 | 状态 / 内部目标日期* | 交付范围与退出验收条件 |
| --- | --- | --- |
| **M0** | **已完成** | 纯 MoonBit 核心、Native/JS/Wasm GC、流式状态机、CLI/Worker/工作台及 3 处正确性修复（`16a7b49`）。 |
| **M1** | **已完成** | 满量程 8/12/16 位合法 `NEAR` 扩展（`640/640` CharLS 双向互操作通过）。 |
| **M2** | **已完成（2026-11-25）** | `P=2–16`、独立 `MAXVAL`、合法 `NEAR`、`LSE ID=1` 自定义预设，Precision/Streaming/Compatibility Labs（`fc43bc2`）。 |
| **M3-A** | **已完成（2026-11-25）** | 多分量帧（1–255）、多 `SOS`、`ILV=0` 多扫描、跨扫描 `LSE1` 继承与零重置、非连续/重排 ID、工作台多通道与 Scan Inspector（`36bb9e6`）。已通过 **Annex E `E.2-1`、`E.2-4`**（总 6/12）。 |
| **M3-B** | 开发目标 **2026-12-25** | 行交错 `ILV=1`、样本交错 `ILV=2`、合法 `H/V` 采样因子与边缘 MCU、点变换 `Pt` 及双尺度误差分离。首要验收：**Annex E `E.2-2`、`E.2-3`、`E.2-5`–`E.2-8`**。 |
| **M4** | 开发目标 **2027-01-10** | `LSE ID=2/3` 映射表与续表、表规范与简略格式（`§7(b)(c)`）及外部表生命周期、`DRI/RST0–RST7`、`DNL`、`LSE ID=4` 扩展尺寸与剩余标记语法。 |
| **M5** | 开发目标 **2027-01-20** | 完整 Part 1 符合性闭环：官方 Annex E（`12/12`）、T.87 `§8.2`/`§8.3`、适用独立参考实现、三后端完整能力矩阵与干净环境复现。 |

*\*M3-B 至 M5 日期为项目内部开发目标，不代表组委会已认可最终验收日期。* [完整兼容路线](docs/ROADMAP.md) · [项目工程状态](PROJECT_STATUS.md) · [性能基准](docs/BENCHMARK.md)
