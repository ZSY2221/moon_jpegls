# MoonJLS v2 全栈优化与回归报告

- 分支：`antigravity/v2-perf-polish-20261124`（基于 `antigravity/visual-polish-20261124` @ `40d834f`，原展示精修分支及 `reports/{rc2,rc3,presentation,visual-polish}` 保持冻结未改动）
- 环境：`Node v24.20.0`、`Chrome 158.0.8127.37`、`Moon 0.1.20261119`、`AMD Ryzen 9 8945HX`、`Windows 11 + WSL2`

## 一、核心优化项

### 1. MoonBit Core 引擎突破（`core/parameters.mbt`, `core/model.mbt`, `core/bits.mbt`, `core/encoder.mbt`, `core/decoder.mbt`）
- **消除每像素堆分配与异常包装开销**：将 `DecodePhase` 拆解为无载荷纯标签枚举 + 标量字段，移除热路径函数（`BitReader::byte`、`GolombReader::read`、`Parameters::check_error`、`Decoder::advance_scan`）的每像素/每字节 `raise CodecError`（消除 `Result.Ok`、`Option` 与 `neighbors()` 四元组堆分配）。
- **SoA 上下文布局与硬件级数学加速**：`Scan` 常规与游程上下文改为平铺 `FixedArray[Int32]` SoA（保持 `workspace_bytes()` 公式不变）；`golomb_order` 改用 `clz()` 常数时间计算；`Parameters` 预计算 `q_lut` 梯度量化表并特化 `step = 1/3/5/7` 除法；邻域常规像素跨步复用 `q2 = q1`。
- **零分配 32-bit 缓冲流式行循环**：
  - `Encoder::step` 在输出缓冲区余量充足时直接写入 `output`（32-bit 位缓冲 + 寄存器缓存邻域 + 无损直通重建），保持 `BitWriter` 状态与 1-byte 分块边界比特级一致。
  - `Decoder::step` 使用 32-bit 左对齐位缓冲 + `clz()` 单次解码 Golomb 符号，前瞻安全填充永不跨过 `0xFF + >=128` 标记并在行/循环退出时精确回退整字节，确保 EOI 与尾随字节语义严格不变。

### 2. Bridge FFI / Worker / PGM 与 Native CLI 突破
- **Bridge 批量打包读写（`cmd/bridge/bridge.mbt`, `sdk/index.mjs`）**：新增 `encoder_set8`（每次 16 个 16-bit 样本）、`decoder_set8`（每次 32 字节）、`DecodePort.row` 行缓存，以及 48-bit 精确 `Double` 打包读取（`encoder_pack6` / `decoder_pack3`）与 32-bit 打包读取（`encoder_word` / `decoder_pair`），保持现有单元素导出完全兼容。
- **Worker 与 PGM 热路径优化（`sdk/worker.mjs`, `sdk/worker-client.mjs`, `web/pgm.mjs`, `web/app.mjs`）**：
  - 消除编码侧逐行阻塞 `progress` IPC 往返；支持浏览器大块任务按 `maxBatchBytes`（16 KiB）批量回传重建行（始终立即送出首行与末行，保留 Backpressure ACK）。
  - 浏览器端对 `core.wasm` 执行单次获取与 `WebAssembly.compile` 缓存复用（支持不支持结构化克隆模块时平滑回退至缓存 `ArrayBuffer` 传输）。
  - `web/pgm.mjs` 用无分配 `Uint8Array` 大端序移位替代每样本 `DataView` 调用。
- **Native CLI I/O 批量化（`cmd/moonjls/files.mbt`, `cmd/moonjls/main.mbt`）**：消除 `Source::samples` 逐字节 `async` 调度开销，并以块对齐 `buffer_row` 减少 `decode_stream` 逐行写系统调用次数。

### 3. 前端体验与无障碍精修（`web/index.html`, `web/style.css`, `web/labels.mjs`, `web/app.mjs`）
- 补充 Firefox `#progress::-moz-progress-bar` 语义色阶与 `appearance: none`。
- 守卫 `#file` 取消弹窗导致的误清空（`if (file) setSource(file)`）。
- 中英文切换同步更新 `document.title` 与工作栏、视图标签组、流式管线图 `aria-label`。
- 支持空闲/就绪/完成态拖放 `.pgm` / `.jls` 文件加载（运行中禁止打断）。
- 桌面对照模式下聚焦 `#original` 画布并缩窄至 `≤ 640 px` 时，自动将焦点平顺交接至 `#reconstruction` 画布；Wasm GC 编译/实例化失败时附带切换至 JavaScript 后端提示。

---

## 二、实测性能对比

