import { useState } from "react";
import { Bot, FolderOpen, Link2, Plus, RefreshCcw, SquareTerminal, Trash2, Unlink } from "lucide-react";
import { projectName, shortPathLabel } from "../domain/routingModel";
import {
  adapterContextLabel,
  adapterStateLabel,
  isDeployableWorkspaceAdapter,
  isWorkspaceAdapterInstalled,
  workspaceDeploymentStateLabel,
  workspaceDeploymentSummary,
} from "../domain/workspaceModel";
import type {
  WorkspaceDocumentMappingEntry,
  WorkspaceDocumentMappingsStatus,
  WorkspaceEnrollment,
  WorkspaceGitExcludeStatus,
  WorkspaceInspection,
} from "../types";

type DeployBusy = "inspect" | "enroll" | "clean" | null;

interface DeployWorkspaceSectionProps {
  workspacePath: string;
  workspaceInspection: WorkspaceInspection | null;
  selectedDeployAdapters: string[];
  deployBusy: DeployBusy;
  launchBusy: string | null;
  gitRootPath: string;
  gitExcludeStatus: WorkspaceGitExcludeStatus | null;
  gitExcludeMissingPatterns: Set<string>;
  gitExcludeTrackedPatterns: Set<string>;
  gitExcludeBlocked: boolean;
  gitExcludeBusy: boolean;
  includeClaudeSettingsExclude: boolean;
  documentMappingPath: string;
  documentMappings: WorkspaceDocumentMappingsStatus | null;
  documentMappingBusy: string | null;
  documentMappingBlocked: boolean;
  onWorkspacePathChange: (value: string) => void;
  onInspectWorkspace: () => void;
  onChooseWorkspace: () => void;
  onLaunchCli: () => void;
  onDeploySelected: () => void;
  onClearGenerated: () => void;
  onGitRootPathChange: (value: string) => void;
  onApplyGitExclude: () => void;
  onChooseGit: () => void;
  onClaudeSettingsExcludeChange: (checked: boolean) => void;
  onDocumentMappingPathChange: (value: string) => void;
  onChooseDocumentMapping: () => void;
  onDeployDocumentMapping: (sourcePath?: string) => void;
  onRemoveDocumentMapping: (entry: WorkspaceDocumentMappingEntry) => void;
  onOpenDocumentMappingPath: (path: string, label: string) => void;
}

