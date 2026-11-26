# MoonJLS

[English](README.md) · [两分钟评审指南](docs/REVIEWER_GUIDE.md) · [符合性结果](docs/CONFORMANCE_RESULTS.md) · [工作台](https://zsy2221.github.io/moon_jpegls/web/)

MoonJLS 用于高精度整数图像的无损或有界近无损 JPEG-LS 交换。一个 MoonBit 核心同时驱动 Native CLI、JS 与 Wasm GC SDK。核心保留预测行，命令行管道和 Worker 可以在输入仍到达时交付重建行。

## 运行工作台

在仓库根目录执行以下命令。

~~~sh
node sdk/build.mjs
node web/build.mjs
python -m http.server 8000 --bind 127.0.0.1 --directory web/dist
~~~

打开[本机工作台](http://127.0.0.1:8000/web/)，加载 8 位或 16 位显微图像，选择 ILV 和 NEAR 后运行。扫描检查器展示实际编码次序和分量尺寸，误差计算使用原始整数样本。可下载 JPEG-LS 码流与运行报告。[浏览器检查](web/README.md)

Native CLI 可从管道压缩一张小图并检查结果。

~~~sh
printf 'P5\n3 2\n255\n\000\177\377\001\052\020' |
  moon run --target native cmd/moonjls -- encode-pgm 0 - sample.jls 7
moon run --target native cmd/moonjls -- inspect sample.jls --json
~~~

有 H/V 采样的图像可从独立分量 PGM 编码，并解码到各自尺寸的 PGM。[CLI 与 SDK 接口](docs/API.md) · [流式管道示例](examples/stream_pipeline.sh) · [MoonBit 消费示例](examples/consumer/README.md)

## 已验收范围

| 阶段 | 交付能力 | 核验记录 |
| --- | --- | --- |
| M2 | 2–16 位编码精度、独立 MAXVAL、合法 NEAR、LSE1 预置 | [388 组 M2 矩阵](reports/t87-m2-20261125/synthetic-matrix.md) |
| M3-A | 多分量非交错扫描、跨扫描 LSE1 默认值 | [M3-A 验收](reports/t87-m3a-20261125/README.md) |
| M3-B | ILV=1 行交错、ILV=2 样本交错、H/V 采样与边缘 MCU | [JS、Wasm GC、Native 的官方 Annex E 12/12](docs/CONFORMANCE_RESULTS.md) |

HP 1.00 独立双向验证了全部 12 条。CharLS Wasm 0.10.0 验证其支持的 10 条，E.2-7/8 的采样超出该参考版本的能力。报告记录源码、产物、输入、重建和候选码流的身份。NASA LOLA 是公开高程数据实验，核对同一码流的 1,036,800 个重建样本。[复跑与证据](docs/CODEX_M3B_HANDOFF.md) · [LOLA 数据出处](tests/fixtures/LUNAR_DATA.md)

~~~sh
moon test core --target js --deny-warn
moon test core --target wasm-gc --deny-warn
CC=clang moon test core --target native --deny-warn
~~~

纯 MoonBit 编解码实现位于[编码器](core/encoder.mbt)、[解码器](core/decoder.mbt)与[上下文模型](core/model.mbt)。[Native CLI](cmd/moonjls/main.mbt)链接同一个核心，[MoonBit 桥接](cmd/bridge/bridge.mbt)生成 JS 与 Wasm GC 产物。[SDK](sdk/index.mjs)、[Worker](sdk/worker.mjs)与[工作台](web/app.mjs)负责宿主传输和呈现。[实现地图](docs/MOONBIT_IMPLEMENTATION_MAP.md)

## T.87 Part 1 路线

最终目标是完整的 ITU-T T.87 / ISO/IEC 14495-1 Part 1 编码、解码和数据格式能力。官方 Annex E 全部使用 Pt=0。后续按阶段实现非零点变换、映射表、简略和表规范格式、重启、DNL、扩展尺寸，并完成完整 §8 验收。[阶段路线](docs/ROADMAP.md) · [支持范围](docs/SCOPE.md) · [Mooncakes 包状态](docs/MOONCAKES_RELEASE.md)
