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

export type AgentTool = "codex" | "codex-cli" | "codex-app" | "claude" | "claude-cli" | "other";

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

export type TargetBindingType = "window" | "codex-app-thread" | "codex-cli-session";

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
  sessionId?: string | null;
  workspacePath?: string | null;
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
  taskTitle?: string | null;
  state: SessionState;
  lastEvent: string;
  lastMessage: string;
  needsAttention: boolean;
  windowHint?: WindowHint;
  targetBinding?: TargetBinding | null;
  workspaceId?: string;
  workspacePath?: string;
  launchId?: string | null;
  launchState?: string | null;
  launchRevision?: number | null;
  launchWindowResolvedAt?: string | null;
  claudeProviderId?: string | null;
  claudeModel?: string | null;
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
  pendingPromptClipboardMode?: "safe" | "raw" | null;
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
  reviewRequired?: boolean;
  reviewStatus?: "pending" | "reviewed" | string | null;
  reviewRequestedAt?: string | null;
  reviewedAt?: string | null;
  reviewedBy?: string | null;
  reviewAction?: string | null;
  reviewTurnId?: string | null;
  reviewNote?: string | null;
  reviewCanvasNodeId?: string | null;
  archivedAt?: string | null;
  archiveReason?: string | null;
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

export interface WindowActivationRequest {
  sessionId: string;
  tool: AgentTool;
  title: string;
  processName: string;
  titleToken: string;
  titleContains: string[];
  project: string;
  cwd: string;
  pid: number | null;
  hwnd: number | null;
}

export interface WindowProbeResult {
  sessionId: string;
  result: ActivationResult;
}

export type OpenPathResult = ActivationResult;

export interface ObsidianVaultRegistrationResult {
  ok: boolean;
  vaultRoot: string;
  vaultId: string;
  registryPath: string;
  runtimeConfigPath?: string | null;
  runtimeConfigExists?: boolean;
  runtimeConfigFileExists?: boolean;
  vaultRuntimeState?: {
    loaded?: boolean;
    evidence?: Array<{
      fileName?: string;
      path?: string;
      exists?: boolean;
      size?: number | null;
      mtime?: string | null;
    }>;
  };
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
  installedDeploymentVersion?: number | null;
  expectedDeploymentVersion?: number;
  installedHookProtocolVersion?: number | null;
  expectedHookProtocolVersion?: number;
  expectedHookEvents?: string[];
  configuredHookEvents?: string[];
  missingHookEvents?: string[];
  deploymentIssues?: string[];
  reason?: string;
  evidence?: string[];
  directoriesToCreate?: string[];
  filesToWrite?: string[];
  filesToMerge?: string[];
  risks?: string[];
}

export interface WorkspaceInspection {
  schemaVersion: number;
  deploymentVersion?: number;
  hookProtocolVersion?: number;
  workspaceId: string;
  workspacePath: string;
  projectName: string;
  existingEnrollment?: boolean;
  deploymentRoot?: string;
  gitExclude?: WorkspaceGitExcludeStatus;
  documentMappings?: WorkspaceDocumentMappingsStatus;
  supportedAdapters: WorkspaceAdapterPlan[];
  deferredAdapters?: WorkspaceAdapterPlan[];
}

export interface WorkspaceEnrollment {
  ok: boolean;
  schemaVersion: number;
  deploymentVersion?: number;
  hookProtocolVersion?: number;
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
  uri?: string | null;
  shell?: string;
  shellFallback?: boolean;
  launchEnvironment?: string | null;
  requestedLaunchEnvironment?: string | null;
  environmentFallback?: boolean;
  claudeProviderId?: string | null;
  claudeProviderLabel?: string | null;
  claudeModel?: string | null;
  windowHint?: WindowHint | null;
  targetBinding?: TargetBinding | null;
  session?: AgentSession | null;
  launch?: ManagedLaunch | null;
  message: string;
}

export interface WorkspaceDocumentMappingEntry {
  label: string;
  sourcePath: string;
  sourceRelativePath: string;
  targetPath: string;
  targetRelativePath: string;
  type: string;
  configured: boolean;
  sourceExists: boolean;
  targetExists: boolean;
  status: "available" | "mapped" | "missing-source" | "missing-target" | "conflict" | string;
  message: string;
}