export function DeployWorkspaceSection({
  workspacePath,
  workspaceInspection,
  selectedDeployAdapters,
  deployBusy,
  launchBusy,
  gitRootPath,
  gitExcludeStatus,
  gitExcludeMissingPatterns,
  gitExcludeTrackedPatterns,
  gitExcludeBlocked,
  gitExcludeBusy,
  includeClaudeSettingsExclude,
  documentMappingPath,
  documentMappings,
  documentMappingBusy,
  documentMappingBlocked,
  onWorkspacePathChange,
  onInspectWorkspace,
  onChooseWorkspace,
  onLaunchCli,
  onDeploySelected,
  onClearGenerated,
  onGitRootPathChange,
  onApplyGitExclude,
  onChooseGit,
  onClaudeSettingsExcludeChange,
  onDocumentMappingPathChange,
  onChooseDocumentMapping,
  onDeployDocumentMapping,
  onRemoveDocumentMapping,
  onOpenDocumentMappingPath,
}: DeployWorkspaceSectionProps) {
  const workspaceActionsBlocked = deployBusy !== null || launchBusy !== null || documentMappingBusy !== null;

  return (
    <section className="dialog-section deploy-workspace-section">
      <div className="dialog-section-heading">
        <strong>Workspace</strong>
        <span>{workspaceInspection ? projectName(workspaceInspection.workspacePath) : "Not checked"}</span>
      </div>
      <input
        className="deploy-path-input"
        type="text"
        spellCheck={false}
        value={workspacePath}
        placeholder="Paste or choose a workspace path"
        title={workspacePath || "No workspace selected"}
        disabled={workspaceActionsBlocked}
        onChange={(event) => onWorkspacePathChange(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            onInspectWorkspace();
          }
        }}
      />
      <div className="deploy-action-row">
        <button type="button" disabled={workspaceActionsBlocked} onClick={onChooseWorkspace}>
          Choose
        </button>
        <button
          type="button"
          title="Check folder before deploying; this does not write files."
          disabled={!workspacePath.trim() || workspaceActionsBlocked}
          onClick={onInspectWorkspace}
        >
          {deployBusy === "inspect" ? "Checking" : "Check"}
        </button>
        <button type="button" title="Start a CLI in this folder without deployment or a managed task."
          disabled={!workspacePath.trim() || workspaceActionsBlocked} onClick={onLaunchCli}>
          <SquareTerminal size={12} aria-hidden="true" />
          <span>Launch CLI</span>
        </button>
        <button
          type="button"
          className="primary"
          disabled={!workspaceInspection || selectedDeployAdapters.length === 0 || workspaceActionsBlocked}
          onClick={onDeploySelected}
        >
          {deployBusy === "enroll" ? "Deploying" : "Deploy Selected"}
        </button>
        <button
          type="button"
          className="danger-action"
          title="Clear generated session notes and reset the base canvas without removing hooks."
          disabled={!workspaceInspection?.existingEnrollment || workspaceActionsBlocked}
          onClick={onClearGenerated}
        >
          <Trash2 size={12} aria-hidden="true" />
          <span>{deployBusy === "clean" ? "Clearing" : "Clear Generated"}</span>
        </button>
      </div>

      {workspaceInspection ? (
        <>
          <dl className="deploy-status-grid">
            <div>
              <dt>Path</dt>
              <dd title={workspaceInspection.workspacePath}>{shortPathLabel(workspaceInspection.workspacePath)}</dd>
            </div>
            <div>
              <dt>State</dt>
              <dd>{workspaceDeploymentStateLabel(workspaceInspection)}</dd>
            </div>
            <div>
              <dt>Selected</dt>
              <dd>{selectedDeployAdapters.length}</dd>
            </div>
          </dl>
          <div className="deploy-state-note">{workspaceDeploymentSummary(workspaceInspection)}</div>
        </>
      ) : (
        <div className="deploy-placeholder">Check a workspace to review deployment status.</div>
      )}

      <div className="deploy-subsection">
        <div className="dialog-section-heading">
          <strong>Git exclude</strong>
          <span>{gitExcludeStatus ? gitExcludeStatus.status : "Optional"}</span>
        </div>
        <input
          className="deploy-path-input"
          type="text"
          spellCheck={false}
          value={gitRootPath}
          placeholder="Git repository root, optional"
          title={gitRootPath || "No Git root selected"}
          disabled={gitExcludeBlocked}
          onChange={(event) => onGitRootPathChange(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              onApplyGitExclude();
            }
          }}
        />
        <div className="deploy-action-row">
          <button type="button" disabled={gitExcludeBlocked} onClick={onChooseGit}>
            Choose Git
          </button>
          <button type="button" className="primary" disabled={!workspacePath.trim() || gitExcludeBlocked} onClick={onApplyGitExclude}>
            {gitExcludeBusy ? "Adding" : "Add exclude"}
          </button>
        </div>
        <label className="deploy-option-row">
          <input
            type="checkbox"
            checked={includeClaudeSettingsExclude}
            disabled={gitExcludeBlocked}
            onChange={(event) => onClaudeSettingsExcludeChange(event.currentTarget.checked)}
          />
          <span>Also exclude `.claude\settings.local.json`</span>
        </label>
        <GitExcludeStatusView
          status={gitExcludeStatus}
          missingPatterns={gitExcludeMissingPatterns}
          trackedPatterns={gitExcludeTrackedPatterns}
        />
      </div>

      <DocumentMappingsSection
        workspaceEnrolled={Boolean(workspaceInspection?.existingEnrollment)}
        mappingPath={documentMappingPath}
        status={documentMappings}
        busy={documentMappingBusy}
        blocked={documentMappingBlocked}
        onMappingPathChange={onDocumentMappingPathChange}
        onChoose={onChooseDocumentMapping}
        onDeploy={onDeployDocumentMapping}
        onRemove={onRemoveDocumentMapping}
        onOpenPath={onOpenDocumentMappingPath}
      />
    </section>
  );
}

