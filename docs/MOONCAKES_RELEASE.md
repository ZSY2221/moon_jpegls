# Mooncakes 与复审前交付

## 2026-11-26 正式发布

`ZSY2221/moon_jpegls@0.1.0` 已由现有 `ZSY2221` 账号正式发布。发布前匿名版本查询为 HTTP 404，`moon publish --frozen` 退出码 0、服务端 200。发布后匿名元数据和公开 ZIP 均返回 200，状态为 PUBLIC。归档为 615,635 B、219 个文件，SHA-256 与预先验收的包一致。

| 对应项 | 固定值或验收入口 |
| --- | --- |
| `tested_source_sha` | `e32c9161b4679656aa1aba7f01374150a1a9951a`。[回归记录](../reports/november-release-20261126/release-regressions.json) · [候选 CI](https://github.com/ZSY2221/moon_jpegls/actions/runs/45823530089) |
| `package_source_sha` | `e32c9161b4679656aa1aba7f01374150a1a9951a`，由洁净 Git 归档打包。公开包 SHA-256 为 `09122f4a16ec828ff7b7e88a855bacdef5614ee313d33573dc94b2ee2180fffb`。[公开元数据](https://mooncakes.io/api/v0/registry/modules/ZSY2221/moon_jpegls?version=0.1.0) · [公开 ZIP](https://download.mooncakes.io/user/ZSY2221/moon_jpegls/0.1.0.zip) |
| `delivery_sha` | 以 [PR #5 合并记录](https://github.com/ZSY2221/moon_jpegls/pull/5)的实际合并提交为准，与 [main CI](https://github.com/ZSY2221/moon_jpegls/actions/workflows/verification.yml?query=branch%3Amain)及[线上构建标识](https://zsy2221.github.io/moon_jpegls/web/build-info.json)核对。冻结后的提交记录发布证据和复跑器。模块、核心、SDK、Worker、Web 源码和构建配置沿用受测版本。 |
| 复审与演示 | [两分钟评审入口](REVIEWER_GUIDE.md) · [事实清单](../submission/2026-11/FACTS_FOR_APPLICANT.md) · [公开工作台](https://zsy2221.github.io/moon_jpegls/web/) |

包内检查了 `moon.mod`、BSD-3-Clause LICENSE、THIRD_PARTY_NOTICES 和必要 MoonBit 源码。模块无额外直接依赖。归档排除了缓存、报告、申报材料和生成的 SDK/Web 产物。SDK 和 Worker 使用 GitHub 源码构建，另行验收。

离线验证通过临时回环注册表安装候选。正式在线验证在仓库外建立全新的 Moon 工程和 `MOON_HOME`，禁用依赖缓存，通过公共注册表执行 `moon add ZSY2221/moon_jpegls@0.1.0`。公开 ZIP 校验匹配，安装后的核心源码哈希匹配。Native、JS、Wasm GC 各通过七项公开 API 检查，覆盖 16 位 NEAR=0/3、行交付与严格尾随、ILV=2、H/V 边缘几何、Pt 重建 65,540、Wt=1 映射以及 LSE3 续表。[离线与线上收据](../reports/november-release-20261126/mooncakes-publication.json)

复跑使用 Python、curl 和所示 MoonBit 工具链。Windows Native 运行使用实际 WSL 名称，可用 `--wsl-distro` 指定。将 `PATH_TO_ZIP` 换为上述公开 ZIP 的本地副本。复跑器再次从公共地址核对 ZIP，并在全新环境在线安装。

~~~sh
python reports/november-release-20261126/verify_release_consumer.py --mode public --version 0.1.0 --archive PATH_TO_ZIP --output online-consumer.json
~~~

早期匿名探测在安装前遇到传输断开和站点返回 HTML。修正到官方下载域并重跑后，完整线上安装通过。正式发布执行一次。

## 历史 M3-B 候选

2026-11-26（Asia/Singapore）。以下记录绑定 M3-B 历史候选 `ZSY2221/moon_jpegls@0.1.0` 的 [`8c5882f`](https://github.com/ZSY2221/moon_jpegls/commit/8c5882f292327393d36763450c886359bd6aa224)。该记录保留当时的打包、离线消费与匿名查询结果。[公开 API](API.md)

| 检查 | 结果 |
| --- | --- |
| 洁净候选打包 | `git archive` 导出固定提交，`moon package --frozen` 退出码 0、0 警告，ZIP 561,350 B、210 个条目。包内核对 LICENSE、moon.mod 与 MoonBit 核心，过滤报告、申报资料、本机工具和生成产物 |
| 离线消费 | 独立临时工程经回环 registry 装入该 ZIP，停服后以 `--frozen` 执行。JS、Wasm GC、Native 各通过 4 个公开 API 用例，覆盖 12/16 位、非默认 MAXVAL 与 RESET、NEAR=0/255 |
| 匿名查询 | 实查当前包及 0.1.0 均返回 HTTP 404。已发布控制包返回 HTTP 200 |
| 全新匿名在线安装 | 在独立 Moon 环境分别请求当前包与固定 0.1.0，均退出 255，注册表返回模块找不到或无权访问。线上消费测试仍待公开包安装 |
| 当时的正式线上发布 | `not_run` |

历史候选 ZIP SHA-256 为 `bdb5022e5cb2b16c4edb7b801c6799582f4ccc6e0b0d80b9b2d76ef5bc08b97f`。消费脚本从仓库根目录接收已固定的 `--commit` 值，构建并记录完整命令、安装来源和样本。[历史打包与消费记录](../reports/t87-m3b-20261126/public-delivery/package-consumer.json) · [历史复跑器](../reports/review-consumer-20261125/run.py)
