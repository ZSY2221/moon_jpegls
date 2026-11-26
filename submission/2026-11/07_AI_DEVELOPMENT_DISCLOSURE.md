# MoonJLS AI 辅助开发记录

## 实际分工

- M0–M2 阶段，Codex 与早期 Antigravity 参与核心、CLI 和桥接、SDK/Worker、工作台与验证脚本开发。
- Antigravity 实现 M3-A 多分量非交错多扫描、跨扫描 LSE1、Native planar/PGM/PPM 流式路径、SDK/Worker 多扫描协议、结构检查器与独立黄金回归。M3-A 以 HP 1.00 和 CharLS Wasm 复验了所支持的 6 条官方向量。Antigravity 随后实现首版 ILV=1 并提交 `b76a02fb520861d002b17cb017e34d806b7fea5d`。[M3-A 记录](../../reports/t87-m3a-20261125/README.md)
- Codex 接手后保全并复验 ILV=1，完成 ILV=2、H/V 采样、边缘 MCU 和三后端的独立验收，更新既有工作台、GitHub 验证和公开交付材料。[M3-B 交接](../../docs/CODEX_M3B_HANDOFF.md) · [PR #2](https://github.com/ZSY2221/moon_jpegls/pull/2)

## 负责人核对项

参赛者 `ZSY2221` 决定项目场景和完整 T.87 Part 1 目标，负责仓库治理、正式发布授权、提交赛事材料以及对外声明。代码和报告的人工复核由负责人按实际进度确认。

飞书表单要求负责人独立撰写一页以内的 Markdown 申报书。本目录的历史申报参考件归档在 M2 阶段。负责人可用事实清单核对当前源码、证据和未完成的标准范围，再自行撰写、提交。[事实清单](FACTS_FOR_APPLICANT.md) · [实时表单](https://bxup9uklfcb.feishu.cn/share/base/form/shrcnWUMlgpbwHaXgzV7HmNhNhg)