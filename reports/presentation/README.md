# MoonJLS 展示版浏览器证据

2026-11-24（新加坡时间）。以下为作者本机执行。Chrome 158.0.8127.37，Playwright Core 1.65.1，Node 24.20.0，Moon 0.1.20261119，moonc v0.10.22+124d61d05，Python 3.12.10。固定 RC3 基线源码 `2feb00b8ef657b7259ba70bccf1ff0ceaf08765b`。封存的 `main` 仍为 `d7c01785b26672f89c41b253e172bc02bd0a09c0`。 [版本、原文件字节和浏览器响应清单](manifest.json)

## 截图

| 实际操作 | 截图 |
| --- | --- |
| 原 RC3 基线，1440×900 视口 | [基线](screens/baseline-1440.png) |
| 中文桌面，1440×900 视口，NEAR=3，展开资源 | [中文桌面](screens/desktop-zh.png) |
| 英文桌面，1366×768，NEAR=3 | [英文桌面](screens/desktop-en.png) |
| 中文窄屏，390×844 视口，NEAR=0 | [窄屏](screens/narrow-390.png) |
| 实际处理完全部行，受控 writer 暂扣 close | [暂定和输出收尾](screens/finalizing.png) |
| 受控 writer 拒绝 close，页面保留未完成行 | [输出收尾失败](screens/failed.png) |

两种桌面尺寸都在首屏显示操作和三联预览。窄屏无横向溢出。中文桌面与窄屏采用全页截图，浏览器视口仍分别为 1440×900 和 390×844。桌面截图的 NEAR=3 结果为 105,655 B，最大误差 3。窄屏 NEAR=0 为 142,176 B，最大误差 0。两组保留 65535 原样本点读。 [布局测量与截图回执](capture-receipt.json)

## 已执行的验证

- 修改前从固定源执行 `npm.cmd ci --prefix web`、SDK 和页面构建、PGM 五组测试、便携取消探针、原版 Chrome smoke 与截图。基线冒烟无业务页异常，静态 HTTP 服务出现原页面默认请求 favicon 的 404。最终页面提供本地空 favicon，最终版 Chrome 验收包含严格 console error 断言。 [基线日志](baseline-smoke.txt) · [基线资源回执](baseline-smoke.json)
- 修改后执行五组 PGM 与三组预览测试、便携取消探针。Chrome 验证横图、高图 40×320 采样、390 px 下的坐标、键盘点读和留白忽略。 [单元测试](unit.txt) · [便携探针](cancel-probe.txt) · [浏览器取样几何](preview-geometry.txt)
- 正式烟测运行内置 16 位样图 NEAR=0 与 3、无参考 JLS 解码、截断和不支持输入、1 B 暂停和恢复。扣住实际 EOI 时四行仍可见，状态为暂定且没有下载，释放后正常结束。挂起输出 close 时尚无成功或总时，受控成功关闭后页面总时含 175.5 ms 等待；拒绝关闭后显示 `NotAllowedError`。分别扣住原图参考窗口、sink.write、sink.close 后取消并立即重启，三次都保留新样本 4000 和新下载。 [最终烟测与真实加载哈希](candidate-smoke.txt) · [烟测回执](candidate-smoke.json)
- 从 NASA LOLA 实图下载 999,459 B JLS，再通过页面解码、下载 2,073,618 B PGM。1,036,800 个整数样本与 CharLS Wasm 同码流相等，原图最大绝对误差为 3。 [夹具来源](../../tests/fixtures/LUNAR_DATA.md) · [真实下载与独立裁判日志](candidate-smoke.txt)

### 性能防回退

使用 RC3 主配置的 512×4096、16 位、Wasm GC、NEAR=0、编码 4096 样本和解码 4096 字节、有界验证。Windows 11、Ryzen 9 8945HX、高性能电源方案。同一 Chrome 会话交替执行两个静态路径，各 2 次预跑、5 次正式。记录于 13:46:41–13:46:58（新加坡时间）。计时从真实点击到最终界面解锁，每次包括 Worker 启动、预览、验证和输出 close。首个 Canvas 在重建 `putImageData` 返回时取点。两个版本使用同一计时边界。页面计时与此处回归探针使用各自标注的范围。

| 配置 | 五次正式总时，ms | 总时中位数 | 首 Canvas 中位数 |
| --- | --- | ---: | ---: |
| RC3 | 1202.0, 1101.4, 1139.1, 1205.9, 1253.7 | 1202.0 ms | 14.8 ms |
| 展示版 | 981.0, 964.2, 1107.1, 1101.7, 944.6 | 981.0 ms | 14.7 ms |

总时未出现稳定超过 5% 回退，首 Canvas 通过 2 ms 门槛。数据仅用于判断此轮样式和状态接入的回退风险。原 RC3 多配置历史性能报告保持原数值。 [全部试次、未舍入数据、阶段时钟与实际响应](paired.json)

## 复跑与未测

按 [演示交接](../../docs/PRESENTATION_HANDOFF.md) 启动及运行测试。下面的回归命令从最终分支或审查包根目录执行。先用同一工具链生成当前 `web/dist`。五份不同的 [RC3 基线页面文件](baseline-web) 来自 `2feb00b` 并核过实际加载哈希，可替换独立静态树副本中的同名文件。公共构建和其余七个页面资产两侧相同。有独立的 RC3 静态树时也可直接使用。

```powershell
$before = '.evidence/presentation-before'
New-Item -ItemType Directory -Force .evidence | Out-Null
Copy-Item -Recurse web/dist $before
Copy-Item reports/presentation/baseline-web/* "$before/web/"
node web/bench-presentation.mjs --help
node web/bench-presentation.mjs --baseline $before --baseline-source 2feb00b8ef657b7259ba70bccf1ff0ceaf08765b --candidate web/dist --candidate-source c97a38c8f3a16ce26e07c51b72094424bc5bffed --output .evidence/presentation/replay.json
```

本轮不含系统文件保存对话框实测、Firefox/Safari、Native 目标新运行、浏览器 RSS 或 RC3 压力组重跑。暂停、取消与 close 注入仅在浏览器测试脚本内。RC3 原始 runner 已找回，最早 profile 对应的旧 probe 未找到。原始数据、出处和校验仍保留。 [历史补档](../rc3/harness/README.md)
