# 需要你处理的事项

在每条下面的"回复："后面写你的回复即可，下一轮 loop 会读到。处理完的条目移到文末的"已处理"。

## 待处理

### [请你过目] 旧 AMO 的 DeepSeek 修复待你验证（2026-10-12，阶段 0）
修复在主目录的 `chore/next-gen-planning-2026-10` 分支上：Codex 0.161 不再接受 `agents.default_subagent_*` 参数，导致 DeepSeek 路由启动失败。请执行 `npm run amo:restart`，再用 DeepSeek 拉起一个 Managed Codex，确认能正常启动。确认后告诉我，我把这个分支合并回 master。这件事和 Studio 无关，loop 不会碰主目录。
附件：`docs/deepseek-routing-sop.md`
回复：

## 已处理

（暂无）
