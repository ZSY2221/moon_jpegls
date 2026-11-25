# MoonJLS 评审指南（两分钟完整审查入口）

本文档专为比赛评委与技术审查人员编写，可独立阅读，直接回应初审驳回意见并给出所有可验证链接与复现命令。

## 1. 对初审驳回意见的逐条回应

原初审意见：*“高位深科研图像保存具有明确用途，纯 MoonBit 编解码与流式状态管理也有实质贡献；但材料仅确立受限 JPEG-LS 子集，后续计划未包含完整 T.87 标准符合性目标，尚不满足本轮格式实现的终点要求。需补明最终标准范围与分阶段兼容路径。”*

1. **① 最终目标**：**MoonJLS 的最终目标是完整实现 ITU-T T.87（06/1998）/ ISO/IEC 14495-1 JPEG-LS Part 1 的编码、解码和数据格式能力**，并按标准要求分阶段验证（`§8.2`/`§8.3`、Annex E 与独立参考实现）。**当前 M3-A 是演进路线上的阶段版本，不是最终标准范围。** T.870 Part 2 与 DICOM 属独立扩展，SPIFF（`§4.8` / `Annex H.5`）按可选容器单列。 [完整标准目标与能力矩阵](T87_CONFORMANCE_PLAN.md)
2. **② 当前已完成（M3-A 阶段版本）**：M0（基线与修复）、M1（满量程 NEAR 640/640）、M2（`P=2–16`、独立 `MAXVAL`、合法 `NEAR`、自定义 `LSE1`）与 **M3-A（单帧 1–255 分量、`H=V=1`、非交错多扫描 `ILV=0`、`Pt=0`、跨扫描 `LSE1` 继承与零默认重算、非连续 ID 与合法重排扫描、Native planar 流式 CLI 及多通道工作台 + Scan Structure Inspector）均已完成**（“两条预测行”核心工作区与 Scan 状态分开记账，P6 RGB 宿主平面转换另行单独记账 `host_conversion_buffer_bytes`）。
3. **③ 后续实现路径**：**交错、采样和点变换（`M3-B`，目标 2026-12-25，首要验收 `E.2-2`/`E.2-3`/`E.2-5`–`E.2-8`）→ 其余格式与标记能力（`M4`，目标 2027-01-10，包含 `LSE2/3`、简略与表规范格式、`DRI/RST`、`DNL`、`LSE4`）→ 完整符合性验收（`M5`，目标 2027-01-20）**。上述日期均为内部工程开发目标，不代表赛事已认可的期限。 [分阶段兼容路线](ROADMAP.md)
4. **MoonBit 原生实现证据**：100% JPEG-LS 算法、预测/上下文建模、Golomb/位填充、多扫描状态机、Native CLI 与 JS/Wasm GC FFI 端口全部由纯 MoonBit 编写（`17` 个 `.mbt` 文件，共 **6,764 行**）；JS 仅承担宿主加载、Worker 背压协议、P6 PPM 宿主格式包装与浏览器工作台 UI，不含编解码数学逻辑。 [MoonBit 原生实现地图](MOONBIT_IMPLEMENTATION_MAP.md)

## 2. 当前 M3-A 已交付能力与真实验证口径

