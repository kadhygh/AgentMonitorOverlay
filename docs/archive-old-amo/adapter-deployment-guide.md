# AMO Adapter Deployment Guide

Updated: 2026-07-08

This guide defines how Agent Monitor Overlay deploys workspace-local adapters and hooks. Deployment should be deterministic, script-driven, and reversible. Do not rely on an LLM to decide which files to write during normal deployment.

## Project Document Mappings

An enrolled workspace may expose selected project documentation folders inside its AMO Obsidian vault. This is a
separate deploy action from CLI adapters and does not change hook or deployment protocol versions.

The deploy window writes mappings below the vault-local `Project/` directory:

```text
<workspace>/.amo/AMO - <project>/Project/AIWork
  -> <workspace>/AIWork

<workspace>/.amo/AMO - <project>/Project/Docs
  -> <workspace>/Docs
```

On Windows these are directory junctions. The source directory remains authoritative: opening or editing a mapped
Markdown file in Obsidian reads and writes the real project file. Removing a mapping deletes only the junction and its
workspace metadata; it must never recursively delete the source directory.

Mapping safety rules:

- the source must be an existing directory inside the selected workspace
- the workspace root itself cannot be mapped
- `.amo` and all descendants cannot be mapped
- a directory containing the AMO vault cannot be mapped, preventing recursive traversal
- a normal file/directory or a junction to another source at the target path is a conflict and is never overwritten
- target names are derived from the selected source directory name and live directly under `Project/`

Workspace Check reports configured mappings only. Every source directory must be selected or entered explicitly; AMO
does not infer mappings from conventional folder names such as `AIWork` or `Docs`. Mapping metadata is stored in
`.amo/workspace.json` under `documentMappings`. `Clear Generated` preserves `Project/` mappings. The local
`.amo/.gitignore` excludes `AMO - */Project/` so Git does not traverse or record mapped documentation through the vault.

Workspace registry, managed launch identity, Hook Protocol v3, placeholder cards, and Card resume are planned in `docs/workspace-managed-launch-plan.md`. Project-local deployment metadata remains authoritative; the future broker Workspace Registry is only an index of explicitly enrolled projects.

## Goals

- Start from a user-selected project folder.
- Inspect folder state and local tool hints.
- Produce a deployment plan before writing files.
- Install only project-local AMO-owned hook/adapter files after confirmation.
- Create and maintain a project-local `.amo/` folder.
- Support future adapters without changing the core deployment flow.
- Avoid global hook deployment by default.

## Deployment Phases

```text
inspect
  -> plan
  -> apply
  -> health check
  -> update / clean
```

### Inspect

Input:

```json
{
  "workspacePath": "G:\\PROJECT\\SomeProject"
}
```

The inspect step should detect:

- existing `.amo/`
- existing `.codex/`, `.claude/`, or known tool config
- project root indicators such as `.git/`, `package.json`, `pyproject.toml`, `Cargo.toml`
- whether the workspace is writable
- whether AMO-owned files already exist
- whether user-owned hook config would need merging

Inspect must not write files.

### Plan

Output:

```json
{
  "workspacePath": "G:\\PROJECT\\SomeProject",
  "supportedAdapters": [
    {
      "id": "codex-cli",
      "label": "Codex CLI",
      "confidence": "high",
      "status": "available",
      "filesToWrite": [
        ".amo/workspace.json",
        ".amo/hooks/codex-stop-message.mjs",
        ".codex/hooks.json"
      ],
      "filesToMerge": [
        ".codex/hooks.json"
      ],
      "risks": [
        "Project-local Codex hooks may require Codex trust/review in this workspace."
      ]
    }
  ],
  "unsupportedAdapters": [
    {
      "id": "kiro-ide",
      "reason": "Kiro IDE adapter work is dropped from the active roadmap."
    }
  ]
}
```

The plan should be suitable for UI display before the user clicks deploy.

### Apply

Apply should:

- create `.amo/`
- write AMO-owned hook scripts
- merge tool hook config instead of overwriting user-owned config
- back up user-owned files before modification
- record installed adapter metadata in `.amo/enrollment.json`
- create the dedicated AMO vault folder (`.amo/AMO - <project>/` for new deployments)
- install the AMO-owned Obsidian plugin into the project-local vault
- never write global hook config unless a future explicit advanced mode allows it

### Health Check

Health checks should report:

- adapter files exist
- adapter deployment metadata reports the expected `deploymentVersion`
- adapter hook metadata reports the expected `hookProtocolVersion`
- tool hook config contains every expected AMO lifecycle event for that adapter
- tool hook config points to AMO-owned adapter files
- AMO bridge URL is configured
- `workspace.vaultRoot` is present
- `workspace.vaultRoot/.obsidian/plugins/md-anno-tools/` is present and configured
- a dry-run payload can be produced
- known local limitations

The first MVP can use a dry-run rather than starting Codex automatically.

