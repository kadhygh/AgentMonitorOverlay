# Obsidian Sync-Back Bridge Spike

Date: 2026-05-11
Worker: `worker-obsidian-sync-back`
Scope: disposable Obsidian test vault, annotation marker, summary generation, and safe `copy + focus` bridge back to a target AMO session.

## Goal

This spike defines and prototypes the smallest safe bridge from an Obsidian note back to a monitored CLI session.

The first version is intentionally **not** auto-send. It prepares the right text, copies it, focuses the intended target window, and leaves the final paste/send action to the user.

Recommended first path:

```text
annotated note
  -> summarize annotations
  -> copy summary to clipboard
  -> focus target session/window
  -> user manually paste/send
```

## Why This Version Stops At Copy + Focus

The current Agent Monitor Overlay MVP is still a read-only monitor plus click-to-window router. Auto-send would cross into higher-risk control behavior.

Key reasons:

- window focus can fail or be stolen by Windows
- terminal window identity is not the same as live agent input readiness
- multiple sessions can exist for the same tool or project
- multiline paste semantics differ across shell, TUI, and agent prompts
- a wrong target can pollute the wrong session or even land in a shell prompt
- the user still needs one last human check before send

Because of that, the bridge contract in this spike is:

```text
copy + focus + manual send
```

not:

```text
inject keys + auto-enter + auto-approve
```

## Disposable Test Vault

This worktree prepares a disposable vault under:

```text
tmp/obsidian-sync-back-vault
```

It is intentionally local-only and ignored by git. The tracked seed lives under:

```text
examples/obsidian/test-vault-seed/
```

The vault contains:

- one linked note seed
- one local plugin skeleton
- one helper config file

The user can open that vault manually in Obsidian and continue from there.

## Annotation Marker Contract

The spike uses explicit HTML comment markers so annotations stay readable in plain Markdown and do not depend on undocumented Obsidian storage.

Marker shape:

```markdown
<!-- AMO:ANNOTATION:BEGIN {"id":"ann-20260511-001","kind":"question","priority":"high"} -->
Annotation body goes here.
<!-- AMO:ANNOTATION:END -->
```

Rules:

- `BEGIN` must include a JSON object
- `END` must be explicit
- nested annotations are not supported in this spike
- malformed JSON or missing `END` is treated as a hard parse error

Metadata fields used now:

- `id`
- `kind`
- `priority`

Allowed example kinds:

- `note`
- `question`
- `todo`
- `risk`
- `decision`

## Note Binding Contract

The active note declares its target session in frontmatter.

Example:

```yaml
---
amo:
  targetSessionId: codex-agent-monitor-overlay-task-h
  expectedTool: codex
  cwd: D:\Projects\CommonProject\AgentMonitorOverlay
  project: AgentMonitorOverlay
  windowHint:
    titleToken: "[AMO:codex:agent-monitor-overlay:task-h]"
    process: WindowsTerminal.exe
    titleContains:
      - Codex
      - AgentMonitorOverlay
---
```

Minimum required fields for the spike:

- `amo.targetSessionId`
- `amo.expectedTool`

Strongly recommended:

- `amo.cwd`
- `amo.project`
- `amo.windowHint.titleToken`
- `amo.windowHint.process`

This keeps sync-back on the same identity model already used by AMO routing:

- `sessionId`
- `tool`
- `cwd`
- `project`
- `windowHint.pid`
- `windowHint.hwnd`
- `windowHint.titleToken`
- `windowHint.process`

## Summary Output

The plugin generates a deterministic Markdown summary. It does not call an LLM.

Summary content includes:

- source note path
- target session/tool/project/cwd
- total annotation count
- counts by kind
- counts by priority
- normalized item list

The summary is written to:

```text
AMO/SyncBackPreviews/<source-note>-sync-back.md
```

That gives the user a visible review surface before sending anything back.

## Sync-Back Request Payload

The plugin writes a structured request JSON to the vault outbox and then calls a local helper script.

Outbox path:

```text
.amo/sync-back/outbox/
```

Request shape:

