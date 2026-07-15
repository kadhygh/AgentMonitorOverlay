import type { AgentSession, WorkspaceAdapterPlan, WorkspaceCleanResult, WorkspaceInspection, WorkspaceMaintenanceStatus } from "../types";

export type LaunchPanelAdapterId = "codex-cli" | "claude-cli" | "codex-app";
export type MaintenanceTone = "ok" | "warning" | "error" | "unknown";

export function isDeployableWorkspaceAdapter(adapter: WorkspaceAdapterPlan) {
  return typeof adapter.deployable === "boolean" ? adapter.deployable : adapter.status === "available";
}

export function adapterStateLabel(adapter: WorkspaceAdapterPlan) {
  return adapter.deploymentStatus ?? adapter.status;
}

export function isWorkspaceAdapterUpToDate(adapter: WorkspaceAdapterPlan) {
  return adapter.deploymentStatus === "deployed";
}

export function isWorkspaceAdapterInstalled(adapter: WorkspaceAdapterPlan) {
  return adapter.deploymentStatus === "deployed" || adapter.deploymentStatus === "needs-update";
}

export function workspaceLaunchLabel(adapterId: LaunchPanelAdapterId) {
  if (adapterId === "codex-cli") return "Codex CLI";
  if (adapterId === "claude-cli") return "Claude CLI";
  return "ChatGPT";
}

export function workspaceAdapterPlan(inspection: WorkspaceInspection | null | undefined, adapterId: LaunchPanelAdapterId) {
  const requiredAdapterId = adapterId === "codex-app" ? "codex-cli" : adapterId;
  const allAdapters = [...(inspection?.supportedAdapters ?? []), ...(inspection?.deferredAdapters ?? [])];
  return allAdapters.find((adapter) => adapter.id === requiredAdapterId) ?? null;
}

export function workspaceAdapterLaunchable(inspection: WorkspaceInspection | null | undefined, adapterId: LaunchPanelAdapterId) {
  const adapter = workspaceAdapterPlan(inspection, adapterId);
  return Boolean(adapter && isWorkspaceAdapterInstalled(adapter));
}

export function workspaceAdapterLaunchDetail(inspection: WorkspaceInspection | null | undefined, adapterId: LaunchPanelAdapterId) {
  const adapter = workspaceAdapterPlan(inspection, adapterId);
  if (!adapter) {
    return "not detected";
  }
  if (isWorkspaceAdapterInstalled(adapter)) {
    if (adapterId === "codex-app") return "open a new task";
    return adapter.deploymentStatus === "needs-update" ? "deployed, update available" : "deployed";
  }
  return adapter.deploymentStatus ?? adapter.status;
}

export function isWorkspaceAdapterNeedsUpdate(adapter: WorkspaceAdapterPlan) {
  return adapter.deploymentStatus === "needs-update";
}

export function adapterContextLabel(adapter: WorkspaceAdapterPlan) {
  if (isWorkspaceAdapterNeedsUpdate(adapter)) {
    const installed = adapter.installedHookProtocolVersion ?? "old";
    const expected = adapter.expectedHookProtocolVersion ?? "?";
    return `hook ${installed} -> ${expected}`;
  }
  return adapter.workspaceState ?? adapter.confidence;
}

export function isWorkspaceAdapterDeployed(adapter: WorkspaceAdapterPlan) {
  return isWorkspaceAdapterUpToDate(adapter);
}

export function selectedWorkspaceAdapterIds(inspection: WorkspaceInspection) {
  return inspection.supportedAdapters
    .filter((adapter) => isDeployableWorkspaceAdapter(adapter) && adapter.recommended !== false && !isWorkspaceAdapterUpToDate(adapter))
    .map((adapter) => adapter.id);
}

export function workspaceDeploymentSummary(inspection: WorkspaceInspection) {
  const deployedCount = inspection.supportedAdapters.filter(isWorkspaceAdapterUpToDate).length;
  const updateCount = inspection.supportedAdapters.filter(isWorkspaceAdapterNeedsUpdate).length;
  const deployableCount = inspection.supportedAdapters.filter(isDeployableWorkspaceAdapter).length;
  const empty = inspection.supportedAdapters.some((adapter) => adapter.workspaceState === "empty");

  if (updateCount > 0) {
    return `${updateCount} adapter(s) need hook update. Deploy Selected will refresh them.`;
  }

  if (empty && deployedCount === 0) {
    return "Empty folder, no AMO hooks deployed.";
  }

  if (deployedCount === 0) {
    return `No AMO hooks deployed. ${deployableCount} adapter(s) can be installed.`;
  }

  const pendingCount = Math.max(0, deployableCount - deployedCount);
  if (pendingCount > 0) {
    return `${deployedCount} deployed, ${pendingCount} available to deploy.`;
  }

  return `${deployedCount} adapter(s) deployed.`;
}

export function workspaceDeploymentStateLabel(inspection: WorkspaceInspection) {
  const updateCount = inspection.supportedAdapters.filter(isWorkspaceAdapterNeedsUpdate).length;
  const deployedCount = inspection.supportedAdapters.filter(isWorkspaceAdapterUpToDate).length;
  const empty = inspection.supportedAdapters.some((adapter) => adapter.workspaceState === "empty");
  if (updateCount > 0) return "needs update";
  if (deployedCount > 0) return "deployed";
  return empty ? "empty" : "not deployed";
}

export function workspaceGeneratedNoteCount(status: WorkspaceMaintenanceStatus | null | undefined) {
  if (!status) return 0;
  return status.counts.generatedNotes ?? status.counts.replyNotes + status.counts.promptNotes;
}

export function workspaceUsesSessionLayoutV2(status: WorkspaceMaintenanceStatus | null | undefined) {
  const canvasPath = status?.paths?.canvas?.replace(/\\/g, "/") ?? "";
  return canvasPath.endsWith("Canvases/AgentFlow.base.canvas") && status?.canvas?.marker?.canvasType === "agent-flow-base";
}

export function workspaceCleanFeedback(result: WorkspaceCleanResult) {
  const summary = `Cleared ${workspaceGeneratedNoteCount(result.before)} generated note(s) and reset ${result.before.counts.canvasNodes} canvas node(s).`;
  if (!workspaceUsesSessionLayoutV2(result.after)) {
    return `${summary} Legacy layout still detected; restart AMO/broker, then run Deploy/Update to switch this workspace to session layout v2.`;
  }
  return `${summary} New turns will use session layout v2.`;
}

export function maintenanceToneForSession(session: AgentSession, status?: WorkspaceMaintenanceStatus | null): MaintenanceTone {
  const pluginHealth = status?.pluginHealth ?? session.obsidianPluginHealth;
  if (status && !status.ok) {
    if (!status.exists.vaultRoot || !status.exists.canvas || !status.canvas.readable || pluginHealth?.status === "missing") {
      return "error";
    }
    return "warning";
  }
  if (pluginHealth && !pluginHealth.ok) {
    return pluginHealth.status === "missing" ? "error" : "warning";
  }
  if (!session.workspacePath && !session.vaultRoot) {
    return "unknown";
  }
  return "ok";
}

export function maintenanceTitleForSession(session: AgentSession) {
  const tone = maintenanceToneForSession(session);
  const health = session.obsidianPluginHealth;
  const lines = ["Workspace tools"];
  if (tone === "warning" || tone === "error") {
    lines.push("Needs review");
  }
  if (health?.issues?.length) {
    lines.push(...health.issues);
  }
  return lines.join("\n");
}