完整机械可读指标见 [summary.json](file:///D:/Program%20Files/GPT_project/moon_jpegls/reports/v2-opt/summary.json)。

### 1. Node 全量 12 组合基准（`scripts/bench_node.mjs effect`，3 轮中位数，单位 ms）

| 图像 · NEAR | CharLS Wasm（编 / 解） | Wasm GC 基线 → 优化（加速比） | JS 基线 → 优化（加速比） |
|---|---:|---:|---:|
| `smooth` 768×512 · NEAR=0 | 5.3 / 4.3 | 19.0 → 7.4 (**2.57×**) / 26.6 → 9.3 (**2.86×**) | 19.3 → 7.6 (**2.54×**) / 31.3 → 9.7 (**3.23×**) |
| `smooth` 768×512 · NEAR=3 | 7.7 / 4.6 | 18.8 → 8.0 (**2.36×**) / 25.0 → 9.4 (**2.66×**) | 20.6 → 7.9 (**2.60×**) / 30.2 → 8.5 (**3.54×**) |
| `edges` 768×512 · NEAR=0 | 1.2 / 1.0 | 12.4 → 3.8 (**3.26×**) / 14.0 → 4.9 (**2.87×**) | 9.7 → 4.0 (**2.41×**) / 10.1 → 14.8 (0.68×) |
| `edges` 768×512 · NEAR=3 | 1.7 / 1.3 | 12.5 → 3.7 (**3.36×**) / 13.0 → 4.8 (**2.73×**) | 9.1 → 4.3 (**2.11×**) / 9.5 → 4.6 (**2.06×**) |
| `texture` 768×512 · NEAR=0 | 6.9 / 8.4 | 34.4 → 12.3 (**2.78×**) / 48.3 → 13.2 (**3.66×**) | 29.9 → 12.2 (**2.45×**) / 54.4 → 14.3 (**3.81×**) |
| `texture` 768×512 · NEAR=3 | 9.4 / 7.5 | 31.5 → 13.2 (**2.39×**) / 42.9 → 12.8 (**3.36×**) | 30.0 → 12.3 (**2.43×**) / 51.0 → 13.4 (**3.80×**) |
| `noise` 768×512 · NEAR=0 | 7.8 / 10.9 | 45.6 → 15.7 (**2.92×**) / 65.5 → 16.0 (**4.09×**) | 37.8 → 14.8 (**2.55×**) / 63.9 → 17.6 (**3.64×**) |
| `noise` 768×512 · NEAR=3 | 11.5 / 11.1 | 41.4 → 16.4 (**2.52×**) / 55.7 → 15.8 (**3.54×**) | 35.5 → 14.7 (**2.41×**) / 57.4 → 16.5 (**3.48×**) |
| `lily-channel-1-center` 512×512 · NEAR=0 | 5.0 / 6.9 | 27.0 → 10.6 (**2.55×**) / 35.4 → 11.8 (**3.01×**) | 24.8 → 10.7 (**2.31×**) / 37.2 → 12.1 (**3.07×**) |
| `lily-channel-1-center` 512×512 · NEAR=3 | 8.1 / 6.2 | 26.4 → 11.0 (**2.40×**) / 32.3 → 11.1 (**2.91×**) | 24.8 → 10.9 (**2.27×**) / 36.6 → 11.6 (**3.16×**) |
| `lola-moon` 1440×720 · NEAR=0 | 19.3 / 27.7 | 111.3 → 43.0 (**2.59×**) / 149.7 → 45.4 (**3.30×**) | 99.4 → 42.2 (**2.35×**) / 156.3 → 47.1 (**3.32×**) |
| `lola-moon` 1440×720 · NEAR=3 | 25.7 / 26.6 | 103.4 → 44.7 (**2.32×**) / 133.6 → 43.7 (**3.06×**) | 96.0 → 42.1 (**2.28×**) / 143.9 → 44.7 (**3.22×**) |

### 2. WSL Native CLI（`lola-moon.raw`, 1440×720 16-bit 全进程含 I/O，3 轮中位数）

| 模式 | 基线（ms） | 优化后（ms） | 加速比 |
|---|---:|---:|---:|
| NEAR=0 编码 | 295.2 | **128.6** | **2.30×** |
| NEAR=0 解码 | 143.7 | **51.4** | **2.80×** |
| NEAR=3 编码 | 310.0 | **131.9** | **2.35×** |
| NEAR=3 解码 | 145.1 | **49.9** | **2.91×** |

### 3. Chrome 端到端配对基准（`512×4096` 16-bit PGM, Wasm GC, NEAR=0, bounded, chunk=4096, 交替 2 预热 + 5 正式对）

| 指标 | 基线 `40d834f` 中位数（MAD） | 优化后中位数（MAD） | 变化 |
|---|---:|---:|---|
| 端到端总耗时 (`wallMs`) | 1561.2 ms (155.0 ms) | **787.2 ms** (**18.2 ms**) | **-49.6%（1.98× 加速，抖动降 8.5×）** |
| 首次 Canvas 更新 (`firstCanvasMs`) | 18.7 ms (2.7 ms) | **15.3 ms** (**2.1 ms**) | **-3.4 ms（1.22× 加速）** |

---

## 三、完整正确性验证记录

全部检查均在最终代码与构建产物完成后实跑通过：
1. `moon check --deny-warn`：通过（0 警告）。
2. `moon test core --target js --deny-warn`：7/7 通过。
3. `moon test core --target wasm-gc --deny-warn`：7/7 通过。
4. WSL `moon test core --target native --deny-warn`：7/7 通过；WSL Native CLI `29×7` `chunk=3` 编码 / `chunk=1` 解码及 `lola.pgm` 无损往返 + `verify` 全通过。
5. `node scripts/interop.mjs .evidence/v2-opt/validation js wasm-gc`：100 张参考图像、400 次编码、736 次解码对照、100 次双后端字节全同、160 次单字节切分、162 次截断测试、48 次 CharLS 熵流变异试验、官方规范测试与暂停/取消检查全部通过。
6. `node --test web/pgm.test.mjs web/preview.test.mjs`：10/10 通过。
7. `node REVIEW_EVIDENCE/web_cancel_probe.mjs .`：取消后重启防串扰检查通过。
8. `node scripts/bench_node.mjs resource wasm-gc encode/decode ... 512 4096 4096 4096 pause`：暂停回压与有界内存语义通过。
9. Chrome `web/smoke.mjs`（含 1,036,800 样本 NASA LOLA 实图 CharLS 校验、文件对话框取消保护、拖拽加载、中英文 `title`/`aria-label`、Worker ACK）与 `web/preview-browser.mjs`（含 roving `tabindex`、`#original` 到 `#reconstruction` 跨断点焦点交接与 0 控制台/页面报错）：全部通过。
