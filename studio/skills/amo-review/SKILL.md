---
name: amo-review
description: Open AMO Studio's file reviewer or Git Review for a person to inspect a specified file, saved edits, or a commit range, with comments directed back to the AMO conversation. Use when asked to open or show work in AMO's reviewer.
---

# Open the AMO reviewer

Use the connected AMO MCP tool `review_open` (some clients prefix it with the server name `amo`). It opens the existing review UI; it does not run an AI code review or approve changes.

- Current file, including unchanged files or a project without Git: `{ "mode": "file", "file": "src/example.ts", "line": 24, "endLine": 36 }`. Line numbers start at 1 and are optional.
- Saved edits to a file: `{ "mode": "changes", "file": "src/example.ts" }`. This compares the working tree with HEAD, including staged, unstaged and untracked files. Omit `file` to review the project.
- Working tree against another ref: `{ "file": "src/example.ts", "base": "main" }`. Comments are supported.
- Committed changes: `{ "commit": "HEAD~1", "file": "src/example.ts" }` or `{ "range": "main...feature", "file": "src/example.ts" }`. These views are read-only. `A..B` compares B with A; `A...B` compares B with its merge base with A. `range` cannot be combined with `base` or `commit`.

The current AMO session supplies the project and comment recipient. For another registered project, provide `workspaceId` from AMO's project context. A topic session without a project needs an explicit workspace. Paths can be project-relative or absolute inside that project. Do not supply a session id to the MCP tool.

Save requested edits before opening. Calling again rereads the saved file or Git changes. If the requested file has no changes in the selected range, use file mode when the person wants to see its current content. A deleted file can be reviewed in changes mode.

An accepted request means Studio has been asked to open the reviewer. Describe the file and comparison requested; do not claim the person has reviewed, approved, or sent comments. The person chooses when to send comments back. If Studio has no open window, report the tool's error and ask them to start Studio; do not restart their sessions.

## External harness fallback

When the AMO MCP tool is unavailable but the Studio installation is known, use its CLI:

```powershell
node '<studio>/scripts/amo-review.mjs' '<project>' --mode file --file 'src/example.ts' --line 24 --end-line 36 --data '<studio-data>' --json
node '<studio>/scripts/amo-review.mjs' '<project>' --file 'src/example.ts' --base main --data '<studio-data>' --json
```

`--data` selects that running instance's data directory (development default: `<studio>/.data`; environment override: `AMO_STUDIO_DATA_DIR`). Add `--session` only when the receiving AMO session id is known. Let the CLI read its local authentication files; never print tokens. Exit 0: request accepted; 1: refused/invalid arguments; 2: Studio unavailable. Refine a refused request using its error; do not repeatedly retry an unchanged request.
