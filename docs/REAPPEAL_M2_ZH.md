# MoonJLS 11 月黑客松复审补充说明

感谢评审指出最终标准范围说明不足。MoonJLS 面向高精度整数图像交换，交付纯 MoonBit JPEG-LS 内核、Native／JS／Wasm GC 流式接入以及可复现的科学验证工具链。项目以完整实现 ITU-T T.87（06/1998）／ISO/IEC 14495-1 的 JPEG-LS Part 1 编码、解码和格式能力为终点。

原阶段是满量程 8／12／16 位灰度实现。M2 在当前单帧、单分量、单扫描的范围内，已将编码精度扩至 2–16 位，支持独立 MAXVAL、基于有效 MAXVAL 的合法 NEAR，以及真正参与编解码的自定义 LSE ID 1 的 T1、T2、T3 和 RESET。三后端完成 388 组新增正例和边界复验。官方 Annex E 的 9–12 号在三个后端完成编码和解码检查，编码结果与官方码流逐字节相同。1–8 号涉及多分量和相关扫描能力，仍作为后续验收项逐一保留。

下一阶段实现多分量、多扫描、交错、采样和点变换，再处理映射表、简略格式、重启、DNL 和扩展尺寸，最后用 Annex E 与补充边界试验完成逐项验收。计划目标依次为 12 月 25 日、2027 年 1 月 10 日和 1 月 20 日。完整实现的赛事验收节点仍以组委会明确要求为准。

工作台展示实际采样精度、误差、流式行为和统一验证报告。验收用到的官方 HP T.87 工具、CharLS、独立向量及各自限制均有版本和回执。独立消费已从真实归档在回环 registry 复验。公开 Mooncakes 在线安装尚不可验证。

恳请根据补充后的标准范围、已完成的兼容增量和可复现的分阶段验收路线重新审核。

- 受测源码提交 https://github.com/ZSY2221/moon_jpegls/commit/fc43bc2b4ed69cad9d967e63c2019ff1e8f3be44
- 独立分支 https://github.com/ZSY2221/moon_jpegls/tree/antigravity/t87-m2-20261125
- 评审入口 https://github.com/ZSY2221/moon_jpegls/blob/antigravity/t87-m2-20261125/docs/REVIEWER_GUIDE.md
- 逐项验收 https://github.com/ZSY2221/moon_jpegls/blob/antigravity/t87-m2-20261125/docs/CONFORMANCE_RESULTS.md
