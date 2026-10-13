# AMO Studio 自动迭代规则

`/loop` 的每一轮都必须遵守本文件。对话上下文可能被压缩，所以**状态只认文件，不认记忆**。

## 1. 每轮流程

1. **定位**：工作目录固定为 `G:\PROJECT\AgentMonitorOverlay-studio`（git worktree）。先执行 `git status` 和 `git branch --show-current`，确认当前分支是 `studio/main` 或 `studio/stage-N`。不对时，先修正再做事。
2. **读状态**：依次读 `studio/STATUS.md`、`studio/NEEDS_YOU.md`、当前阶段的 `studio/plans/stage-N.md`、`studio/LOOP_LOG.md` 的最后 5 条、`studio/design/interaction-notes.md`。
3. **处理用户回复**：如果 `NEEDS_YOU.md` 里有用户新写的回复，先处理：
   - 转成任务，写进当前阶段的计划；
   - 解除对应的阻塞；
   - 把这一条移到"已处理"。
4. **选任务**：取当前阶段计划里第一个满足以下条件的任务：
   - 状态是 `todo`；
   - 依赖的任务都已完成；
   - 没有被"必须等你"阻塞。

   如果没有可做的任务：阶段验收已经全部完成，就执行第 6 节的阶段收尾；否则说明全部被阻塞，按第 8 节处理。
5. **实现**：一轮只做一个任务。如果任务比预想的大，就拆开：在计划里新增子任务，本轮只完成其中第一个。
6. **验证**：在 `studio/` 下运行 `npm run verify`，包括类型检查、单元测试和构建。脚手架任务完成之前，按该任务自己写明的验证方式来。界面任务还要：
   - 跑相关的端到端测试；
   - 截图保存到 `studio/screenshots/<阶段>/<任务ID>-<简述>.png`。
7. **提交**：只 `git add` 本任务涉及的文件，不用 `git add -A` 或 `git add .`。commit 信息格式为 `<type>(studio): <摘要>`，末尾加上会话要求的 Co-Authored-By 行。
8. **记录**：
   - 在计划里把任务状态改为 `done`；
   - 在 `LOOP_LOG.md` 末尾追加一条记录；
   - 如果进度有变化，更新 `STATUS.md`。
9. **安排下一轮**：
   - 还有可做的任务：60～300 秒后继续；
   - 只剩等待用户的事项：3600 秒后再检查。

## 2. LOOP_LOG 记录格式

```
## <日期 时间> · <任务ID> <任务名>
- 结果：done | partial | failed（第 n 次）
- 改动：<主要文件或目录>
- 验证：<命令与结果>
- commit：<hash>
- 遗留：<无 / 说明>
```

## 3. 红线（任何情况下都不做）

1. **不碰旧 AMO 的运行环境**：
   - 不修改、不重启、不停止旧 AMO 的进程；
   - 不读写 `broker/data/`；
   - 不修改主目录 `G:\PROJECT\AgentMonitorOverlay` 里的文件。
