# MoonJLS · 两分钟评审指南

MoonJLS 面向高精度整数图像的数据交换。科学图像在采集、处理和归档之间需要保留整数样本，或明确限制编解码新增的误差。纯 MoonBit 核心用同一套状态机实现 Native 管道、JS、Wasm GC 和 Worker 接入，便于 MoonBit 应用嵌入有界流式编解码和跨后端复验。

## 这次交付了什么

- **可用的单分量 JPEG-LS**。单帧、单分量、单扫描、ILV=0，支持有界文件和管道。在既有 NEAR 扩展基础上，M2 实现 **P=2–16、独立 MAXVAL、按 MAXVAL 计算 NEAR 上限，以及自定义 LSE ID 1 T1/T2/T3/RESET**。编解码使用同一组实际参数，PGM 保留头部 MAXVAL。
- **独立验证**。388 个新增正例在三后端验证。固定 HP T.87 官方参考程序对拍其适用范围，MAXVAL 1/2 另用独立推导的 Annex A 位流向量。官方 Annex E 用例 9–12 在每个后端完成编码与解码验收，全部 12 次 MoonJLS 编码与官方码流逐字节一致。用例 1–8 的多分量流保留各自的未支持状态。 [逐项结果与报告](CONFORMANCE_RESULTS.md)
- **科学工作台**。Precision Lab 查看实际精度、MAXVAL、LSE 参数、原始整数、重建和误差；Streaming Lab 查看真实行交付、ACK、分块和载荷；Compatibility Lab 消费与验收脚本共用的能力清单。已核验的 NASA 栅格可显示以米计的编解码新增误差。 [工作台说明](../web/README.md) · [报告格式](VERIFICATION_REPORT.md)

## 完整 Part 1 的交付路径

终点为 ITU-T T.87（06/1998）／ISO/IEC 14495-1 的完整 Part 1 编码、解码与格式。下一阶段 M3 指向多分量／多扫描、交错、采样和点变换，目标 12 月 25 日。M4 指向映射和续表、简略格式、重启、DNL、扩展尺寸，目标 2027 年 1 月 10 日。M5 按条款逐项验收，目标 2027 年 1 月 20 日。日期是开发目标，赛事最终验收时间以组委会确认。 [标准与能力边界](T87_CONFORMANCE_PLAN.md) · [路线](ROADMAP.md)

## 最快复现

检出 [受测产品源码 `fc43bc2`](https://github.com/ZSY2221/moon_jpegls/commit/fc43bc2b4ed69cad9d967e63c2019ff1e8f3be44)。从仓库根运行：

```sh
moon test core --target js --deny-warn
moon test core --target wasm-gc --deny-warn
CC=clang moon test core --target native --deny-warn
node sdk/build.mjs
node web/build.mjs
python -m http.server 8000 --bind 127.0.0.1 --directory web/dist
```

打开 [本机工作台](http://127.0.0.1:8000/web/)，点内置示例后运行。独立工具、命令、版本和哈希见 [M2 验收报告](../reports/t87-m2-20261125/README.md)。[仓库外安装记录](MOONCAKES_RELEASE.md)使用真实包归档和本地回环 registry，Mooncakes 在线查询目前返回 404。

审查入口是本提交所在的复审或独立 M2 分支。公开提交、默认分支、包发布和本机留存分别记录。[工程状态](../PROJECT_STATUS.md)
