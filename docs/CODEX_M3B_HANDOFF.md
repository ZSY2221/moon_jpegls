# MoonJLS M3-B 接力交接

2026-11-26（Asia/Singapore）。M3-B 的行交错、样本交错、H/V 采样和边缘 MCU 已在固定候选通过官方 Annex E Table E.2 的 **12/12** 三后端双向验收。 [逐项结果](CONFORMANCE_RESULTS.md) · [能力清单](../tests/conformance/manifest.json)

## 工作树与固定候选

- 工作目录为 D:\Program Files\GPT_project\moon_jpegls-antigravity，工作分支为 antigravity/t87-m3b-20261125。采样开始时本地和远端工作分支均为 6648e2382dc63ceba15b9382b81d76c2caece1ae，工作树干净。初始状态、过程输出和失败收据保存在 .evidence/codex-m3b-sampling/。
- 受测产品源码为 1b2d959015d15717b972c5a8bac35178b418d2d6，Git tree 为 62dbd8f829e0d6512d606fef269e44a12bcefd59。后续交接提交更新采样证据和能力清单。清单由 Web 构建复制，更新后已另核对打包版本。以 git rev-parse HEAD、git status 和远端查询获得当前分支状态。 [产品提交](https://github.com/ZSY2221/moon_jpegls/commit/1b2d959015d15717b972c5a8bac35178b418d2d6) · [工作分支 Actions](https://github.com/ZSY2221/moon_jpegls/actions?query=branch%3Aantigravity%2Ft87-m3b-20261125)
- 上一阶段保全了已有独立 ILV=1 提交 b76a02fb520861d002b17cb017e34d806b7fea5d，并在 25fadceb8de039a76e749ff368993a30926176aa 完成 ILV=2。E.2-2/3/5/6 在两个参考、三个后端都通过。接手前的二进制兼容检查点、完整 bundle、补丁和 SHA-256 在 .evidence/codex-m3b-takeover/。原工作目录 D:\Program Files\GPT_project\moon_jpegls 的较早核心改动和私有草稿仍在该目录。 [交错阶段原始结果](../reports/t87-m3b-20261126/annex-e-hp.json) · [交错阶段回归](../reports/t87-m3b-20261126/regressions.json)

## 官方采样向量与独立参考

| 用例 | NEAR | JS 编码 / 解码 | Wasm GC 编码 / 解码 | Native 编码 / 解码 | 每后端候选流 |
| --- | --- | --- | --- | --- | --- |
| E.2-7 T8SSE0.JLS | 0 | passed / passed | passed / passed | passed / passed | 51,781 B，与官方逐字节一致 |
| E.2-8 T8SSE3.JLS | 3 | passed / passed | passed / passed | passed / passed | 32,231 B，与官方逐字节一致 |

两条官方流的 SOF55 为 256×256、P=8。SOS 按 ID 1、2、3，ILV=1、Pt=0，映射选择器全零。H×V 分别为 2×4、2×1、1×2，真实分量分别为 256×256、256×64、128×128。64 个 MCU 每组按照 1、1、1、1、2、3、3 的整行顺序，共交付 448 行、98,304 样本。官方样例的高度可整除 Vmax，额外部分 MCU 由独立字面量和定向回归覆盖。 [T.87 §4.3.1、Annex B.2/B.4、C.2、Annex E](https://www.itu.int/rec/T-REC-T.87-199806-I/en)

HP 1.00 独立解出全部 12 条官方流和 36 份候选流。NEAR=0 样本等于原图，NEAR>0 与 HP 对官方流的重建完全相等，并满足与原图的误差界。E.2-8 相对原图最大误差是 3。同一码流的 MoonJLS 和 HP 重建逐样本一致。CharLS Wasm 0.10.0 对其它 10 条独立验证通过，对 E.2-7/8 返回 errorCode 7，列为 reference_unsupported。该能力探针退出码 1，候选流未再交给该参考。 [HP 全部 12 条](../reports/t87-m3b-20261126/annex-e-final-hp.json) · [CharLS 适用 10 条](../reports/t87-m3b-20261126/annex-e-final-charls.json) · [CharLS 采样能力](../reports/t87-m3b-20261126/annex-e-final-charls-sampling.json)

## 核心、宿主与边界

- [core/parameters.mbt](../core/parameters.mbt) 用受限整数计算分量几何，并按真实样本数判定资源上限。产品按本轮约定对两个轴都向上取整。T.87 §4.3.1 的原版横向公式未印出取整符号，HP 1.00 探针在部分非整比横向组合采用向下截断。官方 E.2-7/8 的比例都是整数，奇数尺寸测试单列。 [T.87](https://www.itu.int/rec/T-REC-T.87-199806-I/en)
- [core/model.mbt](../core/model.mbt) 的 next_line_or_finish 使补充行参与重建预测、共享上下文和分量 RUNindex，交付前移除。编码器使用上一条已重建行的样本补足末组，无额外整幅缓存。FF00 与 EBBC 两条手工熵字面量分别覆盖零补充行与非零补充行。HP 可读这两条宽度整齐的向量，但会把补行写入输出并产生不匹配的短分量 PGM 头。原始 HP 边界探针位于 .evidence/codex-m3b-sampling/hp-edge/。
- [Native CLI](../cmd/moonjls/main.mbt) 的 encode-pgms 接受 --sampling 2x4,2x1,1x2，decode-pgms 按真实分量尺寸输出，普通 PPM 拒绝不同尺寸的分量。Native raw-le 依交付顺序写真实行。[SDK](../sdk/index.mjs) 保留按声明分量顺序的连续 planar 输出，Worker 逐行和批次携带 width、height、stride、分量及扫描位置。切换分量等待旧批 ACK 时，也核算当前源行与旧批次同时持有的峰值。
- [现有工作台](../web/README.md) 的样本读数和报告按真实分量坐标。预览只在显示环节缩放，采样下载是按声明分量顺序的 U16LE 平面数据，报告含尺寸和偏移。E.2-7/8 的浏览器 smoke 验证导出与独立 HP 重建的哈希一致。本机浏览器的文件写入替身另验证 E.2-8 的定位写入。系统级文件选择器的人工流程仍未实测。

## 固定候选的复跑门禁

- 三后端核心各 26/26，--deny-warn 通过。SDK、Web 构建和 TypeScript 严格检查通过。Worker 协议 21/21，Node 26/26。真实 JS 和 Wasm GC Worker 样例验证了 71 个有效样本、EOI 前交付、等待 ACK 时取消和立即重启。旧 112 B 峰值仍符合其固定用例，新采样跨分量协议用例峰值是 38 B。
- M2/M3-A 黄金与 M3-B 新核心字面量和 Native 采样黄金均通过。完整 M2 共 388 正例、18 标记变体、7 非法编码、6 Native PGM。640 NEAR 矩阵在同一源码的 JS、Wasm GC、Native 上复跑通过。
- Native 行交付、多扫描交付、尾部与晚到尾随均通过。5×5 采样向量按 1 B 写入，在暂扣 EOI 时已交付 11 个有效行、47 个有效样本。补充行数为 5。
- 真实 Chrome 158 全套工作台 smoke 通过。E.2-7（JS）和 E.2-8（Wasm GC）分别导出 98,304 样本，另核验浏览器下载的 NASA LOLA 固定图像。固定 NEAR=3 LOLA 码流的 1,036,800 样本在三后端与 CharLS 同一码流重建完全一致，相对原始数据最大误差为 3。三个后端重新编码均与固定的 999,459 B 码流逐字节一致。 [回归原始数据索引和产物 SHA-256](../reports/t87-m3b-20261126/sampling-release-regressions.json) · [NASA 固定样例记录](../reports/t87-m3b-20261126/lola-fixed-sampling-candidate.json) · [数据出处](../tests/fixtures/LUNAR_DATA.md)

## 本机复跑

实际 WSL 名称为 OpenAtom-Validation-2204-20261120（Ubuntu 22.04.5 LTS、GCC 11.4.0）。Windows 与 WSL 使用 Moon 0.1.20261119 / moonc v0.10.22+124d61d05，Node 24.20.0。官方附件解包到 .tools/annex-e 与 .tools/annex-e-hp，版本和逐文件 SHA-256 写入 Annex E 收据。CharLS 包为 @team-charls/charls-wasm@0.10.0，安装在 .tools/oracle-npm。

~~~powershell
git status --short --branch
git rev-parse HEAD
$d = 'OpenAtom-Validation-2204-20261120'
$target = '.tools/wsl-build-codex-sampling'
$native = "$target/native/release/build/cmd/moonjls/moonjls.exe"
$out = '.evidence/codex-m3b-sampling'
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
wsl -d $d --exec python3 REVIEW_EVIDENCE/native_sampling_delivery_regression.py $native
node scripts/validate_annex_e.mjs --fixtures .tools/annex-e --native-exe $native --native-wsl $d --hp-reference .tools/annex-e-hp
node scripts/validate_annex_e.mjs --fixtures .tools/annex-e --native-exe $native --native-wsl $d --cases 1,2,3,4,5,6,9,10,11,12
node scripts/validate_annex_e.mjs --fixtures .tools/annex-e --native-exe $native --native-wsl $d --cases 7,8
python scripts/test_m2.py --hp-archive '../moon_jpegls/.tools/itu-reference/jlsrefV100.zip' --native-binary $native --native-wsl $d --directory "$out/m2-388"
& '../moon_jpegls/.tools/oracle-venv/Scripts/python.exe' scripts/validate.py --near-matrix --native-exe $native --native-wsl $d --directory "$out/near-640"
~~~

E.2-7/8 的 CharLS 采样能力探针预期退出码 1。浏览器复跑可在本机用 python -m http.server 8000 --bind 127.0.0.1 --directory web/dist 提供构建，另开 PowerShell。

~~~powershell
$env:MOONJLS_WEB_URL = 'http://127.0.0.1:8000'
$env:MOONJLS_CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
$env:MOONJLS_ANNEX_FIXTURES = (Resolve-Path '.tools/annex-e').Path
$env:MOONJLS_LOLA = (Resolve-Path '../moon_jpegls/.evidence/real/lola.pgm').Path
node web/smoke.mjs
~~~

固定 LOLA 历史流另用以下命令检查。报告绑定 PGM、JLS、三个产物和独立重建哈希。

~~~powershell
node "$out/verify_lunar_fixed.mjs" --project . --pgm '../moon_jpegls/.evidence/real/lola.pgm' --jls '../moon_jpegls/.evidence/lunar-budget-20261125/js-near3-9ca2f131-a782-4f31-9e5b-7da07274be5e/lola.jls' --native-exe $native --native-wsl $d --encode
~~~

本地 .evidence/codex-m3b-sampling/ 还有浏览器截图、命令原始退出码、HP 局限性样例、完整 388/640 原始数据、旧候选不支持采样的记录。公开 JSON 将临时路径的用户目录前缀替换为占位符。

## 下一阶段公开交付入口

从受测源码与已推送分支核对实际工作台、最新 CI 和能力清单，再执行提示词 3 的页面呈现、正常 PR 和公开交付。Annex E 全部使用 Pt=0。完整 T.87 Part 1 还有非零点变换、映射表和简略格式、重启、DNL、扩展尺寸等阶段。 [标准计划](T87_CONFORMANCE_PLAN.md) · [路线](ROADMAP.md)

## GitHub

产品提交 1b2d959015d15717b972c5a8bac35178b418d2d6 已正常推送。远端 main 查询为 3ebd55f09ebdb5b661ea2bd08fcab764e4f51d7c。产品和交接提交各自的运行绑定各自的 head SHA。 [产品提交 Verification](https://github.com/ZSY2221/moon_jpegls/actions/runs/45777394539) · [工作分支 Actions](https://github.com/ZSY2221/moon_jpegls/actions?query=branch%3Aantigravity%2Ft87-m3b-20261125)
