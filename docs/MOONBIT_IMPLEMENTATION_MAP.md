# MoonJLS 实现地图

JPEG-LS 编解码、熵位流与扫描状态机位于 MoonBit。Native CLI 直接链接核心，JS 与 Wasm GC 通过 MoonBit 桥接调用相同的实现。

| 职责 | 手写 MoonBit 入口 | 定位符号 |
| --- | --- | --- |
| 精度、有效 MAXVAL、采样几何和资源限额 | [core/parameters.mbt](../core/parameters.mbt) | FrameInfo、component_width、component_height、resolve_preset |
| MED 预测、梯度、共享上下文和预测行 | [core/model.mbt](../core/model.mbt) | Scan、med_predict、update_regular、next_line_or_finish |
| 规则和游程模式、ILV=2 联合游程 | [core/encoder.mbt](../core/encoder.mbt) · [core/decoder.mbt](../core/decoder.mbt) | Encoder::step、sample_vector、Decoder::step、advance_scan |
| Golomb-Rice、FF 位填充、SOF55、SOS、LSE1 | [core/bits.mbt](../core/bits.mbt) · [core/markers.mbt](../core/markers.mbt) | BitWriter、BitReader、GolombReader、HeaderParser |
| 公共便捷 API | [core/image.mbt](../core/image.mbt) | encode、decode、encode_scans、decode_multicomponent、inspect |
| Native 管道、PGM 以及码流检查 | [cmd/moonjls/main.mbt](../cmd/moonjls/main.mbt) · [cmd/moonjls/files.mbt](../cmd/moonjls/files.mbt) | dispatch、encode-pgms、decode-pgms |
| JS 和 Wasm GC 编译入口 | [cmd/bridge/bridge.mbt](../cmd/bridge/bridge.mbt) | encoder_builder、decoder_component、decoder_scan |
| 交错、补行和分块测试 | [core/interleave_wbtest.mbt](../core/interleave_wbtest.mbt) · [core/stream_wbtest.mbt](../core/stream_wbtest.mbt) | EOI、游程、非法组合、水位与工作区 |

[SDK](../sdk/index.mjs) 管理类型与缓冲，[Worker](../sdk/worker.mjs)管理逐行交付、背压和取消，[工作台](../web/app.mjs)负责预览和核验。这些是手写宿主 JS。sdk/generated/core.mjs、sdk/generated/core.wasm 与 web/dist 由构建生成。比对脚本、测试夹具和报告另列。[构建脚本](../sdk/build.mjs) · [Linguist 属性](../.gitattributes) · [测试结果](CONFORMANCE_RESULTS.md)
