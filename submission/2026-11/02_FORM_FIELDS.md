# 飞书官方报名表逐项填写与修改指南（2026-11-25 实地核对版）

官方报名表链接：`https://bxup9uklfcb.feishu.cn/share/base/form/shrcnWUMlgpbwHaXgzV7HmNhNhg`
表单标题：**2026 MoonBit 国产基础软件开源大赛-11月黑客松 项目申报**

> **操作规则（2026-11-25 实测确认）**：页面顶部提示 `问卷仅能提交三次，可以重复修改。` 请先登录您原提交使用的飞书账号，点击页面右上角 **「查看提交记录」** 打开原未通过初审的申报记录进行修改并重新提交，**切勿新建重复报名记录**。本清单仅供您本人核对、修改与最终点击提交。

---

## 一、实测飞书表单全部真实字段清单（共 14 个基础字段 + 5 个条件触发字段）

以下字段名称、必填标记（`*`）、条件触发逻辑及填表提示均按飞书表单实测结果逐一核对：

| 序号 | 飞书真实字段名 | 必填 | 出现条件 | 建议填写 / 核对内容 |
| :-: | --- | :-: | --- | --- |
| 1 | **是否参加过MoonBit黑客松** | `*` | 始终显示 | 沿用原报名选择（选「是」可复用部分个人信息，同时隐藏字段 4/7/15/16；选「否」会显示全部 19 项字段） |
| 2 | **参赛方向** | `*` | 始终显示 | 沿用原报名选择（如 `新项目申报-参与季度评选` 或 `新项目申报-不参与季度评选`；选新项目申报时显示字段 11 `项目申报书`） |
| 3 | **姓名** | `*` | 始终显示 | 沿用本人真实姓名 |
| 4 | **GitHub ID** | `*` | 仅第 1 题选「否」时显示 | `ZSY2221`（若为团队则列出全部队员 GitHub ID） |
| 5 | **联系方式（邮箱）** | `*` | 始终显示 | 沿用本人国内邮箱（表单提示不要使用 Gmail 等国外邮箱） |
| 6 | **联系方式（电话）** | `*` | 始终显示 | 沿用本人可加微信的手机号 |
| 7 | **身份证照片** | `*` | 仅第 1 题选「否」时显示 | 沿用本人身份证正反面照片（可加参赛水印） |
| 8 | **身份证号码** | `*` | 始终显示 | 沿用本人真实身份证号 |
| 9 | **项目名称** | `*` | 始终显示 | `MoonJLS——纯 MoonBit JPEG-LS Part 1 编解码内核与符合性验证工具链`（若字符长度受限，可用 `MoonJLS` 或 `MoonJLS: MoonBit-Native JPEG-LS Part 1 Codec`） |
| 10 | **项目的GitHub仓库链接** | `*` | 始终显示 | 若希望评审入口直达含 M2 及最新复审材料分支：填写 `https://github.com/ZSY2221/moon_jpegls/tree/codex/moonjls-reappeal-20261125`（或在获得您确认将 PR #1 合并至 `main` 后填 `https://github.com/ZSY2221/moon_jpegls`；**当前 `main` 仍是旧版 `60befa6`，务必在备注与申报书中同步注明 PR #1 与复审分支！**） |
| 11 | **项目申报书** | `*` | 第 2 题选「新项目申报-*」时显示 | **文件上传（支持多文件）**。**重要提示**：表单下方明确写明 **`请使用 markdown 格式，长度控制在一页以内，不要使用 AI 编写。`** 建议您先审阅并用本人语言微调 [`03_ONE_PAGE_PROPOSAL.md`](03_ONE_PAGE_PROPOSAL.md) 后再上传（若平台需要 PDF 附图版可一并附 [`04_ONE_PAGE_PROPOSAL.pdf`](04_ONE_PAGE_PROPOSAL.pdf)） |
| 12 | **银行卡账号** | `*` | 始终显示 | 沿用原填写账号（无空格） |
| 13 | **银行卡所属分行** | `*` | 始终显示 | 沿用原填写开户支行全称 |
| 14 | **推荐人** | 选填 | 始终显示 | 若无推荐人留空或保持原填写；如有有效推荐人填写其已成功报名的 GitHub ID（“已有项目维护”填“无”） |
| 15 | **所属高校/组织** | `*` | 仅第 1 题选「否」时显示 | 沿用原真实高校/组织全称（无则填“无”） |
| 16 | **学信网认证报告** | `*` | 仅第 1 题选「否」时显示 | 沿用原学信网在线验证/学历证明材料 |
| 17 | **《参赛诚信承诺书》** | `*` | 始终显示 | 勾选 `我已阅读并同意《参赛承诺书》` |
| 18 | **备注** | 选填 | 始终显示 | **强烈建议在此粘贴完整复审说明 [`01_RESUBMISSION.txt`](01_RESUBMISSION.txt)**（若字段字数受限，则粘贴下文第三节的「精简版备注文本」，确保评委直接看到对初审驳回意见的回应、PR #1、分支及评审指南链接） |
| 19 | **你是通过什么渠道了解到本次比赛的？** | 选填 | 始终显示 | 沿用原填写 |