- **M3-A 实现范围**（固定受测产品核心/CLI/SDK [`36bb9e6`](https://github.com/ZSY2221/moon_jpegls/commit/36bb9e6a77bd38db6806a0cc5047885b694276b5)）：完整支持 M2 全部单分量精度与预置能力，并在单帧多分量、每扫描 `Ns=1`/`ILV=0`/`H=V=1`/`Pt=0` 下支持任意合法分量 ID、非法扫描拓扑校验、跨扫描 `LSE1` 继承/零默认重算与 Native/SDK/Worker/Chrome 工作台全链路多通道检查。
- **全部真实实测记录**（下列所有套件均直接在 `36bb9e6` 上重跑验证；完整日志与收据见 [M3-A 验收汇总](../reports/t87-m3a-20261125/README.md)）：
  1. **三后端核心测试**：Native / JS / Wasm GC 各 **18/18** 通过（`--deny-warn` 0 警告）。
  2. **官方 Annex E Table E.2（4/12 → 6/12）**：**`E.2-1`（`T8C0E0.JLS`）**、**`E.2-4`（`T8C0E3.JLS`）** 与 **`E.2-9`–`E.2-12`** 在三后端通过 **HP 1.00** 与 **CharLS Wasm 0.10.0** 编码与解码验收，全部 **18 次**候选编码与官方 `.JLS` 逐字节一致；**`E.2-2, 3, 5, 6, 7, 8`**（交错/子采样）解码按预期返回 `UnsupportedFeature`。**通过 6/12 属于阶段进展，不宣称完整 Part 1 或“完成 50%”。** [Annex E 逐项结果](CONFORMANCE_RESULTS.md)
  3. **M3-A & M2 黄金回归（CI 每次运行）**：`scripts/verify_m3a_golden.mjs`（7 正例 + 7 负例 + CharLS 核对）、`scripts/verify_m2_golden.mjs`（12 正例 + 18 变体 [含 `lse-after-scan` → `InvalidData`] + 7 非法编码 + 4 PGM）及 Native 跨扫描实时行交付回归 `native_multiscan_delivery_regression.py` 全部通过。
  4. **本机全量合成矩阵与 NEAR 回归**：**388 组 M2 正例 + 18 变体 + 7 非法编码 + 6 PGM**（HP 1.00 & Annex A）与 **640/640** 满量程 NEAR 双向回归均在三后端通过（`640` 组仅为满量程 NEAR 回归，非 M2/M3-A 全笛卡尔积）。
  5. **真实浏览器工作台**：Chrome 158 完成 `#sample-rgb8`、16-bit 多分量样本（`>255` 原值保留）、独立 `.jls`（`C0/C1/C2` 标签与 Scan Structure Inspector 点击联动）及 CharLS Wasm 独立解码核对。
  6. **包发布边界**：`moon package --frozen` 打包无警告通过；Mooncakes 在线查询返回 HTTP 404 / `not found`，未执行线上发布。 [Mooncakes 记录](MOONCAKES_RELEASE.md)

## 3. 最快独立复现（从仓库根执行）

```sh
# 核心测试（JS / Wasm GC / Native）
moon test core --target js --deny-warn
moon test core --target wasm-gc --deny-warn
CC=clang moon test core --target native --deny-warn

# 构建 SDK、工作台与 Native CLI，并执行 CI 同款独立 M2 & M3-A 黄金回归
CC=clang moon build cmd/moonjls --target native --release --deny-warn
node sdk/build.mjs
node web/build.mjs
node scripts/validate_annex_e.mjs --check-manifest
node scripts/verify_m2_golden.mjs --native-exe _build/native/release/build/cmd/moonjls/moonjls.exe
node scripts/verify_m3a_golden.mjs --native-exe _build/native/release/build/cmd/moonjls/moonjls.exe

# 本地启动科学工作台（打开 http://127.0.0.1:8000/web/）
python -m http.server 8000 --bind 127.0.0.1 --directory web/dist
```

## 4. 关键审查入口索引

- **仓库主页（`main`）与 PR**：[`main`](https://github.com/ZSY2221/moon_jpegls) 完整呈现在 PR #1（M2）之后通过 `antigravity/t87-m3a-20261125` 合并的最新 M3-A 源码、文档与证据（M3-A 核心锚定 [`36bb9e6`](https://github.com/ZSY2221/moon_jpegls/commit/36bb9e6a77bd38db6806a0cc5047885b694276b5)）。
- **核心规范与路线**：[T87_CONFORMANCE_PLAN.md](T87_CONFORMANCE_PLAN.md) · [ROADMAP.md](ROADMAP.md) · [SCOPE.md](SCOPE.md) · [CONFORMANCE_RESULTS.md](CONFORMANCE_RESULTS.md)
- **源码与实测**：[MOONBIT_IMPLEMENTATION_MAP.md](MOONBIT_IMPLEMENTATION_MAP.md) · [PROJECT_STATUS.md](../PROJECT_STATUS.md) · [reports/t87-m3a-20261125/README.md](../reports/t87-m3a-20261125/README.md)
