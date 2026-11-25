# MoonJLS M2 验收记录

受测产品源码固定为 [`fc43bc2`](https://github.com/ZSY2221/moon_jpegls/commit/fc43bc2b4ed69cad9d967e63c2019ff1e8f3be44)。本轮在 Windows Node 24.20.0 和 Ubuntu 22.04 WSL2 执行，Moon 0.1.20261119、moonc v0.10.22+124d61d05 和 clang 14。JS/Wasm GC 核心、Native CLI 的指纹和主机重试记录见 [provenance.json](provenance.json)。

| 验收项 | 证据 |
| --- | --- |
| 388 个 M2 正例、18 个 LSE 变体、7 个非法编码输入、6 个 Native PGM 检查 | [合成矩阵、官方 HP 与独立 Annex A 向量](synthetic-matrix.md) |
| 官方 Annex E 12 条，9–12 编码与解码通过，1–8 解码按范围拒绝 | [逐条结论](../../docs/CONFORMANCE_RESULTS.md) · [官方参考](annex-e-hp.json) · [CharLS](annex-e-charls.json) · [初次 HP 限制](annex-e-hp-initial.json) |
| 历史满量程 NEAR 640/640，固定二进制复跑。5,120 次 CharLS Wasm 同流比较，8,320 次 CharLS 原生同流比较 | [复跑汇总](p1-near-regression.json) · [640 组逐项结果](p1-near-cases.json.gz) |
| Native 4096 B 分块 EOI 前行交付、12 项定向、20 项尾部与晚到尾随 | [行交付](native-row-delivery.json) · [尾部](native-tail.json) |
| Chrome 158 真实 M2 和旧能力验证。P=9、MAXVAL=300、T1/T2/T3=5/9/23、RESET=42 试验收集 6 次 ACK 与 2 个已交付行，成功终态为零暂定行 | [固定版工作台](fixed-smoke.log) · [预览](fixed-preview.log) · [资产回执](fixed-chrome-smoke-receipt.json) · [报告回执](fixed-chrome-report-receipt.json) · [真实 Worker](fixed-worker.log) |
| NASA 1,036,800 样本 × JS/Wasm GC × NEAR 0–3，仍与历史下载哈希一致。Chrome NEAR=3 下载另与固定 CharLS 逐样本对拍 | [固定版 Node 记录](lunar-fixed-run.json) · [Chrome 日志](chrome-smoke-preview.log) |
| 真实归档独立消费，含 12/16 位非默认 MAXVAL 和自定义预置 | [包归档与逐样本结果](package-consumer.json) · [发布准备](../../docs/MOONCAKES_RELEASE.md) |

现有 CI 采用官方版本化 MoonBit Linux 归档和固定 SHA-256，另检查运行时工具版本。浏览器真实网关和需官方 HP 附件的测试单独执行。 [工作流](../../.github/workflows/verification.yml) · [如何复跑](../../docs/CONFORMANCE_RESULTS.md)

独立 HP 实跑和规范独立推导的短向量覆盖参考实现的不同边界。M2 是单扫描交付。完整 Part 1、正式 Mooncakes 在线发布和新的性能实验仍在各自范围。 [评审入口](../../docs/REVIEWER_GUIDE.md)
