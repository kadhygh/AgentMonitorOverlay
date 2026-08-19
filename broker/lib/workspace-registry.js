const fs = require("fs");
const path = require("path");
const { AMO_DIR, AMO_SCHEMA_VERSION } = require("./amo-constants");
const { readJsonFile, readJsonFileStrict, writeJsonFile } = require("./filesystem");
const { httpError } = require("./http");
const { normalizeText } = require("./normalize");

function createWorkspaceRegistry({ dataFile, recordDebugLog = () => {} } = {}) {
  if (!dataFile) throw new Error("createWorkspaceRegistry requires dataFile");
  const records = new Map();

  function load() {
    records.clear();
    const snapshot = readJsonFile(dataFile, { workspaces: [] });
    for (const record of Array.isArray(snapshot?.workspaces) ? snapshot.workspaces : []) {
      if (normalizeText(record?.workspaceId) && normalizeText(record?.workspacePath)) {
        records.set(record.workspaceId, record);
      }
    }
  }

  function persist() {
    writeJsonFile(dataFile, {
      schemaVersion: AMO_SCHEMA_VERSION,
      workspaces: Array.from(records.values()),
    });
  }

  function registerInspection(inspection) {
    if (!inspection?.existingEnrollment) return null;
    return upsert({
      workspaceId: inspection.workspaceId,
      workspacePath: inspection.workspacePath,
      projectName: inspection.projectName,
      workspaceLabel: normalizeWorkspaceLabel(inspection.workspaceLabel),
      adapterIds: deployedAdapterIds(inspection.supportedAdapters),
      deploymentVersion: inspection.deploymentVersion || null,
      hookProtocolVersion: inspection.hookProtocolVersion || null,
      lastInspectedAt: new Date().toISOString(),
      status: "ready",
    });
  }

  function registerEnrollment(enrollment) {
    return upsert({
      workspaceId: enrollment.workspaceId,
      workspacePath: enrollment.workspacePath,
      projectName: path.basename(enrollment.workspacePath),
      workspaceLabel: normalizeWorkspaceLabel(enrollment.workspaceLabel),
      vaultRoot: enrollment.vaultRoot || null,
      adapterIds: enrollment.installedAdapters || [],
      deploymentVersion: enrollment.deploymentVersion || null,
      hookProtocolVersion: enrollment.hookProtocolVersion || null,
      lastInspectedAt: new Date().toISOString(),
      status: "ready",
    });
  }

  function upsert(input) {
    const workspaceId = normalizeText(input?.workspaceId);
    const workspacePath = normalizeText(input?.workspacePath);
    if (!workspaceId || !workspacePath) return null;

    const now = new Date().toISOString();
    const existing = records.get(workspaceId);
    const record = {
      ...(existing || {}),
      ...input,
      workspaceId,
      workspacePath,
      projectName: normalizeText(input.projectName) || path.basename(workspacePath),
      adapterIds: Array.from(new Set([...(existing?.adapterIds || []), ...(input.adapterIds || [])])),
      registeredAt: existing?.registeredAt || now,
      updatedAt: now,
    };
    records.set(workspaceId, record);
    persist();
    recordDebugLog("broker", "workspace.registry_updated", { workspaceId, workspacePath });
    return decorateAvailability(record);
  }

  function list() {
    return Array.from(records.values())
      .map(decorateAvailability)
      .sort((left, right) => left.projectName.localeCompare(right.projectName));
  }

  function updateLabel(workspaceId, value) {
    const normalizedId = normalizeText(workspaceId);
    if (!normalizedId || !records.has(normalizedId)) {
      throw httpError(404, "workspace_not_registered", `Workspace is not registered: ${normalizedId || "missing"}`);
    }

    const existing = records.get(normalizedId);
    const workspaceLabel = normalizeWorkspaceLabel(value, { strict: true });
    const workspaceFile = path.join(existing.workspacePath, AMO_DIR, "workspace.json");
    if (!fs.existsSync(workspaceFile)) {
      throw httpError(409, "workspace_not_enrolled", "Workspace label requires an enrolled .amo/workspace.json");
    }

    const metadata = readJsonFileStrict(workspaceFile);
    if (normalizeText(metadata?.workspaceId) !== normalizedId) {
      throw httpError(409, "workspace_identity_mismatch", "Registered workspace and .amo/workspace.json identity do not match");
    }
    const now = new Date().toISOString();
    writeJsonFile(workspaceFile, {
      ...metadata,
      workspaceLabel,
      updatedAt: now,
    });

    const record = {
      ...existing,
      workspaceLabel,
      updatedAt: now,
    };
    records.set(normalizedId, record);
    persist();
    recordDebugLog("broker", "workspace.label_updated", {
      workspaceId: normalizedId,
      workspacePath: existing.workspacePath,
      workspaceLabel,
    });
    return decorateAvailability(record);
  }

  function forget(workspaceId) {
    const normalizedId = normalizeText(workspaceId);
    if (!normalizedId || !records.has(normalizedId)) {
      throw httpError(404, "workspace_not_registered", `Workspace is not registered: ${normalizedId || "missing"}`);
    }
    const removed = records.get(normalizedId);
    records.delete(normalizedId);
    persist();
    recordDebugLog("broker", "workspace.registry_forgotten", {
      workspaceId: normalizedId,
      workspacePath: removed.workspacePath,
    });
    return removed;
  }

  function decorateAvailability(record) {
    const workspaceExists = directoryExists(record.workspacePath);
    const enrollmentExists = workspaceExists && fs.existsSync(path.join(record.workspacePath, AMO_DIR, "workspace.json"));
    return {
      ...record,
      status: !workspaceExists ? "unavailable" : enrollmentExists ? record.status || "ready" : "unenrolled",
      available: workspaceExists,
      enrollmentPresent: enrollmentExists,
    };
  }

  load();
  return { forget, list, registerEnrollment, registerInspection, updateLabel };
}

function normalizeWorkspaceLabel(value, { strict = false } = {}) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") {
    if (strict) throw httpError(400, "invalid_workspace_label", "Workspace label must be text");
    return null;
  }

  const normalized = value.trim().replace(/\s+/gu, " ");
  if (!normalized) return null;
  if (normalized.length > 32) {
    if (!strict) return null;
    throw httpError(400, "workspace_label_too_long", "Workspace label must be 32 characters or fewer");
  }
  if (/[\\/:*?"<>|\u0000-\u001f]/u.test(normalized)) {
    if (!strict) return null;
    throw httpError(400, "invalid_workspace_label", "Workspace label cannot contain path separators or control characters");
  }
  return normalized;
}

function directoryExists(value) {
  try {
    return fs.statSync(value).isDirectory();
  } catch {
    return false;
  }
}

function deployedAdapterIds(adapters) {
  return (Array.isArray(adapters) ? adapters : [])
    .filter((adapter) => adapter?.deploymentStatus === "deployed" || adapter?.deploymentStatus === "needs-update")
    .map((adapter) => adapter.id)
    .filter(Boolean);
}

module.exports = { createWorkspaceRegistry, normalizeWorkspaceLabel };
