# 内嵌 JPEG-LS 映射表

以已发布的 Pt 版本 `caf99016798e1e4aa23f12426df2266278401825` 为基础，验证 JPEG-LS 交换格式中内嵌的单字节映射表。能力清单将整个映射功能列为 `partially_supported`。

## 编解码语义

- T.87 §7 在预测解码完成后使用重建索引 `Rx` 查表。分量预测行与熵状态保留索引，流式输出只转换有效行。
- C.2.3 用 SOS 的 `Tmi` 为各分量选择表。0 表示恒等，非零 `Pt` 要求所有选择器为 0。选择时表的条目数必须等于当前 LSE1 及帧默认值解析出的 `MAXVAL+1`。
- C.2.4.1.2–3 给出定义、重定义和续表结构。ID 2 可重定义同一 TID，ID 3 必须紧接上一表段，TID 和 Wt 匹配，非末段填满可容纳的条目。对 Wt=1 的默认 P16 表，两个段容纳 65,530 和 6 个条目。
- Native、SDK 和 Worker 提供映射值与选择器。PGM 使用 MAXVAL 255。浏览器和报告保留编码域 NEAR，任意映射后的误差上界记作无定义。未内嵌的引用需要外部表的简略格式支持，当前返回 `UnsupportedFeature`。引用的多字节表同样返回该状态，C.2.4.1.2 未规定这些字节的应用解释。

[ITU-T T.87 标准和附件](https://www.itu.int/rec/T-REC-T.87-199806-I/en)

## 独立参考

用固定 [CharLS 3.0.0-dev `36255a43`](https://github.com/team-charls/charls/tree/36255a43fb95179d6466f61df2f604ae0b6a3d4d) 从码流解码索引。再调用 `get_mapping_table_id`、`find_mapping_table_index`、`get_mapping_table_info` 和 `get_mapping_table_data` 取出实际内嵌的字节，按 `table[Rx]` 计算输出。两条主要向量由该过程独立核对。

| 向量 | 解码索引 | 映射结果 | 表数据 SHA-256 |
| --- | --- | --- | --- |
| P2，MAXVAL=3，Wt=1 | 0, 3, 1, 2 | 201, 234, 212, 223 | `3a6fb44eb00988e27498bfbc278ed34124af50fca3bbb22b82f9df4318bd9e96` |
| P16，MAXVAL=65535，Wt=1，LSE2+LSE3 | 0, 65535, 17, 65528, 65529, 65530, 65531 | 201, 190, 132, 113, 124, 135, 146 | `482235240c5d2583492ae60c3997acbfd81f2d565a993f93b8255bae3c2c9f6d` |

CharLS Wasm 0.10.0 仅交付索引。HP 1.00 接受独立的基础索引流，遇内嵌表退出 10（`reference_unsupported`）。固定 CharLS 开发版将同 TID 重定义拒为重复表。重定义向量用独立编码的每扫描索引和按 T.87 写入的两份四项字典验证，前后扫描各有自己的预期结果。[重定义条款及独立向量](../scripts/verify_mapping_tables.mjs)

## 复跑

~~~powershell
moon check --target all --deny-warn
node sdk/build.mjs
$d = 'OpenAtom-Validation-2204-20261120'
$target = '.tools/wsl-build-codex-m4-mapping'
wsl -d $d --exec /root/.moon/bin/moon build cmd/moonjls --target native --release --target-dir $target --deny-warn
$native = "$target/native/release/build/cmd/moonjls/moonjls.exe"
node scripts/verify_mapping_tables.mjs --native-exe $native --native-wsl $d
~~~

验证器用固定索引流和显式表字节构造输入，输出逐条 SHA-256、重建和错误分类。正例按 1/7/4096 B 输入，包含 SOS 分量选择、跨扫描复用和重定义、预帧表、实际 P16 续表及标记填充。反例包含缺表、非法 Pt、截断、链间插入标记、错误 TID/Wt、错误项数与严格尾随。SDK 检查表段共 65,550 B 时预算的精确边界。真实 Chrome 用两个 Worker 后端下载映射 PGM 和报告。

## 固定候选结果

产品提交 `3ffdf629b9ebe3ef48d5f31d66632e28111c99b3` 的 Native、JS、Wasm GC 各通过 8 条正例，每例以 1、7、4096 B 解码。13 条反例核对格式错、参考功能范围、截断及严格尾随，两种 SDK 后端另核验预算边界和暂停 EOI 时的选择器元数据。Native PGM 实际载荷为 `201,234,212,223`，头部 MAXVAL 255。[逐条哈希与命令](../reports/t87-m4-mapping-20261126/embedded-mapping.json)

在 E.2-8 的 NEAR=3 索引流上另构造只映射第二分量的变体。原始索引重建哈希逐样本对应 HP 1.00，变体在三个后端均得到独立预期的 98,304 样本和 448 行。5×5 奇数采样向量的 41 样本及 11 行一致，消费 1 个补充行。两个变体使用经 E.2-7/8 校准的 Python 索引参考和逐索引查表。

本机复跑官方 Annex E 12 条，三个后端的 36 份编码与官方逐字节一致，36 次解码均与本机 HP 参考重建一致。核心三后端各 29/29，Worker 21/21，Node 33/33，388 组 M2、Native 流式和 TypeScript 通过。Chrome 首次测试因新用例把数字传给 Playwright 表单填写函数而退出。测试脚本修订 `6f8a2ee72baaee866f6692cc498e0ab36808e811` 后完整复跑通过，验证两个 Worker 后端的 PGM 与报告，并复核 NASA LOLA 的 1,036,800 个样本。[本机门禁记录](../reports/t87-m4-mapping-20261126/embedded-mapping.json) · [PR #4](https://github.com/ZSY2221/moon_jpegls/pull/4)
