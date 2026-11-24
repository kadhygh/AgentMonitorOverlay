# collab-spec-eval：用真模型验收 `plans/collab-agent-spec.md`

在产品实现之前，验的是规格本身：角色卡、叫醒消息、工具说明、收尾和闸门这几段话，够不够让三种模型（sonnet、gpt6.2sol、dxx-ds；用户 11-23 允许用来测试）照着做。结论和数字在 `studio/out/collab-spec-eval/report.md`。

## 组成

| 文件 | 是什么 |
|---|---|
| `collab.mjs` | 协作的状态（`state.json`）：事项（编号、负责方、状态、在等谁、卡在哪、绑定、结论、状态历史）、消息和每个收件人的回执（送到 / 看过 / 处理了）、取代和撤回的提醒、30 轮上限、「待我处理」 |
| `mcp.mjs` | 按规格第 3 节实现的 MCP 服务（名字叫 `amo`）：`amo_whoami`、`cowork_read/post/matter/conclude/ask/mark/retract/note/board`、`session_start`（带 `matter`）、`session_send`。工具说明是规格的话；执行会话越权（群聊发言、@ 人、改状态、定结论、读别的事项、改板）被拒并记一笔；主控改对方的事项只记不拒（规格说这道闸门 Studio 拦不住）。每个会话一个地址 `/mcp/<key>`，端口用 testkit 的 `listenInStudioRange` |
| `scenario.mjs` | 场景「苦无改穿透」（改编自 `studio/out/cowork-flow/sim.html`）：小仓库（`src/kunai.js`、`config/kunai.json`、测试、`docs/kunai.md`）、两个人写死的台词、人怎么回「等人确认」（按标题分类）、从规格里读角色卡、第 0/4/5 节和叫醒模板 |
| `run.mjs` | 驱动：扮演小王和老李、Host 巡检（每 20 秒，只在有变化时按第 2 节叫醒；@、取代提醒和执行交回立刻叫；主控正在一轮里就等它结束）、执行会话的开、叫、交回；轮数、时间上限，安静 75 秒停 |
| `runners.mjs`、`run-lib.mjs` | 三种模型各自的 CLI 怎么跑（见下） |
| `score.mjs` | 从记录里数规格「验收」的各项（1–7，v5 起加 1′ 事件推状态、8 AI 问答、9 接手）→ `<run>/score.json`、`score.md`；8 的自动配对不可靠，以人工抽看为准 |
| `dump.mjs` | 一次运行整理成能读的时间线 → `<run>/transcript.md`（人工抽看用） |
| `selftest.mjs` | 不开模型，用 MCP 客户端把工具和拒绝走一遍 |
| `smoke.mjs` | 每种模型一轮，看它连得上、只看得到这个 `amo`、有 shell |

## 跑

```
node spikes/collab-spec-eval/selftest.mjs
node spikes/collab-spec-eval/smoke.mjs sonnet          # 或 gpt6.2sol / dxx-ds
node spikes/collab-spec-eval/run.mjs --model sonnet --tag v3 --turns 60 --minutes 60
node spikes/collab-spec-eval/score.mjs out/collab-spec-eval/<run>
node spikes/collab-spec-eval/dump.mjs out/collab-spec-eval/<run>
```

（在 `studio/` 下跑；用低优先级起：`Start-Process … -PassThru | % { $_.PriorityClass = 'BelowNormal' }`。）

- 规格每次运行开头从 `plans/collab-agent-spec.md` 读，抄一份到 `<run>/spec-used.md`。`--spec <那份 spec-used.md>` 用旧版跑，`--tooltext v1` / `v4` 换回第一版 / v4 的工具说明（v4 是状态还要手改、cowork_read 不分三层的那版），用来对比前后。
- 11-25 起（v5）：状态由事件推出来（`collab.mjs` 的 `recompute`：绑执行、@ 和回复、`cowork_ask`、人回话、推上去的提交、执行贴了通过 → 在做 / 等对方 / 等人确认 / 已推送 / 待核对；主控只补判断，手改记「手改」）；`--stale <分钟>` 是「久没动静」的阈值（规格写 2 小时，这里默认缩成 6 分钟）。执行说过了、主控标已验时，脚本都在那个提交上真跑一遍 `node --test`（`run.mjs` 的 `testAt`），记进 `turns.json`。
- `--takeover LM|WM|none`（默认 LM）：老李提出两块提议（或那个主控到第 7 轮）时，给它换一个新会话接手，提示照第 6 节（角色卡 + 那句话 + 叫醒）。
- 弹道执行在事项里直接 @ 小王的主控问盾和冰冻两个边界（`scenario.mjs` 的 `TRUTH` 是对的答案），`cowork_post` 的 `basis` 记来源。
- `table.mjs <run…>`：几次运行并排比。
- 每一轮开始前在 `budget.json` 记一次（`spikes/lib.mjs` 的 `countTurn`；sonnet → claude，gpt6.2sol → gpt，dxx-ds → deepseek）。
- 沙盒在 `%TEMP%\amo-studio-sandbox\collab-spec-<run>\`：一个 bare `origin.git`（post-receive 把每次推送记进 `push.log`，合 master 的时间就从这里看）、每个会话一份 clone、Codex 和 DSH 自己的家目录。不碰用户的 Studio、`.data`、团队服务器。

## 怎么让模型只看到这个 `amo`

用户的 Studio 也有一个叫 `amo` 的 MCP（带真的 `cowork_*`），模型不能看到它。三种都不经 Studio Host，直接跑各自的 CLI：

| 模型 | 怎么跑 | 怎么只给这一个 MCP |
|---|---|---|
| sonnet | `claude -p --output-format stream-json --model sonnet --permission-mode bypassPermissions`，`--session-id` / `--resume` 接着一轮轮跑；用本机的 Claude Code 登录 | `--strict-mcp-config --mcp-config <只写这一个 amo 的文件>`，`--setting-sources project`；环境 `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1`、`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`（不然会读到用户的 `~/.claude/CLAUDE.md`） |
| gpt6.2sol | `codex exec --json` / `codex exec resume <thread>`，provider 是 DXX 站点（responses），key 从 AMO 的旧凭据只读拿 | 自己的 `CODEX_HOME`（沙盒里），`config.toml` 只写 `mcp_servers.amo.url` |
| dxx-ds | DSH 源码 clone（`deepseek-harness/apps/cli/lib/bin.js --profile acp`），ACP `session/new` 时传 `mcpServers` | 自己的 `DSH_HOME`；`DSH_PERMISSION_MODE=danger-full-access`（写错值时 DSH 会关掉 shell 工具，第一次 ds 运行就是这样作废的） |

三者都把 `CLAUDE*`、`ANTHROPIC*`、`AMO_*`、`CODEX_*` 环境变量清掉（`runners.mjs` 的 `cleanEnv`）。凭据只读、不打印。

## 已知的限制

- DSH 走的是内置 DeepSeek 渠道的 deepseek-v4-flash，不是用户的 Dxx-DS 渠道；它只报上下文大小，没有输出 token，第 7 项的输入是每轮上下文之和（估算）。
- Codex 的 usage 是一个 thread 累计的，`score.mjs` 取差值；输入里约九成是缓存命中。
- 人的回答是按标题和正文分类后写死的，分错时会给出不对题的回答（`turns.json` 的 `people` 记了每次分到哪一类）。
- 上下文压缩（第 6 节）只验了「新会话接手」（`--takeover`），真正的压缩没验：一次运行不到 30 轮，没有会话压缩过。
- 「久没动静」阈值缩成 6 分钟，整个场景 5–28 分钟，没有触发过。
