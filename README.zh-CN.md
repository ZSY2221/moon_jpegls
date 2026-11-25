# MoonJLS

[English](README.md)

MoonJLS 是纯 MoonBit 的高位深 JPEG-LS 流式编解码器，支持单通道、单帧、单扫描的 T.87 子集。有效位深支持 8、12、16 位。`NEAR=0` 逐样本无损，正整数 `NEAR` 表示原始整数样本的绝对误差上界，8 位上限为 127，12／16 位上限为 255。Native、Wasm GC 和 JS 共用两个预测行和同一状态机。 [支持范围](docs/SCOPE.md)

项目最终目标是实现 ITU-T T.87（06/1998）／ISO/IEC 14495-1 的完整 JPEG-LS Part 1 编解码与数据格式能力。上文的灰度子集是当前阶段成果。[标准能力矩阵与验收计划](docs/T87_CONFORMANCE_PLAN.md) 逐项列出已验证能力和待实现项，[分阶段兼容路线](docs/ROADMAP.md) 给出各阶段的交付物和通过条件。

## 构建与测试

实测使用 Moon `0.1.20261119`、`moonc v0.10.22+124d61d05` 和 Node `24.20.0`。Native 在 Ubuntu 22.04 WSL2 上运行。原生构建需要系统 C 编译器。

```sh
moon test core --target js --deny-warn
moon test core --target wasm-gc --deny-warn
moon test core --target native --deny-warn
moon build cmd/moonjls --target native --release
```

三个后端各通过 11 项核心测试，包含原有 12 组位深与 NEAR 组合及高 NEAR 边界、全部单切分位置、逐字节输入、单字节输出、长游程、结束标记和错误边界。外部验证另行执行 CharLS 双向互操作及同一码流逐样本对比。 [验证报告与复跑](docs/VALIDATION.md)

## CLI 与流式管道

在 Linux 或 WSL 的项目目录执行以下命令。示例下载公开 NASA 16 位月面高程样本，使用新文件名输出。

```sh
python3 scripts/fetch_lunar_fixture.py .evidence/real/lola.pgm
moon run --target native cmd/moonjls -- encode-pgm 0 .evidence/real/lola.pgm lola.jls 4096
moon run --target native cmd/moonjls -- decode lola.jls recovered.pgm pgm 4096
moon run --target native cmd/moonjls -- inspect lola.jls
moon run --target native cmd/moonjls -- verify lola.jls 17
```

raw 编码使用 `encode WIDTH HEIGHT BITS NEAR INPUT OUTPUT [raw-le|raw-be] [CHUNK]`。8 位每样本 1 字节，12 和 16 位每样本 2 字节，PGM 高位深采用大端字节序。`-` 表示标准输入或输出。输出文件采用独占创建，失败时可能留下部分文件。`inspect` 和 `verify` 均验证至 EOI，并拒绝尾随数据。 [真实流式管道](examples/stream_pipeline.sh)

## 浏览器、SDK 与消费模块

```sh
node sdk/build.mjs
node web/build.mjs
python -m http.server 8000 --bind 127.0.0.1 --directory web/dist
```

打开 [本机工作台](http://127.0.0.1:8000/web/)。可载入内置 16 位样例、P5 PGM 或 `.jls` 文件。对 PGM，Worker 对真实压缩流完成往返，热图和点读保留原始整数尺度，最大误差遍历全部样本计算。界面提供进度、暂停、恢复和取消。普通下载显式缓冲，页内限制 64 MiB。可以改用有界核验，或在支持文件保存 API 的浏览器选择直接写盘。 [浏览器复验](web/README.md)

`sdk/index.mjs` 提供同步流式会话和异步源、消费回调，输出 `Uint16Array` 样本行。`worker-client.mjs` 提供逐次确认的背压和手动控制。独立 MoonBit 消费模块通过包依赖使用核心，并展示 MoonImage Gray16 整图适配。 [JS/TS 接口](sdk/README.md) · [独立消费者](examples/consumer/README.md)

## 证据与边界

对照预构建 CharLS 2.4.5 与官方 CharLS Wasm，原语料覆盖满量程 16 位整数、合成边界与近无损条件。扩展矩阵另对拍当前子集下全部 640 组合法位深与 NEAR 组合。 [NEAR 扩展实跑](reports/review-near-20261125/README.md)资源实验固定宽度并增加高度，分别记录核心分配载荷、进程峰值、首行时机与慢消费。压缩效果另用公开显微图和月面高程数据。 [基准与复现](docs/BENCHMARK.md)

多分量、自定义预置参数、映射表、重启间隔、DNL 和扩展尺寸属于后续 Part 1 阶段。T.870 Part 2 与 DICOM 容器分别列为独立扩展。公开范围查重、未验证路径和下一步都随本地候选版本记录。 [查重证据](docs/ECOSYSTEM_AUDIT.md) · [项目状态](PROJECT_STATUS.md) · [Antigravity 交接](docs/ANTIGRAVITY_HANDOFF.md)