### Workspace Launch Shortcuts

Workspace launch is separate from deployment. Deploy/inspect tells AMO which adapters are installed and launchable; launching a CLI does not by itself create a task card, note, canvas node, or provider session. The hook-created provider session remains the source of truth.

`POST /api/workspaces/launch` may accept:

```json
{
  "workspacePath": "G:\\PROJECT\\SomeProject",
  "adapterId": "claude-cli",
  "sessionName": "Investigate thunder skill"
}
```

Rules:

- `workspacePath` is required and must be the enrolled project folder.
- `adapterId` must be a supported launch id such as `codex-cli`, `claude-cli`, or `codex-app`.
- `sessionName` is optional and only meaningful for adapters with a verified native display-name option.
- If a provider does not support native new-session naming, ignore `sessionName` rather than passing guessed CLI arguments.
- A launch result may report process/window diagnostics, but the first hook event still owns the durable provider `sessionId`.

Current provider behavior:

- `claude-cli`: local CLI help exposes `--name <name>`, so launch may pass `sessionName` as the Claude display name. AMO may also keep a short-lived pending display-name hint and apply it as card `taskTitle` when the first matching hook-created Claude session arrives.
- `codex-cli`: local CLI help does not expose a verified new-session name option. Do not pass `--name` or similar guessed arguments. Launch plain `codex` in the project folder and let the user rename the AMO task card after the real session appears.
- `codex-app`: launch/open behavior is app-specific and should not reuse CLI naming assumptions.

Pending launch names are UI labels only. They must not become identity keys, must expire, and must not override an existing provider session title or user-edited AMO task title without explicit user action.

### Deployment And Hook Versions

AMO tracks deployment state separately from the Obsidian plugin version. The vault-local `md-anno-tools` version only describes the Obsidian-side note/canvas/panel behavior. CLI/TUI hook freshness is tracked by AMO deployment metadata.

Current deployment metadata:

- `deploymentVersion: 2`: the current workspace adapter deployment package version.
- `hookProtocolVersion: 2`: the current hook-to-broker event protocol.
- `hookEvents`: the lifecycle events the deployed adapter is expected to send.

Workspace deploy writes these fields to `.amo/workspace.json`, `.amo/enrollment.json`, and each `.amo/adapters/<adapter-id>.json`. Workspace inspect also checks the actual merged hook file (`.codex/hooks.json` or `.claude/settings.local.json`) for all expected AMO events. If adapter metadata is missing, stale, or the merged hook config lacks a required event such as `PreToolUse`, the adapter should inspect as `needs-update` rather than `deployed`.

`Deploy Selected` is allowed to repair a `needs-update` adapter. Up-to-date adapters are not selected by default, but their individual `Update` action can still force a redeploy of that adapter.

### Update And Clean

Update should re-run inspect and apply only missing or stale AMO-owned pieces. It is the current repair path.

Clean should remove generated vault content and derived AMO state while preserving workspace enrollment, adapters, hooks, and user-owned configuration.

Full deployment history, disable, and uninstall flows are not planned for the current MVP. Reintroduce them only if real project usage shows that update and clean are not enough.

## `.amo/` Directory

Recommended shape:

```text
.amo/
  workspace.json
  enrollment.json
  adapters/
    codex-cli.json
    claude-cli.json
  hooks/
    codex-stop-message.mjs
  state/
    sessions.json
    bindings.json
    pending-replies.json
  AMO - <project>/
    Sessions/
      <session-id>/
        session.json
        turns/
          generated/
    Canvases/
      AgentFlow.base.canvas
      Work/
    .obsidian/
      community-plugins.json
      plugins/
        md-anno-tools/
          manifest.json
          main.js
          styles.css
          data.json
  logs/
    hook-errors.log
    bridge-events.log
```

Generated state, logs, and vault content should not be committed accidentally. AMO should add or suggest ignore rules for `.amo/state/`, `.amo/logs/`, generated session notes, and the base canvas.

Session layout v2 is the active target for generated vault content. New generated notes go under `AMO - <project>/Sessions/<session-id>/turns/generated/`, the base raw flow lives at `AMO - <project>/Canvases/AgentFlow.base.canvas`, and future human-organized work canvases live under `AMO - <project>/Canvases/Work/`. The flat `Replies/`, `Prompts/`, and root `AgentFlow.canvas` shape is compatibility cleanup for old test deployments only.

## Adapter Contract

Each adapter definition should provide:

- `id`: stable id, for example `codex-cli`.
- `label`: UI label.
- `detect(workspacePath)`: returns confidence and evidence.
- `plan(workspacePath)`: returns files to write, merge, back up, and risks.
- `apply(plan)`: writes AMO-owned files and merges config.
- `healthCheck(workspacePath)`: verifies installed state.
- `disable(workspacePath)`: disables without deleting user content.
- `uninstall(workspacePath)`: removes AMO-owned files and config entries.
- `payloadContract`: JSON schema or example payload sent to AMO bridge.
- `limitations`: known missing fields such as reply capture, PID/HWND, or session id.

