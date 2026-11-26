# MoonJLS 两分钟评审指南

MoonJLS 面向科研栅格、高程数据等整数图像的 JPEG-LS 无损和有界近无损交换。一个 MoonBit 内核驱动 Native CLI、JS 与 Wasm GC SDK。流式解码允许下游在收到完整帧之前逐行接收重建。[源码地图](MOONBIT_IMPLEMENTATION_MAP.md)

## 一次运行

可打开公开工作台，或从仓库根目录构建同一工作台。[工作台](https://zsy2221.github.io/moon_jpegls/web/) · [部署记录](https://github.com/ZSY2221/moon_jpegls/deployments)

~~~sh
node sdk/build.mjs
node web/build.mjs
python -m http.server 8000 --bind 127.0.0.1 --directory web/dist
~~~

打开本机工作台的 `/web/`。选 16 位显微样例，设置 ILV=2 和 NEAR 后运行，检查扫描次序、分量尺寸、原始整数、重建整数和误差，再下载码流或运行报告。选择「采样 JPEG-LS」可观察 H/V、实际分量尺寸和末组补行。兼容证据区提供当前构建、固定源码和支持范围。[工作台说明](../web/README.md) · [16 位实跑截图](../reports/t87-m3b-20261126/public-delivery/microscopy-16-ilv2.png) · [采样结构截图](../reports/t87-m3b-20261126/public-delivery/microscopy-sampled-structure.png)

## 从初审意见到当前证据

早期材料确立了受限 JPEG-LS 子集，对完整标准目标与阶段兼容路径交代不足。MoonJLS 将完整 ITU-T T.87 / ISO/IEC 14495-1 Part 1 的编码、解码和数据格式能力作为最终目标，并为各阶段规定独立参考和可复跑退出条件。[标准计划](T87_CONFORMANCE_PLAN.md) · [阶段路线](ROADMAP.md)

| 已交付阶段 | 可审查证据 |
| --- | --- |
| M2 编码精度、MAXVAL、NEAR 及 LSE1 | [388 组独立矩阵](../reports/t87-m2-20261125/synthetic-matrix.md) |
| M3-A 多分量非交错多扫描与扫描间参数 | [三后端验收](../reports/t87-m3a-20261125/README.md) |
| M3-B 行交错、样本交错、H/V 采样及边缘 MCU | [官方 12 条逐项证据](CONFORMANCE_RESULTS.md) |
| 无映射 Pt 与精确 32 位输出 | [独立参考、65,540 样本与复跑](POINT_TRANSFORM_RESULTS.md) |
| 内嵌 Wt=1 映射表解码 | [LSE2/LSE3、重定义和逐分量选择](EMBEDDED_MAPPING_RESULTS.md) |

JS、Wasm GC、Native 在固定候选上对 Annex E 12 条均通过独立 HP 1.00 编码和解码验收，候选码流与官方逐字节一致。CharLS Wasm 0.10.0 复验支持的 10 条。E.2-7/8 使用 HP，CharLS 的采样能力单列。工作台的原图比较由本次运行实际执行，兼容视图展示固定候选的独立参考档案。[报告和重跑入口](CODEX_M3B_HANDOFF.md)

## 可继续核对

- 三后端执行 MoonBit 核心、黄金流、Native 流式尾部、SDK/Worker、TypeScript 和浏览器检查。官方向量来源、哈希、验收命令与 CI 的实际参考范围由[符合性结果](CONFORMANCE_RESULTS.md)说明。
- NASA LOLA 用于公开数据实验。固定码流的 1,036,800 个样本已由三后端和 CharLS 重建核对。[LOLA 数据](../tests/fixtures/LUNAR_DATA.md)
- 12 条 Annex E 均使用 Pt=0。非零 Pt 和内嵌映射各有独立证据。后续分项包括映射编码、多字节表项、外部表与简略格式、重启、DNL 和扩展尺寸，并按 §8 完成完整 Part 1 核验。路线日期为项目内部目标。[范围](SCOPE.md) · [路线](ROADMAP.md)
- [M3-B PR #2](https://github.com/ZSY2221/moon_jpegls/pull/2) · [Pt PR #3](https://github.com/ZSY2221/moon_jpegls/pull/3) · [映射 PR #4](https://github.com/ZSY2221/moon_jpegls/pull/4) · [最新交付与 Mooncakes](MOONCAKES_RELEASE.md)