---

## 二、标准申报核心内容对照表（覆盖评审所需全部 14 项内容）

不论填写在 **字段 11《项目申报书》**、**字段 18 备注**，还是补充给组委会的说明中，以下全部要素已齐备且口径一致：

| 内容维度 | 可直接复制使用的标准内容 |
| --- | --- |
| **项目名称** | MoonJLS——纯 MoonBit JPEG-LS Part 1 编解码内核与符合性验证工具链（`MoonJLS: MoonBit-Native JPEG-LS Part 1 Codec and Conformance Verification Toolkit`） |
| **项目简介** | MoonJLS 面向高精度整数图像的数据交换，提供纯 MoonBit JPEG-LS 编解码核心、Native／JS／Wasm GC 流式接入及可复现的符合性验证工具链。当前 M2 阶段支持单帧、单分量、单扫描的 P=2–16、独立 MAXVAL、合法 NEAR 和自定义 LSE ID 1 预置参数。项目最终目标是完整实现 ITU-T T.87（06/1998）／ISO/IEC 14495-1 JPEG-LS Part 1 的编码、解码和数据格式能力，并通过官方 Annex E、§8 符合性测试和独立参考实现逐阶段验收。 |
| **项目目标** | 完整实现 ITU-T T.87（06/1998）／ISO/IEC 14495-1 JPEG-LS Part 1 编解码及全部交换/简略/表规范格式，覆盖 Native、JS、Wasm GC 三后端，并提供有界流式传输与逐项独立验证闭环。 |
| **真实应用场景** | ① **高精度科研与遥感数据无损/可控近无损保存**（如 NASA LOLA 16 位月面高程图、工业/显微灰度栅格，支持逐样本校验与精确误差界）；② **大图有界流式管道处理**（CLI/管道/Browser Worker 分块输入输出、逐行确认背压与取消，不在核心缓存整图）；③ **MoonBit 生态图像工具集成**（提供 `ZSY2221/moon_jpegls` 核心包及 `MoonImage Gray16` 适配示例）。 |
| **核心交付物** | 纯 MoonBit 核心库 `core/*.mbt`（2,807 行）、Native 流式 CLI `cmd/moonjls`（622 行）、JS/Wasm GC FFI 桥接 `cmd/bridge`（477 行）、SDK 与背压 Worker（`sdk/`）、浏览器科学工作台 Precision/Streaming/Compatibility Lab（`web/`）、独立参考验证工具链与黄金回归（`scripts/`、`tests/conformance/`）。 |
| **技术路线** | 以单一纯 MoonBit 核心驱动三后端（Native 直接链接；JS/Wasm GC 经标量/打包 FFI 端口导出，零编解码逻辑在宿主 JS 中），通过 `Encoder::step` / `Decoder::step` 有界状态机实现分块无关流式处理、严格 EOI 尾随检测及外部参考对拍。 |
| **当前完成度** | **M0（基线与修复）、M1（满量程 8/12/16 位 NEAR 640/640）、M2（P=2–16、独立 MAXVAL、合法 NEAR、LSE ID=1 自定义预置）均已完成**。当前 M2 为阶段性交付，**不是最终标准范围**。 |
| **标准最终目标** | 完整覆盖 **ITU-T T.87（06/1998）/ ISO/IEC 14495-1 JPEG-LS Part 1**：基础交换格式（SOF55/SOS/EOI、P=2–16、Regular/Run/Run interruption、Golomb/填充、LSE1、多分量多扫描、ILV=0/1/2、采样与 MCU、Pt、LSE2/3、DRI/RST、DNL、LSE4）+ 简略与表规范格式（§7(b)(c)、LSE2/3 外部表生命周期）+ §8/Annex E 符合性。T.870 Part 2 与 DICOM 属独立扩展，SPIFF 为单独说明的可选容器。 |
| **阶段兼容路线** | M0–M2 已完成；**M3-A**（目标 2026-12-10）：多分量与 `ILV=0` 多扫描（验收 E.2-1/E.2-4）；**M3-B**（目标 2026-12-25）：`ILV=1/2`、采样、MCU、点变换 `Pt`（验收 E.2-2/3/5–8）；**M4**（目标 2027-01-10）：`LSE2/3`、表规范与简略格式、`DRI/RST`、`DNL`、`LSE4` 与剩余标记；**M5**（目标 2027-01-20）：完整 Part 1 符合性闭环与发布候选。（以上均为内部开发目标，赛事验收节点以组委会为准。） |
| **测试与独立验证** | 三后端核心单元测试各 15/15；M2 独立合成矩阵 388 正例 + 18 LSE 变体 + 7 非法编码 + 6 Native PGM 通过；CI 运行 12 组独立 HP/Annex A 黄金用例 + 18 变体 + 7 非法编码 + 4 PGM + 历史 640 满量程 NEAR 矩阵；官方 Annex E E.2-9–12 双向通过且 12 次编码逐字节一致（E.2-1–8 按当前范围返回 `UnsupportedFeature`）；NASA LOLA 1,036,800 样本与 Chrome 工作台通过。 |
| **GitHub** | 仓库：`https://github.com/ZSY2221/moon_jpegls`；复审最新分支：`https://github.com/ZSY2221/moon_jpegls/tree/codex/moonjls-reappeal-20261125`（注：`main` 仍为 `60befa6` 旧版，最新交付在 PR #1 及 `codex/moonjls-reappeal-20261125` / `antigravity/t87-m2-20261125`） |
| **PR** | `https://github.com/ZSY2221/moon_jpegls/pull/1`（唯一开放 PR，已更新标准路线与 CI 黄金回归） |
| **评审指南** | `https://github.com/ZSY2221/moon_jpegls/blob/codex/moonjls-reappeal-20261125/docs/REVIEWER_GUIDE.md` |
| **推荐人** | 留空或保持原报名填写（若由赛事推荐人推荐，填写其已报名成功的 GitHub ID；已有项目维护赛道填“无”） |

