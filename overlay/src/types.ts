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
  boundAt?: string | null;
  boundBy?: string | null;
  boundLabel?: string | null;
}

export type ObsidianPluginHealthStatus = "ok" | "warning" | "missing" | "unknown";

export interface ObsidianPluginHealth {
  ok: boolean;
  status: ObsidianPluginHealthStatus;
  pluginId: string;
  vaultRoot?: string | null;
  installed?: boolean;
  enabled?: boolean;
  expectedVersion?: string | null;
  installedVersion?: string | null;
  expectedBridgeUrl?: string | null;
  dataBridgeUrl?: string | null;
  mainJsExists?: boolean;
  issues?: string[];
  checkedAt?: string;
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
  pendingPromptId?: string;
  pendingPrompt?: string;
  pendingPromptCreatedAt?: string;
  pendingPromptCopiedAt?: string | null;
  pendingAnnotationCount?: number;
  pendingAnnotationSource?: {
    source?: string | null;
    vaultRoot?: string | null;
    notePath?: string | null;
    turnId?: string | null;
  };
  obsidianPluginHealth?: ObsidianPluginHealth;
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

export interface ObsidianVaultRegistrationResult {
  ok: boolean;
  vaultRoot: string;
  vaultId: string;
  registryPath: string;
  alreadyRegistered: boolean;
  changed: boolean;
}

export interface FolderPickResult {
  ok: boolean;
  cancelled: boolean;
  path?: string | null;
  message: string;
}

export interface BrokerEnsureResult {
  ok: boolean;
  started: boolean;
  pid?: number | null;
  message: string;
}

export interface WorkspaceAdapterPlan {
  id: string;
  label: string;
  status: string;
  confidence?: string;
  scope?: string;
  reason?: string;
  evidence?: string[];
  directoriesToCreate?: string[];
  filesToWrite?: string[];
  filesToMerge?: string[];
  risks?: string[];
}

export interface WorkspaceInspection {
  schemaVersion: number;
  workspaceId: string;
  workspacePath: string;
  projectName: string;
  existingEnrollment?: boolean;
  deploymentRoot?: string;
  supportedAdapters: WorkspaceAdapterPlan[];
  deferredAdapters?: WorkspaceAdapterPlan[];
}

export interface WorkspaceEnrollment {
  ok: boolean;
  schemaVersion: number;
  workspaceId: string;
  workspacePath: string;
  deploymentRoot: string;
  installedAdapters: string[];
  installedFiles: string[];
  mergedFiles: string[];
  backups: string[];
  vaultRoot: string;
  canvasPath: string;
  deferredAdapters?: WorkspaceAdapterPlan[];
}
