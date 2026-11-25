# MoonJLS 工程状态

状态日期：**2026-11-25**。项目当前由 **Antigravity** 担任唯一主力 AI 维护助手，参赛者/项目负责人（`ZSY2221`）负责最终技术决策、标准边界确认与提交审核。

## 1. GitHub 分支、提交基线与合并状态

| 条目 | 实际标识与说明 |
| --- | --- |
| 公开仓库 | `https://github.com/ZSY2221/moon_jpegls` |
| **当前 M3-A 受测核心/CLI/SDK 提交** | [`36bb9e6a77bd38db6806a0cc5047885b694276b5`](https://github.com/ZSY2221/moon_jpegls/commit/36bb9e6a77bd38db6806a0cc5047885b694276b5)（`core/`、`cmd/`、`sdk/`、`tests/conformance/m3a_golden/`） |
| 历史 M2 受测基线 | [`fc43bc2b4ed69cad9d967e63c2019ff1e8f3be44`](https://github.com/ZSY2221/moon_jpegls/commit/fc43bc2b4ed69cad9d967e63c2019ff1e8f3be44) / [`a7d8c39`](https://github.com/ZSY2221/moon_jpegls/commit/a7d8c391b7af0d88bc5c912ed62c78eaf4c79565)（已通过 [PR #1](https://github.com/ZSY2221/moon_jpegls/pull/1) 合入 `main`） |
| **M3-A 交付分支与默认分支 `main`** | 从 `origin/main` 切出 `antigravity/t87-m3a-20261125` 完成 M3-A 功能升级与全套独立验收，经 CI 通过后以 `--no-ff` 合入默认分支 `main` |
| 原 Windows 实验工作区 | `D:\Program Files\GPT_project\moon_jpegls` 原有未提交实验与草稿完整保留，不混入复审版本 |

## 2. 里程碑完成状态（M0–M3-A 已完成，M3-B–M5 为后续目标）

- **M0（已完成）**：纯 MoonBit 核心、Native/JS/Wasm GC 三后端、流式状态机、CLI/Worker/工作台与 `16a7b49` 三处正确性修复。 [M0 复验证据](reports/review-fix-20261125/README.md)
- **M1（已完成）**：满量程 8/12/16 位全部 **640 组**在三后端完成 CharLS 双向验证（640/640）。 [M1 证据](reports/review-near-20261125/README.md)
- **M2（已完成，2026-11-25）**：单帧、单分量、单扫描下支持 **`P=2–16`、独立 `MAXVAL`、合法 `NEAR`、`LSE ID=1` 自定义预设**及 Precision/Streaming/Compatibility Labs。 [M2 验收汇总](reports/t87-m2-20261125/README.md)
- **M3-A（已完成，2026-11-25，受测源码 `36bb9e6`）**：单帧 **1–255 分量**、`H=V=1`、**非交错多扫描（`ILV=0`, `Ns=1`）**、`Pt=0`、跨扫描 `LSE1` 继承与零字段默认重算、非连续 ID 与合法重排扫描、Native planar 流式入口、SDK/Worker 多扫描支持、多通道工作台与 Scan Structure Inspector。 [M3-A 验收汇总](reports/t87-m3a-20261125/README.md) · [逐项 Annex E](docs/CONFORMANCE_RESULTS.md)
- **最终标准终点与后续开发目标（M3-B 至 M5）**：最终目标是完整实现 **ITU-T T.87（06/1998）/ ISO/IEC 14495-1 JPEG-LS Part 1** 编码、解码与数据格式能力（`M3-B` 目标 2026-12-25、`M4` 目标 2027-01-10、`M5` 目标 2027-01-20；均为内部开发目标，实际赛事验收节点待组委会确认）。 [唯一标准能力矩阵](docs/T87_CONFORMANCE_PLAN.md) · [分阶段兼容路线](docs/ROADMAP.md)

## 3. M3-A 验证与复审材料汇总

- **三后端核心与 `36bb9e6` 全量实测**：核心测试 Native / JS / Wasm GC 各 **18/18**（`--deny-warn` 0 警告）；官方 Annex E **6/12**（`E.2-1`、`E.2-4`、`E.2-9`–`E.2-12`）通过 HP 1.00 与 CharLS Wasm 0.10.0 双参考双向验收（18 次候选编码与官方流逐字节一致，`E.2-2, 3, 5, 6, 7, 8` 返回 `UnsupportedFeature`）；M3-A 黄金回归（7 正例 + 7 负例）、M2 388 正例全量矩阵（含 `lse-after-scan` 更新为 `InvalidData`）、640 组 NEAR 矩阵、Native 多扫描首分量实时行交付与 Chrome 158 工作台全项通过。
- **CI 自动运行范围**：每次推送运行三后端 18/18 核心测试、Native 逐行/多扫描/尾部回归、Worker/SDK/TS 严格检查、Annex E 清单检查、`verify_m2_golden.mjs`、`verify_m3a_golden.mjs` 与 640 组 NEAR 矩阵。
- **MoonBit 原生实现统计与包消费边界**：17 个 `.mbt` 文件共 **6,764 行**（[docs/MOONBIT_IMPLEMENTATION_MAP.md](docs/MOONBIT_IMPLEMENTATION_MAP.md)）；`moon package --frozen` 打包无警告通过，Mooncakes 在线查询返回 HTTP 404 / `not found`（未线上发布）。 [Mooncakes 准备记录](docs/MOONCAKES_RELEASE.md)

## 4. 历史本地候选版归档（仅供追溯，保持原貌）

- **2026-11-24 RC3**：固定受测源码 `2feb00b8ef657b7259ba70bccf1ff0ceaf08765b`（分支 `antigravity/rc3-20261124`），交付 64 KiB 参考行窗口与工作台修复。 [RC3 实测](reports/rc3/README.md) · [RC3 交接](docs/RC3_HANDOFF.md)
- **RC2**：固定受测源码 `a146998f31675769fb6c3bc9055ef7798f254b1d`，完成两项宿主修复与解码 Worker 调度优化。 [RC2 实测](reports/rc2/README.md) · [RC2 交接](docs/RC2_HANDOFF.md)
- **2026-11-23 rc.1**：Git 标签 `v0.1.0-rc.1`，验证初期 8/12/16 位 NEAR=0–3 与 100 张合成语料。 [干净检出记录](reports/RELEASE_CHECK.md) · [历史验证](docs/VALIDATION.md)
