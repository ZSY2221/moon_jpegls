# MoonJLS 评审指南（两分钟完整审查入口）

本文档专为比赛评委与技术审查人员编写，可独立阅读，直接回应初审驳回意见并给出所有可验证链接与复现命令。

## 1. 对初审驳回意见的逐条回应

原初审意见：*“高位深科研图像保存具有明确用途，纯 MoonBit 编解码与流式状态管理也有实质贡献；但材料仅确立受限 JPEG-LS 子集，后续计划未包含完整 T.87 标准符合性目标，尚不满足本轮格式实现的终点要求。需补明最终标准范围与分阶段兼容路径。”*

1. **最终标准范围**：**MoonJLS 的最终目标是完整实现 ITU-T T.87（06/1998）/ ISO/IEC 14495-1 JPEG-LS Part 1 的编码、解码和数据格式能力**，并通过 `§8.2`/`§8.3`、Annex E 及独立参考实现逐阶段验收。当前 M2 是演进路线上的阶段交付，绝不是最终标准范围。T.870 Part 2 与 DICOM 属独立扩展，SPIFF（`§4.8`/`Annex H.5`）按可选容器单列。 [完整标准目标与能力矩阵](T87_CONFORMANCE_PLAN.md)
2. **分阶段兼容路线与严格退出条件**：M0（基线与修复）、M1（满量程 NEAR 扩展，640/640）、M2（`P=2–16`、独立 `MAXVAL`、合法 `NEAR`、`LSE1` 自定义预设）**均已完成**；后续按 **M3-A**（多分量与非交错多扫描，目标 2026-12-10，首要验收 `E.2-1`/`E.2-4`）→ **M3-B**（交错 `ILV=1/2`、采样因子、`Pt`，目标 2026-12-25，首要验收 `E.2-2`/`E.2-3`/`E.2-5`–`E.2-8`）→ **M4**（`LSE2/3` 映射表及续表、简略与表规范格式、`DRI/RST`、`DNL`、`LSE4`、剩余标记，目标 2027-01-10）→ **M5**（完整 Part 1 符合性验收，目标 2027-01-20）推进。日期均为内部工程目标，最终赛事验收时间以组委会明确为准。 [分阶段兼容路线](ROADMAP.md)
3. **MoonBit 原生实现证据**：100% JPEG-LS 算法、预测/上下文建模、Golomb/位填充、流式状态机、Native CLI 与 JS/Wasm GC FFI 端口全部由纯 MoonBit 编写（`16` 个 `.mbt` 文件，共 **4,528 行**）；JS 仅承担宿主加载、Worker 背压协议、报告格式化与浏览器工作台 UI，不含编解码数学逻辑。 [MoonBit 原生实现地图](MOONBIT_IMPLEMENTATION_MAP.md)

## 2. 当前 M2 已交付能力与真实验证口径

- **M2 实现范围**（受测产品源码 [`fc43bc2`](https://github.com/ZSY2221/moon_jpegls/commit/fc43bc2b4ed69cad9d967e63c2019ff1e8f3be44)）：单帧、单分量、单扫描、`ILV=0`、`Pt=0`、`P=2–16`、独立 `MAXVAL`、`NEAR` 按有效 `MAXVAL` 合法约束、`LSE ID=1` 默认及自定义 `T1/T2/T3/RESET`，全链路覆盖 Native、JS、Wasm GC、CLI、SDK、Worker 及科学工作台（Precision Lab / Streaming Lab / Compatibility Lab）。
- **全部真实实测记录**（M2 证据冻结提交 [`a7d8c39`](https://github.com/ZSY2221/moon_jpegls/commit/a7d8c391b7af0d88bc5c912ed62c78eaf4c79565) 及本轮 CI 黄金集补强）：
  1. **三后端核心测试**：Native / JS / Wasm GC 各 **15/15** 通过。
  2. **M2 本机独立合成矩阵**：**388 组 M2 新增正例**（HP V.1.00 与 `MAXVAL=1,2` 独立 Annex A 向量）+ **18 个 LSE 码流变体** + **7 个非法编码用例** + **6 项 Native PGM 检查**在三后端全部通过。 [M2 合成矩阵](../reports/t87-m2-20261125/synthetic-matrix.md)
  3. **CI 固定独立黄金回归**：GitHub Actions 在每次推送自动于三后端运行 **12 组代表性独立 HP/Annex A 黄金用例 + 18 个 LSE 变体 + 7 个非法编码 + 4 项 Native PGM**（[`scripts/verify_m2_golden.mjs`](../scripts/verify_m2_golden.mjs)）。
  4. **历史满量程 NEAR 回归**：**640/640** 复跑通过（**仅针对满量程 8/12/16 位 NEAR，不是 M2 全部参数空间笛卡尔积**）。
  5. **官方 Annex E Table E.2**：**`E.2-9`–`E.2-12`** 在三后端编码与解码通过，12 次候选编码与官方流逐字节一致；**`E.2-1`–`E.2-8`**（多分量）按范围返回 `UnsupportedFeature`（编码未运行）。CI 当前仅检查清单结构，完整 12 条 ITU 流由本机实跑留存。 [Annex E 逐项结果](CONFORMANCE_RESULTS.md)
  6. **NASA LOLA 与真实浏览器**：**1,036,800** 个 16 位月面高程样本完成真实逐样本核对（`NEAR=0–3`）；Chrome 158 完成真实 M2 参数、下载、误差热图与取消重启验收。 [M2 验收汇总](../reports/t87-m2-20261125/README.md)
  7. **包发布边界**：`0.1.0` 本地归档回环 registry 三后端消费通过；Mooncakes 线上查询返回 HTTP 404（尚未执行线上发布）。 [Mooncakes 记录](MOONCAKES_RELEASE.md)

## 3. 最快独立复现（从仓库根执行）

```sh
# 核心测试（JS / Wasm GC / Native）
moon test core --target js --deny-warn
moon test core --target wasm-gc --deny-warn
CC=clang moon test core --target native --deny-warn

# 构建 SDK、工作台与 Native CLI，并执行 CI 同款独立 M2 黄金回归
CC=clang moon build cmd/moonjls --target native --release
node sdk/build.mjs
node web/build.mjs
node scripts/validate_annex_e.mjs --check-manifest
node scripts/verify_m2_golden.mjs --native-exe _build/native/release/build/cmd/moonjls/moonjls.exe

# 本地启动科学工作台（打开 http://127.0.0.1:8000/web/）
python -m http.server 8000 --bind 127.0.0.1 --directory web/dist
```

## 4. 关键审查入口索引

- **代码审查 PR**：[Pull Request #1](https://github.com/ZSY2221/moon_jpegls/pull/1)（`codex/moonjls-reappeal-20261125` → `main`；注意当前仓库首页 `main` 分支仍停留在旧提交 `60befa6`，最新复审成果位于 PR #1 与 `codex/moonjls-reappeal-20261125` / `antigravity/t87-m2-20261125` 分支）
- **核心规范与路线**：[T87_CONFORMANCE_PLAN.md](T87_CONFORMANCE_PLAN.md) · [ROADMAP.md](ROADMAP.md) · [SCOPE.md](SCOPE.md) · [CONFORMANCE_RESULTS.md](CONFORMANCE_RESULTS.md)
- **源码与状态**：[MOONBIT_IMPLEMENTATION_MAP.md](MOONBIT_IMPLEMENTATION_MAP.md) · [PROJECT_STATUS.md](../PROJECT_STATUS.md) · [reports/t87-m2-20261125/README.md](../reports/t87-m2-20261125/README.md)
