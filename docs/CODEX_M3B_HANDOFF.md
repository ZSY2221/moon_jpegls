# MoonJLS M3-B 接力交接

2026-11-26（Asia/Singapore）。本轮完成等尺寸交错。官方 Annex E Table E.2 在同一候选三后端双向通过 **10/12**，采样验收为下一轮。 [逐项结果](CONFORMANCE_RESULTS.md) · [能力清单](../tests/conformance/manifest.json)

## 工作树与检查点

- 工作目录为 D:\Program Files\GPT_project\moon_jpegls-antigravity，分支为 antigravity/t87-m3b-20261125。接手时分支干净，已有 ILV=1 提交 b76a02fb520861d002b17cb017e34d806b7fea5d。两处工作树和 reflog 均未找到可复用的 ILV=2 差异，当前实现直接接在该提交上。
- 原 Codex 工作目录为 D:\Program Files\GPT_project\moon_jpegls。其 HEAD 为 27f045d853d6b6a1b1317a55f199d077705ba326，三份未提交的核心差异是较早的上下文及热循环优化。私有申报草稿留在原处。
- 本地 .evidence/codex-m3b-takeover/ 保存初始 worktree 列表、两树的 staged/unstaged 二进制兼容补丁、已核验的 m3b-base.bundle 和检查点 SHA-256。交接范围内未发现未跟踪源码。工作树状态以 git status --short --branch 为准。
- 受测核心、SDK、CLI 产品源码为 25fadceb8de039a76e749ff368993a30926176aa，Git tree 为 1f3732746e36b0bf709cfab3ca36dece86000a7d。后续交接提交更新文档、实测能力清单和记录。后续提交 SHA 可用 git rev-parse HEAD 获取。

## 结果与实现

| 用例 | ILV / NEAR | JS 编码 / 解码 | Wasm GC 编码 / 解码 | Native 编码 / 解码 | 每后端候选流 |
| --- | --- | --- | --- | --- | --- |
| E.2-2 T8C1E0.JLS | 1 / 0 | passed / passed | passed / passed | passed / passed | 100,615 B，官方逐字节一致 |
| E.2-3 T8C2E0.JLS | 2 / 0 | passed / passed | passed / passed | passed / passed | 99,734 B，官方逐字节一致 |
| E.2-5 T8C1E3.JLS | 1 / 3 | passed / passed | passed / passed | passed / passed | 63,005 B，官方逐字节一致 |
| E.2-6 T8C2E3.JLS | 2 / 3 | passed / passed | passed / passed | passed / passed | 62,300 B，官方逐字节一致 |

每条流在每后端核对 196,608 样本。HP 1.00 与 CharLS Wasm 0.10.0 分别对官方流和所有候选流独立解码，重建一致。NEAR=0 与官方原图逐样本一致。NEAR=3 与各参考解出的官方重建逐样本一致，相对原图最大误差为 3，同一码流 MoonJLS 和参考重建最大差为 0。现有六条 M2/M3-A 官方流在该提交上复跑通过。E.2-7/8 三后端解码返回预期 UnsupportedFeature；编码、H/V 重建和采样参考验收为 not_run。 [HP 原始 JSON](../reports/t87-m3b-20261126/annex-e-hp.json) · [CharLS 原始 JSON](../reports/t87-m3b-20261126/annex-e-charls.json)

ILV=1 已保全并复验。b76a02f 的三后端各 19/19，SDK 构建和 TypeScript 严格检查通过，Worker 协议 20/20，Node 21/21。该提交的 E.2-2/5 双参考三后端双向通过。当时 E.2-3/6 的预期失败已保留在本地 baseline-ilv2-{hp,charls}.json。当前提交仍通过 ILV=1 的这些门禁。

