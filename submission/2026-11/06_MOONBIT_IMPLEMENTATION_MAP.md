# MoonJLS MoonBit 原生实现地图（评委可点击源码直达版）

本文档与仓库 [`docs/MOONBIT_IMPLEMENTATION_MAP.md`](../../docs/MOONBIT_IMPLEMENTATION_MAP.md) 同源同步，所有链接直接指向 GitHub 公开默认分支 `main` 下的真实 MoonBit 源码。

## 1. 核心声明：MoonBit 是 MoonJLS 的唯一编解码实现语言

- 全部 **6,764 行 `.mbt` 源码（17 个文件，200,976 字节）** 承担 100% 的 JPEG-LS Part 1 核心算法、M3-A 多扫描状态机、Native CLI 与 JS/Wasm GC 导出口。
- `sdk/*.mjs`（7 个运行时文件，1,486 行）与 `web/*.mjs`（9 个 UI 运行时文件，2,848 行）**不包含任何一行 JPEG-LS 预测、上下文更新、Golomb 或位填充代码**，仅负责宿主加载、Worker 背压、P6 PPM 宿主平面转换与界面展示。

## 2. 可点击源码直达索引

| 模块 | 职责与核心符号 | 直达 GitHub 源码链接 | 行数 |
| --- | --- | --- | ---: |
| 帧/扫描参数与结构 | `Frame`、`FrameInfo`、`ComponentSpec`、`ScanSpec`、`ScanInfo`、`StreamStructure`、`ErrorLocation`、`validate_frame_dimensions` | [core/parameters.mbt](https://github.com/ZSY2221/moon_jpegls/blob/main/core/parameters.mbt) | 407 |
| 预测与上下文建模 | `Scan`、`med_predict`、`quantize_gradient`、`Scan::context_id`、`Scan::update_regular`、`Scan::update_run`、`golomb_order`、`Scan::workspace_bytes` | [core/model.mbt](https://github.com/ZSY2221/moon_jpegls/blob/main/core/model.mbt) | 344 |
| 位流与标记写出 | `BitWriter`、`BitWriter::frame_header`、`BitWriter::lse1`、`BitWriter::scan_header_for`、`BitWriter::finish_scan`、`BitReader::reset` | [core/bits.mbt](https://github.com/ZSY2221/moon_jpegls/blob/main/core/bits.mbt) | 262 |
| 流式标记解析器 | `HeaderParser`、`HeaderParser::begin_inter_scan`、`frame_segment`、`preset_segment`、`scan_segment`（支持多扫描与跨扫描 LSE1） | [core/markers.mbt](https://github.com/ZSY2221/moon_jpegls/blob/main/core/markers.mbt) | 420 |
| 多扫描流式编码器 | `Encoder`、`Encoder::new`、`Encoder::new_multicomponent`、`Encoder::scan_index`、`Encoder::step` | [core/encoder.mbt](https://github.com/ZSY2221/moon_jpegls/blob/main/core/encoder.mbt) | 892 |
| 多扫描流式解码器 | `Decoder`、`Decoder::step`、`Decoder::frame_info`、`Decoder::scans`、`Decoder::structure`、`Decoder::error_location` | [core/decoder.mbt](https://github.com/ZSY2221/moon_jpegls/blob/main/core/decoder.mbt) | 1,020 |
| 整图便捷接口 | `encode`、`decode`、`decode_with_preset`、`encode_multicomponent`、`decode_multicomponent`、`inspect` | [core/image.mbt](https://github.com/ZSY2221/moon_jpegls/blob/main/core/image.mbt) | 211 |
| MoonBit 白盒单元测试 | 三后端各跑 18/18 回归（单/多扫描、LSE1 继承/零重置、`0xFF 0x00` 切分、工作区、负数边界） | [multiscan_wbtest.mbt](https://github.com/ZSY2221/moon_jpegls/blob/main/core/multiscan_wbtest.mbt) · [preset_wbtest.mbt](https://github.com/ZSY2221/moon_jpegls/blob/main/core/preset_wbtest.mbt) · [stream_wbtest.mbt](https://github.com/ZSY2221/moon_jpegls/blob/main/core/stream_wbtest.mbt) · [workspace_wbtest.mbt](https://github.com/ZSY2221/moon_jpegls/blob/main/core/workspace_wbtest.mbt) | 930 |
| Native CLI 与多扫描 IO | `encode-planar`、`encode-pgms`、`encode-ppm`、`decode-pgms`、`inspect`/`verify --json`、`Source` | [cmd/moonjls/main.mbt](https://github.com/ZSY2221/moon_jpegls/blob/main/cmd/moonjls/main.mbt) · [files.mbt](https://github.com/ZSY2221/moon_jpegls/blob/main/cmd/moonjls/files.mbt) | 1,329 |
| JS / Wasm GC FFI 桥 | `encoder_builder_*`、`decoder_component_*`、`decoder_scan_*`、`decoder_structure_offset`、`decoder_error_*` | [cmd/bridge/bridge.mbt](https://github.com/ZSY2221/moon_jpegls/blob/main/cmd/bridge/bridge.mbt) | 800 |
| 独立消费与 Gray16 适配 | 外部包依赖及 `MoonImage Gray16` 适配 | [gray16.mbt](https://github.com/ZSY2221/moon_jpegls/blob/main/examples/consumer/gray16/gray16.mbt) · [main.mbt](https://github.com/ZSY2221/moon_jpegls/blob/main/examples/consumer/main.mbt) · [consumer_m2.mbt](https://github.com/ZSY2221/moon_jpegls/blob/main/tests/conformance/consumer_m2.mbt) | 149 |
