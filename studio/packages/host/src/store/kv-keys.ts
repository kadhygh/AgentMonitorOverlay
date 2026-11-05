// Every key the Host keeps in the kv table (2026-11-04, 架构整理第 6 步: about 60 keys had no list, and the ones
// per session were never deleted with the session). The features keep their own constants; kv-keys.test.ts reads the
// Host's sources and fails when a key is used that is not here, or listed here and no longer used.
//
// scope: what one value belongs to. "global": one value for the Host. "session" / "task" / "workspace": the key is
// the prefix + that id, and Store.purge deletes it with what it belongs to. "folder" / "token": the prefix + a folder
// path or an MCP token (the token's key goes with its session, see Store.purge). "outside": the prefix + the id of a
// Claude session started outside Studio (接续已有会话, 2026-11-05).

export type KvScope = "global" | "session" | "task" | "workspace" | "folder" | "token" | "outside";

export interface KvKey {
  /** The whole key, or for a scope other than global the prefix the id is appended to. */
  key: string;
  scope: KvScope;
  /** Where it is read and written (under packages/host/src). */
  owner: string;
  what: string;
}

export const KV_KEYS: readonly KvKey[] = [
  // Settings (设置)
  { key: "settings:presets", scope: "global", owner: "core/shared.ts", what: "常用预设" },
  { key: "settings:disabled-features", scope: "global", owner: "core/shared.ts", what: "设置 → 功能：关掉的功能" },
  { key: "settings:experimental-features", scope: "global", owner: "core/shared.ts", what: "设置 → 功能：打开的实验功能" },
  { key: "settings:team-auto-send", scope: "global", owner: "core/shared.ts", what: "中转：会话发的问题不等「发送」直接发" },
  { key: "settings:agent-shell-help", scope: "global", owner: "runtime/agent-env.ts", what: "设置 → 功能 → 命令行适配：关掉时为 0（默认开）" },
  { key: "settings:quota-display", scope: "global", owner: "core/shared.ts", what: "设置 → 额度：各账号的额度显示在哪" },
  { key: "settings:quick-models", scope: "global", owner: "core/shared.ts", what: "设置 → 模型 → 快速选择" },
  { key: "settings:subsession-notes", scope: "global", owner: "core/shared.ts", what: "设置 → 子会话：人写的模型用法" },
  { key: "settings:project-groups", scope: "global", owner: "core/shared.ts", what: "左栏的项目分组" },
  { key: "settings:topic-groups", scope: "global", owner: "core/shared.ts", what: "左栏的专题分组" },
  { key: "settings:common-workspace", scope: "global", owner: "core/shared.ts", what: "结构 v2 以前的公共空间（只在迁移时读）" },
  { key: "settings:model-prefs", scope: "global", owner: "core/model-prefs.ts", what: "各模型上次选的选项" },
  { key: "settings:auto-compact-tokens", scope: "global", owner: "runtime/compact.ts", what: "自动压缩点" },
  { key: "settings:auto-compact-profiles", scope: "global", owner: "runtime/compact.ts", what: "按模型的自动压缩点" },
  { key: "settings:claude-accounts", scope: "global", owner: "runtime/claude/accounts.ts", what: "Claude 账号" },
  { key: "settings:claude-login", scope: "global", owner: "runtime/claude/claude-login.ts", what: "Claude 的登录方式" },
  { key: "settings:dsh-path", scope: "global", owner: "runtime/dsh/install.ts", what: "DSH 源码克隆的位置" },
  { key: "settings:dsh-desktop-path", scope: "global", owner: "runtime/dsh/install.ts", what: "DSH 桌面版的位置" },
  { key: "settings:dsh-source", scope: "global", owner: "runtime/dsh/install.ts", what: "DSH 用桌面版还是克隆" },
  { key: "settings:dsh-auth", scope: "global", owner: "runtime/dsh/install.ts", what: "DSH 用账号还是 API Key" },
  { key: "settings:scratchpad-shortcut", scope: "global", owner: "features/scratchpad/service.ts", what: "便签窗口的全局快捷键" },
  { key: "settings:scratchpad-safe-newlines", scope: "global", owner: "features/scratchpad/service.ts", what: "便签「复制」是否合并换行" },
  { key: "chat.settings", scope: "global", owner: "runtime/chat-settings.ts", what: "设置 → 界面：对话的设置（会话开始时 runtime 读）" },
  { key: "modelChannels", scope: "global", owner: "runtime/channels.ts", what: "模型渠道" },
  { key: "hiddenProfiles", scope: "global", owner: "runtime/channels.ts", what: "藏起来的模型" },
  { key: "prompt-templates", scope: "global", owner: "features/prompttemplates/service.ts", what: "提示词模板" },
  { key: "mcp:servers", scope: "global", owner: "features/mcp/service.ts", what: "Studio 自己的 MCP 服务器" },
  { key: "mcp:global", scope: "global", owner: "features/mcp/service.ts", what: "MCP 服务器默认开关" },
  { key: "mcp:status", scope: "global", owner: "features/mcp/service.ts", what: "MCP 服务器上次的状态" },
  // State the Host keeps
  { key: "scratchpad", scope: "global", owner: "core/shared.ts", what: "便签第 2 阶段的纯文本（只在没有 scratchpad:doc 时读）" },
  { key: "scratchpad:doc", scope: "global", owner: "features/scratchpad/service.ts", what: "便签的文档" },
  { key: "scheduler:task", scope: "global", owner: "core/shared.ts", what: "调度任务的 id" },
  { key: "dsh:check", scope: "global", owner: "runtime/dsh/install.ts", what: "DSH 上次「检查」的结果" },
  { key: "dsh:config-options", scope: "global", owner: "runtime/dsh/install.ts", what: "DSH 上次给的模型和选项（API Key）" },
  { key: "dsh:config-options:account", scope: "global", owner: "runtime/dsh/install.ts", what: "同上，用桌面版账号时" },
  { key: "duty.items", scope: "global", owner: "features/duty/service.ts", what: "值守项" },
  { key: "duty.runs", scope: "global", owner: "features/duty/service.ts", what: "值守的运行记录" },
  { key: "duty.found", scope: "global", owner: "features/duty/service.ts", what: "值守检查上次找到的" },
  { key: "duty.sessions", scope: "global", owner: "features/duty/service.ts", what: "值守开的会话 → 值守项（留最近 300 个）" },
  { key: "issues.sessions", scope: "global", owner: "features/issues/service.ts", what: "问题页：每个问题最后写它的会话（留最近 300 个）" },
  { key: "sessions.inbox", scope: "global", owner: "features/sessions/inbox.ts", what: "收件箱里有待送消息的会话" },
  { key: "sessions.peer-queue", scope: "global", owner: "features/sessions/inbox.ts", what: "收件箱以前 session_send 的队列（启动时迁进收件箱，过一两个版本删）" },
  { key: "teamrelay.sends", scope: "global", owner: "features/teamrelay/service.ts", what: "中转：会话要发的（等人确认、已发出）" },
  { key: "teamrelay.threads", scope: "global", owner: "features/teamrelay/service.ts", what: "中转：会话发出的中转会话" },
  // 远程
  { key: "remote.enabled", scope: "global", owner: "features/remote/service.ts", what: "远程为哪个账号打开（默认关闭）" },
  { key: "remote.pairs", scope: "global", owner: "features/remote/service.ts", what: "配对的设备" },
  { key: "remote.unpairs", scope: "global", owner: "features/remote/service.ts", what: "服务器还不知道的解除配对" },
  { key: "remote.grants", scope: "global", owner: "features/remote/grants.ts", what: "授权给别的设备的任务" },
  { key: "remote.allowed", scope: "global", owner: "features/remote/grants.ts", what: "授权：允许的设备" },
  { key: "remote.allowedProjects", scope: "global", owner: "features/remote/create.ts", what: "别的设备可以在哪些项目里开任务" },
  { key: "remote.security", scope: "global", owner: "features/remote/create.ts", what: "远程的安全设置" },
  { key: "remote.usageShare", scope: "global", owner: "features/remote/usage.ts", what: "能看这台电脑模型额度的别的账号的设备（远程额度）" },
  { key: "remote.taskRequests", scope: "global", owner: "features/remote/requests.ts", what: "别的设备要开的任务" },
  { key: "remote.asks", scope: "global", owner: "features/remote/requests.ts", what: "别的设备的开任务请求（本机这边）" },
  { key: "remote.asks.hidden", scope: "global", owner: "features/remote/requests.ts", what: "藏起来的开任务请求" },
  { key: "remote.dismissed", scope: "global", owner: "features/remote/copies.ts", what: "不再显示的远程任务副本" },
  { key: "remote.images", scope: "global", owner: "features/remote/copy-images.ts", what: "远程会话里的图片 → 本机的附件" },
  // Per session, task, project: deleted with it (Store.purge)
  { key: "role-stamp:", scope: "session", owner: "core/role.ts", what: "会话上次看到的角色卡" },
  { key: "annotation-seq:", scope: "session", owner: "features/review/service.ts", what: "批注编号" },
  { key: "report-turn:", scope: "session", owner: "features/sessions/service.ts", what: "已汇报过的那一轮" },
  { key: "claude.login:", scope: "session", owner: "runtime/claude/claude-login.ts", what: "会话用的 Claude 登录方式" },
  { key: "subsession-setup:", scope: "session", owner: "features/sessions/setups.ts", what: "@ 开子会话… 的设定（session_start 的 setup）" },
  { key: "claude-handoff-seen:", scope: "session", owner: "runtime/claude/transcripts.ts", what: "已读过的子会话交回" },
  { key: "claude-adopted:", scope: "outside", owner: "runtime/claude/outside.ts", what: "接续已有会话：已经接过的原会话 → 接着做的 Studio 会话" },
  { key: "mcp-identity:session:", scope: "session", owner: "mcp/identity.ts", what: "会话的 MCP token" },
  { key: "mcp-identity:token:", scope: "token", owner: "mcp/identity.ts", what: "MCP token → 会话（跟着会话删）" },
  { key: "remote.review-comments:", scope: "task", owner: "features/remote/comments.ts", what: "远程任务的 Review 批注" },
  { key: "mcp:project:", scope: "workspace", owner: "features/mcp/service.ts", what: "项目的 MCP 开关" },
  { key: "dsh-folder:", scope: "folder", owner: "runtime/dsh/dsh-runtime.ts", what: "DSH 改过权限的文件夹（按路径，不随会话删）" },
];

/** The prefixes Store.purge deletes `prefix + id` of, by what is deleted. */
export const kvPrefixes = (scope: "session" | "task" | "workspace"): string[] => KV_KEYS.filter((k) => k.scope === scope).map((k) => k.key);

/** The session's key that holds its MCP token; the token's own key is `MCP_TOKEN_PREFIX + token`. */
export const MCP_SESSION_PREFIX = "mcp-identity:session:";
export const MCP_TOKEN_PREFIX = "mcp-identity:token:";
