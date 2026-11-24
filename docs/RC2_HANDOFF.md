# MoonJLS RC2 本地工程交接

复验日期为 2026-11-24（新加坡时间）。工作目录 `D:\Program Files\GPT_project\moon_jpegls`，分支 `main`。正式测试的源提交以 [构建清单](../reports/rc2/build.json) 的 `source.commit` 为准。Antigravity 从该 SHA 新建独立分支。原 rc.1 标签及 `reports/` 根下的历史验证和计时仍可按原报告的提交检出复现。

## 本轮行为合同

- Native CLI 让核心先推进。宿主切片耗尽后，仍可能有内部状态可交付零输入消耗的行。只有实际 `NeedInput` 才补读。EOI 前的行仍为暂定输出，CLI 完成前会确认 EOF 并拒绝尾随数据。 [复现](../REVIEW_EVIDENCE/NATIVE_PIPE_AUDIT.md)
- 每个浏览器任务有自己的身份、取消信号、Worker 和 sink。取消立即解除工作台锁定。旧任务的异步读取或写入可在宿主继续完成，恢复后不得影响当前预览、统计、新写入或下载。已进入文件系统的 `close()` 仍由宿主决定是否完成，应用守卫不会撤回该 I/O。 [复现](../REVIEW_EVIDENCE/WEB_CANCEL_AUDIT.md)
- 解码 `row` 事件携带完整行统计，当行只等待一份数据 ACK。无行时的进度按 50 ms 限频，`done` 仍携带最终统计。以 `row` 作为逐行进度来源。编码事件行为按原接口执行。

## 复验顺序与可修改范围

1. 从构建清单的源 SHA 洁净检出。按 `docs/VALIDATION.md` 安装锁定的 CharLS wheel、npm oracle 和 Playwright。用 `python scripts/build_evidence.py build --directory .tools/rc2-local-build --native-wsl Ubuntu-22.04` 重新生成三后端和静态树。其他机器可按实际 Moon/clang 路径构建。
2. 用清单的 `nativeBinary` 在 Linux/WSL 运行 `python3 REVIEW_EVIDENCE/audit_native_pipe.py <nativeBinary> --require-eager` 和 `python3 REVIEW_EVIDENCE/native_tail_matrix.py <nativeBinary>`。先验 4 行、后验终态。回归应覆盖缺失 EOI、截断、非零填充和本块、后续块尾随。
3. 执行 `node REVIEW_EVIDENCE/web_cancel_probe.mjs .`。用 `python -m http.server 8000 --bind 127.0.0.1 --directory .tools/rc2-local-build/static` 启动本机静态树，再运行 `npm --prefix web run smoke`。重点复核取消后立即重启、原始 16 位像素、下载内容、慢消费 ACK 和暂停恢复。
4. 视觉层主要改 `web/style.css`、`web/index.html`、`web/labels.mjs` 或 `web/preview.mjs`。改变 `web/app.mjs` 时保留任务身份检查、sink 顺序和 `Uint16Array` 原值。更改 Worker 数据流、TypedArray 所有权或 core/bridge 前先独立立项，并复跑 CharLS、单字节分块和内存对照。

## 测量范围

本轮唯一产品性能实验是 Worker 的解码重复 progress/ACK。独立 Node SDK、纯 MoonBit 核心、编码路径和界面渲染均不计入该收益。浏览器测量排除 DOM、fixture 预载和结果落盘，包含启动新 Worker、消息往返、限长块拷贝与逐样本校验。fixture 和参考重建作为测试夹具预载，进程 RSS 和随高度增长的流式工作区由无整图输入的 Node 资源对照分开记录。系统文件保存对话框、Firefox 和 Safari 无本轮覆盖。

原始数据、门槛和复跑命令见 [RC2 实测](../reports/rc2/README.md)。发布、推送与赛事提交由作者决定。
