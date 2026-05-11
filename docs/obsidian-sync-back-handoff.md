# Obsidian Sync-Back Handoff

Date: 2026-05-11
Worktree: `D:\Projects\CommonProject\AgentMonitorOverlay-task-h-sync-back`
Scope: Task H disposable Obsidian vault, annotation summary flow, and safe `copy + focus` sync-back prototype.

## What Exists

This worktree contains a self-contained Task H spike for the future Obsidian workflow sidecar.

Implemented in this worktree:

- a design doc for the bridge contract and safety boundary
- a tracked vault seed
- a local plugin skeleton for Obsidian desktop
- a local PowerShell helper for `copy + focus`
- a static verification script

The first version remains:

```text
annotate -> summarize -> copy -> focus -> manual paste/send
```

It does **not** auto-send or inject keys into a terminal.

## Key Files

- `docs/obsidian-sync-back-bridge.md`
- `docs/tasks/task-h-obsidian-sync-back-bridge-spike.md`
- `examples/obsidian/test-vault-seed/Notes/codex-task-h-test.md`
- `examples/obsidian/sync-back-request.example.json`
- `prototypes/obsidian-sync-back-plugin/manifest.json`
- `prototypes/obsidian-sync-back-plugin/main.js`
- `prototypes/obsidian-sync-back-plugin/syncBackCore.js`
- `scripts/obsidian/Prepare-SyncBackTestVault.ps1`
- `scripts/obsidian/Invoke-SyncBackBridge.ps1`
- `scripts/obsidian/verify-prototype.js`

## Local Disposable Vault

The tracked seed is under:

```text
examples/obsidian/test-vault-seed/
```

The local materialized vault is created under:

```text
tmp/obsidian-sync-back-vault/
```

To recreate it on a new machine:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\obsidian\Prepare-SyncBackTestVault.ps1
```

That script copies:

- the sample note into `tmp/obsidian-sync-back-vault/Notes/`
- the plugin into `tmp/obsidian-sync-back-vault/.obsidian/plugins/amo-sync-back-test/`
- `data.json` pointing at the local helper script

## Plugin Commands

The plugin currently exposes three commands:

1. `AMO: Insert Annotation Block`
2. `AMO: Summarize Active Note Annotations`
3. `AMO: Copy Summary and Focus Target Session`

Expected behavior:

- command 1 inserts a marker-wrapped annotation block
- command 2 parses annotation blocks from the active note and writes a preview summary note
- command 3 also copies the summary, writes a sync-back request JSON, and calls the PowerShell helper

## Annotation Contract

Annotation blocks use explicit HTML comment markers:

```markdown
<!-- AMO:ANNOTATION:BEGIN {"id":"ann-...","kind":"question","priority":"high"} -->
Annotation body
<!-- AMO:ANNOTATION:END -->
```

The parser treats malformed JSON or missing `END` as hard errors.

## Note Binding Contract

The active note uses frontmatter:

```yaml
amo:
  targetSessionId: ...
  expectedTool: ...
  cwd: ...
  project: ...
  windowHint:
    titleToken: ...
    process: ...
    titleContains:
      - ...
```

The target session binding is explicit on purpose. This spike does not allow title-only guessing from note names.

## Helper Behavior

The helper script:

```text
scripts/obsidian/Invoke-SyncBackBridge.ps1
```

does the following:

1. read the sync-back request JSON
2. query broker sessions if broker is live
3. merge request-local hints with live session hints
4. run layered window resolution
5. optionally focus the resolved target window
6. return structured JSON

Resolver order:

1. `hwnd`
2. `pid`
3. `titleToken`
4. `process + titleContains`
5. `process + project`

If target resolution is ambiguous, the helper returns `ambiguous_target` and refuses to choose silently.

## Verification Done

Verified in this worktree:

- `node --check prototypes/obsidian-sync-back-plugin/main.js`
- `node --check prototypes/obsidian-sync-back-plugin/syncBackCore.js`
- `node .\scripts\obsidian\verify-prototype.js`
- `powershell -ExecutionPolicy Bypass -File .\scripts\obsidian\Prepare-SyncBackTestVault.ps1`
- `powershell -ExecutionPolicy Bypass -File .\scripts\obsidian\Invoke-SyncBackBridge.ps1 -RequestPath .\examples\obsidian\sync-back-request.example.json -DryRun`
- `git diff --check`

Important observed result:

- helper dry-run returned `ambiguous_target` on this machine because multiple `WindowsTerminal` windows matched the fallback `process + project` route
- this is the intended safe behavior

## Not Yet Verified

Not verified yet:

- actual Obsidian GUI launch on this machine
- manually enabling the local plugin in Obsidian
- full command palette flow inside Obsidian
- successful focus transfer from inside Obsidian to a real target session
- any auto-send path

## Recommended Next Step On New Device

1. clone or pull this branch
2. run `Prepare-SyncBackTestVault.ps1`
3. open `tmp/obsidian-sync-back-vault` in Obsidian
4. enable local plugin `amo-sync-back-test`
5. open `Notes/codex-task-h-test.md`
6. run the three plugin commands in order
7. report the first real GUI/UX issues back into this spike

## Current Judgment

This spike is ready for human attach-and-continue.

The risky part is no longer the file scaffolding; it is the real Obsidian UX and exact target-window identity during `copy + focus`.
