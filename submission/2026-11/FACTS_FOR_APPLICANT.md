# MoonJLS 复审事实清单

2026-11-26（Asia/Singapore）。已在飞书实际表单核对《项目申报书》要求。Markdown 一页以内，不使用 AI 编写，至少列出三个完整的预期使用场景，仓库有不少于十个有效提交。表单提供「查看提交记录」入口。本清单供负责人核对事实、源码和证据后，亲自修改原记录。[当前表单](https://bxup9uklfcb.feishu.cn/share/base/form/shrcnWUMlgpbwHaXgzV7HmNhNhg)

## 初审反馈与当前增量

MoonJLS 面向科研栅格和高位深整数图像的 JPEG-LS 无损或有界近无损交换。Native 管道和浏览器 Worker 可在流终结前逐行交付暂定重建，格式与尾随校验完成后确认结果。[MoonBit 实现地图](../../docs/MOONBIT_IMPLEMENTATION_MAP.md) · [工作台](https://zsy2221.github.io/moon_jpegls/web/)

- 初审认可项目用途及 MoonBit 核心贡献，并指出既有材料只确立了受限 JPEG-LS 子集，缺少完整 T.87 终点和阶段兼容路径。项目将完整 ITU-T T.87 / ISO/IEC 14495-1 Part 1 的编码、解码和数据格式作为终点，逐阶段给出范围、用例、独立参考和退出条件。路线图日期为内部工作目标。[标准计划](../../docs/T87_CONFORMANCE_PLAN.md) · [阶段路线](../../docs/ROADMAP.md)
- M2 已验证 2–16 位精度、独立 MAXVAL、合法 NEAR 及 LSE1。M3-A 已验证多分量非交错多扫描和跨扫描预置。M3-B 新增 ILV=1 行交错、ILV=2 样本交错、H/V 采样及边缘 MCU。原始有效分量样本在补行被消耗后依真实尺寸交付。算法和状态机是 MoonBit，Native、JS、Wasm GC 共用核心。[实现地图](../../docs/MOONBIT_IMPLEMENTATION_MAP.md) · [支持范围](../../docs/SCOPE.md)
- 非零 Pt 已验证无映射流的正逆变换和原始域误差界。Native、SDK、Worker 和工作台能精确交付超过 65,535 的重建整数，独立宽样本实测为 65,540。[Pt 结果、参考与复跑](../../docs/POINT_TRANSFORM_RESULTS.md)
- M4 首个增量为交换格式内嵌 Wt=1 映射表解码，已支持 LSE2 定义和重定义、LSE3 续表，以及 SOS 按分量选择。P16 已跨 65,530+6 项续表边界，重建报告按编码域索引给出 NEAR。任意查表后的值没有通用 NEAR 误差上界。[映射结果、参考与复跑](../../docs/EMBEDDED_MAPPING_RESULTS.md)
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

全部 36 份候选流与对应官方码流逐字节一致。本机 HP 1.00 实际解码并逐样本核对。CI 实跑三后端编解码，十条即时调用 CharLS Wasm。E.2-7/8 使用官方字节及固定的历史 HP 重建哈希。Annex E 12 条均为 Pt=0。完整 388 组 M2、640 组 NEAR 及流式、Worker/SDK/TypeScript 和 Chrome 回归的执行版本见交付表。[逐条结果](../../docs/CONFORMANCE_RESULTS.md) · [受测版本与发布](../../docs/MOONCAKES_RELEASE.md)

Pt 验收分别使用可直接解码的 FFmpeg 组合、CharLS 编码域适配、手算短向量，以及经 E.2-7/8 校准的独立 Python 参考。采样和宽值不依赖 FFmpeg 的窄输出。映射验收用固定 CharLS 开发版核对两个向量的索引和表字节，并用标准构造向量核对重定义。HP 1.00 不支持直接解码非零 Pt 或内嵌映射。[Pt 参考限制](../../docs/POINT_TRANSFORM_RESULTS.md) · [映射参考限制](../../docs/EMBEDDED_MAPPING_RESULTS.md)

## 剩余范围与退出条件

| 阶段 | 剩余工作 | 退出条件与风险处理 |
| --- | --- | --- |
| M4 映射与简略格式 | 映射编码、不透明多字节表项、C.4 表规范流、C.3 简略图像的外部表生命周期 | 核对编码与解码、多字节输出契约、定义及续表、装载与复用、缺表与错误宽度、生命周期和预算 |
| M4 标记与状态 | DRI/RST、DNL、扩展尺寸和剩余标记语法 | 分别核对重启单位与复位、DNL 终结、有效或超限尺寸、标记位置及截断。以适用参考和独立规范向量验证 |
| M5 | 完整 Part 1 §8 验收 | 必选能力按编码、解码、格式和三后端逐项通过。干净环境可复跑并能追溯源、产物、参考与样本哈希 |

公开能力矩阵分别记录编码、解码、数据格式和参考能力。Annex E 12/12 覆盖官方最小测试组，M4/M5 的完整标准验收按表推进。[能力清单](../../tests/conformance/manifest.json) · [ITU-T T.87](https://www.itu.int/rec/T-REC-T.87-199806-I/en)

## 发布与协作事实

- 本轮受测产品及包源码 `e32c9161b4679656aa1aba7f01374150a1a9951a`。Mooncakes 正式版本为 `ZSY2221/moon_jpegls@0.1.0`，公开查询与 ZIP 校验通过，全新在线安装后 Native、JS、Wasm GC 各通过七项公开 API 检查。GitHub 与工作台部署由 PR 的真实合并提交、main CI 和构建标识核对。[PR #2](https://github.com/ZSY2221/moon_jpegls/pull/2) · [PR #3](https://github.com/ZSY2221/moon_jpegls/pull/3) · [PR #4](https://github.com/ZSY2221/moon_jpegls/pull/4) · [本轮 PR #5](https://github.com/ZSY2221/moon_jpegls/pull/5) · [复审前发布记录](../../docs/MOONCAKES_RELEASE.md)
- Antigravity 实现 M3-A 和首版 ILV=1。Codex 接手后保全并复验 ILV=1，完成 ILV=2、H/V、边缘 MCU、无映射 Pt、宽输出、内嵌映射解码、独立复跑和复审前发布工作。负责人负责选题、标准路线、仓库治理及申报决策；人工复核进度由负责人按实际情况确认。[协作记录](07_AI_DEVELOPMENT_DISCLOSURE.md)

## 原表单提交前核对

- 项目名和仓库填原记录的 MoonJLS 与 GitHub 仓库链接。演示、固定证据和包版本可引用已核验的两分钟指南与发布记录。[仓库](https://github.com/ZSY2221/moon_jpegls) · [演示](https://zsy2221.github.io/moon_jpegls/web/) · [两分钟指南](../../docs/REVIEWER_GUIDE.md)
- 负责人独立写一页 Markdown，按表单核对项目简介、方向与通用性、至少三个完整场景、拟实现功能、原创或参考关系及相应来源和许可证。已实测的材料可从公开高程数据、显微图像交错交换、Native 或 Worker 流式交付三类中核对。具体截止时刻和个人提交记录以实际表单和邮件为准。
