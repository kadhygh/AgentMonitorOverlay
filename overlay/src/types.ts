export type SessionState =
  | "starting"
  | "running"
  | "waiting_permission"
  | "waiting_user"
  | "idle"
  | "completed"
  | "failed"
  | "cancelled"
  | "unknown";

export type AgentTool = "codex" | "claude" | "kiro" | "other";

export interface WindowHint {
  process?: string;
  title?: string;
  titleToken?: string;
  titleContains?: string[];
  project?: string;
  cwd?: string;
  tool?: AgentTool;
  pid?: number | null;
  hwnd?: number | null;
}

export interface AgentSession {
  tool: AgentTool;
  sessionId: string;
  cwd: string;
  title: string;
  state: SessionState;
  lastEvent: string;
  lastMessage: string;
  needsAttention: boolean;
  windowHint?: WindowHint;
  updatedAt: string;
}

export interface ActivationResult {
  ok: boolean;
  message: string;
}
