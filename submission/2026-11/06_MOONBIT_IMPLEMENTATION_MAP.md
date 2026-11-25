# MoonJLS MoonBit 原生实现地图（评委可点击源码直达版）

本文档与仓库 [`docs/MOONBIT_IMPLEMENTATION_MAP.md`](../../docs/MOONBIT_IMPLEMENTATION_MAP.md) 同源同步，所有链接直接指向 GitHub 公开默认分支 `main` 下的真实 MoonBit 源码。

## 1. 核心声明：MoonBit 是 MoonJLS 的唯一编解码实现语言

- 全部 **4,528 行 `.mbt` 源码（16 个文件，131,923 字节）** 承担 100% 的 JPEG-LS Part 1 核心算法、流式状态机、Native CLI 与 JS/Wasm GC 导出口。
- `sdk/*.mjs`（7 个运行时文件，1,162 行）与 `web/*.mjs`（7 个 UI 运行时文件，1,974 行）**不包含任何一行 JPEG-LS 预测、上下文更新、Golomb 或位填充代码**，仅负责宿主加载、Worker 背压与界面展示。

## 2. 可点击源码直达索引

| 模块 | 职责与核心符号 | 直达 GitHub 源码链接 | 行数 |
| --- | --- | --- | ---: |
| 参数与预设 | `Frame`、`Preset`、`Limits`、`default_preset`、`resolve_preset`、`Parameters::new` | [core/parameters.mbt](https://github.com/ZSY2221/moon_jpegls/blob/main/core/parameters.mbt) | 281 |
| 预测与上下文建模 | `Scan`、`med_predict`、`quantize_gradient`、`Scan::context_id`、`Scan::update_regular`、`Scan::update_run`、`golomb_order`、`Scan::workspace_bytes` | [core/model.mbt](https://github.com/ZSY2221/moon_jpegls/blob/main/core/model.mbt) | 344 |
| 位流与标记写出 | `BitWriter`、`BitWriter::symbol`、`BitWriter::header`（SOF55/LSE1）、`BitReader`、`GolombReader::read` | [core/bits.mbt](https://github.com/ZSY2221/moon_jpegls/blob/main/core/bits.mbt) | 227 |
| 流式标记解析器 | `HeaderParser`、`frame_segment`、`preset_segment`、`scan_segment`、`accept`（SOI/SOF55/LSE1–4/DRI/SOS/APPn/COM） | [core/markers.mbt](https://github.com/ZSY2221/moon_jpegls/blob/main/core/markers.mbt) | 276 |
| 流式编码器 | `Encoder`、`Encoder::step`、`Encoder::regular`、`Encoder::run_sample`、`Encoder::cancel` | [core/encoder.mbt](https://github.com/ZSY2221/moon_jpegls/blob/main/core/encoder.mbt) | 752 |
| 流式解码器 | `Decoder`、`Decoder::step`、`Decoder::advance_scan`、`Decoder::advance_end`、`Decoder::row` | [core/decoder.mbt](https://github.com/ZSY2221/moon_jpegls/blob/main/core/decoder.mbt) | 835 |
| 整图便捷接口 | `encode`、`decode`、`decode_with_preset` | [core/image.mbt](https://github.com/ZSY2221/moon_jpegls/blob/main/core/image.mbt) | 92 |
| MoonBit 白盒单元测试 | 三后端各跑 15/15 回归（参数/LSE1/全单切分/长游程/EOI/工作区公式） | [preset_wbtest.mbt](https://github.com/ZSY2221/moon_jpegls/blob/main/core/preset_wbtest.mbt) · [stream_wbtest.mbt](https://github.com/ZSY2221/moon_jpegls/blob/main/core/stream_wbtest.mbt) · [workspace_wbtest.mbt](https://github.com/ZSY2221/moon_jpegls/blob/main/core/workspace_wbtest.mbt) | 473 |
| Native CLI 与 PGM IO | `encode_stream`、`decode_stream`、`dispatch`、`Source`、`PgmHeader` | [cmd/moonjls/main.mbt](https://github.com/ZSY2221/moon_jpegls/blob/main/cmd/moonjls/main.mbt) · [files.mbt](https://github.com/ZSY2221/moon_jpegls/blob/main/cmd/moonjls/files.mbt) | 622 |
| JS / Wasm GC FFI 桥 | `EncodePort`、`DecodePort`、`encoder_pack6`、`decoder_pack3` | [cmd/bridge/bridge.mbt](https://github.com/ZSY2221/moon_jpegls/blob/main/cmd/bridge/bridge.mbt) | 477 |
| 独立消费与 Gray16 适配 | 外部包依赖及 `MoonImage Gray16` 适配 | [gray16.mbt](https://github.com/ZSY2221/moon_jpegls/blob/main/examples/consumer/gray16/gray16.mbt) · [main.mbt](https://github.com/ZSY2221/moon_jpegls/blob/main/examples/consumer/main.mbt) · [consumer_m2.mbt](https://github.com/ZSY2221/moon_jpegls/blob/main/tests/conformance/consumer_m2.mbt) | 149 |
