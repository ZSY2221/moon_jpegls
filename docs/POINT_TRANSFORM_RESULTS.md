# JPEG-LS 非零点变换

本专项基于已交付的 M3-B，在 `codex/t87-pt-20261126` 独立验证无映射表的非零 Pt、适用的交错和采样组合，以及精确宽输出。

## 条款与样本域

- T.87 §4.3.2 规定 SOF55 的 `P=2–16` 是原始样本精度。编码器在预测前取 `q=floor(x/2^Pt)`，预测行、梯度、游程和误差都使用编码域整数。由 T.87 §7 与 Annex F 第 15 步，交付样本时将编码域重建值乘回 `2^Pt`。分量预测行保留编码域值，补充行仍参与熵状态。
- T.87 C.2.3 沿用 T.81 B.2.3 的 SOS 布局。低四位 `Al` 表示 `Pt=0–15`。原始精度为 P 且 `Pt≥P` 时，合法输入的商全为零。编码器写高四位 `Ah=0`，解码器沿用 T.81 Table B.3 的严格标记检查。T.87 §3.3 中的“ignored”描述 Ah 不参与计算。非零 Pt 要求该扫描所有 `Tmi=0`。不同扫描可分别取 Pt、NEAR、LSE1。
- T.87 C.2.4.1.1 的 Table C.1 / C.2 使用 SOF55 的 P。即使输入商最多只有 `max(P−Pt,0)` 个有效位，默认 MAXVAL 仍为 `2^P−1`。显式 LSE1、零字段继承、阈值、RESET 和 `NEAR ≤ min(255, floor(MAXVAL/2))` 按活动编码参数解析。输入同时受原始 P 与移位后 MAXVAL 约束。
- 当 `Tmi=0` 时，令 `s=2^Pt`、`x=s·q+r`、`0≤r<s`。若 `|q̂−q|≤NEAR`，则 `|s·q̂−x|≤s·NEAR+s−1`。Pt>0、NEAR=0 会保留编码域的 q，原始低位仍可能丢失。报告分别记录编码域 NEAR、原始域误差界与两域实测误差。

