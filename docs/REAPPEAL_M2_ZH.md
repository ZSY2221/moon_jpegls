# MoonJLS 11 月黑客松复审补充说明

MoonJLS——纯 MoonBit JPEG-LS Part 1 编解码内核与符合性验证工具链（MoonJLS: MoonBit-Native JPEG-LS Part 1 Codec and Conformance Verification Toolkit）。

感谢评审指出初审材料中“最终标准范围与分阶段兼容路径”说明不足。**MoonJLS 的最终目标是完整实现 ITU-T T.87（06/1998）/ ISO/IEC 14495-1 JPEG-LS Part 1 的编码、解码和数据格式能力**，并通过 `§8.2`/`§8.3`、Annex E 与独立参考实现逐阶段验收。当前已完成 M0（基础引擎与三处修复）、M1（满量程 8/12/16 位 NEAR 扩展，640/640）与 M2（单帧单分量单扫描下的 `P=2–16`、独立 `MAXVAL`、基于有效 `MAXVAL` 约束的合法 `NEAR` 以及 `LSE ID=1` 自定义 `T1/T2/T3/RESET`）。**当前 M2 是演进路线上的阶段版本，不是最终标准范围。**

## 当前 M2 独立验证与 CI 加固

- **受测 M2 产品源码**：[`fc43bc2b4ed69cad9d967e63c2019ff1e8f3be44`](https://github.com/ZSY2221/moon_jpegls/commit/fc43bc2b4ed69cad9d967e63c2019ff1e8f3be44)；M2 证据冻结基线 [`a7d8c39`](https://github.com/ZSY2221/moon_jpegls/commit/a7d8c391b7af0d88bc5c912ed62c78eaf4c79565)。
- **三后端实测与固定源码归档证据**：JS / Wasm GC / Native 核心白盒测试各 **15/15**；固定受测源码 `fc43bc2` 的本机独立矩阵 **388 组**正例、**18 个** LSE 变体、**7 个**非法编码边界与 **6 项** Native PGM 检查全部通过；官方 Annex E **`E.2-9`–`E.2-12`** 三后端编码与解码通过（12 次候选编码与官方流逐字节一致），**`E.2-1`–`E.2-8`** 对应未实现多分量能力，解码按预期返回 `UnsupportedFeature`（编码尚未运行）；历史满量程 NEAR **640/640** 复跑通过（仅限满量程 8/12/16 位 NEAR 回归，不是 M2 全参数空间穷举）；NASA LOLA **1,036,800** 样本与 Chrome 158 工作台验收通过（以上重型实验沿用 `fc43bc2` 归档证据）。
- **CI 新增独立合成黄金回归**：GitHub Actions 已新增 [`scripts/verify_m2_golden.mjs`](../scripts/verify_m2_golden.mjs)，每次推送自动在三后端运行 12 组独立合成 HP/Annex A 黄金用例、18 个 LSE 变体（含零默认字段）、7 个非法编码边界及 4 项 Native PGM 检查（注：12 组合成黄金用例不等同于官方 Annex E 全部 12 项通过）；Annex E 清单检查与完整 ITU 语料本机实跑明确区分。
- **包发布边界**：`0.1.0` 本地归档回环 registry 消费通过三后端，**不等于 Mooncakes 公开发布成功**；Mooncakes 线上查询返回 HTTP 404，尚未进行线上正式发布。

## 分阶段兼容路线（内部开发目标）

- **M3-A（目标 2026-12-10）**：多分量帧与非交错多扫描（`ILV=0` 多 `SOS`、跨扫描 LSE 继承与错序检查），首要验收 Annex E **`E.2-1`、`E.2-4`**。
- **M3-B（目标 2026-12-25）**：交错模式（`ILV=1/2`）、合法采样因子与边缘 MCU、点变换 `Pt` 及双尺度误差分离，首要验收 Annex E **`E.2-2`、`E.2-3`、`E.2-5`–`E.2-8`**。
- **M4（目标 2027-01-10）**：`LSE ID=2/3` 映射表及续表、表规范数据与简略图像格式（`§7(b)(c)`）、`DRI/RST0–RST7`、`DNL`、`LSE ID=4` 扩展尺寸与剩余标记语法。
- **M5（目标 2027-01-20）**：完整 Part 1 符合性验收（官方 Annex E `12/12`、`§8.2`/`§8.3`、独立参考、三后端及干净环境复现）。上述日期均为项目内部工程目标，不代表组委会已认可最终验收日期。T.870 Part 2 与 DICOM 属独立扩展，SPIFF 按可选容器单列。

恳请根据补充后的完整 T.87 Part 1 最终目标、M0–M2 已交付成果、MoonBit 原生实现证据与带退出条件的分阶段兼容路线重新审核。

- 仓库默认分支 `main` 与目标合入 PR：[ZSY2221/moon_jpegls](https://github.com/ZSY2221/moon_jpegls) · [Pull Request #1](https://github.com/ZSY2221/moon_jpegls/pull/1)（`codex/moonjls-reappeal-20261125` → `main`）
- 固定受测源码提交：[`fc43bc2`](https://github.com/ZSY2221/moon_jpegls/commit/fc43bc2b4ed69cad9d967e63c2019ff1e8f3be44) · M2 证据冻结：[`a7d8c39`](https://github.com/ZSY2221/moon_jpegls/commit/a7d8c391b7af0d88bc5c912ed62c78eaf4c79565)
- 两分钟评审入口：[REVIEWER_GUIDE.md](REVIEWER_GUIDE.md) · [MOONBIT_IMPLEMENTATION_MAP.md](MOONBIT_IMPLEMENTATION_MAP.md)
- 权威标准矩阵与路线：[T87_CONFORMANCE_PLAN.md](T87_CONFORMANCE_PLAN.md) · [ROADMAP.md](ROADMAP.md) · [CONFORMANCE_RESULTS.md](CONFORMANCE_RESULTS.md)
