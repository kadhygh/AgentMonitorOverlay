# 接续终端 / Claude desktop app 里的会话（2026-11-05）

## 为什么做

10-30 讨论过一次后放弃（以为接过来后 Studio 的会话页是空的，补历史工作量大）。11-05 重新做：有人想换到 AMO，但很多任务还在 Claude desktop app 里跑，有几个长会话是固定流程，不想抽成交接文档。

10-30 估错的地方：把 Claude 的对话记录转成 Studio 条目早就有（`runtime/claude/transcripts.ts` 的 `importTranscript`，10-13 做「交给终端 → 收回」时写的）。

## 用户定的范围（11-05）

- 入口只放在**新建任务页**（任务页不加「接续到这个任务」）。
- 第一版只做 **Claude**；Codex 以后再做；DSH 不做（Studio 用自己的 `DSH_HOME`，看不到外面的会话）。
- 第一版一次接一个。

## 查到的事实（11-05 在本机验证过）

| 事 | 结论 | 怎么验证的 |
|---|---|---|
| desktop app 的会话在哪 | 和终端一样，在 `~/.claude/projects/<目录编码>/<id>.jsonl`；记录里 `entrypoint` 是 `claude-desktop`（第三方版 `claude-desktop-3p`），终端是 `cli`，Studio 是 `sdk-ts` | 读 Claude Code 二进制里的 entrypoint 表；本机没装 desktop app，**desktop app 实际写出的文件未验证** |
| 列出会话 | SDK 的 `listSessions({ includeProgrammatic: false })` 和终端 `/resume` 的列表一致：不列 `sdk-*` 开的（Studio 的会话不出现）；给 `dir` 时还会列 git worktree 里的 | 临时配置目录里造了一份 desktop 记录，列得出来 |
| 复制会话 | `forkSession(id)` 复制到**原会话同一个目录**，记录里的 cwd 不变，第一条的 entrypoint 也不变 | 同上 |
| 换个工作目录续 | 在 B 目录 `--resume` 一个记录在 A 目录下的会话：能找到，接着写进 A 下面那份文件，上下文链是连着的 | 实测（这次用到了本机登录，调用了一次模型） |
| 读历史 | `getSessionMessages` 只返回**最后一次压缩之后**的链（37MB、压缩过 4 次的会话读出 293 条，第一条是压缩摘要），140ms | 本机一个真实长会话 |

## 方案

1. **列出**：`GET /api/claude/outside-sessions`。Host 用当前 Claude 账号的配置目录（多账号的目录都链到默认目录的 `projects`）调 `listSessions({ includeProgrammatic: false })`，再去掉：Studio 里已有的 `runtimeRef`（包括归档的），已经接续过的原会话（kv `claude-adopted:<原 id>`）。每条带：标题、第一句、目录、最后活动时间、大小、git 分支、匹配到的项目（目录等于项目或在项目里面，取最长的）。Claude 订阅不是本机登录时（只有测试会这样）返回不可用。
2. **预览**：`GET /api/claude/outside-sessions/:ref/preview`，最后几条用户消息和回复的文字，加总条数、是否压缩过。
3. **接续**：`POST /api/tasks` 的 `firstSession.resumeFrom = <原会话 id>`，模型必须是 Claude 订阅。Claude runtime：
   - 一律**复制**（`forkSession`），原会话不动：desktop app 里还开着也不会两边同时写；复制件标题用任务名。
   - 新会话的 `runtimeRef` = 复制件的 id；记下 `claude-adopted:<原 id>`。
   - 用 `importTranscript` 导入复制件的历史，前面加一条说明（接续自哪、原目录、压缩过的话只导入了最后一次压缩之后的部分），压缩摘要本身不导入。
   - 有第一句话就接着发；没有就只接过来，等人发。
4. **目录**：会话在项目根目录（任务的项目）里继续。原目录和项目目录不一样时（子目录、worktree），新建任务页提示「原来在 X 里工作，接过来后在 Y 里继续」；没有项目能对上时，可以一键把原目录添加为项目。
5. **界面**：新建任务页标题行加「接续已有会话…」（在别的设备上时不显示）。弹窗按项目分组列出，右边预览；选好回到表单：名称、项目自动填，模型锁定 Claude 订阅，第一句话可以不填，主按钮变成「接续」，「放进待办」不可用。

## 没做 / 以后

- Codex（`thread/list`、`thread/read` + `codex/events.ts` 的映射）。
- 导入最后一次压缩之前的历史（要自己按 `logicalParentUuid` 走链）。
- 多选一次接多个。