export interface WorkspaceDocumentMappingsStatus {
  ok: boolean;
  available: boolean;
  projectRoot: string;
  projectRootRelativePath: string;
  mappedCount: number;
  entries: WorkspaceDocumentMappingEntry[];
  message: string;
}

export interface WorkspaceDocumentMappingResult {
  ok: boolean;
  schemaVersion: number;
  changed: boolean;
  workspacePath: string;
  vaultRoot: string;
  documentMappings: WorkspaceDocumentMappingsStatus;
}

export interface CliEnvironmentOption {
  id: "windows-powershell" | "powershell7" | "alacritty-powershell7";
  label: string;
  available: boolean;
  terminal: string;
  shell: string;
  executablePath?: string | null;
  shellPath?: string | null;
  version?: string | null;
  reason?: string | null;
}

export interface CliEnvironmentsResult {
  ok: boolean;
  defaultId: CliEnvironmentOption["id"];
  environments: CliEnvironmentOption[];
}

export interface WorkspaceRegistryEntry {
  workspaceId: string;
  workspacePath: string;
  projectName: string;
  vaultRoot?: string | null;
  adapterIds: string[];
  deploymentVersion?: number | null;
  hookProtocolVersion?: number | null;
  status: "ready" | "unavailable" | "unenrolled" | string;
  available: boolean;
  enrollmentPresent: boolean;
  registeredAt: string;
  updatedAt: string;
}

export interface WorkspaceRegistryResult {
  ok: boolean;
  count: number;
  workspaces: WorkspaceRegistryEntry[];
}

export interface ManagedLaunch {
  launchId: string;
  workspaceId: string;
  workspacePath: string;
  adapterId: string;
  mode: "new" | "resume";
  state: string;
  titleToken: string;
  createdAt: string;
  expiresAt?: string;
  claimedSessionId?: string | null;
  claudeProviderId?: string | null;
  claudeModel?: string | null;
}

export interface WorkspaceGitExcludeEntry {
  pattern: string;
  reason?: string;
  trackedPath?: string;
  trackedPaths?: string[];
}

export interface WorkspaceGitExcludeStatus {
  ok: boolean;
  status: string;
  includeClaudeSettingsLocal?: boolean;
  gitRootPath: string;
  gitDirPath: string;
  excludeFilePath: string;
  workspaceRelativePath: string;
  entries: WorkspaceGitExcludeEntry[];
  missingEntries: WorkspaceGitExcludeEntry[];
  existingEntries: WorkspaceGitExcludeEntry[];
  trackedEntries: WorkspaceGitExcludeEntry[];
  message: string;
}

export interface WorkspaceGitExcludeResult {
  ok: boolean;
  schemaVersion: number;
  changed: boolean;
  includeClaudeSettingsLocal?: boolean;
  workspacePath: string;
  gitRootPath: string;
  gitDirPath: string;
  excludeFilePath: string;
  workspaceRelativePath: string;
  entries: WorkspaceGitExcludeEntry[];
  addedEntries: WorkspaceGitExcludeEntry[];
  existingEntries: WorkspaceGitExcludeEntry[];
  status: WorkspaceGitExcludeStatus;
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
    sessions: string;
    generated: string;
    workCanvases: string;
    replies: string;
    prompts: string;
    canvas: string;
    plugin: string;
  };
  exists: {
    amoRoot: boolean;
    workspaceJson: boolean;
    vaultRoot: boolean;
    sessions: boolean;
    generated: boolean;
    workCanvases: boolean;
    replies: boolean;
    prompts: boolean;
    canvas: boolean;
    plugin: boolean;
  };
  counts: {
    replyNotes: number;
    promptNotes: number;
    generatedNotes?: number;
    sessionFolders?: number;
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

export interface WorkspacePluginUpdateResult {
  ok: boolean;
  schemaVersion: number;
  workspacePath: string;
  vaultRoot: string;
  installedFiles: string[];
  before: WorkspaceMaintenanceStatus;
  after: WorkspaceMaintenanceStatus;
}
