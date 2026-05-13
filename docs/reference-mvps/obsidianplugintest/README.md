# Obsidian Plugin Test MVP Snapshot

Snapshot date: 2026-05-13

Source project:

```text
D:\Projects\CommonProject\obsidianplugintest
```

This folder preserves the useful parts of the external Obsidian MVP that informed the Phase 5 AMO Obsidian Bridge plan. It is a reference snapshot, not the active plugin development workspace.

## Included

### Handoff Docs

```text
handoff/CODEX_REPLY_NOTE_HOOK_INTEGRATION.md
handoff/OBSIDIAN_ANNOTATION_PLUGIN_DEVELOPMENT.md
```

These are the highest-value files. Read them first.

### Codex Stop Hook MVP

```text
codex-hook/hooks.json
codex-hook/hooks/cache-stop-message.mjs
```

Useful confirmed behavior:

- Uses Codex `Stop` hook.
- Reads `last_assistant_message`.
- Caches the assistant reply as Markdown and JSON.
- Writes only `{"continue":true}` to stdout.
- Keeps failure non-blocking for Codex.

Important: `codex-hook/hooks.json` is a snapshot from the source machine and contains an absolute path. Any real project must update the command path before installing it.

### Obsidian Annotation Plugin MVP

```text
plugin/src/main.ts
plugin/styles.css
plugin/manifest.json
plugin/package.json
plugin/package-lock.json
plugin/README.md
plugin/esbuild.config.mjs
plugin/eslint.config.mts
plugin/tsconfig.json
plugin/version-bump.mjs
plugin/versions.json
plugin/gitignore.snapshot
```

Useful confirmed behavior:

- Renders `[!anno]...[/anno]` in Obsidian reading mode.
- Copies annotations from the active note to the clipboard.
- Wraps editor selection in `[!anno]...[/anno]`.
- Appends a new annotation to the current note.

## Excluded

```text
node_modules/
main.js
*.map
.codex/cache/
```

Reasons:

- `node_modules/` is dependency output.
- `main.js` is the Obsidian plugin build artifact.
- `.codex/cache/` is local runtime data containing captured assistant turns.

## How This Feeds AMO

The AMO Phase 5 bridge should reuse the ideas, not blindly copy runtime paths:

1. Keep hooks short and protocol-clean.
2. Keep `.codex/cache/` as a fallback.
3. POST captured replies to AMO bridge `/api/replies`.
4. Keep `[!anno]...[/anno]` as the first annotation format.
5. Add a new Obsidian command later: `Send current note annotations to AMO`.
6. Use overlay for `copy pending prompt + focus target CLI`.

Main AMO design doc:

```text
docs/amo-obsidian-bridge-mvp.md
```
