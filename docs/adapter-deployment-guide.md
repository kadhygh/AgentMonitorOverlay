# AMO Adapter Deployment Guide

Updated: 2026-05-16

This guide defines how Agent Monitor Overlay deploys workspace-local adapters and hooks. Deployment should be deterministic, script-driven, and reversible. Do not rely on an LLM to decide which files to write during normal deployment.

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
  -> repair / disable / uninstall
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
- existing `.codex/`, `.claude/`, `.kiro/`, or known tool config
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
      "reason": "Kiro IDE hook payload and install target still need local verification."
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
- tool hook config points to AMO-owned adapter files
- AMO bridge URL is configured
- `workspace.vaultRoot` is present
- `workspace.vaultRoot/.obsidian/plugins/md-anno-tools/` is present and configured
- a dry-run payload can be produced
- known local limitations

The first MVP can use a dry-run rather than starting Codex automatically.

### Repair, Disable, Uninstall

Repair should re-run inspect and apply only missing or stale AMO-owned pieces.

Disable should leave files in place when possible but stop the adapter from firing.

Uninstall should remove AMO-owned files and remove AMO hook entries from merged user config, preserving backups and user-owned content.

## `.amo/` Directory

Recommended shape:

```text
.amo/
  workspace.json
  enrollment.json
  adapters/
    codex-cli.json
    codex-app.json
    claude-cli.json
    kiro-ide.json
  hooks/
    codex-stop-message.mjs
  state/
    sessions.json
    bindings.json
    pending-replies.json
  AMO - <project>/
    AgentFlow.canvas
    Replies/
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

Generated state, logs, and vault content should not be committed accidentally. AMO should add or suggest ignore rules for `.amo/state/`, `.amo/logs/`, and generated reply content.

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

MVP status: first implementation target.

Expected deployment:

- create `.amo/hooks/codex-stop-message.mjs`
- merge `.codex/hooks.json`
- keep `.codex/cache/` only when broker debug is enabled or bridge delivery fails
- offer a local `.git/info/exclude` update for `.amo/`, `.codex/cache/`, and `.codex/hooks.json`
- POST `last_assistant_message` to `POST /api/replies`
- keep hook stdout protocol-clean with `{"continue":true}`

Known risks:

- Codex project-local hook trust/review behavior needs local smoke validation per enrolled workspace.
- Hook payload does not provide a native window handle.

### `codex-app`

MVP status: deferred.

Expected future route:

- inspect available local app/server integration points
- avoid assuming Codex CLI hook files apply to Codex App
- define its own payload contract

### `claude-cli`

MVP status: implemented for workspace-local prompt/reply/permission hook capture.

Expected deployment:

- create `.amo/hooks/claude-message.mjs`
- create `.amo/adapters/claude-cli.json`
- merge `.claude/settings.local.json`
- keep fallback cache under `.amo/logs/claude-cache/` only when broker debug is enabled or bridge delivery fails
- offer a local `.git/info/exclude` update for `.amo/`; `.claude/settings.local.json` is opt-in because teams may intentionally version other `.claude` files
- POST `prompt` from `UserPromptSubmit` to `POST /api/prompts`
- POST `last_assistant_message` from `Stop` to `POST /api/replies`
- POST `PermissionRequest` as event-only payload to `POST /api/events`
- keep hook stdout protocol-clean with JSON only, so `UserPromptSubmit` does not inject AMO text into Claude context

Known risks:

- Claude Code may require `/hooks` review before first use in a workspace.
- Hook payload does not provide a native window handle.
- `.claude/settings.local.json` is local machine configuration and should not be committed.

### `kiro-ide`

MVP status: deferred.

Expected future route:

- verify IDE hook install target and payload shape
- prefer project-local or workspace-local configuration
- use IDE window/title binding when native handles are unavailable

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
