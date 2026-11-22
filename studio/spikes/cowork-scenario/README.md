# 协作的真模型场景

`plans/cowork.md` 第 5 步。用真模型跑一遍协作，看 AI 会不会按时机接住消息、写不写白板、会不会乱 @，以及每一轮多花多少 token。模型用 dxx-ds、gpt6.2sol、sonnet（用户 2026-11-23 定）。

## 跑

先在 `studio/` 下 `npm run build`。

```
node spikes/cowork-scenario/run.mjs --planner sonnet --coder gpt6.2sol --turns 25 --minutes 30
node spikes/cowork-scenario/run.mjs --planner sonnet --coder gpt6.2sol --dry   # 只搭环境，不调模型
node spikes/cowork-scenario/report.mjs out/cowork-scenario/<run> [<run> …]   # 出 report.md
```

- 环境都在 `%TEMP%\amo-studio-sandbox\cowork-<run>\`：
  - 一个本机的中转服务（这份代码，端口 47900–47949），账号「策划」「程序」；
  - 两个 Host（`packages/host/dist/bin.js`），各有自己的数据目录、`AMO_HOME`、`CODEX_HOME`；
  - 一个小仓库 `origin.git`，两边各 clone 一份。
- 不碰用户的 Studio、`.data`、`~/.codex` 的设置，也不碰团队服务器。sonnet 用本机 Claude Code 的登录，和用户自己的会话一样，所以会在 `~/.claude/projects` 下留会话记录。
- 模型怎么接写在 `models.mjs`：
  - gpt6.2sol 是 DXX 站点上的 Codex 渠道，Key 用旧 AMO 的 DXX Key，从凭据管理器只读；
  - sonnet 是内置的 Claude 订阅，本机登录；
  - dxx-ds 走 DSH 源码 clone（`AMO_STUDIO_DSH_CLONE`，默认 `G:\PROJECT\deepseek-harness`）。
- 额度：每一轮开始时用 `spikes/lib.mjs` 的 `countTurn` 记进 `budget.json`。人发的消息在发之前记。被 @ 后 Host 自己开的轮，脚本最早只能在它出现时记，所以这类轮是开了以后才记上的。到 `--turns` 就打断两边的会话并停下。
- 结果在 `studio/out/cowork-scenario/<run>/`（不进仓库）：`result.json`、两边会话的 items、`log.txt`。

## 场景

1. 策划开协作「射速上限可配」（目标是一个小需求，分 4 条），两边各把自己的会话拉进来。程序先交代自己的 AI 等着，策划交代自己的 AI 来带这件事。
2. 「AI 发起 @ 和提问」一开始关着：AI 的 @ 和子会话先成草稿，主人（脚本）过 4 秒用 RelayClient 发出；第一份草稿发出后打开这个选项。
3. 子会话问到人时，这个人回答，另一个人在里面插一句话。
4. 群聊里有 AI 发言后，策划先说一句不带 @ 的话（不该叫醒谁），后面再 @ 一次程序的 AI。
5. 停下的条件：两边都待命、没有排队的消息、没有草稿、没有等人的子会话，并且这样持续 60 秒；或者到了轮数上限、时间上限。
