const fs = require("fs");
const path = require("path");
const { AMO_DIR, AMO_SCHEMA_VERSION } = require("./amo-constants");
const { readJsonFile, writeJsonFile } = require("./filesystem");
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
  return { forget, list, registerEnrollment, registerInspection };
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

module.exports = { createWorkspaceRegistry };
