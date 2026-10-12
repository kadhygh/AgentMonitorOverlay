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

## 已处理

（暂无）