[T.87 正文与官方附件](https://www.itu.int/rec/T-REC-T.87-199806-I/en) · [T.81 B.2.3 与 Table B.3](https://www.w3.org/Graphics/JPEG/itu-t81.pdf)

## 输出范围

MoonBit `Decoder::row` 和整图 API 返回精确的 `Int32` 重建值。解码器为非零 Pt 扫描按分量保留一条恢复行，计入核心载荷。补充行消耗码流，用户仅收到有效行。

合法的近无损重建可能超出 SOF55 的原始样本精度。例如 P=16、Pt=1 的固定向量在 NEAR=3 时可得到 `q̂=32768`，逆变换为 **65536**。FFmpeg 9.0.1 的 16 位输出在该向量中回绕为 0，其结果只用于其支持范围内的直接对照。

- Native `moonjls decode INPUT OUTPUT raw32-le 4096` 按有效行的交付顺序输出每样本 4 B。另提供 `raw32-be`。
- JS/Wasm GC SDK 流式和整图解码接受 `sampleFormat: 'u32'`，输出 `Uint32Array`。Worker 用同样选项提供 4 B 样本，并按实际转移缓冲区和 ACK 生命周期统计。SDK CLI 的 `decode --sample-format u32` 输出小端数据，报告记录宽度、端序和布局。
- 工作台的 32 位平面下载按 SOF 分量顺序输出小端整数。报告包含各分量的字节偏移和真实几何。预览点读保留整数，显示映射单独计算。Chrome 实测并下载 **65540**（字节 `04 00 01 00`）。[浏览器截图](../reports/t87-pt-20261126/point-transform-u32.png)
- 固定窄 raw 和默认 SDK 窄输出继续按原有宽度工作，超限时返回 `UnsupportedFeature`。PGM/PPM 的 MAXVAL 上限为 65535。[Netpbm PGM 格式](https://netpbm.sourceforge.net/doc/pgm.html)

## 宽输出与采样候选验收

冻结产品提交 [`7835c6147b869f3f4db565c1a2b726f48d088a6a`](https://github.com/ZSY2221/moon_jpegls/commit/7835c6147b869f3f4db565c1a2b726f48d088a6a)。上一候选的 12 条向量在本提交复跑，三后端共 108 次编码和 108 次解码通过。[本次逐条结果](../reports/t87-pt-20261126/wide-fixed-point-transform.json)

独立 Python 参考按 Annex A、B、C 和 F 实现编码、解码和边缘行重建。先用官方原始数据重建两条 Pt=0 校准流。E.2-7 的 51,781 B 与 E.2-8 的 32,231 B 均与官方码流逐字节一致。两个重建各有 98,304 个有效样本，哈希匹配归档的 HP 1.00 收据。校准后的参考生成和解码以下非零 Pt 流。[独立参考实现](../scripts/sampled_point_transform_reference.py) · [逐条向量、命令与哈希](../reports/t87-pt-20261126/sampled-point-transform.json)

矩阵共 16 条，包含 P=8/12/16、奇数尺寸、ILV=0/1 的不等采样、等几何 ILV=2、每扫描 Pt/NEAR 和显式 LSE1。NEAR 主要用 0 和 3，并用 2 捕捉宽值。使用 1/7/4096 B 码流切分。附加的 ILV=2 与 ILV=0 混合扫描条目在 Native CLI 执行解码，在 JS/Wasm GC 执行双向验证。

| 后端 | 编码 | 解码 | 替代补行解码 |
| --- | ---: | ---: | ---: |
| JS | 48/48 | 48/48 | 24/24 |
| Wasm GC | 48/48 | 48/48 | 24/24 |
| Native | 45/45 | 48/48 | 24/24 |

5×5 的 P=16/Pt=2/NEAR=2 采样向量交付 11 行、47 个有效样本，消费码流中的 5 个补充行，首样本恢复为 65540。Native 的 36 次宽输出分块和端序检查还覆盖 65536、同帧扫描使用不同 Pt，以及 2,147,450,880，并验证 EOI 前行交付和晚到尾随拒绝。奇数采样沿用双轴向上取整。官方校准数据的尺寸比例均可整除。[宽输出与回归记录](../reports/t87-pt-20261126/wide-release-regressions.json)

同一产品提交在三个后端以 HP 1.00 双向复跑全部 12 项 Pt=0 官方用例，36 份候选流均与官方逐字节一致。三后端核心各 28/28、Worker 21/21、Node 33/33、SDK/Web 构建和严格 TypeScript 通过。本机 388 组 M2 及产品提交 CI 的 640 组 NEAR 通过。Chrome 158 实跑 JLS、PGM、32 位输出和报告下载，同时核对采样的有效平面、ACK、取消重启及 1,036,800 样本 NASA LOLA。[本次 Pt=0 官方回归](../reports/t87-pt-20261126/wide-pt0-annex-e-hp.json) · [产品提交 CI](https://github.com/ZSY2221/moon_jpegls/actions/runs/45791800761)

宽输出候选首次 push 检查在 M2 非法编码探针中遇到 stdin `EPIPE`，同一 SHA 的 PR 检查通过。测试运行器修订 `cb21fbfaa3f3547d0ba2c0a515f2bf1c762dfdd0` 仅在预期拒绝且子进程已非零退出时保留退出码和 stderr，继续执行原有拒绝断言。[失败记录](https://github.com/ZSY2221/moon_jpegls/actions/runs/45791678744) · [最终 PR 检查](https://github.com/ZSY2221/moon_jpegls/pull/3/checks)

## 前一候选验收与参考能力

受测提交为 [`d5a9ab436ab7362f7601a64469fdf940db46ec5b`](https://github.com/ZSY2221/moon_jpegls/commit/d5a9ab436ab7362f7601a64469fdf940db46ec5b)。以下用例在 JS、Wasm GC、Native 上分别以 1、7、4096 粒度执行编码和解码。SDK 编码输入按样本计，码流和 Native 分块按字节计。[逐条源样本、参考、重建、命令与哈希](../reports/t87-pt-20261126/point-transform.json)

| 用例 | 数量 | 范围 | 三后端两方向 |
| --- | ---: | --- | --- |
| 默认参数灰度 | 6 | P=8/12/16，Pt=2/4/5，NEAR=0/3，边界和非零余数 | passed |
| Pt 边界 | 2 | P=8，Pt=8 和 15，商为零 | passed |
| 行/样本交错 | 2 | ILV=1、2，同尺寸三分量 | passed |
| 非交错独立扫描 | 1 | 三扫描分别取 Pt=2/0/3 与 NEAR=3/0/0 | passed |
| 显式 LSE1 | 1 | MAXVAL=31，手算游程中断码字和解码结果 | passed |

共 **108 次编码、108 次解码**。FFmpeg 9.0.1 直接解码 9 条参考流和 27 份候选流，逐样本相同。其余多分量正例使用 CharLS Wasm 0.10.0 提供独立的 Pt=0 编码域熵流和重建，再依据标准写入 SOS 的 Al 和乘回尺度。显式 MAXVAL=31 的单像素参考手算熵字节为 `20`，由 FFmpeg 直接验算。额外覆盖非法映射选择器、Ah 标记检查、超出 MAXVAL 的 NEAR、截断、尾随、重复 NeedInput 和输入 Pt=16。[独立验证器](../scripts/verify_point_transform.mjs)

HP 1.00 直接遇到非零 Pt 退出 10，CharLS Wasm 直接返回错误 7，能力项记为 `reference_unsupported`。18 条识别能力探针中，FFmpeg 17 条精确重建，1 条暴露 uint16 回绕。边界测试的正确恢复值为 260、4100、65540。Native P8 raw 拒绝 260，PGM 可精确保存。P12 的 4100 在 Native raw16 和 SDK 中通过。P16 的 65540 在原有窄输出路径明确返回 `UnsupportedFeature`。Native 无输出的 `inspect` 和 `verify` 可检查宽值所在码流。SDK 的 `inspect` 使用 Uint16 行通路，遇宽值也会拒绝。[工具能力探针](../reports/t87-pt-20261126/reference-capabilities.json)

该候选另有手推 Annex B 补行向量和 Native 5×5 采样报告，交付 10 行和 44 个有效样本。当时仍在验收广泛 H/V 组合和精确宽输出。当前验收见上节。

同一提交的官方 Annex E 12 项在三个后端以 HP 1.00 做双向回归，36 份编码均与官方逐字节一致。官方向量全部使用 Pt=0。三后端核心各 28/28、Worker 21/21、Node 26/26、SDK/Web 构建和严格 TypeScript 通过。本机完整 M2（388 组）及同一候选 CI 的 640 组 NEAR 均通过。Chrome 158 在项目子路径验证 Pt=4、NEAR=0 的 JLS、报告和 PGM 下载，编码域误差为 0，原始域实际最大误差为 15。Chrome 同时覆盖旧采样导出、取消/重启、ACK 及 1,036,800 样本 NASA LOLA。[Pt=0 官方回归](../reports/t87-pt-20261126/pt0-annex-e-regression.json) · [运行与资产记录](../reports/t87-pt-20261126/runtime-regression.json) · [受测提交 CI](https://github.com/ZSY2221/moon_jpegls/actions/runs/45785757788)

首轮提交的 Chrome 检查发现扫描完成后仍显示 Pt=0。修复后从实际 SOS 读出 Pt、NEAR 和预置值，并在同一套 Chrome 检查中重跑。保留首轮失败记录。[首轮 CI](https://github.com/ZSY2221/moon_jpegls/actions/runs/45785056933)

## 复跑

~~~powershell
$d = 'OpenAtom-Validation-2204-20261120'
$target = '.tools/wsl-build-codex-pt-wide'
$native = "$target/native/release/build/cmd/moonjls/moonjls.exe"
moon check --target all --deny-warn
wsl -d $d --exec /root/.moon/bin/moon build cmd/moonjls --target native --release --target-dir $target --deny-warn
node sdk/build.mjs
node web/build.mjs
node scripts/verify_point_transform.mjs --native-exe $native --native-wsl $d --ffmpeg ffmpeg
python scripts/fetch_annex_e.py --fixtures .tools/annex-e-ci --hp-reference .tools/annex-e-hp
node scripts/verify_sampled_point_transform.mjs --fixtures .tools/annex-e-ci --native-exe $native --native-wsl $d
wsl -d $d --exec python3 REVIEW_EVIDENCE/native_wide_output_regression.py $native
node scripts/validate_annex_e.mjs --fixtures .tools/annex-e-ci --native-exe $native --native-wsl $d --hp-reference .tools/annex-e-hp
~~~

在 `.tools/oracle-npm` 安装固定的 `@team-charls/charls-wasm@0.10.0`。GitHub CI 运行两套 Pt 矩阵和 Native 宽输出。直接 FFmpeg 和 HP 运行来自本机。[PR #3](https://github.com/ZSY2221/moon_jpegls/pull/3) · [部署记录](https://github.com/ZSY2221/moon_jpegls/deployments)
