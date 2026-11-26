# Mooncakes 候选包与注册表状态

2026-11-26（Asia/Singapore）。候选为 `ZSY2221/moon_jpegls@0.1.0`。源码固定在 [`8c5882f`](https://github.com/ZSY2221/moon_jpegls/commit/8c5882f292327393d36763450c886359bd6aa224)，模块声明 BSD-3-Clause，支持 Native、Wasm GC、JS，无额外直接依赖。[公开 API](API.md)

| 检查 | 结果 |
| --- | --- |
| 洁净候选打包 | `git archive` 导出固定提交，`moon package --frozen` 退出码 0、0 警告，ZIP 561,350 B、210 个条目。包内核对 LICENSE、moon.mod 与 MoonBit 核心，过滤报告、申报资料、本机工具和生成产物 |
| 离线消费 | 独立临时工程经回环 registry 装入该 ZIP，停服后以 `--frozen` 执行。JS、Wasm GC、Native 各通过 4 个公开 API 用例，覆盖 12/16 位、非默认 MAXVAL 与 RESET、NEAR=0/255 |
| 匿名查询 | 实查当前包及 0.1.0 均返回 HTTP 404。已发布控制包返回 HTTP 200 |
| 全新匿名在线安装 | 在独立 Moon 环境分别请求当前包与固定 0.1.0，均退出 255，注册表返回模块找不到或无权访问。线上消费测试仍待公开包安装 |
| 正式线上发布 | `not_run`。本机 Windows 的 `moon whoami` 返回 ZSY2221。项目负责人授权对官方注册表执行 `moon publish` 后，使用固定候选发布并重跑全新在线消费 |

候选 ZIP SHA-256 为 `bdb5022e5cb2b16c4edb7b801c6799582f4ccc6e0b0d80b9b2d76ef5bc08b97f`。消费脚本从仓库根目录接收已固定的 `--commit` 值，构建并记录完整命令、安装来源和样本。[当前打包与消费记录](../reports/t87-m3b-20261126/public-delivery/package-consumer.json) · [复跑器](../reports/review-consumer-20261125/run.py) · [Mooncakes 查询](https://mooncakes.io/api/v0/registry/modules/ZSY2221/moon_jpegls?version=0.1.0) · [Moon CLI 文档](https://docs.moonbitlang.com/en/stable/toolchain/moon/commands.html)
