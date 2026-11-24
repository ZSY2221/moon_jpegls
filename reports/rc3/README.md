# RC3 本地复核

2026-11-24（新加坡时间）。工作起点为 RC2 的证据提交 `299fd9afcbaac67d8d65b42545fb632a429ef202`。本目录保存新增记录，RC2 原始结果继续留在 [RC2 报告](../rc2/README.md)。

## Native 原超时

RC2 的 512×4096、16 位、CLI 7 字节块慢消费用例已经运行过，排空阶段触发 20 秒测试时限。同二进制、同码流的无限速对照，4096 字节块耗时 0.641 秒，7 字节块耗时 93.035 秒。7 字节块在管道满后暂停 101.1 ms 的对照于 92.699 秒结束，输出全部 4,194,304 B，与 CharLS 重建逐样本一致。归因为极小块 I/O 与调度成本高于原测试预算。此次归因只更改验证驱动。 [原结论](../rc2/native-slow-sink.json) · [原现场、复跑命令与归因](NATIVE.md)

## 真实工作台与保留决定

**保留私有参考行窗口。** 先在 RC2 工作台完成 28 次诊断任务。Wasm GC、NEAR=0 的五次正式诊断中，逐行参考读取和整数物化占总墙钟的中位比例为 56.1%，超过预先约定的 20%。每次完整任务均有 4096 次参考 Blob 读取，并在逐行核验后确认行数据。参考等待可能与编码或管道活动重叠，比例用于筛选。 [基线 profile 和全部试次](workbench-profile.json)

同一 Chrome 会话切换独立的 before/after 页面 URL，文件通过真实输入控件选取，消费方式为有界校验。512×4096、16 位固定夹具沿用 RC2 的生成规则。编码的块大小 4096 指样本元素，解码指字节。Windows 11、Ryzen 9 8945HX、高性能电源方案、Chrome 158.0.8127.37、Node 24.20.0。正式对照从 12:56:09 至 12:58:20 新加坡时间结束。每个配置、每个版本两次预跑和五次正式任务，共 16 次预跑与 40 次正式任务。对照关闭诊断计数，两侧保留相同的最小计时钩子。 [试次顺序、五次原值、配对、min/max、MAD 和实际响应 SHA-256](workbench-paired.json) · [复算门槛](workbench-gates.json)

| 后端 / NEAR | 基线墙钟中位数 ms | 候选墙钟中位数 ms | 降幅 | 首行 Canvas 中位数 ms 基线 → 候选 |
| --- | ---: | ---: | ---: | ---: |
| Wasm GC / 0 | 2768.9 | 1315.0 | 52.51% | 14.3 → 14.6 |
| Wasm GC / 3 | 2902.2 | 1273.5 | 56.12% | 15.3 → 14.8 |
| JS / 0 | 2975.2 | 1314.1 | 55.83% | 16.8 → 16.8 |
| JS / 3 | 4117.0 | 1725.7 | 58.08% | 20.9 → 20.6 |

墙钟从选好源和有界消费方式后点击 **Run** 起，至 Worker 终态、完整样本核验、sink.close 和当前任务界面完成。包含实际 Blob 读取、参考行整数转换、逐样本比较及预览。夹具生成、文件选择和系统对话框在计时之外。首行时间记录首个重建 `putImageData` 返回，实际显示器呈现未测。加载 Worker、首行到达与 sink 时间各自保存在原始报告。每组首行以未舍入值通过 `max(基线的 10%, 2 ms)` 门槛。JS/NEAR=3 基线的墙钟 MAD 为 287.1 ms，保留了全部样本。性能结论限定在这里实测的页面路径、机器与数据配置。

## 窗口、输出与所有权

首行单独读取。后续按真实 raster offset 读取完整行窗口，最多 65,536 B，尾部按实际字节裁剪，行宽超预算走原逐行读取。编码读取游标独立。替换窗口前释放旧逻辑引用；一次只有一个窗口加载。每次交付新建一个拥有独立缓冲的 `Uint16Array`。任务关闭或取消释放窗口引用；已发起的 `Blob.arrayBuffer()` 可能晚完成，await 后检查取消再决定是否采纳。GC 和浏览器进程 RSS 未采样。 [实现](../../web/pgm.mjs) · [五组边界断言](pgm-unit.txt)

| 固定宽度 512 | 逐样本核验行数 | 参考 Blob 读取次数 | 参考读量 | 常驻原始窗口峰值 | 窗口与一行物化重叠峰值 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 高 4096，RC2 | 4096 | 4096 | 4,194,304 B | 0 B | 2048 B |
| 高 4096，RC3 | 4096 | 65 | 4,194,304 B | 65,536 B | 66,560 B |
| 高 128，RC3 | 128 | 3 | 131,072 B | 65,536 B | 66,560 B |

端到端由多个逻辑载荷同时构成。高 4096 对照的编码输入/输出峰值均为 8192/533 B，解码输入/输出峰值均为 533/1024 B。编码直接处理路径的源原始块与物化样本重叠峰值为 16,384 B；可与原图窗口、Worker/桥接和预览重叠。页面有界路径逐块消费后丢弃，每个试次的 Workers 终态队列归零。原始值、预览 Canvas 与选用缓冲下载时的结果分别计量。没有浏览器总内存实测。 [高图对照](workbench-memory.json) · [短图复核](workbench-memory-short.json)

## 实际回归与未测范围

