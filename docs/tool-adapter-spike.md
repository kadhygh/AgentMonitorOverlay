# Tool Adapter Spike

Worker: `worker-tool-adapters`
Date: 2026-05-07
Scope: Codex / Claude / Kiro event sources for Agent Monitor Overlay.

## Summary

This spike verifies the official hook or protocol surfaces that can feed the Phase 2 broker event API.

Recommended MVP path:

1. Use Codex lifecycle hooks for `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, and `Stop`.
2. Use Claude Code hooks for `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `Notification`, `Stop`, `StopFailure`, `CwdChanged`, and `SessionEnd`.
3. Use Kiro CLI hooks for basic CLI monitoring first. Use Kiro ACP only when Agent Monitor Overlay later becomes a controlled session host. Treat Kiro IDE hooks as useful but less machine-verified until tested inside the IDE UI.

## Current Adapter Implementation Notes

As of 2026-05-10, `scripts/adapters/Send-AgentMonitorEvent.ps1` supports optional routing overrides through these environment variables:

- `AMO_WINDOW_PROCESS`
- `AMO_WINDOW_TITLE`
- `AMO_WINDOW_TITLE_TOKEN`
- `AMO_WINDOW_PID`
- `AMO_WINDOW_HWND`
- `AMO_WINDOW_TITLE_CONTAINS`

Implementation guardrails:

- If any `AMO_WINDOW_*` override is provided, the adapter does not mix in ancestor-process autodetection.
- If `AMO_WINDOW_PID` or `AMO_WINDOW_HWND` is provided, exact-handle routing should not be polluted by an auto-generated process or title token unless the caller explicitly supplies those fields too.
- `titleToken` remains the portable default contract when no explicit exact-handle override is supplied.

The adapter should not parse terminal screen text. It should receive hook JSON, normalize it, and POST a small event to:

```text
POST http://127.0.0.1:17654/api/events
```

## Official Sources Checked

Verified from official documentation on 2026-05-07:

- Codex Hooks: https://developers.openai.com/codex/hooks
- Codex Config Reference: https://developers.openai.com/codex/config-reference
- Claude Code Hooks: https://code.claude.com/docs/en/hooks
- Kiro CLI Hooks: https://kiro.dev/docs/cli/hooks/
- Kiro ACP: https://kiro.dev/docs/cli/acp/
- Kiro IDE Hooks: https://kiro.dev/docs/hooks/

## Capability Matrix

| Tool | Event source | session id | cwd | event name | transcript/log path | permission/waiting signal | window hint |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Codex | Lifecycle hooks | Yes, `session_id` | Yes, `cwd` | Yes, `hook_event_name` | Yes, `transcript_path` can be string or null | Yes for `PermissionRequest`; partial for active/running via prompt/tool/stop events | No native window handle. Derive from tool + cwd + terminal title convention |
| Codex | `notify` config | Partial, payload shape is narrower than hooks | Not enough for MVP by itself | Notification type only | Not enough for MVP by itself | Completion only | No |
| Claude | Hooks | Yes, `session_id` | Yes, `cwd` | Yes, `hook_event_name` | Yes, `transcript_path` | Yes: `PermissionRequest`, `Notification` with `notification_type`, `StopFailure`, `Elicitation`; `permission_mode` is also present on many events | No native window handle. Derive from tool + cwd + terminal title convention |
| Claude | HTTP hooks | Same input as command hooks | Same | Same | Same | Same | No |
| Kiro CLI | CLI hooks | Yes, `session_id` | Yes, `cwd` | Yes, `hook_event_name` | No transcript path in hook examples | PreToolUse exit code 2 can block; no documented permission prompt event in CLI hook page | No native window handle. Derive from `kiro-cli` + cwd/title |
| Kiro ACP | JSON-RPC session protocol | Yes for ACP sessions (`sessionId`) | Yes at `session/new` | Yes for ACP methods and `session/notification` update types | Yes for persisted session/event files under `~/.kiro/sessions/cli/` | ToolCall status and TurnEnd are available; permission semantics need live verification | If Overlay starts/owns ACP process, it can keep process/window metadata |
| Kiro IDE hooks | IDE Agent Hooks | Pending exact payload verification | Likely, but not documented in the overview page | Event trigger names in UI | Not verified | Hooks cover prompt submit, turn completion, pre/post tool use, and spec task events | IDE window title/process matching only |

## Codex Findings

Status: verified from official docs; not live-tested against a real Codex hook in this task.

