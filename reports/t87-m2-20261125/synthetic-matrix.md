# M2 单分量合成矩阵

2026-11-25（新加坡时间），Windows Node 24.20.0 的 JS、Wasm GC 与 Ubuntu 22.04 WSL Native 均通过同一矩阵。受测核心、CLI 和 SDK 源码对应提交 `fc43bc2b4ed69cad9d967e63c2019ff1e8f3be44`。Moon 0.1.20261119、moonc v0.10.22+124d61d05，Native 使用 clang 14。本轮复核单帧、单分量、单扫描的 P=2–16、MAXVAL、NEAR 和 LSE ID 1。 [夹具、参数及 SHA-256](synthetic-matrix-manifest.json) · [逐用例后端结果及产物 SHA-256](synthetic-matrix-results.json)

| 检查 | 实测 |
| --- | ---: |
| 正常配置，三后端编码码流逐字节相同、重建逐样本相同 | 388 |
| JS、Wasm GC、Native 每个后端的有效 LSE 变体 | 5 |
| 每后端拒绝的非法、截断或超出子集的 LSE 变体 | 13 |
| 每后端拒绝的非法编码参数或样本 | 7 |
| Native PGM 输入、输出及重编码核对 | 6 |

388 个正常配置包含各位深的代表性合法 MAXVAL 与去重后的 NEAR 0、1、上限减一、上限。MAXVAL 覆盖 1、2、非二次幂、二次幂边界、满量程减一、满量程，以及 SOF 精度大于实际 MAXVAL 所需位深。专门的 16 位 257×600 条纹图在 RESET=65535 下交付 154,200 个无误差样本，重复更新同一个常规上下文并越过 RESET 计数。三后端分别比较正常与单字节分块的输出，也分别将参考码流的分块重建与参考整数完全对拍。最大观测误差为 255，每个用例均不超过自己的 NEAR。

## 独立参考的边界

- 正向共 231 个 HP/ITU V.1.00 原样码流、106 个保持 HP 熵段并调整 SOF 精度与等效显式 LSE 的码流，以及 51 个由 T.87 Annex A 游程和 Golomb 规则推导的 1×1 小码流。反向以 HP 原样解码 189 个三后端共享码流、以保持熵段的 SOF/LSE 等效形式解码 148 个，另对 51 个小码流独立复核熵字节与像素。HP 可下载的参考工具限定在常规码流语法。 [ITU-T T.87 与官方参考资料](https://www.itu.int/rec/T-REC-T.87-199806-I/en)
- HP 工具拒绝 MAXVAL 1/2，且部分低 MAXVAL 的隐式阈值与 T.87 默认公式有差异。探针曾在 P=3、MAXVAL=4、NEAR=1 得到 HP 隐式阈值 2/2/2，T.87 公式给出 3/3/3。合成矩阵为 HP 显式传入标准的有效阈值和 RESET，并对写出的实际参数复核。旧解码器需要的等效头部转换只改 SOF 精度和 LSE，保留 SOS 与熵码流。归档 SHA-256 为 `085285f0552ef0b6ebcf29bc5a6d3bc0d6bda0408e9f2f1c138be2e55200814f`。
- 固定的 CharLS 2.4.5 通路先使用满量程初始化编码参数，再改写部分自定义 MAXVAL 信息。其预测裁剪也依赖适用于满量程的位掩码。因此合成矩阵的任意 MAXVAL 采用上述 HP 与 T.87 小向量，Annex E 的独立结果另行保存。 [CharLS 编码参数初始化](https://github.com/team-charls/charls/blob/14b654dff1efed4d04e278ff3e99f0a486cf20cc/src/jpegls.cpp#L143-L164) · [CharLS 预测裁剪](https://github.com/team-charls/charls/blob/14b654dff1efed4d04e278ff3e99f0a486cf20cc/src/default_traits.h#L82-L90) · [Annex E 结果](annex-e-hp.json)

## 复跑

先构建当前 SDK 与 WSL Native。将 ITU-T T.87 附带归档中的 `jlsrefV100.zip` 保存在仓库外。下面从 Windows PowerShell 调用官方 32 位 Windows 参考程序，真实 Native CLI 由 WSL 运行。

```powershell
node sdk/build.mjs
wsl -d Ubuntu-22.04 --exec bash -lc 'CC=clang ~/.moon/bin/moon build cmd/moonjls --target native --release --target-dir .tools/wsl-build'
python scripts/test_m2.py --hp-archive 'C:/path/to/jlsrefV100.zip' `
  --native-binary .tools/wsl-build/native/release/build/cmd/moonjls/moonjls.exe `
  --native-wsl Ubuntu-22.04 --directory .evidence/m2-matrix-wide
```

完整运行退出码为 0。先前 283 配置子集也已独立通过。扩大矩阵的首次重启曾在创建 Windows 进程前遇到系统错误 1455。稍后重跑完成全部 388 配置。旧 HP 工具的 `-i...` 调用出现访问冲突 `0xc0000005`，正式运行使用位置参数输入，参考计算和样本证据均来自成功运行。
