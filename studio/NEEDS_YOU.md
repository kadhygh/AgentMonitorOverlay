# 需要你处理的事项

在每条下面的"回复："后面写你的回复即可，下一轮 loop 会读到。处理完的条目移到文末的"已处理"。

## 待处理

### [请你过目] 旧 AMO 的 DeepSeek 修复待你验证（2026-10-12，阶段 0）
修复在主目录的 `chore/next-gen-planning-2026-10` 分支上：Codex 0.161 不再接受 `agents.default_subagent_*` 参数，导致 DeepSeek 路由启动失败。请执行 `npm run amo:restart`，再用 DeepSeek 拉起一个 Managed Codex，确认能正常启动。确认后告诉我，我把这个分支合并回 master。这件事和 Studio 无关，loop 不会碰主目录。
附件：`docs/deepseek-routing-sop.md`
回复：

### [请你过目] 用真实 TUI 验证 /fork、side chat 和重连（2026-10-12，阶段 1，S1-00e）
需要你在终端里操作一次，大约 5 分钟，DeepSeek 大约用 5～8 次。在 `G:\PROJECT\AgentMonitorOverlay-studio` 下执行 `node studio/spikes/s1-00e-tui.mjs`，按它打印的步骤做：在另一个窗口粘贴接入命令，TUI 里说一句话、执行 `/fork`（有 side chat 也开一次），再发一句含 AMO-RESTART 的话让脚本重启 server，等 TUI 重连后再说一句，最后 Ctrl+C。server 用沙盒的 CODEX_HOME，默认 provider 是 DeepSeek，不会用到 GPT。做完回复"已做"即可，结果在 `studio/spikes/results/s1-00e.log`，下一轮我来分析。不做也不挡后续开发。
附件：`studio/spikes/RESULTS.md`（a～d 的结论）
回复：

### [请你过目] 阶段 1 完成：可以试用 Studio 了（2026-10-13，阶段 1，S1-12）
Studio 现在能在工作台里用 Codex（含 DeepSeek 路由）推进任务：看板、DSH 式新建任务、任务页（会话树、分支、子 agent、归档）、对话（流式、工具卡片、审批、插话、打断）、一键在终端用原版 Codex TUI 接入同一会话。真实 DeepSeek 冒烟、终端接入和 Host 重启都已验证。你有空时可以按下面的方式用一用，有不顺手的地方写在"回复"或 `design/interaction-notes.md` 的"待补充"里，会变成返工任务。不用回复也不挡后续阶段。
试用：
1. 在 `G:\PROJECT\AgentMonitorOverlay-studio\studio` 下执行 `npm start`（会先构建，再打开窗口；Host 默认端口 47900，与旧 AMO 的 17654、1420 不冲突）。
2. 左栏"+ 登记工作区"，选一个真实工程（建议先选一个不怕改动的）。
3. "+ 新任务"，模型选"Codex · DeepSeek Flash"或"Codex · 默认"，说第一句话。需要原版 TUI 时点"在终端打开"。
4. 关掉窗口后 Host 仍在运行（会话不中断）；要彻底停掉执行 `npm run host:stop`。数据在 `studio/.data/`。
注意：真实使用时 Codex 会话写在你自己的 `~/.codex` 里（和平时用 Codex 一样，`codex resume` 也能看到）；测试和冒烟一律用沙盒目录。
本阶段的默认决定（可推翻）：带首条消息新建的任务直接进"进行中"；会话状态多了红色的"出错"；没有会话的卡片显示"未开始"；会话顶栏加了"分支"按钮；"在终端打开"后保持"共享"直到手动收回；正常退出 Host 会停掉 app-server（重启 Host 时保留）；字体暂用本机字体；回复里的链接暂不可点击；子 agent 的工具卡片排在审批卡片前面。
附件：`studio/screenshots/stage-1/`（S1-09 看板、S1-10 新建任务与首条回复、S1-11a 任务页、S1-11c 审批与子 agent）；`studio/spikes/RESULTS.md`（协议结论 a～g）
回复：

## 已处理

（暂无）