Codex lifecycle hooks are behind:

```toml
[features]
codex_hooks = true
```

Codex looks for hooks in config layers such as:

- `~/.codex/hooks.json`
- `~/.codex/config.toml`
- `<repo>/.codex/hooks.json`
- `<repo>/.codex/config.toml`

Important operational notes:

- Project-local hooks only load when the project `.codex/` layer is trusted.
- Multiple matching command hooks for the same event run concurrently.
- Command hooks receive one JSON object on `stdin`.
- Hook commands run with the session `cwd` as their working directory.
- The common input fields include `session_id`, `transcript_path`, `cwd`, `hook_event_name`, and `model`.
- Turn-scoped hooks also include `turn_id`.

Useful Codex events:

- `SessionStart`: session starts, resumes, or clears.
- `UserPromptSubmit`: user submits prompt.
- `PreToolUse`: before supported Bash / apply_patch / MCP tools.
- `PermissionRequest`: Codex is about to ask for approval.
- `PostToolUse`: after supported tool use.
- `Stop`: turn stops and latest assistant message can be available.

Codex state mapping:

| Codex event | Recommended state |
| --- | --- |
| `SessionStart` | `starting` |
| `UserPromptSubmit` | `running` |
| `PreToolUse` | `running` |
| `PermissionRequest` | `waiting_permission` |
| `PostToolUse` | `running` |
| `Stop` | `idle` |

Codex gaps:

- No native window handle or terminal window id in hook input.
- `transcript_path` can be null.
- Hooks are turn/tool lifecycle events, not a full process monitor.
- Permission waiting can be seen at `PermissionRequest`, but generic "waiting for user text input" is best inferred from `Stop`/idle and elapsed time.

## Claude Findings

Status: verified from official docs; not live-tested against a real Claude hook in this task.

Claude Code hooks can be command, HTTP, MCP tool, prompt, or agent hooks. Command hooks receive JSON on stdin; HTTP hooks receive the same JSON as POST body.

Official hook locations include:

- `~/.claude/settings.json`
- `.claude/settings.json`
- `.claude/settings.local.json`
- managed policy settings
- plugin hooks
- skill or agent frontmatter

Common fields shown in event examples include:

- `session_id`
- `transcript_path`
- `cwd`
- `permission_mode` on many interactive events
- `hook_event_name`

Useful Claude events:

- `SessionStart`
- `UserPromptSubmit`
- `PreToolUse`
- `PermissionRequest`
- `PostToolUse`
- `PostToolUseFailure`
- `Notification`
- `Stop`
- `StopFailure`
- `CwdChanged`
- `SessionEnd`
- `Elicitation` / `ElicitationResult` for MCP user input flows

Claude state mapping:

| Claude event | Recommended state |
| --- | --- |
| `SessionStart` | `starting` |
| `UserPromptSubmit` | `running` |
| `PreToolUse` | `running` |
| `PermissionRequest` | `waiting_permission` |
| `Notification` + `notification_type=permission_prompt` | `waiting_permission` |
| `Notification` + `notification_type=idle_prompt` | `waiting_user` |
| `Elicitation` | `waiting_user` |
| `PostToolUse` | `running` |
| `PostToolUseFailure` | `running` with error in `lastMessage` |
| `Stop` | `idle` |
| `StopFailure` | `failed` |
| `SessionEnd` | `completed` |
| `CwdChanged` | keep current state; update cwd |

Claude gaps:

- No native window handle in hook input.
- Some events can alter agent behavior if the hook prints stdout or returns control JSON. The monitor adapter should exit 0 with no stdout for observability-only use.
- HTTP hooks are attractive later because they avoid local script path management, but command hooks are easier to share as examples and keep broker auth local-only.

## Kiro Findings

Status: verified from official docs at documentation level; Kiro CLI/IDE not live-tested in this task.

Kiro has three relevant routes.

### Route 1: Kiro CLI Hooks

Kiro CLI hooks receive JSON on stdin. Official examples include:

```json
{
  "hook_event_name": "agentSpawn",
  "cwd": "/current/working/directory",
  "session_id": "abc123-def456-789"
}
```

Tool events add:

- `tool_name`
- `tool_input`
- `tool_response` for `postToolUse`

Useful Kiro CLI hook events:

- `agentSpawn`
- `userPromptSubmit`
- `preToolUse`
- `postToolUse`
- `stop`

Kiro CLI state mapping:

