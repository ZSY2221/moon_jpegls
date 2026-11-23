# MoonJLS 工程状态

2026-11-23（新加坡时间）整理。本地首版候选为 Git 标签 `v0.1.0-rc.1`，包版本 `0.1.0`。

| 项目 | 实际状态 |
| --- | --- |
| 工作目录 | `D:\Program Files\GPT_project\moon_jpegls` |
| 分支与精确提交 | `main`。`git rev-parse v0.1.0-rc.1^{commit}` 获取首版候选 SHA，`git rev-parse HEAD` 获取工作目录 SHA。 |
| 发布 | 本地 Git、打包与静态构建。GitHub、Mooncakes 和公开网页尚未发布。 |
| A–C | 支持范围和预构建外部裁判已固定。8、12、16 位及 NEAR 0–3 双向对拍通过。 |
| D | 核心任意分块、EOI、背压、取消与资源实验已运行。单图整图入口另测。 |
| E | Native 文件和管道、JS/TS SDK、Worker、浏览器工作台、独立 MoonBit 模块和 Gray16 消费示例已运行。 |
| F | 独立核对公开生态、标准标记和跨后端验证。源码 `bcca320ff2fd3d36cbfa10b5e3138f2887256251` 从干净检出通过构建、核心测试、浏览器和包验证。 |

## 实跑与可复验的状态

- Windows 工具链为 Moon `0.1.20261119`、`moonc v0.10.22+124d61d05`、Node `24.20.0`、npm `11.19.0`、Python `3.12.10`。Windows Native check 通过。Windows Native run 缺可见的系统 C 编译器。Ubuntu 22.04 WSL2 使用相同 Moon 工具链，GCC 11.4、Clang 14、CMake 3.22.1 可用，Native 测试、命令行及独立消费模块已实跑。
- 7 个核心测试组分别在 JS、Wasm GC 和 WSL Native 通过。独立套件含 100 张合成图及声明范围内的官方流，两种 CharLS 构建的参考解码一致。固定配置下同一 MoonJLS 编码在各已验证后端和分块间一致。跨后端、截断与失败记录见 [VALIDATION.md](docs/VALIDATION.md)。
- 固定宽度 512、增高至 4096 时，编码核心数组与计数器载荷为 9992 B，解码为 10751 B。首个解码行在消费 573 B 后出现。慢消费暂停期间，额外源读取为零。输入和输出峰值与进程 RSS 单独报告。 [BENCHMARK.md](docs/BENCHMARK.md)
- Chrome `158.0.8127.37`、Edge `158.0.4370.33` 均验证缓冲下载、有界消费、错误反馈和 Worker 暂停。操作系统文件选择器路径尚未实测。Firefox、Safari 与其他 Node 版本尚无覆盖。

范围内已运行的门槛见 [VALIDATION.md](docs/VALIDATION.md)。未支持项包括彩色及交错、超出默认等价类的 LSE preset、映射表、重启恢复、DNL、扩展尺寸、T.870 Part 2 和 DICOM 容器。未观察到第三方采用。

下一次复核应从 16 位 NEAR=3、完全单字节分块、Worker 背压和文件保存失败恢复开始，再为性能热点建立可归因的同边界基准。 [干净检出记录](reports/RELEASE_CHECK.md) · [Antigravity 交接](docs/ANTIGRAVITY_HANDOFF.md)
