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
  workspaceId?: string;
  workspacePath?: string;
  vaultRoot?: string;
  lastReplyAt?: string;
  lastReplyNote?: string;
  lastReplyNoteAbsolutePath?: string;
  canvasPath?: string;
  canvasAbsolutePath?: string;
  canvasNodeId?: string;
  updatedAt: string;
}

export interface ActivationCandidate {
  hwnd: number;
  processId: number;
  processName?: string | null;
  title: string;
  label: string;
}

export interface ActivationResult {
  ok: boolean;
  message: string;
  candidates?: ActivationCandidate[];
}

export type OpenPathResult = ActivationResult;
