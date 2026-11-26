# MoonJLS 工程状态

2026-11-26（Asia/Singapore）。M2、M3-A、M3-B、无映射 Pt 和内嵌 Wt=1 映射解码已交付。Native、JS、Wasm GC 的官方 Annex E 12 条全部双向通过，用例均为 Pt=0。完整 T.87 Part 1 是分阶段目标。ZSY2221 决定项目范围与提交，逐阶段协作和复核记录见交接。[受测源码与证据](docs/CODEX_M3B_HANDOFF.md)

- [当前支持范围](docs/SCOPE.md)和[兼容路线](docs/ROADMAP.md)记录最终 Part 1 目标、现有能力和阶段退出条件。
- [逐条官方结果](docs/CONFORMANCE_RESULTS.md)和[机器可读清单](tests/conformance/manifest.json)区分实际执行与参考能力限制。
- [M3-B PR #2](https://github.com/ZSY2221/moon_jpegls/pull/2) · [Pt PR #3](https://github.com/ZSY2221/moon_jpegls/pull/3) · [映射解码 PR #4](https://github.com/ZSY2221/moon_jpegls/pull/4) · [复审前交付版本](docs/MOONCAKES_RELEASE.md)
- `ZSY2221/moon_jpegls@0.1.0` 已公开发布并完成全新在线消费。受测源码、包 SHA-256、交付提交和评审入口见[本轮 PR #5](https://github.com/ZSY2221/moon_jpegls/pull/5)和[发布记录](docs/MOONCAKES_RELEASE.md)。

## 历史验证

- [M2 精度与预置](reports/t87-m2-20261125/README.md) · [M3-A 非交错多扫描](reports/t87-m3a-20261125/README.md)
- [RC3 验证](reports/rc3/README.md) · [RC2 验证](reports/rc2/README.md) · [rc.1 验证](reports/RELEASE_CHECK.md)
