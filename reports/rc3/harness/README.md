# RC3 工作台实测脚本补档

2026-11-24（新加坡时间）。本补档保存原始脚本文本与测试报告的对应关系。原封存提交 `d7c01785b26672f89c41b253e172bc02bd0a09c0` 的数值、记录和 `MoonJLS-RC3-Review.zip` 保留。此次检查是针对作者本地实测的 AI 复算及代码核对。没有重跑浏览器性能。 [原 RC3 证据](../README.md) · [完整脚本哈希、Git blob 与源提交](manifest.json)

| 实测 | Runner 哈希前缀 | Probe 哈希前缀 | 浏览器资产标记的产品源 |
| --- | --- | --- | --- |
| 初始 profile | `3dafe62d` | `248c4195`，未归档 | `299fd9a` |
| 正式 paired | `3dafe62d` | `554dff0c` | `299fd9a`、`6542292` |
| 高图 memory | `3dafe62d` | `554dff0c` | `299fd9a`、`6542292` |
| 实图下载 | `3dafe62d` | `554dff0c` | `6542292` |
| 短图 memory | `d9a510cb` | `554dff0c` | `6542292` |

Runner `3dafe62d` 和 probe `554dff0c` 的原始文件均可从 `8562cd4`、`6542292` 取出。短图 runner `d9a510cb` 的原始文件来自 `2feb00b`，其副本在原 RC3 封存包中也使用同一哈希。补档以 Git 原始字节导出。 [历史 runner](bench-workbench-3dafe62d.mjs) · [短图 runner](bench-workbench-d9a510cb.mjs) · [共用 probe](bench-workbench-probe.mjs)

通过 `git diff 8562cd4 2feb00b -- web/bench-workbench.mjs web/bench-workbench-probe.mjs` 逐段核对。Runner 增加了仅供诊断模式使用的 `--height` 选项，赋予 4096 默认值与 1–65535 边界，参数化原高 4096 的合成 PGM 生成器和夹具文件名。保留宽 512、样本公式、计时逻辑和 probe 字节。已对本地 Git 对象库的所有 blob 做 SHA-256 匹配，并检查工程中的同名脚本缓存。没有找到与最初 profile 所报 `248c4195` 精确相符的原文，此版本明确列为未归档。该记录的原值和哈希继续可复算。

使用档案中 `554dff0c` 的 `instrumentApp` 和 `instrumentPgm` 处理两侧有哈希的原始资产，实际复建 paired、两组 memory 和实图下载记录中的 12 个 `app.mjs` 与 `pgm.mjs` 响应体。全部输出哈希与服务器交付记录及可用的 Chrome 响应体哈希一致。

从封存源码或补档 ZIP 解包后的根目录运行 `python reports/rc3/harness/verify.py`。该命令复用现有门槛复算，核对五份原始报告、已归档文件字节及未归档版本。用 `--zip <路径>` 另验补档 ZIP 的成员、内部 SHA-256 清单和同目录 detached SHA-256。归档脚本仅供溯源。重跑某个历史脚本时，将其与对应 probe 放回独立副本的 `web/`，在该副本安装锁定依赖。