| Kiro CLI event | Recommended state |
| --- | --- |
| `agentSpawn` | `starting` |
| `userPromptSubmit` | `running` |
| `preToolUse` | `running` |
| `postToolUse` | `running` |
| `stop` | `idle` |

Gaps:

- CLI hook examples do not include transcript path or log path.
- CLI hook docs do not show a dedicated permission prompt event.
- Waiting status may need inference or ACP/tool status, not hooks alone.

### Route 2: Kiro ACP

Kiro CLI implements ACP over JSON-RPC stdio via:

```text
kiro-cli acp
```

ACP supports:

- `initialize`
- `session/new`
- `session/load`
- `session/prompt`
- `session/cancel`
- `session/set_mode`
- `session/set_model`

ACP sends session updates through `session/notification`, including:

- `AgentMessageChunk`
- `ToolCall`
- `ToolCallUpdate`
- `TurnEnd`

ACP sessions are persisted under:

```text
~/.kiro/sessions/cli/
```

with:

- `<session-id>.json`
- `<session-id>.jsonl`

Recommendation:

- Use CLI hooks for the first read-only monitor because they fit the existing broker adapter shape.
- Use ACP later if Agent Monitor Overlay becomes the launcher/controller for Kiro sessions. ACP gives better structured streaming and cancellation, but it changes the product from "monitor existing sessions" toward "host controlled sessions".

### Route 3: Kiro IDE Agent Hooks

Kiro IDE supports agent hooks for:

- saving, creating, or deleting files
- user prompt submission and agent turn completion
- before or after tool invocations
- before or after spec task execution
- manual triggers

Recommendation:

- Treat IDE hooks as the likely best route for observing Kiro IDE sessions.
- This needs a live IDE verification task because the overview page does not expose the exact JSON payload shape, session id field name, or transcript/log file path.

## Unified Payload Draft

Adapters should POST this normalized payload to the broker:

```json
{
  "schemaVersion": 1,
  "tool": "codex",
  "source": "hook",
  "sessionId": "abc123",
  "cwd": "G:\\PROJECT\\Example",
  "eventName": "PermissionRequest",
  "state": "waiting_permission",
  "needsAttention": true,
  "transcriptPath": null,
  "logPath": null,
  "turnId": "turn-123",
  "toolName": "Bash",
  "lastMessage": "Approval requested: run tests with network access",
  "windowHint": {
    "process": "WindowsTerminal.exe",
    "titleToken": "[AMO:codex:example:turn-123]",
    "titleContains": ["Codex", "Example"],
    "project": "Example",
    "cwd": "G:\\PROJECT\\Example"
  },
  "raw": {
    "redacted": true
  },
  "observedAt": "2026-05-07T12:00:00+08:00"
}
```

Field notes:

- `sessionId`: use the tool-provided id. If missing, adapter may derive `tool + cwd + process start bucket`, but that should be marked as inferred.
- `cwd`: canonical current working directory from hook payload.
- `eventName`: original hook event name, not normalized.
- `state`: broker-friendly state enum: `starting`, `running`, `waiting_permission`, `waiting_user`, `idle`, `completed`, `failed`, `cancelled`, `unknown`.
- `needsAttention`: true for permission prompts, idle prompts, elicitation/user-input waits, failures, and stale sessions if broker adds a timeout rule.
- `transcriptPath` / `logPath`: path only, never file contents.
- `raw`: optional, redacted. Do not store full prompts, tool output, command output, transcript bodies, secrets, or sensitive paths in repo examples.
- `windowHint`: advisory only. Final window activation belongs to the window-routing worker.

## Adapter Examples

This task adds:

- `examples/hooks/codex-hooks.example.json`
- `examples/hooks/claude-settings.example.json`
- `scripts/adapters/Send-AgentMonitorEvent.ps1`

The examples are intentionally not placed under `.codex/`, `.claude/`, `~/.codex/`, or `~/.claude/` so they cannot affect real sessions until a user deliberately installs them.

## Local Verification Performed

Performed in this task:

- Read required project documents.
- Checked official docs listed above.
- Checked local `codex --help`, `codex hooks --help`, `codex debug --help`, `codex features list`, and `codex app-server --help` without changing config. In this environment `codex_hooks` is listed as `stable true`; `codex hooks --help` falls through to general help, so hook behavior was not live-executed.
- Added a local PowerShell adapter script that can be syntax-checked and dry-run with sample stdin.
- Supervisor added `scripts/adapters/verify.ps1`, which posts representative Codex / Claude / Kiro hook payloads through the adapter script into broker and asserts expected session states.

