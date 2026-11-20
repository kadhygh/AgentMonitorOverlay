# 以后推进

谈过、但现在不做的功能放在这里（用户 2026-11-06 定：讨论出的功能可能做到一半，或者直接放到这个区域里，作为后续推进内容）。

- 每个功能一份 `<主题>.md`，开头一行写 `> 状态：以后推进（日期，为什么先不做）`，接着写做到哪了、剩什么，正文照 plans 的规矩只留决定和原因。
- 谈出了新功能但这一轮不做：直接在这里建一份，写清用户说了什么、谈定了哪些、还没定的问题。
- 做到一半停下：从 `plans/` 挪进来（`git mv`，用 `git grep` 把指向它的路径改掉），状态写清停在哪一步。
- 重新开工：挪回 `plans/`，状态改成「进行中」；做完照常进 `plans/done/`。
- `HANDOFF.md`「还开着的事」只写正在推进的，这里的不列，一行指过来。
- 新增或挪动时更新下面的表。

| 方案 | 是什么 | 停在哪 |
|---|---|---|
| [tutorial-onboarding.md](tutorial-onboarding.md) | 教程和产品内引导 | 教程和展示页 11-05 已上 GitHub Pages；教程第 2、5 章和产品内引导没做 |
| [lan-file-transfer.md](lan-file-transfer.md) | AMO 文件快传（局域网传文件） | 10-31 首轮调查做完，范围没定，没开工 |
| [canvas-workflow.md](canvas-workflow.md) | 画布工作流 canvasflow | 10-30 谈定方向，细节等用户想，没开工；11-20 起不另做模块，规矩留给任务级白板 |
| [turn-changes-commands.md](turn-changes-commands.md) | 本轮改动把命令改的文件也列进来 | 11-06 谈了三种做法、实测了开销，用户定先维持现状，没开工 |
| [plan-review-window-later.md](plan-review-window-later.md) | 计划窗口：远程设备和手机、和上一版对比 | 11-09 第一版（本机工作台）做完，这两项用户定先放着，没开工 |
| [mcp-sse-bridge.md](mcp-sse-bridge.md) | SSE 的 MCP 在 DeepSeek、Codex 会话里也能用（本地转接） | 11-09 先做了带不上就跳过并说明，转接没开工 |
| [agent-collab-direction.md](agent-collab-direction.md) | 后续方向：agent 协作层、任务管家 + 全景、中转协作信道、协作模板 | 11-13 只聊了方向，11-15 整理成文；第一刀和协作模板的 4 个问题没定。方向 1 的 session 卡 = 白板（11-20） |
| [userlayer/](userlayer/README.md) | 三层架构和 9 种表达（`README.md`）、全景（`panorama.md`）、全景的框架（`framework.md`），连同原型和预览脚本 | 11-20 从 `plans/userlayer/` 挪来：11-19 用户定中间层先只试白板。全景停在 P1，测试功能开关留着，会话抽屉在分支 `studio/panorama` 没合 |

还没写成方案的小事（用户定了以后再说）：

- 位置批注的截图（10-28：用一段时间再定；记录在 `docs/history/handoff-2026-10-late.md`）。
- 中转进会话的终端会话、普通聊天、超时提醒（10-30）。
- 类似 DSH 的插件架构（10-31，到时另起方案）。
