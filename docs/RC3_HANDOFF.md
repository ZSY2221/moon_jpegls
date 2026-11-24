# MoonJLS RC3 本地交接

2026-11-24（新加坡时间）。访问 `D:\Program Files\GPT_project\moon_jpegls`。本地固定分支 `antigravity/rc3-20261124` 指向 `2feb00b8ef657b7259ba70bccf1ff0ceaf08765b`。主分支随后只增加交接和实测证据。浏览器做前后对照的候选快照出自 `65422925136b9035e5762ab314631e5c6b667506`，固定交接提交重建的所有比较资产逐文件 SHA-256 相等。 [源码到产物清单](../reports/rc3/manifest.json)

## 第一项工作

从固定分支先复跑取消立即重启、16 位原值、NEAR 边界、下载和暂停，再整理工作台的证据表达。工作位置以 `web/style.css`、`web/index.html` 和 `web/labels.mjs` 为主。调整 `web/preview.mjs` 或 `web/app.mjs` 后复跑受影响场景。保留中英文案、键盘可操作性和原有格式范围。核心、桥接和 Worker 协议留在这个固定版本。

- 显示当前任务身份、后端、有效位深、NEAR、源文件和阶段。将已经交付的暂定行与 EOI、完整验证和 sink 完成后的 `Done` 区分开来。
- 分开表示核心逻辑工作区、桥接/队列、参考缓存和可选下载缓冲。时间带上范围，例如页内完整任务、首个 Canvas 更新、Worker 内部执行。保留实际运行得到的单位和值。
- 原图、重建、热图和像素点读关联逐行 `Uint16Array` 原值。亮度、窗宽窗位和 Canvas 色阶只作用于显示。完整逐样本验证继续按整数值计算。
- 覆盖运行、暂停、取消、错误与重新开始。旧任务的 DOM、统计、下载更新仍须检查身份，尤其是在 await 和 finally 之后。

## 固定版本复验顺序

PowerShell 中启动工作台。已验证的 Chrome 为 158.0.8127.37。安装命令及必要的 CharLS 锁定版本见 [验证说明](VALIDATION.md)。

```powershell
npm.cmd ci --prefix web
node sdk/build.mjs
node web/build.mjs
node --test web/pgm.test.mjs
node REVIEW_EVIDENCE/web_cancel_probe.mjs .
python -m http.server 8000 --bind 127.0.0.1 --directory web/dist
```

在另一终端跑浏览器回归并打开 `http://127.0.0.1:8000/web/`。

```powershell
$env:MOONJLS_WEB_URL = 'http://127.0.0.1:8000'
$env:MOONJLS_EXPECT_REFERENCE_WINDOW = '1'
node web/smoke.mjs
moon test core --target js --deny-warn
moon test core --target wasm-gc --deny-warn
wsl -d Ubuntu-22.04 --exec bash -lc 'CC=clang ~/.moon/bin/moon test core --target native --target-dir .tools/wsl-build --deny-warn'
```

在封存证据的 `main` 提交或审查包根目录执行 `python scripts/verify_rc3_evidence.py`。用实图下载检查时，按报告中的步骤生成 NASA LOLA PGM，再用 `--check-download` 进行浏览器重建和 CharLS 逐样本比较。Native 保留 `--require-eager` 与尾部矩阵。复跑时优先从小图、完全单字节、待处理窗口读取和待处理 sink 写入开始。 [页面与实图命令](../reports/rc3/README.md) · [Native 原命令和记录](../reports/rc3/NATIVE.md)

## 缓存和流式合同

RC3 保留参考窗口，任务私有，最多 64 KiB 原始字节。第一行和超过窗口预算的宽行按原路径读取。缓存窗口替换会清掉旧逻辑引用，行返回独立 `Uint16Array`，编码游标与参考游标独立。一个 pending 窗口加载，无后台预取。取消和关闭后旧缓存不能重新填充。已进入宿主 I/O 的操作可能晚返回，等待后的守卫阻断其可见影响。页面可能有一次旧任务未完成的 I/O 与新任务重叠，浏览器或 GC 的整个进程内存未测。

Native 行和 Worker 行都可能先于完成交付。Native 仍要求终止标记、EOF、无尾随。Worker 在前一行确认前不继续读取；保留单 pending、稳定暂停水位与最终统计。错误沿用现有 `CodecError` 或本次宿主取消信号。完整协议见 [API](API.md) 与 [RC2 协议回归说明](RC2_HANDOFF.md)。开发核心修复需另开分支，先增加最小失败用例，再验证同流、所有声明后端与有关预算。

历史 Native 20 秒慢消费超时、浏览器总 RSS、系统文件保存对话框、其他浏览器与 Mooncakes 在线安装状态见 [RC3 报告](../reports/rc3/README.md)。当前未支持的格式特性保持 [SCOPE](SCOPE.md) 的声明。真实数据的下载源与生成命令随 [数据来源](../tests/fixtures/README.md) 维护。本轮未拍新的截图。新的演示图应从固定版本或实际视觉改动运行后生成。没有远端或参赛操作。