Not performed:

- No real Codex / Claude / Kiro global config was modified.
- No real transcript or log files were read.
- No real hook was installed or fired in a live agent session.
- No Kiro CLI/IDE was launched.

Follow-up live smoke:

- Claude: disposable explicit-settings smoke completed and delivered real `UserPromptSubmit` / `Stop` hook events into broker.
- Codex: current provider configuration works when inherited from the real Codex environment, but project-local `.codex/hooks.json` did not load in the disposable smoke test. A temporary `CODEX_HOME` with only copied `config.toml` / `auth.json` is insufficient for this Codex install. Codex live hook verification still needs either a supported per-process hook injection route or a carefully installed/restored real `CODEX_HOME` user-layer hook.

## Current Repo-Local Hook Smoke Status

As of 2026-05-11, the active workspace has moved beyond the earlier "hooks do not load at all" assumption.

Current state:

- the main repo now contains `.codex/config.toml`, `.codex/hooks.json`, and `.codex/hooks/codex-lifecycle-hook.ps1`
- the current wrapper performs a direct POST to the broker and exits `0`
- broker has received at least some real Codex events in disposable smoke attempts, including `SessionStart` and `UserPromptSubmit`
- Codex can still report hook failure or timeout noise in the interactive session even when broker delivery succeeds

Interpretation:

- repo-local hook discovery is no longer the main open question
- adapter -> broker contract failure is no longer the main open question
- the remaining issue is the hook runner path itself: timing, stdout/stderr cleanliness, wrapper latency, or some interactive-session-specific condition

Practical recommendation:

- keep the first `/hooks` review and smoke round in a disposable sibling repo or test project before treating the main repo as the primary validation target
- treat "broker received the event" and "Codex hook runner completed cleanly" as separate acceptance checks

## Live Verification Steps For Supervisor

Codex:

1. Start broker locally.
2. Set `AGENT_MONITOR_OVERLAY_HOME` to this repo path in the terminal that will launch Codex.
3. Copy `examples/hooks/codex-hooks.example.json` to a disposable test repo's `.codex/hooks.json`.
4. Enable `codex_hooks = true` in that disposable test repo's `.codex/config.toml`.
5. Trust that `.codex` layer if Codex prompts.
6. Run Codex in the disposable repo and submit a small prompt.
7. Confirm broker receives `SessionStart`, `UserPromptSubmit`, tool events, and `Stop`.
8. Trigger a permission request and confirm `waiting_permission`.
9. Record separately whether Codex still prints hook failure or timeout noise even if broker delivery succeeds.

Claude:

1. Start broker locally.
2. Set `AGENT_MONITOR_OVERLAY_HOME` to this repo path in the terminal that will launch Claude Code.
3. Copy `examples/hooks/claude-settings.example.json` into a disposable test repo as `.claude/settings.local.json`.
4. Run Claude Code in that repo and submit a small prompt.
5. Confirm broker receives session/prompt/tool/stop events.
6. Trigger permission and idle notifications; confirm `waiting_permission` and `waiting_user`.

Kiro:

1. For CLI hooks, create a disposable Kiro agent configuration using the same adapter command and confirm `agentSpawn`, `userPromptSubmit`, `preToolUse`, `postToolUse`, and `stop` payloads.
2. For ACP, run `kiro-cli acp` under a thin test harness and inspect `session/new`, `session/notification`, and persisted files under `~/.kiro/sessions/cli/`.
3. For IDE hooks, create a temporary hook from the Kiro Hook UI that runs a local capture command; inspect exact JSON payload shape.

## Risks And Open Questions

- Need a supervisor decision on whether MVP adapter installation should be project-local per workspace, user-global, or plugin-style.
- Need a privacy decision on whether broker should store transcript/log paths at all. They are useful for "open transcript" later but can reveal local path structure.
- Need a window-routing decision on title convention, for example `Codex - <project>`, `Claude - <project>`, `Kiro - <project>`.
- Need live verification for Kiro IDE hook payloads; official overview confirms triggers but not exact machine payload fields.
- Need a broker decision on whether `raw` should be accepted. Safer MVP default is to store only normalized fields and drop full raw payloads.
- Need timeout/staleness policy. Hooks can report events, but if a tool process dies without a final hook, broker should mark the session stale after a configured interval.
