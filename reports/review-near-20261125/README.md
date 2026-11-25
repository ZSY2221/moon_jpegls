# 2026-11-25 合法 NEAR 扩展验证

验证对象为复审版本中单帧、单分量、单扫描、ILV=0、满量程 MAXVAL、默认预置参数的 JPEG-LS 编解码。NEAR 使用原始整数样本单位。基线为 P0 [9ffa66c](https://github.com/ZSY2221/moon_jpegls/commit/9ffa66c2069885519b2727bb05c6c4acd04b67ab) 加本次 P1 改动。工具链、源码与产物 SHA-256 见 [provenance.json](provenance.json)。

## 测试范围

- 参数矩阵覆盖 8 位 128 组、12 位 256 组、16 位 256 组。每组使用固定种子的 31×9 整数图，包含极值、游程和中断、梯度、阈值附近样本与噪声。每个后端对同一码流与独立实现逐样本相等，并检查相对原图的绝对误差界。固定 MoonJLS 策略的码流在不同分块和三个后端逐字节一致。
- CharLS Wasm 0.10.0 为全部 640 组真实编码，另为 16 位 256 组生成隐式预置码流。CharLS 2.4.5 的 Python 驱动为 8／16 位编码，共 384 组，并独立解码全部三种位深的码流。12 位的独立编码由 CharLS Wasm 完成。[参数矩阵汇总](near-matrix-summary.json) · [逐配置、码流与重建哈希 JSON（gzip）](near-matrix-cases.json.gz)
- 单行 129×1 和单列 1×131 各覆盖三个位深的 NEAR 上限，共 6 组。旧矩阵另复验 100 张图及 7 条官方用例，其中 2 条在当前范围内，5 条验证了合法但未支持的错误分类。 [边界形状结果](boundary-shapes-summary.json) · [既有语料复验](legacy-regression-summary.json)
- WSL Native、Windows JS、Wasm GC 的核心各 11/11，Worker 协议 19/19、真实 Node Worker 4/4、页面单测 11/11，TypeScript 7.0.2 严格编译通过。Native 定向交付 12/12、尾部矩阵 20 项和晚到非法尾随通过。[逐行交付](native-row-delivery.json) · [尾部矩阵](native-tail-matrix.json)
- 本机 Chrome 158.0.8127.37 无头模式覆盖 16 位 NEAR=4 和 255、8 位 NEAR=127、12 位 NEAR=255，对照下载的码流核验整数读数、Canvas 热图和图例。NEAR=255 的任务取消后重启，下一任务逐样本一致。JS 和 Wasm GC SDK 各拒绝 6 种非法 NEAR 参数。此前队列和峰值探针复验两后端终态队列 0 B、峰值 112 B。 [工作台日志](chrome-smoke.log) · [浏览器资产指纹](chrome-smoke-receipt.json) · [Worker 轨迹](chrome-worker.log) · [布局和焦点日志](chrome-preview.log)

当前仍是 Part 1 阶段交付。[支持范围](../../docs/SCOPE.md) 和 [路线](../../docs/ROADMAP.md) 保留其他精度、非默认 MAXVAL 和预置参数、多分量与扫描等后续任务。本轮浏览器范围为 Chrome，无完整 Annex E 验收和新性能基准。核心格式检查仍报告基线的样式差异，P1 新增代码的格式已校正。

## 复跑

在仓库根安装 [独立参考驱动](../../docs/VALIDATION.md#reproduce)，用相同版本构建 SDK 和 Native。命令在 Windows PowerShell 运行，Native 使用 Ubuntu 22.04 WSL2。

```powershell
node sdk/build.mjs
node web/build.mjs
wsl -d Ubuntu-22.04 --exec bash -lc 'CC=clang ~/.moon/bin/moon build cmd/moonjls --target native --release --target-dir .tools/wsl-build'
./.tools/oracle-venv/Scripts/python.exe scripts/validate.py --near-matrix --directory .evidence/validation-near-matrix-p1 --native-wsl Ubuntu-22.04 --native-exe .tools/wsl-build/native/release/build/cmd/moonjls/moonjls.exe
./.tools/oracle-venv/Scripts/python.exe scripts/validate.py --conformance --directory .evidence/validation-near-p1-regression --native-wsl Ubuntu-22.04 --native-exe .tools/wsl-build/native/release/build/cmd/moonjls/moonjls.exe
Copy-Item reports/review-near-20261125/run-near-boundary-shapes.py .evidence/run-near-boundary-shapes.py
./.tools/oracle-venv/Scripts/python.exe .evidence/run-near-boundary-shapes.py --near-matrix --directory .evidence/validation-near-boundary-shapes-p1 --native-wsl Ubuntu-22.04 --native-exe .tools/wsl-build/native/release/build/cmd/moonjls/moonjls.exe
moon test core --target js --deny-warn
moon test core --target wasm-gc --deny-warn
wsl -d Ubuntu-22.04 --exec bash -lc 'CC=clang ~/.moon/bin/moon test core --target native --target-dir .tools/wsl-build --deny-warn'
node --experimental-vm-modules --test scripts/test_worker_protocol.mjs scripts/test_worker_codec.mjs web/pgm.test.mjs web/preview.test.mjs
npm exec --offline --yes --package=typescript@7.0.2 -- tsc --strict --noEmit --module nodenext --target es2022 --lib es2022,dom sdk/index.d.mts sdk/worker-client.d.mts
```

补跑 Native 管道时对上述可执行程序运行 `REVIEW_EVIDENCE/native_row_delivery_regression.py` 和 `REVIEW_EVIDENCE/native_tail_matrix.py`。Chrome 使用 README 中的本机静态服务，安装 `web/package-lock.json` 锁定的依赖后运行 `node web/smoke.mjs`、`node web/preview-browser.mjs` 和 `node reports/review-fix-20261125/chrome-worker-probe.mjs .`。可用 `MOONJLS_WEB_URL` 设置同一环回地址，`MOONJLS_SMOKE_RECEIPT` 指定资产收据文件。
