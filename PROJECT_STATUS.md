# MoonJLS 工程状态

状态日期：**2026-11-25**。项目当前由 **Antigravity** 担任唯一主力 AI 维护助手，参赛者/项目负责人（`ZSY2221`）负责最终技术决策、标准边界确认与提交审核。

## 1. GitHub 分支、提交基线与 PR 状态

| 条目 | 实际标识与说明 |
| --- | --- |
| 公开仓库 | `https://github.com/ZSY2221/moon_jpegls` |
| 受测 M2 产品源码提交 | [`fc43bc2b4ed69cad9d967e63c2019ff1e8f3be44`](https://github.com/ZSY2221/moon_jpegls/commit/fc43bc2b4ed69cad9d967e63c2019ff1e8f3be44)（`core/`、`cmd/`、`sdk/`、`web/` 自此提交后未变动） |
| M2 证据冻结基线提交 | [`a7d8c391b7af0d88bc5c912ed62c78eaf4c79565`](https://github.com/ZSY2221/moon_jpegls/commit/a7d8c391b7af0d88bc5c912ed62c78eaf4c79565)（原有 CI run [`45566033737`](https://github.com/ZSY2221/moon_jpegls/actions/runs/45566033737) 通过） |
| 现有开放 PR | [PR #1](https://github.com/ZSY2221/moon_jpegls/pull/1)（Open、可无冲突合并；head 分支为 `codex/moonjls-reappeal-20261125`，base 为 `main`） |
| 复审与同步分支 | `codex/moonjls-reappeal-20261125` 与 `antigravity/t87-m2-20261125`（本轮复审文档、CI 黄金回归与报名材料均同步推送至此二分支最新 HEAD） |
| 仓库默认分支 `main` | `60befa604287d941dc75ffde03a4c52ab80a93ad`（仍为 M2 之前旧版；本轮不自动合并 `main`，需项目负责人审核 PR #1 后决定是否合并） |
| 原 Windows 工作区 | `D:\Program Files\GPT_project\moon_jpegls` 原有未提交修改及草稿文件保持原样保留；本轮全部审计、CI 补强与文档定稿在独立工作树完成 |

## 2. 里程碑完成状态（M0–M2 已完成，M3-A–M5 为后续目标）

- **M0（已完成）**：纯 MoonBit 核心、Native/JS/Wasm GC 三后端、流式状态机、CLI/Worker/工作台与 `16a7b49` 三处正确性修复。 [M0 复验证据](reports/review-fix-20261125/README.md)
- **M1（已完成）**：原有满量程 8/12/16 位（8 位 `NEAR=0–127`、12/16 位 `NEAR=0–255`）全部 **640 组**在三后端完成固定 CharLS 双向验证（640/640）。**注：该 640 组是历史满量程 NEAR 回归，不是当前 M2 全参数空间笛卡尔积。** [M1 证据](reports/review-near-20261125/README.md)
- **M2（已完成，2026-11-25）**：实现单帧、单分量、单扫描（`ILV=0`、`Pt=0`）的 **`P=2–16`、独立 `MAXVAL`、基于有效 MAXVAL 的合法 `NEAR`、以及 `LSE ID=1` 自定义 `T1/T2/T3/RESET`**；工作台交付 Precision Lab、Streaming Lab、Compatibility Lab。受测源码 [`fc43bc2`](https://github.com/ZSY2221/moon_jpegls/commit/fc43bc2b4ed69cad9d967e63c2019ff1e8f3be44)。 [M2 验收汇总](reports/t87-m2-20261125/README.md) · [逐项 Annex E](docs/CONFORMANCE_RESULTS.md)
- **最终标准终点与后续开发目标（M3-A 至 M5）**：最终目标是完整实现 **ITU-T T.87（06/1998）/ ISO/IEC 14495-1 JPEG-LS Part 1** 编码、解码与数据格式能力（`M3-A` 目标 2026-12-10、`M3-B` 目标 2026-12-25、`M4` 目标 2027-01-10、`M5` 目标 2027-01-20；均为内部开发目标，实际赛事验收节点待组委会确认）。 [唯一标准能力矩阵](docs/T87_CONFORMANCE_PLAN.md) · [分阶段兼容路线](docs/ROADMAP.md)

## 3. 当前验证与复审材料补强

- **三后端核心与本机独立 M2 验收（基于 `fc43bc2`）**：核心测试 Native/JS/Wasm GC 各 **15/15**；本机独立矩阵 **388 组 M2 正例** + **18 个 LSE 变体** + **7 个非法编码** + **6 项 Native PGM 检查**通过；官方 Annex E **`E.2-9`–`E.2-12`** 三后端编码与解码通过且 12 次候选编码逐字节一致，**`E.2-1`–`E.2-8`** 按当前能力返回 `UnsupportedFeature`；历史 640/640 复跑通过；NASA LOLA **1,036,800** 样本及 Chrome 工作台通过。
- **CI 新增独立参考黄金回归**：在 `.github/workflows/verification.yml` 新增 `scripts/verify_m2_golden.mjs`，固定校验来自官方 HP V.1.00 与 T.87 Annex A 向量的 **12 组代表性黄金正例 + 18 个 LSE 变体 + 7 个非法编码边界 + 4 项 Native PGM 检查**（JS / Wasm GC / Native），与历史 640 组 NEAR 矩阵及清单校验共同随每次推送运行。
- **MoonBit 原生实现地图与黑客松复审材料**：已补齐 [docs/MOONBIT_IMPLEMENTATION_MAP.md](docs/MOONBIT_IMPLEMENTATION_MAP.md)（`.mbt` 源码 16 文件 4,528 行详细模块与 LOC 统计）、[docs/REVIEWER_GUIDE.md](docs/REVIEWER_GUIDE.md) 及 [`submission/2026-11/`](submission/2026-11/02_FORM_FIELDS.md) 全套复审与表单填报材料。
- **Mooncakes 包消费状态**：`0.1.0` 本地归档回环 registry 消费通过三后端验证；Mooncakes 线上查询仍返回 HTTP 404，未经明确授权不执行线上发布。 [Mooncakes 准备记录](docs/MOONCAKES_RELEASE.md)

## 4. 历史本地候选版归档（仅供追溯，保持原貌）

- **2026-11-24 RC3**：固定受测源码 `2feb00b8ef657b7259ba70bccf1ff0ceaf08765b`（分支 `antigravity/rc3-20261124`），交付 64 KiB 参考行窗口与工作台修复。 [RC3 实测](reports/rc3/README.md) · [RC3 交接](docs/RC3_HANDOFF.md)
- **RC2**：固定受测源码 `a146998f31675769fb6c3bc9055ef7798f254b1d`，完成两项宿主修复与解码 Worker 调度优化。 [RC2 实测](reports/rc2/README.md) · [RC2 交接](docs/RC2_HANDOFF.md)
- **2026-11-23 rc.1**：Git 标签 `v0.1.0-rc.1`，验证初期 8/12/16 位 NEAR=0–3 与 100 张合成语料。 [干净检出记录](reports/RELEASE_CHECK.md) · [历史验证](docs/VALIDATION.md)
