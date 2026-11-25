# 仓库外 MoonBit 包消费验证

2026-11-25（新加坡时间），在全新的临时模块和匿名 Moon 配置中执行 `moon add ZSY2221/moon_jpegls@0.1.0` 及无版本的 `moon add ZSY2221/moon_jpegls`，两次均返回模块找不到或拒绝访问。官方元数据接口的两个查询均返回 HTTP 404，已发布的 `moonbitstack/moonimage@0.2.1` 对照返回 HTTP 200。公开 Mooncakes 安装当前无法验证。 [指定版本](https://mooncakes.io/api/v0/registry/modules/ZSY2221/moon_jpegls?version=0.1.0) · [最新版本](https://mooncakes.io/api/v0/registry/modules/ZSY2221/moon_jpegls) · [公开对照](https://mooncakes.io/api/v0/registry/modules/moonbitstack/moonimage?version=0.2.1)

## 独立消费结果

从固定提交 `9667375c42dd5d20aba832c1c07ebcd0fdfad214` 导出源码，运行 `moon package --frozen` 生成 `ZSY2221-moon_jpegls-0.1.0.zip`。实际归档为 248,340 字节，SHA-256 为 `97a7663bb547f54630c456d0d7f18486abeb03ef9c7685505d71a4aabed04bf9`。

移除源码导出后，新建与项目仓库无关的临时消费模块，通过仅监听本机回环地址的服务用 `moon add` 安装 ZIP。依赖图将 MoonJLS 识别为 registry 模块，`workspace_member: false`。安装后的所有 `core/` 文件均通过逐文件 SHA-256 对比。三个后端都在停止本地服务后使用 `--frozen` 运行，无需 `moon.work` 或共享依赖缓存。这个结果验证了实际归档及公开 API 的本地消费。 [命令、版本、依赖图和逐样本结果](result.json)

每个后端以公共 `encode` 和 `decode` 验证四个 3×2 灰度样本，并将公共 `Decoder::step` 交付的两行逐样本与整图解码比对。三后端的帧、样本和码流长度一致，16 位用例包括 32767、32768 和 65535。

| 位深 | NEAR | 编码字节 | 最大绝对误差 |
| --- | --- | --- | --- |
| 12 | 0 | 48 | 0 |
| 12 | 255 | 30 | 7 |
| 16 | 0 | 70 | 0 |
| 16 | 255 | 60 | 127 |

## 复跑

在 Linux 或 WSL 的仓库根目录运行，准备 Python 3、curl、Git、Moon 0.1.20261119、Node 24.20.0 和 clang。实测使用 Ubuntu 22.04 WSL2 和 clang 14.0.0。Linux Node 由官方归档临时解压并用官方 SHA-256 清单校验。 [MoonBit 依赖管理](https://docs.moonbitlang.com/en/stable/toolchain/moon/module.html#dependency-management) · [Node 24.20.0 校验清单](https://nodejs.org/dist/v24.20.0/SHASUMS256.txt)

```sh
CC=clang python3 reports/review-consumer-20261125/run.py \
  --moon "$(command -v moon)" \
  --output .evidence/consumer-recheck.json \
  --archive .evidence/consumer-ZSY2221-moon_jpegls-0.1.0.zip
```

报告中的 `<temp>`、`<repo>` 和 `<moon-toolchain>` 对应运行时的实际路径。
