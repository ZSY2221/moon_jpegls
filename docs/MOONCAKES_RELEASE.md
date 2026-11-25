# Mooncakes 发布准备 · M3-A（当前未线上发布）

> **发布边界说明**：截至 2026-11-25（M3-A 提交 `36bb9e6` 后复查），MoonJLS **尚未执行 Mooncakes 官方线上发布**。在线包注册表检查明确返回未发布（`moon add ZSY2221/moon_jpegls` 返回 `not found in the registry`，API 查询 `https://mooncakes.io/api/v0/packages/ZSY2221/moon_jpegls` 返回 **HTTP 404**）。下述本地验证仅检验 `moon package --frozen` 打包归档完整性，**不是**公开线上包发布。

| 项目 | 实际核对 |
| --- | --- |
| 包与候选版本 | `ZSY2221/moon_jpegls@0.1.0`，坐标与现有 `core` 公开 API 保持兼容。 |
| 元数据与许可 | `moon.mod` 声明 `BSD-3-Clause`、`repository = "https://github.com/ZSY2221/moon_jpegls"` 和 `+native+wasm-gc+js` 支持；本地 `moon package --frozen` 无警告通过。 |
| 登录检查 | 2026-11-25 本机 `moon whoami` 返回 `Logged in as ZSY2221`。 |
| 线上可发现性（未发布） | `https://mooncakes.io/api/v0/packages/ZSY2221/moon_jpegls` 返回 **HTTP 404**；隔离目录执行 `moon add ZSY2221/moon_jpegls` 返回 `Error: Module ZSY2221/moon_jpegls not found in the registry`。 |
| M3-A 本地候选包打包 | 基于最新 `moon.mod` + M3-A 核心执行 `moon package --frozen`：`Check passed`（0 warnings），产出 815,918 字节归档（SHA-256 `5eb12f19078860117aa61bf501c051eff212068ba16c0996f427aec5d2a72947`）。 |
| M2 历史本地回环消费归档 | 基于 M2 核心 [`65f91cd`](https://github.com/ZSY2221/moon_jpegls/commit/65f91cd8895ddf2adade6f003444c1f599234dae) 的回环 registry 三后端消费实测继续归档留存（283,539 字节 ZIP，SHA-256 `b8b0f14ad77768f75a6cfcd2ced4a2b20ced25523d15278227fe82d104bcc2bd`）。 |
| 正式发布许可条件 | **未经项目负责人（`ZSY2221`）明确授权，不执行线上 `moon publish`。** 后续授权发布前，须重新核对包体积/过滤文件清单、最终版本号、公开文档与匿名在线 `moon add` 复验。 |

[M2 干净回环消费记录](../reports/t87-m2-20261125/package-consumer.json) · [官方 CLI 文档](https://docs.moonbitlang.com/en/stable/toolchain/moon/commands.html)
