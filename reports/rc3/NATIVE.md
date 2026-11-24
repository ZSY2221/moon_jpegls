# Native 大图慢消费归因

2026-11-24（新加坡时间）。RC2 的 512×4096、16-bit、NEAR=0、CLI `CHUNK=7` 试验**运行过，触发 20 秒超时，未通过原试验**。它使用受测源码 `a146998f31675769fb6c3bc9055ef7798f254b1d` 的 ELF（SHA-256 `267837ca5c3015adf1637a322bf27a8ab96699ff9c9e2ee9b3e1166539a7ed6c`），直接读 1,249,961 B 的 CharLS 码流（SHA-256 `3b13b43e944157a11a2fe3561011ee6780a207eb654e890ffa8b50d8b855ecab`），预期输出 4,194,304 B 的 raw-le。 [原始现场与留存缺项](native-rc2-original.json) · [原始超时回溯](native-rc2-timeout.txt)

## 原脚本实际做了什么

父进程没有写 stdin，子进程自己打开压缩文件。脚本每逢尚未填满管道就等 20 ms 后再查水位，最长搜索时间 5 秒。水位达到触发线后只暂停一次 100 ms，随后由 `Popen.communicate(timeout=20)` 同时排空 stdout 和 stderr。20 秒从开始排空计时。原 CPython POSIX 实现给每次 stdout `os.read` 的上限是 32,768 B，实际短读大小、累计等待与超时已收字节未留存。原脚本没有按 7 B 或逐行 sleep。RC2 后续改写的本地脚本已换成较小夹具，故以当时补丁恢复原始源码。 [原始脚本归档](../../REVIEW_EVIDENCE/rc3_native_slowcase_original.py)

## 同一二进制和码流的控制

在 Ubuntu 22.04 WSL2 串行运行，压缩文件与 ELF 仍位于 `/mnt/d`。三组均直接从文件输入，stdin 从启动前接 `/dev/null`，stdout/stderr 同时由 selector 处理。父进程每次最多读 65,536 B，不将 CLI 的读写粒度误作父进程读量。仅 C 先等 stdout 管道达到触发水位，再保持 100 ms。C 暂停期间仍排空 stderr。排空后每个输出数据块逐字节与同码流的 CharLS 参考重建比对。 [逐秒进度、原始时钟和退出记录](native-controls.json)

| 控制 | CLI CHUNK | 主动持有 stdout | 父进程观察到退出 | 输出结果 |
| --- | ---: | --- | ---: | --- |
| A | 4096 | 无 | 0.641 秒 | 4,194,304 B，与参考完全一致 |
| B | 7 | 无 | 93.035 秒 | 4,194,304 B，与参考完全一致 |
| C | 7 | 管道填满后实测 101.1 ms | 92.699 秒 | 4,194,304 B，与参考完全一致 |

退出时间是父进程观察时刻，最后一次轮询可能增加约 100 ms。首字节、首完整行、末输出与两个管道 EOF 有独立时标。读取 CLI 的终态诊断确认实际消费和输出长度。直接文件输入没有父进程最后写入或在传输中关闭 stdin 的事件。终态也不以“宿主送出 EOI”推断。

B 在第 20.053 秒已收到 852,998 B、833 个完整行，随后持续交付。C 在启动后 1.376 秒观测到管道填满，1.477 秒开始排空并继续交付，最终 stdout 和 stderr 均读到 EOF，三组退出码均为 0。C 与 B 的不足半秒差异只是两次单样本观察。

**结论为极小块 I/O/调度成本叠加预算不足。** 原 20 秒预算短于小块配置的正常运行时长，单次 100 ms 暂停不足以解释差距。Native 16-bit 输出按 `floor(CHUNK/2)` 个样本组装，每行 512 样本。`CHUNK=7` 会形成每次最多 6 B 的应用写入，每行 171 次，共约 700,416 次。`CHUNK=4096` 每行一次，共 4096 次。输入读块也随同一 CLI 参数变小。本次未拆分读、写、运行时和 WSL 文件系统各自的时间份额，未发现已用正确驱动和预算仍不完成的产品缺陷。

B 的上限由控制 A 用时及估算的逻辑 I/O 次数比给出，属于宽裕的测试管理预算。C 以实测 B 为 `Tfast`，上限 `2×93.035 + 0.1 + 5 ≈ 191.17 秒`。预算加法用于控制测试时限。原超时不被替代试验改写。没有修改 Native 产品代码。

## 复验

用户可先按 [固定依赖](../../docs/VALIDATION.md) 配置 CharLS，然后通过 `scripts/benchmark.py --mode fixtures --directory .evidence/rc3/native-fixtures` 生成同一码流和参考。解压的审查包不包含这些二进制。下面是作者现场的完整控制命令，需在 Linux/WSL 从仓库根目录执行。其他电脑可以按记录的源码构建 Native CLI，先记录实际生成哈希，再用同一生成物做三组控制。

```sh
python3 scripts/native_slowcase.py \
  --binary .tools/rc2-final-verified-build/targets/native/release/build/cmd/moonjls/moonjls.exe \
  --fixture .evidence/rc2/worker-fixtures/resource-512x4096.jls \
  --reference .evidence/rc2/worker-fixtures/resource-512x4096-near0.reconstructed.raw \
  --source-commit a146998f31675769fb6c3bc9055ef7798f254b1d \
  --binary-sha256 267837ca5c3015adf1637a322bf27a8ab96699ff9c9e2ee9b3e1166539a7ed6c \
  --fixture-sha256 3b13b43e944157a11a2fe3561011ee6780a207eb654e890ffa8b50d8b855ecab \
  --reference-sha256 8d2957a342ebe35cb6d12678efc04f254deeedc2e0efb852bbb236ab8718dc89 \
  --output .evidence/rc3/native-controls-recheck.json
```

`REVIEW_EVIDENCE/audit_native_pipe.py <native> --require-eager` 和 `REVIEW_EVIDENCE/native_tail_matrix.py <native>` 分别复验暂扣 EOI 时的行交付以及严格尾随与输入结束语义。诊断与 Browser 正式计时分开执行。