- Native 再验 1×4 四行在 EOI 之前交付，20 个终结用例及 stdin 开放时晚到尾随拒绝通过。Windows 三后端检查通过，JS、Wasm GC、WSL Native 核心各 7/7。 [Eager](native-eager.json) · [EOI](native-tail.json) · [JS](core-js.txt) · [Wasm GC](core-wasm-gc.txt) · [WSL](core-native.txt)
- 固定源用满 0..65535 夹具跑 NEAR=0 和 3。每次定向运行记录 8 次 CharLS Wasm 同码流比对、13 次 CharLS 2.4.5 同码流比对，最大原图样本误差分别为 0 和 3。两个运行调用相同的 160 个切分、162 个截断前缀以及 mutation 检查，不能相加为新的独立覆盖。 [NEAR=0](interop-near0/report.json) · [NEAR=3](interop-near3/report.json)
- Chrome 实际加载未注入计时钩子的候选产物。窗口读挂起 8 B 后取消立即重启，新任务像素为 4000 并下载新文件；还验证 sink write 挂起取消、非法/不支持提示、暂停、UI 语言切换和单字节延迟 ACK。暂停/恢复探针的已读量在 59 B 保持稳定，释放后完整重建。 [浏览器日志](chrome-smoke.txt) · [浏览器资产回执](chrome-smoke.json) · [便携取消探针](cancel-probe.txt)
- NASA LOLA 的 1440×720、16 位 PGM 实际经过浏览器编码下载 JLS，再从该 JLS 实际解码并下载 PGM。NEAR=3 生成 999,459 B，所有 1,036,800 个样本与 CharLS Wasm 同流重建相等，原图最大绝对误差为 3。 [来源、许可与生成](../../tests/fixtures/LUNAR_DATA.md) · [运行记录与产物哈希](workbench-real-download.json)
- 仓库外解包消费使用与 RC3 相同的 MoonBit 核心和独立 SDK 导出。Moon 包在三后端复验 8/12/16 位与 NEAR 0/3，独立 SDK 通过类型检查及 12 项双向验证。 [方法](external-consumer.md) · [记录](external-consumer.json)
- RC2 隔离 Worker 历史原始数据复算了 8 组 32 次预跑和 80 次正式数据。452 → 352 ms 的中位数降幅为 22.12%。单字节 Wasm GC/NEAR=0 首行未舍入差值约 3.1000 ms，门槛约 3.1900 ms。此次未重跑 RC2 的 80 个计时。 [RC2 哈希与区间复核](rc2-recheck.json)

原 Native 20 秒运行仍标记超时，原始超时时刻的已收字节数无法恢复。Native 大图三组各只跑一次。未测真实大图逐字节浏览器对照、浏览器平台总内存、系统文件保存对话框、Firefox/Safari 和 Mooncakes 在线安装。本地证据由作者实跑。

## 复跑

从源码包根目录执行 `python scripts/verify_rc3_evidence.py`。仅需 Python 和 Node，即可复算 RC2/RC3 门槛和检查保存的同流与暂停证据。构建、测试和平台安装步骤见 [验证说明](../../docs/VALIDATION.md) 与 [固定版本交接](../../docs/RC3_HANDOFF.md)。

```powershell
npm.cmd ci --prefix web
node sdk/build.mjs
node web/build.mjs
node web/bench-workbench.mjs --help
node --test web/pgm.test.mjs
node REVIEW_EVIDENCE/web_cancel_probe.mjs .
```

没有原静态快照时，从 Git 导出并解压 `299fd9a`，在解压根目录执行两个 build 命令获得独立基线。审查包内也有取自该提交且验过哈希的 [基线 app](baseline-web/app.mjs) 与 [基线 PGM](baseline-web/pgm.mjs)。用它们替换独立的静态树副本中的同名文件即可在无 Git 历史的解包目录复建基线。其余十个资产的原始哈希两侧完全相同。以下路径选用新的输出文件。

```powershell
$before = '.evidence/rc2-static'
$after = 'web/dist'
New-Item -ItemType Directory -Force .evidence | Out-Null
Copy-Item -Recurse $after $before
Copy-Item reports/rc3/baseline-web/app.mjs "$before/web/app.mjs"
Copy-Item reports/rc3/baseline-web/pgm.mjs "$before/web/pgm.mjs"
$baseline = '299fd9afcbaac67d8d65b42545fb632a429ef202'
$candidate = '2feb00b8ef657b7259ba70bccf1ff0ceaf08765b'
node web/bench-workbench.mjs --baseline $before --baseline-source $baseline --output .evidence/replay/profile.json --profile --backends wasm-gc,js --nears 0,3 --warmup 2 --repeats 5
node web/bench-workbench.mjs --baseline $before --baseline-source $baseline --candidate $after --candidate-source $candidate --output .evidence/replay/paired.json --backends wasm-gc,js --nears 0,3 --chunk 4096 --warmup 2 --repeats 5
node web/bench-workbench.mjs --baseline $before --baseline-source $baseline --candidate $after --candidate-source $candidate --output .evidence/replay/memory.json --profile
node web/bench-workbench.mjs --baseline $after --baseline-source $candidate --output .evidence/replay/memory-short.json --profile --height 128
python scripts/fetch_lunar_fixture.py .evidence/real/lola.pgm
node web/bench-workbench.mjs --baseline $after --baseline-source $candidate --output .evidence/replay/download.json --check-download .evidence/real/lola.pgm --nears 3
```

用 [产物清单](manifest.json) 将两个静态快照、Chrome 实际取回的响应与 Git 被测源相互对应。正式对照候选快照最初由 `6542292` 构建；`2feb00b` 只追加测试与复核工具。后者重建的全部 12 个无注入资产与候选快照逐文件 SHA-256 相同。首轮筛选 probe 的哈希与后续内存 probe 不同，均保留在各自原始报告中。

原始脚本文本、各试验的脚本和源码对应关系以及原包 SHA-256 见 [脚本溯源补档](harness/README.md)。
