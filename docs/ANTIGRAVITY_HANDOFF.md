# Antigravity 交接

接续当前候选版请使用 [RC2 固定版本交接](RC2_HANDOFF.md)。以下为原 rc.1 的交接记录。

工程唯一目录 `D:\Program Files\GPT_project\moon_jpegls`，分支 `main`，本地首版候选标签 `v0.1.0-rc.1`。在 PowerShell 用 `git rev-parse 'v0.1.0-rc.1^{commit}'` 取得完整 commit，以标签检出可复现的交接版本。后续在独立分支修改，先记录 `git status --short` 以保留用户已有改动。

## 已运行的命令

在 Windows 项目根运行 JS/Wasm GC，Native 运行在已验证的 Ubuntu WSL2。

```powershell
moon check --target all --deny-warn
moon test core --target js --deny-warn
moon test core --target wasm-gc --deny-warn
wsl -d Ubuntu-22.04 --exec /root/.moon/bin/moon test core --target native --target-dir .tools/wsl-build --deny-warn
wsl -d Ubuntu-22.04 --exec /root/.moon/bin/moon build cmd/moonjls --target native --release --target-dir .tools/wsl-build
node sdk/build.mjs
node web/build.mjs
python -m http.server 8000 --bind 127.0.0.1 --directory web/dist
```

打开 [工作台](http://127.0.0.1:8000/web/)。在另一个 PowerShell 使用 `npm.cmd --prefix web ci` 和 `npm.cmd --prefix web run smoke` 复验。浏览器路径可以通过 `MOONJLS_CHROME` 指定。Native 的 Linux ELF 路径是 `.tools/wsl-build/native/release/build/cmd/moonjls/moonjls.exe`。实际管道命令和消费模块见 [流式示例](../examples/stream_pipeline.sh) 与 [独立消费说明](../examples/consumer/README.md)。

Windows Native check 已通过，Windows Native run 缺系统 C 编译器。WSL Native 与编解码互操作已运行。源码版本、全套裁判命令与数据保存在 [验证](VALIDATION.md) 和 [基准](BENCHMARK.md)。

## 接口边界

- `core` 负责算法与生命周期。`Encoder::step` 返回准确的输入样本消耗和输出字节数。`Decoder::step` 逐行借出只读预测行，下一次推进可复用其内存。`eof=true` 表示当前输入末端，空块可正常传递。`Done` 消耗到 EOI，宿主选择尾随数据策略。`Failed` 和取消为终态。
- `cmd/bridge` 是 JS 和 Wasm GC 导出边界。`sdk/index.mjs` 和 `.d.mts` 是应用使用的契约。解码行是拥有独立缓冲区的 `Uint16Array`，适合窗宽窗位和未量化采样。通过 `onRow`、行号、输入输出水位、峰值计数和 `AbortSignal` 接入应用。
- Worker 使用 `needInput/input`、`row/bytes/progress` 和配对 `ack`。一次只允许一个待确认操作。宿主可以暂停、恢复或取消，正在执行的单次源读取可以返回。`row` 与 `bytes` 转移所有权，输入子视图先复制，避免附带整文件底层缓冲区。失败通过 `error.code` 和 `error.message` 传递。 [API 和协议](API.md)
- 主题与布局在 `web/style.css`、`web/index.html`。双语词条在 `web/labels.mjs`。窗宽窗位与热色可在 `web/preview.mjs` 改动，保留原始 `Uint16Array` 和独立的 Canvas 显示变换。`web/app.mjs` 持有状态和任务生命周期，`web/transport.mjs` 管理源和数据汇。

## 独立复核顺序

1. 用同一 16 位满量程输入执行 NEAR 0、1、2、3。核对原图及重建图在 0、32767、32768、65535 附近的整数读数，重放 CharLS 码流并逐样本对比。另查只含 12 位有效范围的 16 位容器。
2. 复验 marker 跨块、熵码、`FF` 后一位填充、Golomb escape、游程末端。用单字节输入和单字节输出暂停多次，记录消费偏移、行次数、重复结束及截断错误。
3. 扣住首行确认并人工暂停，量测源读取、水位和 UI 状态。恢复后核对数据，无消费时也能取消。分别测缓冲下载、有界消费、可用时的直接文件保存与取消保存。
4. 固定宽度增高，比对核心载荷、宿主预览、Worker 中转、Blob 和进程峰值。对 PGM 文件直接分块，记录视图背后持有的缓冲区。打开低内存模式持续运行真实公开数据。
5. 对损坏样本保留 seed、码流、首次差异、SHA 和命令。回归放在 `core/stream_wbtest.mbt` 或 `scripts/validate.py` 对应类别里。核心修复使用独立分支上的小补丁和单一算法写入者，三后端和外部裁判通过后合并。

## 证据位置与限制

截图位于 `reports/screenshots/workbench.png`，来自真实的 400×260 16 位浏览器运行。实测报告位于 `reports/`，实验写出的原始码流和计时原始数据在 `.evidence/`。NASA LOLA 文件及 PGM 哈希见 [数据出处](../tests/fixtures/LUNAR_DATA.md)。显微数据的许可、版本和裁剪见 [基准](BENCHMARK.md)。

已验证的 Chrome、Edge 提供缓冲和有界路径。操作系统文件保存对话框、Firefox 和 Safari 尚未实测。PNG 与 JPEG-LS 的 NEAR>0 对比是体积和误差取舍。Native CLI 的端到端耗时含进程和 I/O，CharLS wheel 的测量另有明确边界。完整的不支持项见 [范围](SCOPE.md)。

优先完成真实文件保存矩阵和 16 位视图窗宽窗位。其次复查浏览器取消后的源读取和对象生命周期。之后通过采样剖析确定优化点，分别报告编码、解码与 SDK 复制成本。任何算法修改沿用可复现外部互操作门槛。