2. **不碰用户的全局配置**：不修改 `~/.codex/config.toml`、`~/.claude/` 下的设置、Windows 凭据管理器中的条目。凭据只读。
3. **不在用户的真实工程里测试**：测试只在 `%TEMP%\amo-studio-sandbox\` 下的沙盒工作区进行，不在用户的真实工程里启动会话或写文件。
4. **git 规则**：
   - 只在 `studio/main` 和 `studio/stage-N` 上提交；
   - 不合并到 master，不 push，不 rebase 已提交的历史，不使用 `reset --hard`；
   - 不删除别的分支或 worktree。
5. **依赖规则**：依赖只安装在 `studio/` 下，版本写死（不用 `^`、`~`），并提交 lockfile。用户已授权的范围：
   - Electron、React、Vite、TypeScript；
   - Vitest、Playwright；
   - `@anthropic-ai/claude-agent-sdk`；
   - 实现功能所需的常用库。

   需要新的外部服务或付费 API 时，属于"必须等你"。
6. **端口**：只使用 47900～47999 这一段端口。旧 AMO 使用 17654 和 1420，不能占用。
7. **窗口**：测试时 Electron 窗口不能抢占焦点：
   - 端到端测试尽量隐藏窗口或放到屏幕外；
   - 截图用 `webContents.capturePage`；
   - 不调用 `focus()`、`show()` 让窗口跳到前台。
8. **测试数据**：测试产生的 Codex thread 测完后归档；测试产生的 Claude session 只放在沙盒目录对应的项目下。
9. **凭据**：Key 不打印、不写日志、不写文件、不放进命令行参数。

## 4. 模型调用预算

- **计数**：一律通过 `studio/budget.json` 计数，额度为 DeepSeek 1000 次、GLM 5000 次（2026-10-12 用户上调，原为 100 次和 1000 次）。每发起一轮真实对话（一次 `turn/start`，或者一次 SDK 的 `query` 轮次）计 1 次，在发起前先加计数。
- **默认用 mock**：单元测试和端到端测试一律使用 mock 模型或 fake app-server。真实模型只在冒烟测试和协议补测中使用，并且要在计划里注明预计次数。
- **不用默认模型**：不使用 Codex 和 Claude 的默认账号模型（GPT、Claude 订阅）发起真实对话。
- **额度预警**：剩余额度不足 20% 时，写入 `NEEDS_YOU.md`，属于"请你过目"。额度用完后，停止所有真实调用，属于"必须等你"。

## 5. 关卡

关卡类型（自动、请你过目、必须等你）的定义见 `ROADMAP.md`。

写入 `NEEDS_YOU.md` 时使用以下格式：

```
### [必须等你|请你过目] <标题>（<日期>，阶段 N，任务 ID）
<两三句说明：要你做什么或决定什么，以及有哪些选项>
附件：<截图、文档路径>
回复：
```

写入后，按第 7 节发送通知。

## 6. 阶段收尾

一个阶段的验收标准全部满足后：

1. **代码审查**：对本阶段的全部改动运行 `/code-review`，把发现的问题修完。
2. **防偏离自查**：对照 `docs/next-gen-vision-architecture-2026-10.md` 的"明确不做"清单，以及 `design/interaction-notes.md`，自查有没有越界、有没有和已确认的交互冲突，结论写进日志。
3. **完整验证**：运行完整的 `npm run verify`，以及全部端到端测试。
4. **合并**：用 `--no-ff` 把 `studio/stage-N` 合并回 `studio/main`。
5. **更新文档**：
   - 更新 `STATUS.md`；
   - 在 `NEEDS_YOU.md` 中写一条"请你过目：阶段 N 完成"，附上截图和试用方式。
6. **准备下一阶段**：新建 `studio/stage-N+1` 分支，编写 `plans/stage-N+1.md`。计划依据：`ROADMAP.md`、前面阶段的实际结果、用户反馈。写完也放进 `NEEDS_YOU.md`，属于"请你过目"，不等回复，继续推进。
7. **发送通知**。

**Portable 包只在发布节点出**（用户 2026-10-13 决定）：日常改动不跑 `npm run package:portable` / `smoke:portable`，用 `npm run verify`、端到端测试和开发版（`npm start`）验证。等用户确认要发布某个版本时，才按那个发布节点打包、冒烟、更新 zip。

## 7. 通知

以下情况用 PushNotification 通知用户：

- 新增一条"必须等你"；
- 一个阶段完成；
- 触发第 8 节的停止条件；
- 模型调用额度预警。

通知控制在一句话以内，说清楚要用户做什么。

## 8. 停止与异常

- **失败**：同一任务连续失败 3 次，把任务标为 `blocked`，写进 `NEEDS_YOU.md`（必须等你），然后跳到下一个可做的任务。
- **连续空转**：连续 3 轮没有任何任务完成（只有失败或空转），就停止 loop：通知用户，并在 `STATUS.md` 写明原因。
- **全部阻塞**：所有剩余任务都被"必须等你"阻塞时，loop 改为每 3600 秒检查一次 `NEEDS_YOU.md`，不做其他事情。
- **全部完成**：阶段 8 完成，或者用户要求停止，停止 loop。
- **发现可能违反红线**：立即停下，写清楚情况，通知用户。不自行回滚破坏性操作。

## 9. 参考资料

- **DeepSeek Harness 源码**（MIT，最新版 0.2.1-alpha.2）：`G:\PROJECT\DeepSeekHarness`。重点参考 `apps/desktop`、`apps/desktop-host`、`packages/client/ui-*`、`packages/subagent/subagent-codex`、`packages/subagent/subagent-claude-code`。
  - 只读，不修改那个仓库。
  - 复制代码时，在根目录的 `THIRD_PARTY_NOTICES.md` 中注明出处。
  - 需要更新时，用 `git pull --ff-only`，并且只在本地没有未提交改动时执行。
- **Codex app-server 协议**：用 `codex app-server generate-ts` 生成类型，版本以 `codex --version` 为准。
- **旧 AMO 中可以借鉴的实现**（只读，按需搬运逻辑，不 import）：
  - 凭据读取：`overlay/src-tauri/src/model_credentials.rs`
  - DeepSeek profile：`broker/assets/deepseek/`
  - Codex 启动参数：`broker/lib/codex-launch-config.js`
  - Claude provider：`broker/lib/claude-provider.js`
