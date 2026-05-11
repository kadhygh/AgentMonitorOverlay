# AMO Sync Back Test Plugin

This is a plain CommonJS Obsidian desktop plugin prototype for Task H.

It provides three commands:

- `AMO: Insert Annotation Block`
- `AMO: Summarize Active Note Annotations`
- `AMO: Copy Summary and Focus Target Session`

What it does:

- inserts explicit annotation markers
- parses annotation blocks from the active note
- generates a deterministic Markdown summary
- writes a preview note
- copies the summary to clipboard
- writes a structured sync-back request JSON
- calls a local PowerShell helper that tries to focus the target session window

What it does not do:

- auto-send text
- inject keys
- auto-approve
- modify global Obsidian settings
- depend on npm or a build pipeline

Main files:

- `manifest.json`
- `main.js`
- `syncBackCore.js`