---

## 三、字段 18「备注」精简版备选文本（如字数受限时使用）

```text
【初审意见复审补充】针对“需补明最终标准范围与分阶段兼容路径”，项目已明确最终目标是完整实现 ITU-T T.87(06/1998)/ISO/IEC 14495-1 JPEG-LS Part 1 编解码与数据格式能力（含交换格式、表规范与简略格式、§8/Annex E）。当前 M2（P=2–16、独立 MAXVAL、合法 NEAR、LSE1 自定义预置）为阶段版本，非最终范围。后续路线（内部目标）：M3-A 多分量与 ILV=0 多扫描（12-10，验收 E.2-1/4）→ M3-B ILV=1/2、采样与 Pt（12-25，验收 E.2-2/3/5–8）→ M4 映射表/简略格式/DRI/DNL/LSE4（01-10）→ M5 完整 Part 1 闭环（01-20）。最新成果与 CI 见 PR #1：https://github.com/ZSY2221/moon_jpegls/pull/1 ；评审指南：https://github.com/ZSY2221/moon_jpegls/blob/codex/moonjls-reappeal-20261125/docs/REVIEWER_GUIDE.md ；能力矩阵：https://github.com/ZSY2221/moon_jpegls/blob/codex/moonjls-reappeal-20261125/docs/T87_CONFORMANCE_PLAN.md
```
