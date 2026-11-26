# JPEG-LS 非零点变换

本专项基于已交付的 M3-B，在 `codex/t87-pt-20261126` 独立验证。

## 条款与样本域

- T.87 §4.3.2 规定 SOF55 的 `P=2–16` 是原始样本精度。编码器在预测前取 `q=floor(x/2^Pt)`，预测行、梯度、游程和误差都使用编码域整数。由 T.87 §7 与 Annex F 第 15 步，交付样本时将编码域重建值乘回 `2^Pt`。分量预测行保留编码域值，补充行仍参与熵状态。
- T.87 C.2.3 沿用 T.81 B.2.3 的 SOS 布局。低四位 `Al` 表示 `Pt=0–15`。原始精度为 P 且 `Pt≥P` 时，合法输入的商全为零。编码器写高四位 `Ah=0`，解码器沿用 T.81 Table B.3 的严格标记检查。T.87 §3.3 中的“ignored”描述 Ah 不参与计算。非零 Pt 要求该扫描所有 `Tmi=0`。不同扫描可分别取 Pt、NEAR、LSE1。
- T.87 C.2.4.1.1 的 Table C.1 / C.2 使用 SOF55 的 P。即使输入商最多只有 `max(P−Pt,0)` 个有效位，默认 MAXVAL 仍为 `2^P−1`。显式 LSE1、零字段继承、阈值、RESET 和 `NEAR ≤ min(255, floor(MAXVAL/2))` 按活动编码参数解析。输入同时受原始 P 与移位后 MAXVAL 约束。
- 当 `Tmi=0` 时，令 `s=2^Pt`、`x=s·q+r`、`0≤r<s`。若 `|q̂−q|≤NEAR`，则 `|s·q̂−x|≤s·NEAR+s−1`。Pt>0、NEAR=0 会保留编码域的 q，原始低位仍可能丢失。报告分别记录编码域 NEAR、原始域误差界与两域实测误差。

[T.87 正文与官方附件](https://www.itu.int/rec/T-REC-T.87-199806-I/en) · [T.81 B.2.3 与 Table B.3](https://www.w3.org/Graphics/JPEG/itu-t81.pdf)

## 输出范围

MoonBit `Decoder::row` 和整图 API 返回精确的 `Int32` 重建值。解码器为非零 Pt 扫描按分量保留一条恢复行，计入核心载荷。补充行消耗码流，用户仅收到有效行。

合法的近无损重建可能超出 SOF55 的原始样本精度。例如 P=16、Pt=1 的固定向量在 NEAR=3 时可得到 `q̂=32768`，逆变换为 **65536**。Native 固定宽度 raw 输出、SDK/Worker 与 Netpbm 保持已有存储约定。能用所选格式表示的值精确交付。超过格式上限的值触发 `UnsupportedFeature`。FFmpeg 9.0.1 的 16 位输出在上述向量中回绕为 0，其结果只用于支持范围内的直接对照。

## 固定候选验收

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

H/V 组合有手推 Annex B 末组向量和 Native 报告回归。Native 实跑 5×5 不齐整采样时，报告取得 10 行和 44 个有效样本。H/V 与非零 Pt 的完整独立工具矩阵及现有接口的宽像素输出仍待验收，因此分支标记 `partially_supported`。

同一提交的官方 Annex E 12 项在三个后端以 HP 1.00 做双向回归，36 份编码均与官方逐字节一致。官方向量全部使用 Pt=0。三后端核心各 28/28、Worker 21/21、Node 26/26、SDK/Web 构建和严格 TypeScript 通过。本机完整 M2（388 组）及同一候选 CI 的 640 组 NEAR 均通过。Chrome 158 在项目子路径验证 Pt=4、NEAR=0 的 JLS、报告和 PGM 下载，编码域误差为 0，原始域实际最大误差为 15。Chrome 同时覆盖旧采样导出、取消/重启、ACK 及 1,036,800 样本 NASA LOLA。[Pt=0 官方回归](../reports/t87-pt-20261126/pt0-annex-e-regression.json) · [运行与资产记录](../reports/t87-pt-20261126/runtime-regression.json) · [受测提交 CI](https://github.com/ZSY2221/moon_jpegls/actions/runs/45785757788)

首轮提交的 Chrome 检查发现扫描完成后仍显示 Pt=0。修复后从实际 SOS 读出 Pt、NEAR 和预置值，并在同一套 Chrome 检查中重跑。保留首轮失败记录。[首轮 CI](https://github.com/ZSY2221/moon_jpegls/actions/runs/45785056933)

## 复跑

~~~powershell
$d = 'OpenAtom-Validation-2204-20261120'
$target = '.tools/wsl-build-codex-pt'
$native = "$target/native/release/build/cmd/moonjls/moonjls.exe"
moon check --target all --deny-warn
wsl -d $d --exec /root/.moon/bin/moon build cmd/moonjls --target native --release --target-dir $target --deny-warn
node sdk/build.mjs
node web/build.mjs
node scripts/verify_point_transform.mjs --native-exe $native --native-wsl $d --ffmpeg ffmpeg
python scripts/fetch_annex_e.py --fixtures .tools/annex-e-ci --hp-reference .tools/annex-e-hp
node scripts/validate_annex_e.mjs --fixtures .tools/annex-e-ci --native-exe $native --native-wsl $d --hp-reference .tools/annex-e-hp
~~~

在 `.tools/oracle-npm` 安装固定的 `@team-charls/charls-wasm@0.10.0`。GitHub CI 同时运行 Pt 独立编码域和短向量矩阵。直接 FFmpeg 和 HP 能力探针来自本机运行。