```json
{
  "kind": "amo.syncBack.request",
  "version": 1,
  "requestId": "sync-back-...",
  "requestedAt": "2026-05-11T00:00:00.000Z",
  "source": {
    "app": "obsidian",
    "notePath": "Notes/codex-task-h-test.md"
  },
  "target": {
    "sessionId": "codex-agent-monitor-overlay-task-h",
    "expectedTool": "codex",
    "cwd": "D:\\Projects\\CommonProject\\AgentMonitorOverlay",
    "project": "AgentMonitorOverlay",
    "windowHint": {
      "titleToken": "[AMO:codex:agent-monitor-overlay:task-h]",
      "process": "WindowsTerminal.exe",
      "titleContains": ["Codex", "AgentMonitorOverlay"]
    }
  },
  "payload": {
    "format": "markdown",
    "summary": "...",
    "annotationCount": 4,
    "previewNotePath": "AMO/SyncBackPreviews/codex-task-h-test-sync-back.md"
  },
  "requestedAction": "copy_focus_manual_send",
  "safety": {
    "requiresUserConfirmation": true,
    "manualSendRequired": true,
    "allowAutoSend": false
  }
}
```

## Local Helper Flow

Prototype helper script:

```text
scripts/obsidian/Invoke-SyncBackBridge.ps1
```

Its job is limited to:

1. read request JSON
2. optionally query broker `GET /api/sessions`
3. resolve the target session if the broker is live
4. merge request window hints with live session hints
5. attempt layered window resolution
6. optionally activate the resolved window
7. return a structured result

Resolver order:

1. exact `hwnd`
2. exact `pid`
3. `titleToken`
4. `process + titleContains`
5. `process + project/cwd basename`

If more than one candidate remains, the helper returns `ambiguous_target`.
If no candidate exists, it returns `window_not_found`.
If focus fails, it returns `focus_blocked`.

This matches the existing AMO routing philosophy from [docs/window-routing-notes.md](D:/Projects/CommonProject/AgentMonitorOverlay-task-h-sync-back/docs/window-routing-notes.md:49).

## Failure Strategy

| Failure | Response |
| --- | --- |
| missing frontmatter binding | do not build request; show user error |
| malformed annotation marker | do not silently skip; fail summary generation |
| zero annotations | allow summary, but warn user that nothing is annotated |
| broker unavailable | continue with request-local `windowHint` only |
| unknown session id | keep copied text, return `session_not_found` |
| stale/ambiguous window | never choose silently; return structured failure |
| Windows blocks foreground focus | keep copied text, report `focus_blocked` |
| summary too long | still build request, but report warning and keep manual send |

## Auto-Send Upgrade Gate

Before any future auto-send implementation, the system should prove all of the following:

1. target session identity is strong and live, not guessed
2. the target is an agent prompt surface, not just a shell window
3. the tool exposes a supported API or controlled PTY write path
4. multiline send semantics are tool-specific and tested
5. preview + confirm + audit log exist
6. retries cannot duplicate partial sends
7. auto-send is disabled by default and opt-in per tool
8. shell execution and approval are still separate from sync-back

Until those conditions exist, `copy + focus + manual send` remains the correct default.

## Files Added By This Spike

- `docs/obsidian-sync-back-bridge.md`
- `docs/tasks/task-f-obsidian-external-note-jump-spike.md`
- `docs/tasks/task-g-obsidian-plugin-model-spike.md`
- `docs/tasks/task-h-obsidian-sync-back-bridge-spike.md`
- `examples/obsidian/sync-back-request.example.json`
- `examples/obsidian/test-vault-seed/`
- `prototypes/obsidian-sync-back-plugin/`
- `scripts/obsidian/Prepare-SyncBackTestVault.ps1`
- `scripts/obsidian/Invoke-SyncBackBridge.ps1`
- `scripts/obsidian/verify-prototype.js`

## Verification Status

Implemented and expected to be statically verifiable:

- annotation block parser
- summary generator
- request JSON generation
- helper dry-run mode
- disposable vault materialization script

Not verified in this spike:

- actual Obsidian GUI interaction
- manual plugin enable flow inside Obsidian
- successful focus transfer to a real target session from inside Obsidian
- any auto-send or key injection path

## References Checked

- Obsidian developer docs for plugin structure (`manifest.json`, `main.js`) on 2026-05-11
- Obsidian help/docs for URI-based vault open behavior on 2026-05-11

These references informed the prototype shape, but this spike intentionally stops short of GUI validation.