interface DocumentMappingsSectionProps {
  compact?: boolean;
  workspaceEnrolled: boolean;
  mappingPath: string;
  status: WorkspaceDocumentMappingsStatus | null;
  busy: string | null;
  blocked: boolean;
  onMappingPathChange: (value: string) => void;
  onChoose: () => void;
  onDeploy: (sourcePath?: string) => void;
  onRemove: (entry: WorkspaceDocumentMappingEntry) => void;
  onOpenPath: (path: string, label: string) => void;
}

export function DocumentMappingsSection({
  compact = false,
  workspaceEnrolled,
  mappingPath,
  status,
  busy,
  blocked,
  onMappingPathChange,
  onChoose,
  onDeploy,
  onRemove,
  onOpenPath,
}: DocumentMappingsSectionProps) {
  const actionsBlocked = blocked || !workspaceEnrolled;
  const [adding, setAdding] = useState(false);

  if (compact) return <div className="wc-document-mappings">
    <div className="wc-row wc-between"><span className="wc-help">{status?.mappedCount || 0} 个目录已映射</span><div className="wc-row">
      <button type="button" className="wc-link" disabled={blocked || !status?.projectRoot || !status.mappedCount} onClick={() => status?.projectRoot && onOpenPath(status.projectRoot, "project notes")}>打开映射目录</button>
      <button type="button" className="wc-button" disabled={actionsBlocked} onClick={() => setAdding(!adding)}><Plus size={14} />添加目录</button>
    </div></div>
    {adding && <div className="wc-settings-detail"><label className="wc-field"><span>项目文档目录</span><input aria-label="项目文档目录" autoFocus value={mappingPath} disabled={actionsBlocked} placeholder="例如 AIWork 或项目内的文档路径" onChange={e => onMappingPathChange(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && mappingPath.trim()) onDeploy(); }} /></label>
      <div className="wc-row"><button type="button" className="wc-button" disabled={actionsBlocked} onClick={onChoose}>选择文件夹</button><button type="button" className="wc-button" disabled={actionsBlocked || !mappingPath.trim()} onClick={() => onDeploy()}>{busy === "add" ? "正在映射…" : "添加映射"}</button><button type="button" className="wc-link" disabled={blocked} onClick={() => setAdding(false)}>收起</button></div>
    </div>}
    {!workspaceEnrolled ? <p className="wc-help">接入至少一个客户端后，可添加项目文档映射。</p> : status && !status.entries.length ? <p className="wc-help">尚未映射项目文档。</p> : null}
    {workspaceEnrolled && status?.entries.map(entry => {
      const canDeploy = entry.status === "available" || entry.status === "missing-target" || (entry.status === "mapped" && !entry.configured);
      return <div className="wc-mapping-row" key={entry.sourcePath}><div><strong>{entry.label}</strong><small title={entry.sourcePath}>{entry.sourceRelativePath} → {entry.targetRelativePath}</small></div><div className="wc-row"><span className={entry.status === "mapped" ? "wc-good" : "wc-warning"}>{busy === entry.sourcePath ? "处理中…" : entry.status === "mapped" ? "已映射" : entry.status === "missing-target" ? "需要修复" : entry.status === "available" ? "可映射" : entry.status}</span>
        <button type="button" className="wc-icon-button" aria-label={`打开 ${entry.label} 源目录`} disabled={blocked || !entry.sourceExists} onClick={() => onOpenPath(entry.sourcePath, entry.label)}><FolderOpen size={15} /></button>
        {entry.status === "mapped" && entry.configured ? <button type="button" className="wc-icon-button" aria-label={`移除 ${entry.label} 映射`} disabled={blocked} onClick={() => onRemove(entry)}><Unlink size={15} /></button>
          : canDeploy ? <button type="button" className="wc-button" disabled={blocked} onClick={() => onDeploy(entry.sourcePath)}><Link2 size={14} />{entry.status === "missing-target" ? "修复" : "映射"}</button> : null}
      </div></div>;
    })}
  </div>;

  return (
    <div className="deploy-subsection deploy-document-mappings">
      <div className="dialog-section-heading">
        <strong>Project notes</strong>
        <span>{status ? `${status.mappedCount} mapped` : "Optional"}</span>
      </div>
      <input
        className="deploy-path-input"
        type="text"
        spellCheck={false}
        value={mappingPath}
        placeholder="Project document folder, for example AIWork"
        title={mappingPath || "No document folder selected"}
        disabled={actionsBlocked}
        onChange={(event) => onMappingPathChange(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            onDeploy();
          }
        }}
      />
      <div className="deploy-action-row">
        <button type="button" disabled={actionsBlocked} onClick={onChoose}>
          <FolderOpen size={12} aria-hidden="true" />
          <span>Choose folder</span>
        </button>
        <button
          type="button"
          className="primary"
          disabled={actionsBlocked || !mappingPath.trim()}
          onClick={() => onDeploy()}
        >
          <Link2 size={12} aria-hidden="true" />
          <span>{busy === "add" ? "Deploying" : "Deploy mapping"}</span>
        </button>
        <button
          type="button"
          disabled={!status?.projectRoot || status.mappedCount === 0 || blocked}
          onClick={() => status?.projectRoot && onOpenPath(status.projectRoot, "project notes")}
        >
          <FolderOpen size={12} aria-hidden="true" />
          <span>Open mapped</span>
        </button>
      </div>
      {!workspaceEnrolled ? (
        <div className="deploy-git-exclude-note status-missing">
          <span>Deploy at least one workspace adapter before adding project document mappings.</span>
        </div>
      ) : status ? (
        <div className="deploy-document-mapping-list" aria-label="Project document mappings">
          {status.entries.length === 0 ? (
            <div className="deploy-git-exclude-note"><span>{status.message}</span></div>
          ) : status.entries.map((entry) => {
            const entryBusy = busy === entry.sourcePath;
            const canDeploy = entry.status === "available" || entry.status === "missing-target";
            return (
              <article className={`deploy-document-mapping status-${entry.status}`} key={entry.sourcePath}>
                <span className="deploy-document-mapping-copy">
                  <strong>{entry.label}</strong>
                  <small title={entry.sourcePath}>{entry.sourceRelativePath} -&gt; {entry.targetRelativePath}</small>
                </span>
                <em>{entry.status}</em>
                <span className="deploy-document-mapping-actions">
                  <button type="button" title="Open source folder" disabled={blocked || !entry.sourceExists} onClick={() => onOpenPath(entry.sourcePath, entry.label)}>
                    <FolderOpen size={12} aria-hidden="true" />
                  </button>
                  {entry.status === "mapped" && entry.configured ? (
                    <button type="button" title="Remove mapping" disabled={blocked} onClick={() => onRemove(entry)}>
                      <Unlink size={12} aria-hidden="true" />
                    </button>
                  ) : canDeploy || (entry.status === "mapped" && !entry.configured) ? (
                    <button type="button" title="Deploy mapping" disabled={blocked} onClick={() => onDeploy(entry.sourcePath)}>
                      <Link2 size={12} aria-hidden="true" />
                    </button>
                  ) : null}
                </span>
                {entryBusy ? <span className="deploy-document-mapping-progress">Working...</span> : null}
              </article>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

interface GitExcludeStatusViewProps {
  status: WorkspaceGitExcludeStatus | null;
  missingPatterns: Set<string>;
  trackedPatterns: Set<string>;
}

export function GitExcludeStatusView({ status, missingPatterns, trackedPatterns }: GitExcludeStatusViewProps) {
  if (!status) {
    return (
      <div className="deploy-git-exclude-note">
        <span>Exclude options changed. Click Add exclude to check and write missing patterns.</span>
      </div>
    );
  }

  return (
    <>
      <div className={`deploy-git-exclude-note status-${status.status}`}>
        <span title={status.excludeFilePath || status.message}>{status.message}</span>
        {status.missingEntries.length > 0 ? (
          <small>{status.missingEntries.map((entry) => entry.pattern).join(", ")}</small>
        ) : status.excludeFilePath ? (
          <small title={status.excludeFilePath}>{shortPathLabel(status.excludeFilePath)}</small>
        ) : null}
      </div>
      {status.entries.length > 0 ? (
        <ul className="deploy-git-exclude-list" aria-label="Git exclude pattern status">
          {status.entries.map((entry) => {
            const missing = missingPatterns.has(entry.pattern);
            const tracked = trackedPatterns.has(entry.pattern);
            const itemState = missing ? "missing" : tracked ? "tracked" : "covered";
            return (
              <li className={`is-${itemState}`} key={entry.pattern}>
                <em>{itemState}</em>
                <span title={tracked ? "This path is already tracked by Git, so exclude cannot hide it." : entry.reason || entry.pattern}>
                  {entry.pattern}
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </>
  );
}

interface DeployAdaptersSectionProps {
  workspaceInspection: WorkspaceInspection | null;
  selectedDeployAdapters: string[];
  deployBusy: DeployBusy;
  launchBusy: string | null;
  documentMappingBusy: boolean;
  onAdapterSelectedChange: (adapterId: string, selected: boolean) => void;
  onDeployAdapter: (adapterId: string) => void;
  onLaunchWorkspace: (adapterId: string) => void;
}

export function DeployAdaptersSection({
  workspaceInspection,
  selectedDeployAdapters,
  deployBusy,
  launchBusy,
  documentMappingBusy,
  onAdapterSelectedChange,
  onDeployAdapter,
  onLaunchWorkspace,
}: DeployAdaptersSectionProps) {
  const workspaceActionsBlocked = deployBusy !== null || launchBusy !== null || documentMappingBusy;

  return (
    <section className="dialog-section deploy-adapters-section">
      <div className="dialog-section-heading">
        <strong>Adapters</strong>
        <span>{workspaceInspection ? `${workspaceInspection.supportedAdapters.length} available targets` : "Awaiting check"}</span>
      </div>
      {workspaceInspection ? (
        <div className="deploy-adapter-list">
          {workspaceInspection.supportedAdapters.map((adapter) => {
            const selectable = isDeployableWorkspaceAdapter(adapter);
            const selected = selectedDeployAdapters.includes(adapter.id);
            const installed = isWorkspaceAdapterInstalled(adapter);
            const stateLabel = adapterStateLabel(adapter);
            const contextLabel = adapterContextLabel(adapter);
            return (
              <article
                className={`deploy-adapter-card status-${adapter.status} state-${stateLabel} ${selected ? "is-selected" : ""}`}
                key={adapter.id}
                title={adapter.reason}
              >
                <label className="deploy-adapter-select" title={selectable ? "Include in Deploy Selected" : "Adapter unavailable"}>
                  <input
                    type="checkbox"
                    checked={selected}
                    disabled={!selectable || deployBusy !== null}
                    onChange={(event) => onAdapterSelectedChange(adapter.id, event.currentTarget.checked)}
                  />
                </label>
                <span className="deploy-adapter-copy">
                  <strong>{adapter.label}</strong>
                  <span>{adapter.reason}</span>
                </span>
                <span className="deploy-adapter-badges">
                  <em>{stateLabel}</em>
                  {contextLabel ? <small>{contextLabel}</small> : null}
                </span>
                <span className="deploy-adapter-actions">
                  {installed ? (
                    <>
                      <button type="button" disabled={workspaceActionsBlocked} onClick={() => onLaunchWorkspace(adapter.id)}>
                        <SquareTerminal size={12} aria-hidden="true" />
                        <span>{launchBusy === adapter.id ? "Starting" : "Run"}</span>
                      </button>
                      {adapter.id === "codex-cli" ? (
                        <button type="button" disabled={workspaceActionsBlocked} onClick={() => onLaunchWorkspace("codex-app")}>
                          <Bot size={12} aria-hidden="true" />
                          <span>{launchBusy === "codex-app" ? "Opening" : "ChatGPT"}</span>
                        </button>
                      ) : null}
                      <button
                        type="button"
                        disabled={!selectable || workspaceActionsBlocked}
                        onClick={() => onDeployAdapter(adapter.id)}
                      >
                        <RefreshCcw size={12} aria-hidden="true" />
                        <span>Update</span>
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="primary"
                      disabled={!selectable || workspaceActionsBlocked}
                      onClick={() => onDeployAdapter(adapter.id)}
                    >
                      <span>{deployBusy === "enroll" ? "Deploying" : "Deploy"}</span>
                    </button>
                  )}
                </span>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="deploy-placeholder">Adapter details appear after Check.</div>
      )}
    </section>
  );
}

interface DeployResultFooterProps {
  workspaceEnrollment: WorkspaceEnrollment | null;
  feedback: string;
  deployBusy: DeployBusy;
  launchBusy: string | null;
  onLaunchWorkspace: (adapterId: string) => void;
  onOpenDeploymentPath: (path: string | undefined, label: string) => void;
}

export function DeployResultFooter({
  workspaceEnrollment,
  feedback,
  deployBusy,
  launchBusy,
  onLaunchWorkspace,
  onOpenDeploymentPath,
}: DeployResultFooterProps) {
  const actionsBlocked = deployBusy !== null || launchBusy !== null;

  if (!workspaceEnrollment) {
    return <span title={feedback}>{feedback}</span>;
  }

  return (
    <div className="deploy-result" title={workspaceEnrollment.vaultRoot}>
      <div className="deploy-result-copy">
        <div className="deploy-result-summary">
          <strong>{workspaceEnrollment.installedAdapters.join(", ")}</strong>
          <span>{workspaceEnrollment.installedFiles.length} files</span>
          <span>{workspaceEnrollment.mergedFiles.length} merged</span>
        </div>
        <span className="deploy-result-feedback" title={feedback}>
          {feedback}
        </span>
      </div>
      <div className="deploy-launch-actions" aria-label="Launch workspace tools">
        {workspaceEnrollment.installedAdapters.includes("codex-cli") ? (
          <button type="button" disabled={actionsBlocked} onClick={() => onLaunchWorkspace("codex-cli")}>
            <SquareTerminal size={12} aria-hidden="true" />
            <span>{launchBusy === "codex-cli" ? "Starting" : "Run Codex"}</span>
          </button>
        ) : null}
        {workspaceEnrollment.installedAdapters.includes("claude-cli") ? (
          <button type="button" disabled={actionsBlocked} onClick={() => onLaunchWorkspace("claude-cli")}>
            <SquareTerminal size={12} aria-hidden="true" />
            <span>{launchBusy === "claude-cli" ? "Starting" : "Run Claude"}</span>
          </button>
        ) : null}
        {workspaceEnrollment.installedAdapters.includes("grok-build") ? (
          <button type="button" disabled={actionsBlocked} onClick={() => onLaunchWorkspace("grok-build")}>
            <SquareTerminal size={12} aria-hidden="true" />
            <span>{launchBusy === "grok-build" ? "Starting" : "Run Grok"}</span>
          </button>
        ) : null}
        {workspaceEnrollment.installedAdapters.includes("codex-cli") ? (
          <button type="button" disabled={actionsBlocked} onClick={() => onLaunchWorkspace("codex-app")}>
            <Bot size={12} aria-hidden="true" />
            <span>{launchBusy === "codex-app" ? "Opening" : "Open ChatGPT"}</span>
          </button>
        ) : null}
        <button type="button" disabled={actionsBlocked} onClick={() => onOpenDeploymentPath(workspaceEnrollment.workspacePath, "workspace")}>
          <FolderOpen size={12} aria-hidden="true" />
          <span>Project</span>
        </button>
        <button type="button" disabled={actionsBlocked} onClick={() => onOpenDeploymentPath(workspaceEnrollment.vaultRoot, "vault")}>
          <FolderOpen size={12} aria-hidden="true" />
          <span>Vault</span>
        </button>
      </div>
    </div>
  );
}
