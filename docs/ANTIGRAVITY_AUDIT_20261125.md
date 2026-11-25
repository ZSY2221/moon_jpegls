# MoonJLS T.87 复审基线审计

2026-11-25（新加坡时间）。本审计使用干净检出的 `27f045d853d6b6a1b1317a55f199d077705ba326`。该提交记录 640 组 P1 互操作及后续验证工具链结果。远端 `main` 核查点为 `60befa604287d941dc75ffde03a4c52ab80a93ad`，公开复审分支为 `codex/moonjls-reappeal-20261125`。本次隔离分支从复审分支创建。原 Windows 工作区有独立的 `core/encoder.mbt`、`core/decoder.mbt`、`core/model.mbt` 修改和未跟踪材料，继续留在原工作区。核查时未发现复审／P2 指向 `main` 的开放 PR，Mooncakes `0.1.0` 查询返回 HTTP 404。 [本次审计源码](https://github.com/ZSY2221/moon_jpegls/commit/27f045d853d6b6a1b1317a55f199d077705ba326) · [阶段状态](../PROJECT_STATUS.md)

| 审计问题 | 基线结论 |
| --- | --- |
| 1. 已实现哪些编码和解码能力？ | 编码和解码均覆盖一帧、一个灰度分量、一个 ILV=0 扫描，支持已知尺寸、常规模式、游程及中断、位填充。P=8/12/16，MAXVAL=2^P−1，NEAR 上限分别为 127/255/255，Pt=0。编码输出交换格式，16 位写显式默认 LSE。解码接受缺省、字段为零或显式默认等价的 LSE1。核心用于 Native、JS、Wasm GC。 [产品范围](SCOPE.md) · [640 组实测](../reports/review-near-20261125/README.md) |
| 2. 哪些设施只识别到头或标记？ | SOF55 字段先检查合法性，再按当前单分量、等采样和已知尺寸限制。LSE1 检查字段顺序和取值，基线只运行默认等价参数。LSE2、LSE4 检查部分段结构后报告不支持。DRI=0 可读，实际重启状态待实现。APPn/COM 在已支持位置按预算跳过。 [标记解析器](../core/markers.mbt) |
| 3. 哪些合法路径返回 `UnsupportedFeature`？ | 合法的非 8/12/16 位精度、自定义 MAXVAL、自定义 LSE1、彩色／多分量、非 1×1 采样、延后或扩展尺寸、非零重启间隔，以及当前解析阶段可识别的映射和点变换均超出基线。流的错误由最早命中的限制决定，彩色 Annex E 用例可在 SOF55 即退出。缺失前置表的 LSE3 在当前解析路径报告 `InvalidData`。 [标记解析器](../core/markers.mbt) |
| 4. Frame/Scan 是否含完整元数据？ | 公开 `Frame` 含宽、高、精度、NEAR，MAXVAL 从精度推导。私有 `Scan` 含单分量样本行、预测上下文、游程和本扫描编码参数。公开接口尚待增加真实 MAXVAL、预置来源及多分量扫描元数据。 [Frame](../core/parameters.mbt) · [Scan](../core/model.mbt) · [接口规划](HIGH_PRECISION_INTERFACES.md) |
| 5. P、MAXVAL、NEAR 和 T1/T2/T3/RESET 是否解耦？ | P 和 NEAR 在 `Frame` 明示，MAXVAL 与精度绑定。解析器用 LSE 中的 MAXVAL 检查语法并解析默认阈值，接入核心前仍限制满量程。T1/T2/T3 和 RESET 由默认参数生成，基线拒绝非默认等价配置。M2 要接受合法范围，并把实际解析、编码、暴露及验证的参数对齐。 [参数和范围](../core/parameters.mbt) · [标记解析器](../core/markers.mbt) |
| 6. CharLS 与 Annex E 各自验证了什么？ | 合成互操作使用已固定的 CharLS 2.4.5 和 CharLS Wasm 0.10.0，交叉编码、解码及样本对拍。Annex E 采用 ITU 附带的官方数据，§8.2 的编码路径与 §8.3 的官方流解码路径各自记账。CharLS 可以独立解码用于比较。官方参考可执行程序在基线记录中未实跑。 [验证方法与版本](VALIDATION.md) · [ITU 正文及附件](https://www.itu.int/rec/T-REC-T.87-199806-I/en) |
| 7. Annex E 已通过多少项？ | 历史七条流的解码验证中，E.2 第 11、12 项（12 位 `TEST16`）通过，第 1、2、3、7、9 项符合当时的 `UnsupportedFeature` 边界。第 4、5、6、8、10 项未纳入历史测试，12 项的 §8.2 编码验证尚无基线证据。M2 的实际结果将单独记录。 [历史验证](VALIDATION.md) |
| 8. 距离完整 Part 1 还有什么？ | M2 补齐 2–16 位灰度、合法 MAXVAL/NEAR 和非默认 LSE1。后续还需多分量、多扫描、ILV=0/1/2、采样、Pt、映射表与续表、简略图像和表格式、实际重启、DNL、扩展尺寸及其状态与标记测试。§6／§7 条款、§8／Annex E 和补充互操作共同约束最终声明。 [完整能力矩阵](T87_CONFORMANCE_PLAN.md) · [路线](ROADMAP.md) |
| 9. 既有 Native 和 Worker 门槛是什么？ | 已固定的 Native 4096 B 反例在 EOI 前交付四行，严格等待 EOF 并拒绝晚到尾随。定向 12/12、尾部矩阵 20 项及额外晚到尾随通过。真实 Chrome 的 JS 和 Wasm GC Worker 峰值均为 112 B、成功终态队列为 0 B，覆盖 ACK 背压、挂起后取消与重启。M2 在新构建复跑后才继承结果。 [三处修复复验](../reports/review-fix-20261125/README.md) · [工具链回归](../reports/verification-toolkit-20261125/README.md) |
| 10. `q_lut` 和 NASA 证据使用什么口径？ | 核心按 `q_lut` 实际整数表长度计入逻辑载荷，16 位／NEAR=0 为 553 项、2,212 B。NASA LOLA 16 位 PGM 的来源、转换、哈希、误差预算与产物分别可追溯。固定 Chrome 报告的 NEAR=3 下载由 CharLS Wasm 对 1,036,800 个样本逐一对拍。新版本的产物、验证报告或物理量结果必须引用相应复跑。 [资源口径](ARCHITECTURE.md) · [NASA 来源](../tests/fixtures/LUNAR_DATA.md) · [NASA 误差预算](../reports/lunar-budget-20261125/README.md) |

M2 编码、解码、语法和验证范围分别在 [Annex E 记录](CONFORMANCE_RESULTS.md) 报告。该记录仅为已验证有限范围的工程证据。Part 2 与 DICOM 独立列在长期范围中。 [T.87 官方版本](https://www.itu.int/rec/T-REC-T.87-199806-I/en) · [项目范围](SCOPE.md)
