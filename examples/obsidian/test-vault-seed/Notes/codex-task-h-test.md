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

# Codex Task H Test

This note is the disposable seed for the sync-back bridge spike.

## Review Notes

<!-- AMO:ANNOTATION:BEGIN {"id":"ann-20260511-001","kind":"question","priority":"high"} -->
Need the bridge to send a concise summary back to the task-h Codex window instead of the raw notes.
<!-- AMO:ANNOTATION:END -->

<!-- AMO:ANNOTATION:BEGIN {"id":"ann-20260511-002","kind":"todo","priority":"normal"} -->
Keep the first version strictly on copy plus focus plus manual send. Do not inject keys into the terminal.
<!-- AMO:ANNOTATION:END -->

<!-- AMO:ANNOTATION:BEGIN {"id":"ann-20260511-003","kind":"risk","priority":"high"} -->
If the target window is ambiguous, the helper must refuse to choose silently.
<!-- AMO:ANNOTATION:END -->

<!-- AMO:ANNOTATION:BEGIN {"id":"ann-20260511-004","kind":"decision","priority":"normal"} -->
Use explicit frontmatter binding so the note always points at a known target session id and tool.
<!-- AMO:ANNOTATION:END -->
