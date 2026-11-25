# Mooncakes 发布准备 · M2（当前未线上发布）

> **发布边界说明**：截至 2026-11-25，MoonJLS **尚未执行 Mooncakes 官方线上发布**（公开在线查询仍返回 HTTP 404）。下述“本地消费”仅是在本机隔离临时目录中通过本地回环（loopback）registry 验证 `moon package --frozen` 生成的候选归档可被第三方 MoonBit 模块正确安装与编译运行，**不是**公开线上包发布。

| 项目 | 实际核对 |
| --- | --- |
| 包与候选版本 | `ZSY2221/moon_jpegls@0.1.0`，坐标保持现有公开 API 坐标。 |
| 元数据与许可 | `moon.mod` 声明 `BSD-3-Clause` 和 `Native` / `JS` / `Wasm GC` 支持。归档及源码保留 `LICENSE`、`README.md` 与 MoonBit 公开核心。ZIP 共 118 项，包含 MoonBit 源码，SDK 生成产物另由 `node sdk/build.mjs` 构建。 |
| 登录检查 | 2026-11-25 本机 `moon whoami` 返回 `Logged in as ZSY2221`。 |
| 线上可发现性（未发布） | 官方 Mooncakes 带版本与无版本查询均为 **HTTP 404**；公开 MoonImage 对照返回 200；干净临时模块的匿名 `moon add` 未能在线安装 MoonJLS。 |
| 本地候选包归档 | 基于固定核心 [`65f91cd`](https://github.com/ZSY2221/moon_jpegls/commit/65f91cd8895ddf2adade6f003444c1f599234dae) 的 `moon package --frozen` 生成 283,539 字节 ZIP，SHA-256 为 `b8b0f14ad77768f75a6cfcd2ced4a2b20ced25523d15278227fe82d104bcc2bd`。 |
| 本地回环 registry 消费验证 | 临时模块从本机回环 registry 安装真实 ZIP。移除导出的源码并停止回环服务后，冻结运行 Native、JS、Wasm GC：每后端通过 4 个 12/16 位、NEAR 0/255 用例（MAXVAL 分别为 4093 和 50000，含自定义 RESET、整图及单字节输出的流式 API）。 |
| 正式发布许可条件 | **未经项目负责人（`ZSY2221`）明确授权，不执行线上 `moon publish`。** 后续授权发布前，须重新核对公开坐标、最终版本、`moon.mod` 描述、许可证与候选 ZIP 内容，并做匿名在线 `moon add` 复验。 |

[干净安装命令、退出码、模块图和每个样本](../reports/t87-m2-20261125/package-consumer.json) · [官方 CLI 文档](https://docs.moonbitlang.com/en/stable/toolchain/moon/commands.html)
