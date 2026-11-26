# MoonJLS 复审事实清单

2026-11-26（Asia/Singapore）。飞书的新项目申报字段《项目申报书》要求 Markdown、一页以内、由参赛者独立撰写。此文件供负责人核对事实、源码和测试证据。[当前表单](https://bxup9uklfcb.feishu.cn/share/base/form/shrcnWUMlgpbwHaXgzV7HmNhNhg)

## 初审反馈与当前增量

- 初审指出，既有材料只确立了受限 JPEG-LS 子集，缺少完整 T.87 符合性终点和阶段兼容路径。项目现将完整 ITU-T T.87 / ISO/IEC 14495-1 Part 1 的编码、解码和数据格式作为终点，逐阶段给出范围、用例、独立参考和退出条件。日期是项目内部工作目标。[标准计划](../../docs/T87_CONFORMANCE_PLAN.md) · [阶段路线](../../docs/ROADMAP.md)
- M2 已验证 2–16 位精度、独立 MAXVAL、合法 NEAR 及 LSE1。M3-A 已验证多分量非交错多扫描和跨扫描预置。M3-B 新增 ILV=1 行交错、ILV=2 样本交错、H/V 采样及边缘 MCU。原始有效分量样本在补行被消耗后依真实尺寸交付。算法和状态机是 MoonBit，Native、JS、Wasm GC 共用核心。[实现地图](../../docs/MOONBIT_IMPLEMENTATION_MAP.md) · [支持范围](../../docs/SCOPE.md)
- NASA LOLA 是公开高程数据实验。固定码流的 1,036,800 个样本在三后端与 CharLS 的重建一致。另有显微图像工作台示例，可观察整数样本、误差、扫描和分量几何。[LOLA 原始结果](../../reports/t87-m3b-20261126/lola-fixed-sampling-candidate.json) · [工作台](https://zsy2221.github.io/moon_jpegls/web/)

## 官方验收

| 官方向量 | 范围 | JS / Wasm GC / Native 编码和解码 | 独立参考 |
| --- | --- | --- | --- |
| E.2-1、4 | 三分量 ILV=0，NEAR=0/3 | 三后端双向通过 | HP、CharLS Wasm |
| E.2-2、5 | 三分量 ILV=1，NEAR=0/3 | 三后端双向通过 | HP、CharLS Wasm |
| E.2-3、6 | 三分量 ILV=2，NEAR=0/3 | 三后端双向通过 | HP、CharLS Wasm |
| E.2-7、8 | H/V 采样与 ILV=1，NEAR=0/3 | 三后端双向通过 | HP；CharLS 返回 reference_unsupported |
| E.2-9、10 | 非默认 LSE1，NEAR=0/3 | 三后端双向通过 | HP、CharLS Wasm |
| E.2-11、12 | 有效 12 位的 TEST16，NEAR=0/3 | 三后端双向通过 | HP、CharLS Wasm |

全部 36 份候选流与对应官方码流逐字节一致。本机运行 HP 1.00 解码并逐样本核对。GitHub Actions 实跑三后端编解码，E.2-7/8 使用官方字节及固定的历史 HP 重建哈希。完整 388 组 M2、640 组 NEAR、Native 交付与尾部、Worker/SDK/TypeScript 和 Chrome 测试的执行版本见交接与报告。[逐条结果](../../docs/CONFORMANCE_RESULTS.md) · [固定候选、报告与命令](../../docs/CODEX_M3B_HANDOFF.md)

## 剩余范围与退出条件

| 阶段 | 剩余工作 | 退出条件与风险处理 |
| --- | --- | --- |
| Pt 专项 | 非零点变换和两域误差语义 | 独立向量验证有效精度、余数、误差与流式切分。参考缺失时使用可审计的规范短向量或第二实现 |
| M4 | 映射表与续表、简略和表规范格式、重启、DNL、扩展尺寸和剩余标记语法 | 逐项通过有效、损坏、断流恢复和资源上限用例。独立参考按能力选用，保留不支持记录 |
| M5 | 完整 Part 1 §8 验收 | 必选能力按编码、解码、格式和三后端逐项通过。干净环境可复跑并能追溯源、产物、参考与样本哈希 |

Annex E 12 条均为 Pt=0。测试范围与剩余 Part 1 矩阵均在仓库公开。[能力清单](../../tests/conformance/manifest.json) · [ITU-T T.87](https://www.itu.int/rec/T-REC-T.87-199806-I/en)

## 发布与协作事实

- GitHub 的合入提交与 PR 检查由 PR 记录，main 构建和部署由 Actions 记录。Mooncakes 候选版本为 `ZSY2221/moon_jpegls@0.1.0`，线上发布、离线消费和匿名查询分别记录。[main](https://github.com/ZSY2221/moon_jpegls/tree/main) · [PR #2](https://github.com/ZSY2221/moon_jpegls/pull/2) · [main Actions](https://github.com/ZSY2221/moon_jpegls/actions/workflows/verification.yml?query=branch%3Amain) · [Mooncakes 状态](../../docs/MOONCAKES_RELEASE.md)
- Antigravity 实现 M3-A 和首版 ILV=1。Codex 接手后保全并复验 ILV=1，完成 ILV=2、H/V、边缘 MCU、独立复跑、工作台和公共交付。负责人负责选题、标准路线、仓库治理及申报决策。人工逐项复核进度由负责人自己确认。[协作记录](07_AI_DEVELOPMENT_DISCLOSURE.md)