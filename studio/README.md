# AMO Studio

AMO 的下一代：由人主导、agent 也能参与的项目推进工作台。

- 愿景与架构：[../docs/next-gen-vision-architecture-2026-10.md](../docs/next-gen-vision-architecture-2026-10.md)
- 协议验证结论：[../docs/protocol-session-spike-2026-10-12.md](../docs/protocol-session-spike-2026-10-12.md)
- 设计预览（模拟数据）：https://claude.ai/artifact/LyWa7NybnLR3Ro84wdGPgv，本地副本在 [design/prototype/](design/prototype/)

本目录独立于旧 AMO（`broker/`、`overlay/`），不 import 旧代码。旧 AMO 在过渡期内照常使用。

## 文件导航

| 文件 | 用途 |
|---|---|
| [STATUS.md](STATUS.md) | 当前进度。两分钟读完 |
| [NEEDS_YOU.md](NEEDS_YOU.md) | 需要用户处理的事项，用户直接在文件里回复 |
| [ROADMAP.md](ROADMAP.md) | 全部阶段的目标、验收标准与关卡 |
| [LOOP_RULES.md](LOOP_RULES.md) | 自动迭代（`/loop`）的规则与红线 |
| [plans/](plans/) | 每个阶段的详细任务清单，进入该阶段时编写 |
| [LOOP_LOG.md](LOOP_LOG.md) | 每轮迭代的记录 |
| [design/interaction-notes.md](design/interaction-notes.md) | 已确认的交互细节，持续补充 |
| [budget.json](budget.json) | 真实模型调用预算与已用量 |
