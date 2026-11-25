# NASA LOLA 月球高程误差预算实测

输入是 NASA CGI Moon Kit 的 unsigned `ldem_4_uint.tif`。从官方源下载后核对 TIFF SHA-256，再按原样本顺序转换为 1440×720、16 位 PGM。PGM 哈希为 `1adb4e047099b942c229a8d21d33b6227dd2b6af22984d8d9de6b128b0e858a6`。[NASA SVS 数据](https://svs.gsfc.nasa.gov/4720/#displacement) · [样本转换与出处](../../tests/fixtures/LUNAR_DATA.md)

| NEAR | 允许的最大高程重建误差 | 观测最大误差 | JPEG-LS 字节数 | 原始栅格 / JPEG-LS |
| ---: | ---: | ---: | ---: | ---: |
| 0 | 0 m | 0 m | 1,363,687 | 1.521× |
| 1 | 0.5 m | 0.5 m | 1,158,560 | 1.790× |
| 2 | 1.0 m | 1.0 m | 1,063,351 | 1.950× |
| 3 | 1.5 m | 1.5 m | 999,459 | 2.075× |

Windows Node.js 24.20.0 上，JS 和 Wasm GC 的四个档位各逐样本检查 1,036,800 个值。同一 NEAR 的两个后端生成相同的 JPEG-LS 和重建 PGM 字节，NEAR=0 的重建 PGM 与输入哈希相同。每个样本计数等于 0.5 m，表中的误差以 NASA 栅格中的原始高程为参照。压缩比的分子为 2,073,600 B 的原始整数栅格，不含 PGM 文件头。[八次运行的结构化报告](summary.json)

运行边界为 Node SDK 整图编码、严格解码至 EOI 并检查尾随数据、逐样本对照。报告保留各阶段的单次耗时、逻辑载荷、构建指纹和读取分块配置。独立参考实现、浏览器 Worker、Native 和进程 RSS 属于本次运行未执行的项目。

```powershell
node sdk/build.mjs
python scripts/fetch_lunar_fixture.py .evidence/real/lola.pgm
node scripts/verify_lunar_fixture.mjs --input .evidence/real/lola.pgm --output .evidence/lunar-budget-20261125
```

运行生成八组 `.jls`、重建 `.pgm` 和 `verification.json`，以及包含校验值的汇总。通过 `--summary` 可以将汇总写到指定的新路径。复跑保留之前的运行记录。

## Chrome 工作台复验

安装 `web/` 的开发依赖，运行 `node web/build.mjs`，再用 `python -m http.server 8000 --bind 127.0.0.1 --directory web/dist` 启动静态服务。另开终端运行 `node web/report-browser.mjs`。脚本默认加载 `.evidence/real/lola.pgm`，可用 `MOONJLS_LOLA` 指定路径，用 `MOONJLS_REPORT_RECEIPT` 保存实际下载的报告。

Chrome 158.0.8127.37 在 NEAR=3 显示 1.5 m 上界和 1.5 m 实测最大误差。像素 `(0,0)` 的原始与重建值为 20000、19999，对应 0 m、−0.5 m。独立打开下载的 JLS 只严格解码，不进行原图比对。普通 PGM 以及同尺寸且改动一字节的 PGM 都保持整数单位。报告覆盖成功、EOI 前取消、非法尾随失败，后两种的四行均标为暂定。
