# Mooncakes 发布准备 · M2

| 项目 | 实际核对 |
| --- | --- |
| 包与候选版本 | `ZSY2221/moon_jpegls@0.1.0`，名称保持现有公开 API 坐标。 |
| 元数据与许可 | `moon.mod` 声明 BSD-3-Clause 和 Native/JS/Wasm GC。归档及源码保留 LICENSE、README 与 MoonBit 公开核心。ZIP 共 118 项，包含 MoonBit 源码，SDK 生成产物另由 `node sdk/build.mjs` 构建。 |
| 登录 | 2026-11-25 本机 `moon whoami` 返回 `Logged in as ZSY2221`。 |
| 线上可发现性 | 官方带版本和无版本查询均为 HTTP 404。公开 MoonImage 对照为 200，干净临时模块的匿名 `moon add` 未安装到 MoonJLS。 |
| 已测包 | 固定核心 [`65f91cd`](https://github.com/ZSY2221/moon_jpegls/commit/65f91cd8895ddf2adade6f003444c1f599234dae) 的 `moon package --frozen` 实际生成 283,539 字节 ZIP，SHA-256 为 `b8b0f14ad77768f75a6cfcd2ced4a2b20ced25523d15278227fe82d104bcc2bd`。 |
| 本地消费 | 临时模块从本机回环 registry 安装真实 ZIP。移除导出的源码并停止 registry 后，冻结运行 Native、JS、Wasm GC。每后端 4 个 12/16 位、NEAR 0/255 用例，MAXVAL 分别为 4093 和 50000，含自定义 RESET、整图及一字节输出的流式 API。 |
| 发布状态 | 正式发布待项目负责人明确授权。当时需重新核对公开坐标、最终版本、许可和候选 ZIP 内容，再做匿名在线安装复验。 |

[干净安装命令、退出码、模块图和每个样本](../reports/t87-m2-20261125/package-consumer.json) · [官方 CLI 文档](https://docs.moonbitlang.com/en/stable/toolchain/moon/commands.html)