## Initial Adapter Scope

### `codex-cli`

MVP status: implemented for workspace-local prompt/reply/permission/tool lifecycle hook capture, plus transcript-assisted interrupt detection.

Expected deployment:

- create `.amo/hooks/codex-stop-message.mjs`
- merge `.codex/hooks.json`
- keep `.codex/cache/` only when broker debug is enabled or bridge delivery fails
- offer a local `.git/info/exclude` update for `.amo/`, `.codex/cache/`, and `.codex/hooks.json`
- POST `prompt` from `UserPromptSubmit` to `POST /api/prompts`
- POST `last_assistant_message` from `Stop` to `POST /api/replies`
- POST `SessionStart`, `PermissionRequest`, `PreToolUse`, and `PostToolUse` as event-only payloads to `POST /api/events`
- use `PreToolUse` / `PostToolUse` events to clear stale permission attention and mark the card `running` after a user handles a request
- while a Codex session is active, tail only newly appended transcript JSONL rows and map `event_msg.payload.type=turn_aborted` to card state `cancelled`
- never use transcript content to create notes, prompts, replies, or Canvas nodes; transcript observation is a narrow status fallback because Codex does not emit `Stop` for an interrupted turn
- keep hook stdout protocol-clean with `{"continue":true}`

Known risks:

- Codex project-local hook trust/review behavior needs local smoke validation per enrolled workspace.
- Hook payload does not provide a native window handle.
- `transcript_path` and its JSONL shape are not a stable public hook contract. AMO therefore token-filters for `turn_aborted`, validates the exact row shape, starts at EOF, and ignores unknown rows.

### `codex-app` (ChatGPT desktop compatibility ID)

MVP status: accepted as the current app target provider.

Current route:

- use explicit target binding/opening instead of assuming Codex CLI hook files apply to ChatGPT desktop
- keep ChatGPT desktop as a launch/focus target for sessions where that workflow is more convenient than CLI
- keep `codex-app`, `codex-app-thread`, and `codex://` as compatibility identifiers even though the user-facing product name is ChatGPT
- open a project with `codex://threads/new?path=<absolute-workspace-path>` and an existing task with `codex://threads/<session-id>`
- do not require ChatGPT desktop to produce the same hook payloads as Codex CLI before treating it as useful

### `claude-cli`

MVP status: implemented for workspace-local prompt/reply/permission/tool lifecycle hook capture.

Expected deployment:

- create `.amo/hooks/claude-message.mjs`
- create `.amo/adapters/claude-cli.json`
- merge `.claude/settings.local.json`
- keep fallback cache under `.amo/logs/claude-cache/` only when broker debug is enabled or bridge delivery fails
- offer a local `.git/info/exclude` update for `.amo/`; `.claude/settings.local.json` is opt-in because teams may intentionally version other `.claude` files
- POST `prompt` from `UserPromptSubmit` to `POST /api/prompts`
- POST `last_assistant_message` from `Stop` to `POST /api/replies`
- POST `SessionStart`, `PermissionRequest`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `StopFailure`, `SessionEnd`, `Elicitation`, and `ElicitationResult` as event-only payloads to `POST /api/events`
- listen to `Notification` only for `permission_prompt`; normal idle/auth/background notifications are intentionally excluded because `Stop`, `StopFailure`, and explicit user-input hooks already own those card transitions
- use `PreToolUse` / `PostToolUse` events to clear stale permission attention and mark the card `running` after a user handles a request
- keep hook stdout protocol-clean with JSON only, so `UserPromptSubmit` does not inject AMO text into Claude context

Known risks:

- Claude Code may require `/hooks` review before first use in a workspace.
- Hook payload does not provide a native window handle.
- `.claude/settings.local.json` is local machine configuration and should not be committed.

### `kiro-ide`

MVP status: dropped from the active roadmap.

Decision:

- Do not spend current MVP time on a Kiro adapter.
- Reconsider only if a real workflow needs Kiro-specific hook payloads or window routing.

## Window Binding Rule

Adapter payloads may include `windowHint`, but they must not put arbitrary process ids into `windowHint.pid`.

Valid `windowHint.pid` means a verified visible-window owner process id. Hook runner PID, CLI child PID, or short-lived script PID should go into diagnostic `processInfo`, not into `windowHint.pid`.

```json
{
  "windowHint": {
    "pid": null,
    "hwnd": null,
    "titleToken": "[AMO:codex:some-project:session]",
    "cwd": "G:\\PROJECT\\SomeProject"
  },
  "processInfo": {
    "cliPid": null,
    "hookRunnerPid": null
  }
}
```

The overlay can still resolve a window by title token, title contains, process name, project name, or user-assisted binding.
