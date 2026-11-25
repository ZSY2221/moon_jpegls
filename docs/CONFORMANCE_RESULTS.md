# T.87 Annex E 验证结果

2026-11-25（新加坡时间）。在固定 M2 源码 `fc43bc2b4ed69cad9d967e63c2019ff1e8f3be44` 上，运行了 Annex E Table E.2 全部 12 条官方流。JS、Wasm GC、WSL Native 各有四条编码通过、四条解码通过。其余八条多分量流在三后端均按当前范围返回 `UnsupportedFeature`。这些多分量模式的编码未运行。

| 用例 | 官方码流 | P / NEAR | 数据路径 | 编码（JS、Wasm GC、Native） | 解码（JS、Wasm GC、Native） |
| --- | --- | --- | --- | --- | --- |
| E.2-1 | `T8C0E0.JLS` | 8 / 0 | 三分量、分离扫描 | 未运行 | 预期 `UnsupportedFeature` |
| E.2-2 | `T8C1E0.JLS` | 8 / 0 | 三分量、行交错 | 未运行 | 预期 `UnsupportedFeature` |
| E.2-3 | `T8C2E0.JLS` | 8 / 0 | 三分量、样本交错 | 未运行 | 预期 `UnsupportedFeature` |
| E.2-4 | `T8C0E3.JLS` | 8 / 3 | 三分量、分离扫描 | 未运行 | 预期 `UnsupportedFeature` |
| E.2-5 | `T8C1E3.JLS` | 8 / 3 | 三分量、行交错 | 未运行 | 预期 `UnsupportedFeature` |
| E.2-6 | `T8C2E3.JLS` | 8 / 3 | 三分量、样本交错 | 未运行 | 预期 `UnsupportedFeature` |
| E.2-7 | `T8SSE0.JLS` | 8 / 0 | 三分量、子采样和行交错 | 未运行 | 预期 `UnsupportedFeature` |
| E.2-8 | `T8SSE3.JLS` | 8 / 3 | 三分量、子采样和行交错 | 未运行 | 预期 `UnsupportedFeature` |
| E.2-9 | `T8NDE0.JLS` | 8 / 0 | `TEST8BS2`，T1=T2=T3=9，RESET=31 | 通过，最大误差 0 | 通过，16,384 个样本一致 |
| E.2-10 | `T8NDE3.JLS` | 8 / 3 | `TEST8BS2`，T1=T2=T3=9，RESET=31 | 通过，最大误差 3 | 通过，16,384 个样本一致 |
| E.2-11 | `T16E0.JLS` | 12 / 0 | `TEST16`，有效精度 12 位，默认预置 | 通过，最大误差 0 | 通过，65,536 个样本一致 |
| E.2-12 | `T16E3.JLS` | 12 / 3 | `TEST16`，有效精度 12 位，默认预置 | 通过，最大误差 3 | 通过，65,536 个样本一致 |

## 实跑与判定

- §8.2 编码用官方 PGM 原图生成 MoonJLS 码流，由参考程序解码。NEAR=0 的重建对拍原图，NEAR>0 的重建对拍同一参考程序对官方流的重建，另核验相对原图的整数误差界。当前四个配置的三个后端还分别生成了与官方文件逐字节相同的码流。
- §8.3 解码用字节和 SHA-256 均核验的官方 `.JLS`，逐样本比较独立参考重建。在支持的四个用例中，JS、Wasm GC、Native 各匹配 163,840 个样本。多分量流的拒绝记录只用于范围边界。
- 官方软件轮使用 ITU-T 附件中的 HP JPEG-LS reference software 1.00，32 位 Windows 程序分别调用 `locod.exe`、`nlocod.exe`、`loco16d.exe` 和 `nloco16d.exe`。另以 `@team-charls/charls-wasm@0.10.0` 独立重测，得到相同的编码／解码结论。 [HP 实跑](../reports/t87-m2-20261125/annex-e-hp.json) · [CharLS 实跑](../reports/t87-m2-20261125/annex-e-charls.json)
- 初次运行的自定义 LSE1 输出以 0 请求默认 MAXVAL。HP 1.00 将它当作字母表大小 1，导致 E.2-9／10 的六个参考解码请求失败。改成在实际输出的 LSE1 明示全部解析后的值后，六项通过。MoonJLS 继续接收 Annex C 允许的零默认字段。 [初次失败](../reports/t87-m2-20261125/annex-e-hp-initial.json) · [LSE 生成](../core/bits.mbt)

Annex E 表只覆盖测试所列条件。M2 的独立合成矩阵另验证 388 个有效配置、18 项码流变体、7 项非法编码输入和 6 项 Native PGM 检查。参考结果区分历史 HP 程序直接处理、等价头适配和独立计算的 Annex A 小向量。完整 Part 1 继续覆盖多分量、采样、点变换、映射、简略格式、重启、DNL 和剩余语法。 [M2 合成矩阵](../reports/t87-m2-20261125/synthetic-matrix.md) · [机器可读矩阵](../tests/conformance/manifest.json) · [完整验收计划](T87_CONFORMANCE_PLAN.md)

## 复跑

从 ITU-T T.87 英文 PDF ZIP 中取出 `jlsimgV100.zip` 和 `jlsrefV100.zip`，分别解入 `.tools/annex-e` 和 `.tools/annex-e-hp`。官方数据、参考程序及其许可留在本地。数据和程序的归档及使用项 SHA-256 均记录在 [manifest](../tests/conformance/manifest.json)。 [ITU 下载与附件](https://www.itu.int/rec/T-REC-T.87-199806-I/en)

使用 Moon `0.1.20261119`、`moonc v0.10.22+124d61d05`、Node `24.20.0`。Native 环境为 Ubuntu 22.04 WSL2 与 Clang。以下命令在 Windows PowerShell 仓库根执行。

```powershell
node sdk/build.mjs
wsl -d Ubuntu-22.04 --exec bash -lc 'CC=clang ~/.moon/bin/moon build cmd/moonjls --target native --release --target-dir .tools/wsl-build'
node scripts/validate_annex_e.mjs --check-manifest
node scripts/validate_annex_e.mjs --fixtures .tools/annex-e --hp-reference .tools/annex-e-hp --native-wsl Ubuntu-22.04 --native-exe .tools/wsl-build/native/release/build/cmd/moonjls/moonjls.exe
npm.cmd install --prefix .tools/oracle-npm --ignore-scripts --save-exact @team-charls/charls-wasm@0.10.0
node scripts/validate_annex_e.mjs --fixtures .tools/annex-e --native-wsl Ubuntu-22.04 --native-exe .tools/wsl-build/native/release/build/cmd/moonjls/moonjls.exe
```

Linux 上使用本地 Native 二进制，并省去 `--native-wsl`。Windows HP 参考程序需能执行 32 位 x86 程序。测试脚本按码流记录失败与非零进程退出。CI 配置运行三后端构建和核心测试、Native 流式检查、Worker、报告与类型检查、矩阵清单检查及既有 640 组 NEAR 互操作。官方 HP 档案轮使用单独的本机实跑记录。CI 的工具链从 MoonBit 官方版本化归档取得，下载时核验工具链和核心库的 SHA-256，运行时核验 Moon 和 moonc 版本。CI 的运行结论以对应 GitHub Actions 记录为准。 [CI 配置](../.github/workflows/verification.yml)
