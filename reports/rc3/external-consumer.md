# 仓库外打包消费验证

2026-11-24（新加坡时间）在作者环境执行。打包源码为 `299fd9afcbaac67d8d65b42545fb632a429ef202`。使用 RC2 构建清单中的 JS 与 Wasm GC 资产，逐个核对 SHA-256。验证仅涉及 MoonBit 公共库与 SDK，页面缓存代码不在此项的验证范围内。 [命令、哈希和原始结果](external-consumer.json)

| 产物 | 字节数 | SHA-256 |
| --- | ---: | --- |
| `ZSY2221-moon_jpegls-0.1.0.zip`，`moon package --frozen` 实际输出 | 141,585 | `eb135fda965f069efe7fd67552211864aa968071558ee49800cf75e778ea1afd` |
| `MoonJLS-SDK-consumption-check.zip`，独立消费测试包 | 33,657 | `94ab9bbea5ee27b8c58b3ad134290db4e920db9969ad2a13d8450ebd53fc77e8` |

- MoonBit 在仓库外的系统临时目录中导出源码，再用实际打包命令生成 ZIP。另建的消费模块通过相对 `moon.work` 引用解出的包。JS、Wasm GC、Ubuntu 22.04 WSL Native 各通过 8、12、16 位与 NEAR=0、3 的 6 个用例。覆盖公开帧、限额、整图 API 和流式 step 接口。NEAR=0 与 NEAR=3 的最大误差分别为 0 和 3。
- Node 24.20.0 在独立目录加载解出的 SDK ZIP。包含两种生成核心、运行模块和两份声明。JS 和 Wasm GC 各通过 6 个 CharLS 双向比较。涵盖单字节解码、`Uint16Array` 输出、稳定 `Truncated` 错误类型。缓存中的 TypeScript 7.0.2 严格检查通过，包含 Worker client 的导出类型。Worker 导出可以从解出的包导入，真实浏览器 Worker 运行属于单独的浏览器回归。
- 固定裁判只在准备小型参考流和比较输出时使用。外部消费模块和 SDK 运行本身只加载解出的包。本次没有测试 Mooncakes 在线安装，也没有第三方采用结论。

以下命令在作者环境复跑，`--tsc` 传入现有的 TypeScript 编译器路径即可执行声明检查。 [执行脚本](external-consumer.py)

```powershell
python reports/rc3/external-consumer.py --commit 299fd9a `
  --output .evidence/rc3/external-recheck.json `
  --oracle-python .tools/oracle-venv/Scripts/python.exe `
  --native-wsl Ubuntu-22.04 `
  --tsc $tscPath
```
