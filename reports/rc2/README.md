# RC2 本地实测证据

2026-11-24（新加坡时间）。完整回归的洁净源码为 `a146998f31675769fb6c3bc9055ef7798f254b1d`。本目录是实测后的证据提交，原 `reports/` 根下 rc.1 的结果仍对应各自记录的源码。构建、运行命令和 SHA-256 见 [构建清单](build.json) 与 [证据清单](manifest.json)。

## 两项正确性修复

| 门槛 | 修复前 | 修复后 |
| --- | --- | --- |
| Native 1×4 全零，暂扣 EOI | EOI 前 1 行，随后 3 行，`--require-eager` 退出 1 | EOI 前 4 行，随后 0 行，退出 0。样本一致。 |
| 取消后立即重启，旧读取晚返回 | 默认 gate 退出 1，新预览显示旧像素 2000 | 默认 gate 退出 0，新预览保持 4000。 |

Native 另跑了 1、2、7、4096 字节分块的 20 个完整流和边界用例，以及一个保持 stdin 打开再补送尾随数据的用例。首次矩阵断言使用了内层诊断文本。CLI 实际输出 `CommandError.Input`，改用这个错误类型后复验通过。真实 Chrome 覆盖阻塞原图行读取、阻塞 sink 写入、立即重启、下载重建，以及数据 ACK 扣留与暂停。停止前、扣留时、稳定暂停时的读取次数均为 59。系统写入使用可控的替身，浏览器与编解码 Worker 是实际运行的。 [修复前后运行记录](host-regressions.json)

额外的 Native 慢消费试验以 4096 字节输入块解码 512×512，stdout 管道填满 65,536 B 后保持 100 ms，随后排空并得到与 CharLS 重建一致的 524,288 B。512×64 夹具恰好可装入该管道，未用于证明阻塞。另一次 512×4096、7 字节块的排空尝试触发 20 秒测试时限，该附加组合无通过结论。 [Native 慢消费记录](native-slow-sink.json)

## Worker 实验与保留判定

基线静态资源来自洁净 `f3c6166` 源码。`981217a` 只改变 `sdk/worker.mjs` 的解码行后进度调度。优化前独立的 [诊断](worker-profile.json) 观察到 4096 个重复 progress 和 4096 个对应 ACK。它包含额外计时探针，等待时间包含宿主和传输，不能把各项相加当成核心耗时。

正式测量在 Windows 11、Chrome 158.0.8127.37、Node 24.20.0、AMD Ryzen 9 8945HX、高性能电源模式进行。同一浏览器会话按配对交替顺序跑基线与候选，每个样本创建一个新 Worker。每版本、每配置 2 次预跑和 5 次正式样本，共 112 次。墙钟从创建 Worker 前到终态并完成 ACK，包含消息、限长块复制与同流 CharLS 逐像素校验。DOM、fixture 预载与落盘在此计时范围之外。测试夹具预载到浏览器用于对照，每次请求交付的独立切片受分块上限限制，核心、桥接和队列水位单独记录。

| 后端 | NEAR | 输入 B | 墙钟中位数前 → 后，ms | 首行中位数前 → 后，ms |
| --- | ---: | ---: | ---: | ---: |
| Wasm GC | 0 | 4096 | 452.0 → 352.0 | 9.5 → 10.2 |
| Wasm GC | 0 | 1 | 35915.5 → 34490.2 | 31.9 → 35.0 |
| Wasm GC | 3 | 4096 | 495.4 → 357.7 | 9.3 → 9.7 |
| Wasm GC | 3 | 1 | 14230.6 → 14207.5 | 21.0 → 21.0 |
| JS | 0 | 4096 | 503.0 → 388.5 | 11.3 → 11.5 |
| JS | 0 | 1 | 29625.4 → 29462.7 | 30.9 → 30.2 |
| JS | 3 | 4096 | 506.9 → 366.9 | 11.4 → 11.6 |
| JS | 3 | 1 | 14239.8 → 14163.4 | 23.6 → 23.3 |

保留 `981217a`。主目标墙钟中位数下降 22.1%。该配置的 progress ACK 由 4096 降为 0，数据行 ACK 仍为 4096，同时间未确认峰值为 1。全部配置通过首行 `max(10%, 2 ms)` 上限、逐行内容和顺序、独立 `Uint16Array` 和队列水位门槛。单字节组的小幅波动不作为加速主张。结论限于浏览器解码 Worker 的调度。 [五次原始样本与消息记录](worker-paired.json) · [可执行门槛检查](worker-gates.json) · [两版加载产物与源码绑定](worker-builds.json)

## 分开解读其他测量

- [Node 完整结果](node-effect.json) 从 API 调用到可用的整图结果，两边均计入所需分配与复制。所有计时的 Node 解码器使用同一个 CharLS 码流，排除 fixture 文件读取、模块加载和校验。Python 原生 wheel/PNG 数据另列，计时边界写入 JSON。
- [Node 资源](node-resource.json) 用限定 source/sink 测直接 SDK，在同一 Node 进程及已加载核心实例下执行 2 次预热和 5 次正式试验，另分开记录独立冷进程和 RSS。包括 28 个固定宽度增高、正常块、小块和慢消费场景，它们不经过 Worker。
- [本轮验证](validation.json) 有 JS、Wasm GC、WSL Native 各 7 组核心测试和 100 个参数化互操作用例。CharLS Native/Wasm 分别完成 1204/736 次同流样本比较，另有 160 个单切分、162 个截断前缀，8、12、16 位的 NEAR 0–3 最大误差为 0、1、2、3。48 个独立变异在两后端共执行 96 次，6 次与 CharLS 同样接受且重建完全一致，90 次双方按固定结构错误码拒绝。 [JS 变异](js-entropy-mutations.json) · [Wasm GC 变异](wasm-gc-entropy-mutations.json)

## 复跑

在含固定裁判的项目根目录执行，输出目录应使用新的名字。构建 SDK 与 Native 的准确参数见 `build.json`。正式配对要求两套独立静态目录的核心、SDK、Worker client 完全相同，只改变 `worker.mjs`。页面和 Worker 实际加载响应的哈希随报告保存。

```powershell
./.tools/oracle-venv/Scripts/python.exe scripts/benchmark.py --mode fixtures --directory .evidence/recheck-fixtures
node web/bench-worker.mjs --baseline <原静态目录> --fixtures .evidence/recheck-fixtures --output .evidence/recheck-profile.json --profile
node web/bench-worker.mjs --baseline <原静态目录> --candidate <候选静态目录> --fixtures .evidence/recheck-fixtures --output .evidence/recheck-worker.json --warmup 2 --repeats 5 --timeout-ms 900000
node scripts/analyze_worker_bench.mjs .evidence/recheck-worker.json
./.tools/oracle-venv/Scripts/python.exe scripts/benchmark.py --mode resource --warmup 2 --repeats 5 --directory .evidence/recheck-resource
./.tools/oracle-venv/Scripts/python.exe scripts/benchmark.py --mode effect --real-data --warmup 2 --repeats 5 --directory .evidence/recheck-effect
```

本轮覆盖 Chrome。Firefox、Safari、Edge 的 RC2 复验、真正的系统保存对话框、Windows 原生 C 编译和完整 T.87 范围认证均没有运行。Native ELF 与核心测试在 Ubuntu 22.04 WSL2 运行。
