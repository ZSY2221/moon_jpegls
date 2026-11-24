# MoonJLS 工作台演示交接

2026-11-24（新加坡时间）。工作目录 `D:\Program Files\GPT_project\moon_jpegls`。本地分支 `antigravity/presentation-20261124`。RC3 功能基线 `2feb00b8ef657b7259ba70bccf1ff0ceaf08765b`，本轮重建与复核源码 `65261dae505fffad3db2d57469c89282c8019909`，产品页面提交 `c97a38c8f3a16ce26e07c51b72094424bc5bffed`。之后只合入已有 RC3 证据并封存本轮记录。 [源码、构建与响应哈希](../reports/presentation/manifest.json)

## 启动

```powershell
npm.cmd ci --prefix web
node sdk/build.mjs
node web/build.mjs
python -m http.server 8000 --bind 127.0.0.1 --directory web/dist
```

打开 [本机工作台](http://127.0.0.1:8000/web/)。可预先准备公开的 NASA LOLA 16-bit PGM，用 `python scripts/fetch_lunar_fixture.py .evidence/real/lola.pgm` 下载并按固定规则生成。也可先完成一次内置样图来准备 JLS 下载。 [数据来源和哈希](../tests/fixtures/LUNAR_DATA.md)

## 90 秒操作顺序

| 时间 | 操作与说明 |
| --- | --- |
| 0–15 秒 | 选择中英文界面，加载 16 位样图。保持 Wasm GC、NEAR=0 和缓冲下载，运行。指出所有文件在本机处理，样本范围 0–65535。 |
| 15–30 秒 | 展示暂定行最终变为逐样本验证通过。点原图或重建图查看坐标和整数值。用键盘聚焦重建图，按右方向键可看到样图 `(1, 0)` 的 65535。确认最大绝对误差为 0。 |
| 30–45 秒 | 保持同一源改 NEAR=3 再运行。查看实际 JLS 字节与最大误差。两次本地截图的 JLS 体积分别为 142,176 和 105,655 B，误差为 0 和 3。现场以此时页面读数为准。 |
| 45–65 秒 | 展开高级设置，输入块设为 1 并用有界验证运行。立即暂停、恢复、取消。界面标识已交付行为未完成。把块大小恢复为 32768，再开始一个可快速完成的新任务。 |
| 65–80 秒 | 切回缓冲下载，选择准备好的 `lola.pgm`，以 NEAR=3 做一次往返并下载 JLS。也可直接读取已下载的 JLS，指出单独解码只验证码流终结，原图误差显示“未比较”。 |
| 80–90 秒 | 展开流式资源，分别指出核心逻辑载荷、解码 Worker 队列、参考窗口配置和缓冲下载上限。需要展示历史比较时，打开 RC3 证据页。 |

完整数据见 [本轮浏览器记录](../reports/presentation/README.md) 与 [RC3 历史性能](../reports/rc3/README.md)。现场有界验证会丢弃输出；需演示实际下载时选择缓冲下载。系统保存对话框与本地文件权限因浏览器而异。

## 状态与计时

- `#status[data-state]` 为页面状态。`ready` 表示可以启动。`running`、`paused` 与 `finalizing` 中的已交付行是暂定结果。最后一行到达后仍需终结验证和输出收尾。`complete` 只在当前任务的 Worker 验证与 `sink.close()` 成功后提交。取消或失败保留可见的暂定预览并标明未完成，没有成功下载入口。
- PGM 往返的完成状态确认了全样本核验。单独解码的完成状态确认 JPEG-LS 终结，NEAR 从文件头取得，原图误差不可用。
- “页内处理耗时”从 sink 建立后开始，至处理、验证与输出 close 返回。首次 Canvas 更新为第一次重建 `putImageData` 返回。现场指标不会混用 Worker 首行时间或历史报告的墙钟结果。
- 原图和重建显示按同一 MAXVAL 映射。内容居中且保持宽高比，留白点击被忽略。缩略图坐标指向每个显示样本对应的原始栅格位置。点读源自最多 480×320 位置的整数状态，颜色仅用于画布展示。误差以原始整数样本计量。

## 停更区与复验

核心、命令与桥接、SDK、Worker、PGM 缓存和 transport 均与固定 RC3 源逐文件一致。只在当前展示分支调整页面和演示测试。旧任务的读取或文件 writer 已发出的 I/O 可能完成，页面必须按任务身份阻止其回写。浏览器测试用受控 writer 模拟系统文件路径，能够复验收尾成功、失败与取消时序。 [流式协议](API.md) · [产品支持范围](SCOPE.md)

启动服务后的另一终端执行以下命令。真实 LOLA 比对需先配置锁定 CharLS Wasm 并准备样本。 [裁判安装](VALIDATION.md)

```powershell
$env:MOONJLS_WEB_URL = 'http://127.0.0.1:8000'
$env:MOONJLS_EXPECT_REFERENCE_WINDOW = '1'
$env:MOONJLS_LOLA = '.evidence/real/lola.pgm'
$env:MOONJLS_PRESENTATION_SCREENSHOTS = '.evidence/presentation/screens'
$env:MOONJLS_SMOKE_RECEIPT = '.evidence/presentation/smoke.json'
node --test web/pgm.test.mjs web/preview.test.mjs
node REVIEW_EVIDENCE/web_cancel_probe.mjs .
node web/smoke.mjs
node web/preview-browser.mjs
node web/capture-presentation.mjs --output .evidence/presentation
python scripts/verify_rc3_evidence.py
python reports/rc3/harness/verify.py
```

完整产品仍只在本地。未做 Chrome 以外的本轮实机浏览器兼容、系统文件保存对话框、RSS 评测、远端发布或赛事提交。
