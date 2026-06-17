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

export type AgentTool = "codex" | "codex-cli" | "codex-app" | "claude" | "claude-cli" | "kiro" | "kiro-ide" | "other";

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

export type TargetBindingType = "window" | "codex-app-thread";

export interface TargetBinding {
  type: TargetBindingType;
  label?: string | null;
  boundAt?: string | null;
  boundBy?: string | null;
  hwnd?: number | null;
  processId?: number | null;
  processName?: string | null;
  title?: string | null;
  threadId?: string | null;
  uri?: string | null;
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
  targetBinding?: TargetBinding | null;
  workspaceId?: string;
  workspacePath?: string;
  vaultRoot?: string;
  lastReplyAt?: string;
  lastReplyNote?: string;
  lastReplyNoteAbsolutePath?: string;
  lastPromptAt?: string;
  lastPromptNote?: string;
  lastPromptNoteAbsolutePath?: string;
  lastPromptCanvasNodeId?: string;
  sentPromptId?: string | null;
  sentPromptNote?: string | null;
  sentPromptNoteAbsolutePath?: string | null;
  sentPromptCanvasNodeId?: string | null;
  sentPromptRecordedAt?: string | null;
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
  dismissedAt?: string | null;
  dismissReason?: string | null;
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
  runtimeConfigPath?: string | null;
  runtimeConfigExists?: boolean;
  obsidianProcessCount?: number | null;
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

export interface BrokerDebugEntry {
  id: string;
  at: string;
  source: string;
  event: string;
  message?: string | null;
  data?: unknown;
}

export interface BrokerDebugStatus {
  ok: boolean;
  enabled: boolean;
  maxEntries: number;
  count: number;
  entries?: BrokerDebugEntry[];
}

export interface WorkspaceAdapterPlan {
  id: string;
  label: string;
  status: string;
  deploymentStatus?: string;
  workspaceState?: string;
  deployable?: boolean;
  recommended?: boolean;
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

export interface WorkspaceLaunchResult {
  ok: boolean;
  schemaVersion: number;
  workspaceId: string;
  workspacePath: string;
  adapterId: string;
  projectName: string;
  launchedAt: string;
  pid?: number | null;
  command?: string;
  args?: string[];
  message: string;
}

export interface WorkspaceMaintenanceStatus {
  ok: boolean;
  schemaVersion: number;
  workspaceId: string;
  workspacePath: string;
  projectName: string;
  amoRoot: string;
  vaultRoot: string;
  paths: {
    workspace: string;
    amoRoot: string;
    vaultRoot: string;
    replies: string;
    prompts: string;
    canvas: string;
    plugin: string;
  };
  exists: {
    amoRoot: boolean;
    workspaceJson: boolean;
    vaultRoot: boolean;
    replies: boolean;
    prompts: boolean;
    canvas: boolean;
    plugin: boolean;
  };
  counts: {
    replyNotes: number;
    promptNotes: number;
    canvasNodes: number;
    canvasEdges: number;
  };
  canvas: {
    exists: boolean;
    readable: boolean;
    amoManaged: boolean;
    nodeCount: number;
    edgeCount: number;
    marker?: {
      schemaVersion?: number | null;
      canvasType?: string | null;
      managedBy?: string | null;
      workspaceId?: string | null;
      labelMode?: string | null;
      hidePropertiesByDefault?: boolean | null;
    } | null;
  };
  pluginHealth?: ObsidianPluginHealth;
  issues: string[];
  checkedAt: string;
}

export interface WorkspaceCleanResult {
  ok: boolean;
  schemaVersion: number;
  workspacePath: string;
  vaultRoot: string;
  clearedSessions: number;
  before: WorkspaceMaintenanceStatus;
  after: WorkspaceMaintenanceStatus;
}