- [编码器](../core/encoder.mbt)的 Encoder::new_scans 分开校验帧分量数与扫描分量数。Encoder::sample_vector 跨输入分块保存部分向量，在扫描次序下共同判定游程并串行更新共享上下文。最大 4 个分量的码字输出先进入有容量上界的 BitWriter，再按调用方容量排出。
- [解码器](../core/decoder.mbt)的 Decoder::advance_scan 在一次符号提交后推进分量游标。Golomb 状态和游程余数跨输入块保留。ILV=2 的中断使用 RItype=0，并在整个像素向量中使用同一 glimit，再将 RUNindex 减一；联合游程关闭时单分量全零梯度进入普通上下文。 [T.87 Annex B.1–B.3、C.2.3、C.2.4.1.1](https://www.itu.int/rec/T-REC-T.87-199806-I/en)
- [扫描模型](../core/model.mbt)在每个 SOS 初始化 A/B/C/N/Nn，分量独立预测，按 SOS 顺序交付整行。ILV=1 的 RUNindex 仍按分量独立。 [SOF/SOS 语法及选择顺序](https://www.w3.org/Graphics/JPEG/itu-t81.pdf#page=41)
- [Native CLI](../cmd/moonjls/main.mbt)的 encode-ppm、encode-pgms、encode-planar 与 [SDK](../sdk/index.mjs)的 encodePlanarImage、编码流接口和 Node CLI 支持 ILV=2。CLI 的行缓冲与整幅 planar 转换分别统计。Worker 复用分量行与现有 ACK 协议，新增真 JS/Wasm GC 编解码、取消和立即重启断言。

## 已实跑回归与重建命令

三后端核心各 23/23，使用 --deny-warn。SDK、Web 构建和 TypeScript 7.0.2 严格检查通过。Worker 协议 20/20，Node 23/23（新增 JS、Wasm GC 两条 ILV=2 Worker 用例）。旧固定 Worker 峰值为 112 B，新固定向量为 72 B。核心白盒覆盖 2/3/4 分量、非连续 ID、首中末联合中断、零梯度正常上下文、glimit、长游程、8/12/16 位、NEAR=0/3、LSE1 继承和默认重算、单字节/7 B/4096 B 切分、重复空 NeedInput、非法分量/尺寸、截断、提前 EOI 和尾随。

Native 行交付、多扫描交付、严格尾部矩阵均通过。Native PPM/PGM/planar 与 Node CLI 的 36 次 ILV=1/2 调用均通过。M2 黄金为 12 正例、18 变体、7 非法编码、4 PGM。M3-A 黄金为 7 正、7 负、21 个后端分组检查、2 个 CharLS 检查。原 neg-interleaved-ilv2 流保持字节不变，其负例原因现在是过早遇到 EOI。Chrome 158 本机工作台导入官方 E.2-3（JS）和 E.2-6（Wasm GC），验证扫描已终结，并下载逐样本匹配独立参考的 PPM。GitHub Actions 对产品 SHA 的 640 NEAR 步骤已通过。完整 388 M2、本机 640 NEAR、浏览器全套及 NASA LOLA 按发布候选执行。 [回归记录、工具版本和三个产物哈希](../reports/t87-m3b-20261126/regressions.json)

实际 WSL 名称是 OpenAtom-Validation-2204-20261120，运行 Ubuntu 22.04.5 LTS、GCC 11.4。历史 Ubuntu-22.04 注册名在本机不存在。Windows 与 WSL 均使用 Moon 0.1.20261119 / moonc v0.10.22+124d61d05，Node 24.20.0。官方附件的解包文件放在 .tools/annex-e，HP 四个可执行文件放在 .tools/annex-e-hp，逐文件哈希由验证器与清单核对。 [官方 ITU 来源](https://www.itu.int/rec/T-REC-T.87-199806-I/en)

~~~powershell
git branch --show-current
git rev-parse HEAD
git status --short --branch
$d = 'OpenAtom-Validation-2204-20261120'
$target = '.tools/wsl-build-codex-m3b'
$native = "$target/native/release/build/cmd/moonjls/moonjls.exe"
moon check --target all --deny-warn
moon test core --target js --deny-warn
moon test core --target wasm-gc --deny-warn
wsl -d $d --exec /root/.moon/bin/moon test core --target native --target-dir $target --deny-warn
wsl -d $d --exec /root/.moon/bin/moon build cmd/moonjls --target native --release --target-dir $target --deny-warn
node sdk/build.mjs
node web/build.mjs
$types = (Get-ChildItem sdk -Filter '*.d.mts').FullName
npx.cmd --yes --package typescript@7.0.2 tsc --noEmit --strict --module nodenext --target es2022 --lib es2022,dom @types
node --experimental-vm-modules --test scripts/test_worker_protocol.mjs
node --test scripts/test_worker_codec.mjs scripts/test_verification_report.mjs web/pgm.test.mjs web/preview.test.mjs
node scripts/verify_m2_golden.mjs --native-exe $native --native-wsl $d
node scripts/verify_m3a_golden.mjs --native-exe $native --native-wsl $d --with-oracle
wsl -d $d --exec python3 REVIEW_EVIDENCE/native_row_delivery_regression.py $native
wsl -d $d --exec python3 REVIEW_EVIDENCE/native_multiscan_delivery_regression.py $native
wsl -d $d --exec python3 REVIEW_EVIDENCE/native_tail_matrix.py $native
node scripts/validate_annex_e.mjs --fixtures .tools/annex-e --native-exe $native --native-wsl $d --hp-reference .tools/annex-e-hp
node scripts/validate_annex_e.mjs --fixtures .tools/annex-e --native-exe $native --native-wsl $d
~~~

CharLS 包固定为 @team-charls/charls-wasm@0.10.0，安装目录为 .tools/oracle-npm。完整原始 stdout/stderr、退出记录、ILV=1 基线、浏览器 smoke 和 CLI 针对性复跑脚本位于本地 .evidence/codex-m3b-takeover/。旧固定 Worker 套件须加 --experimental-vm-modules。最初的错误试跑日志保留在 ilv1-worker-actual.log；使用项目实际命令后通过。

## 下一轮 H/V 入口

- 先读官方 T8SSE0.JLS、T8SSE3.JLS 的 SOF55/SOS，与三个原图 PGM 的真实几何核对。清单已有 TEST8R.PGM、TEST8GR4.PGM、TEST8BS2.PGM 的来源哈希。下一条记录命令见下方。当前 runner 对 E.2-7/8 仍假设等尺寸；执行正向验收前先让 readOriginal、HP 输出解析、compare 和 streamEvidence 按真实分量尺寸工作。
- 从 HeaderParser::scan_segment 与 Encoder::new_scans 的采样闸门、FrameInfo::component_width / component_height 和资源预算接入。ILV=2 同一扫描的等尺寸校验继续保留。采样的 MCU 编码顺序从 Scan::next_line_or_finish 接续，尤其检查补充行的熵状态与预测行更新、有效行交付和统计；Encoder::step 增加流式补行来源，Decoder::step 消费补足的行。
- Host 从 cmd/moonjls/main.mbt 的 decode-pgms 与 sdk/index.mjs 的行元数据和 decodePlanarImage 开始核对。Worker 的 sdk/worker.mjs 在切换分量时可能同时持有旧批次和新行，重算真实宽度下的 ACK 生命周期峰值。保留真正提前交付的回归。

~~~powershell
node scripts/validate_annex_e.mjs --fixtures .tools/annex-e --cases 7,8 --native-exe $native --native-wsl $d --hp-reference .tools/annex-e-hp
~~~

只有两个采样向量也完成与受测候选绑定的三后端双向验收后，才能更新 12/12。Annex E 全部使用 Pt=0，Pt 专项独立推进。

## GitHub

分支初次正常推送到 antigravity/t87-m3b-20261125，核对到远端产品提交 25fadceb8de039a76e749ff368993a30926176aa。首次 push 的 Verification 已通过，包括 640 NEAR 回归步骤。远端 main 查询为 3ebd55f09ebdb5b661ea2bd08fcab764e4f51d7c。当前分支的后续 push 有其自己的 Actions 记录。 [产品提交 Verification](https://github.com/ZSY2221/moon_jpegls/actions/runs/45773364958) · [工作分支 Actions](https://github.com/ZSY2221/moon_jpegls/actions?query=branch%3Aantigravity%2Ft87-m3b-20261125)
