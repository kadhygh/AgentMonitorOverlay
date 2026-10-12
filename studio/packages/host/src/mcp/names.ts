// AMO MCP tools that write but only touch the caller's own task (or its mail), so they run without asking the person.
// Shared by the tool definitions and the Codex server config (`tools.<name>.approval_mode = "approve"`).
export const AUTO_APPROVED_WRITE_TOOLS = ["task_note_add", "handoff_submit"] as const;
