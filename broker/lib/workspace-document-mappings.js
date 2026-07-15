const fs = require("fs");
const path = require("path");
const { AMO_DIR, AMO_PROJECT_DOCS_PATH, AMO_SCHEMA_VERSION } = require("./amo-constants");
const {
  isSameOrDescendantPath,
  readJsonFile,
  resolveDirectoryPath,
  resolveWorkspacePath,
  writeJsonFile,
} = require("./filesystem");
const { httpError } = require("./http");
const { normalizeText } = require("./normalize");

function inspectWorkspaceDocumentMappings(workspacePath, vaultRoot, workspaceConfig = null) {
  const projectRoot = path.join(vaultRoot, AMO_PROJECT_DOCS_PATH);
  const configured = normalizeConfiguredMappings(workspacePath, workspaceConfig?.documentMappings);
  const entriesBySource = new Map();

  for (const mapping of configured) {
    entriesBySource.set(pathKey(mapping.sourcePath), inspectMapping(mapping, projectRoot, true));
  }

  const entries = Array.from(entriesBySource.values()).sort((left, right) => {
    if (left.configured !== right.configured) return left.configured ? -1 : 1;
    return left.sourceRelativePath.localeCompare(right.sourceRelativePath);
  });
  const mappedCount = entries.filter((entry) => entry.status === "mapped").length;

  return {
    ok: true,
    available: Boolean(workspaceConfig && isDirectory(vaultRoot)),
    projectRoot,
    projectRootRelativePath: AMO_PROJECT_DOCS_PATH,
    mappedCount,
    entries,
    message: workspaceConfig
      ? mappedCount > 0
        ? `${mappedCount} project document mapping(s) active.`
        : "No project document mappings deployed. Choose a folder to add one."
      : "Deploy this workspace before adding project document mappings.",
  };
}

function updateWorkspaceDocumentMapping(payload, options = {}) {
  const workspacePath = resolveWorkspacePath(payload?.workspacePath || payload?.workspace_path);
  const workspaceFile = path.join(workspacePath, AMO_DIR, "workspace.json");
  const workspaceConfig = readJsonFile(workspaceFile, null);
  if (!workspaceConfig) {
    throw httpError(409, "workspace_not_enrolled", "Deploy this workspace before adding project document mappings.");
  }

  const vaultRoot = resolveConfiguredVaultRoot(workspacePath, workspaceConfig);
  const action = normalizeText(payload?.action) || "add";
  if (action === "remove") {
    return removeDocumentMapping(workspacePath, vaultRoot, workspaceFile, workspaceConfig, payload, options);
  }
  if (action !== "add") {
    throw httpError(400, "unsupported_mapping_action", `Unsupported document mapping action: ${action}`);
  }

  const sourcePath = resolveDirectoryPath(
    payload?.sourcePath || payload?.source_path,
    "sourcePath",
    "document_mapping_source",
  );
  validateSourcePath(workspacePath, vaultRoot, sourcePath);

  const sourceRelativePath = workspaceRelativePath(workspacePath, sourcePath);
  const targetRelativePath = `${AMO_PROJECT_DOCS_PATH}/${path.basename(sourcePath)}`;
  const projectRoot = path.join(vaultRoot, AMO_PROJECT_DOCS_PATH);
  const targetPath = path.join(vaultRoot, ...targetRelativePath.split("/"));
  fs.mkdirSync(projectRoot, { recursive: true });

  let changed = false;
  if (pathExists(targetPath)) {
    if (!isExpectedLink(targetPath, sourcePath)) {
      throw httpError(
        409,
        "document_mapping_conflict",
        `Mapping target already exists and does not point to the selected folder: ${targetPath}`,
      );
    }
  } else {
    fs.symlinkSync(sourcePath, targetPath, process.platform === "win32" ? "junction" : "dir");
    changed = true;
  }

  const now = new Date().toISOString();
  const existingMappings = normalizeConfiguredMappings(workspacePath, workspaceConfig.documentMappings);
  const nextMapping = {
    sourceRelativePath,
    targetRelativePath,
    type: process.platform === "win32" ? "junction" : "directory-symlink",
    createdAt:
      existingMappings.find((mapping) => pathKey(mapping.sourcePath) === pathKey(sourcePath))?.createdAt || now,
    updatedAt: now,
  };
  const nextMappings = existingMappings
    .filter(
      (mapping) =>
        pathKey(mapping.sourcePath) !== pathKey(sourcePath) &&
        pathKey(mapping.targetRelativePath) !== pathKey(targetRelativePath),
    )
    .map(serializableMapping);
  nextMappings.push(nextMapping);

  writeJsonFile(workspaceFile, {
    ...workspaceConfig,
    updatedAt: now,
    projectDocsPath: AMO_PROJECT_DOCS_PATH,
    documentMappings: nextMappings,
  });
  changed = changed || !existingMappings.some((mapping) => pathKey(mapping.sourcePath) === pathKey(sourcePath));

  const status = inspectWorkspaceDocumentMappings(workspacePath, vaultRoot, {
    ...workspaceConfig,
    documentMappings: nextMappings,
  });
  recordMappingEvent(options, "workspace.document_mapping.added", {
    workspacePath,
    sourcePath,
    targetPath,
    changed,
  });
  return mappingResult(workspacePath, vaultRoot, changed, status);
}

function removeDocumentMapping(workspacePath, vaultRoot, workspaceFile, workspaceConfig, payload, options) {
  const requestedSource = normalizeText(payload?.sourcePath || payload?.source_path);
  if (!requestedSource) {
    throw httpError(400, "missing_document_mapping_source", "Payload must include sourcePath");
  }

  const requestedPath = path.isAbsolute(requestedSource)
    ? path.resolve(requestedSource)
    : path.resolve(workspacePath, requestedSource);
  const existingMappings = normalizeConfiguredMappings(workspacePath, workspaceConfig.documentMappings);
  const mapping = existingMappings.find((entry) => pathKey(entry.sourcePath) === pathKey(requestedPath));
  if (!mapping) {
    throw httpError(404, "document_mapping_not_found", `Document mapping is not registered: ${requestedSource}`);
  }

  const projectRoot = path.join(vaultRoot, AMO_PROJECT_DOCS_PATH);
  const targetPath = path.resolve(vaultRoot, ...mapping.targetRelativePath.split("/"));
  if (!isSameOrDescendantPath(projectRoot, targetPath) || pathKey(projectRoot) === pathKey(targetPath)) {
    throw httpError(400, "unsafe_document_mapping_target", `Refusing to remove mapping outside ${projectRoot}`);
  }

  let changed = false;
  if (pathExists(targetPath)) {
    let stat;
    try {
      stat = fs.lstatSync(targetPath);
    } catch (error) {
      throw httpError(409, "document_mapping_unreadable", `Cannot inspect mapping target: ${error.message}`);
    }
    if (!stat.isSymbolicLink()) {
      throw httpError(409, "document_mapping_conflict", `Refusing to remove a normal directory: ${targetPath}`);
    }
    fs.unlinkSync(targetPath);
    changed = true;
  }

  const now = new Date().toISOString();
  const nextMappings = existingMappings
    .filter((entry) => pathKey(entry.sourcePath) !== pathKey(mapping.sourcePath))
    .map(serializableMapping);
  writeJsonFile(workspaceFile, {
    ...workspaceConfig,
    updatedAt: now,
    documentMappings: nextMappings,
  });
  changed = true;

  const status = inspectWorkspaceDocumentMappings(workspacePath, vaultRoot, {
    ...workspaceConfig,
    documentMappings: nextMappings,
  });
  recordMappingEvent(options, "workspace.document_mapping.removed", {
    workspacePath,
    sourcePath: mapping.sourcePath,
    targetPath,
  });
  return mappingResult(workspacePath, vaultRoot, changed, status);
}

function inspectMapping(mapping, projectRoot, configured) {
  const targetPath = path.join(projectRoot, path.basename(mapping.targetRelativePath));
  const sourceExists = isDirectory(mapping.sourcePath);
  const targetExists = pathExists(targetPath);
  let status = configured ? "missing-target" : "available";
  let message = configured ? "Mapping target is missing." : "Ready to deploy.";

  if (!sourceExists) {
    status = "missing-source";
    message = "Source folder is missing.";
  } else if (targetExists && isExpectedLink(targetPath, mapping.sourcePath)) {
    status = "mapped";
    message = "Project documents are available in the AMO vault.";
  } else if (targetExists) {
    status = "conflict";
    message = "Target path exists but points somewhere else.";
  }

  return {
    label: path.basename(mapping.sourcePath),
    sourcePath: mapping.sourcePath,
    sourceRelativePath: mapping.sourceRelativePath,
    targetPath,
    targetRelativePath: mapping.targetRelativePath,
    type: mapping.type || "junction",
    configured,
    sourceExists,
    targetExists,
    status,
    message,
  };
}

function normalizeConfiguredMappings(workspacePath, value) {
  if (!Array.isArray(value)) return [];
  const mappings = [];
  for (const entry of value) {
    const sourceRelativePath = normalizeText(entry?.sourceRelativePath || entry?.source_relative_path);
    const targetRelativePath = normalizeText(entry?.targetRelativePath || entry?.target_relative_path);
    if (!sourceRelativePath || !targetRelativePath) continue;
    const sourcePath = path.resolve(workspacePath, ...sourceRelativePath.split(/[\\/]+/u));
    mappings.push({
      ...entry,
      sourcePath,
      sourceRelativePath: workspaceRelativePath(workspacePath, sourcePath),
      targetRelativePath: targetRelativePath.split(path.sep).join("/"),
    });
  }
  return mappings;
}

function validateSourcePath(workspacePath, vaultRoot, sourcePath) {
  if (!isSameOrDescendantPath(workspacePath, sourcePath) || pathKey(workspacePath) === pathKey(sourcePath)) {
    throw httpError(400, "document_mapping_outside_workspace", "Document mappings must select a folder inside the workspace.");
  }
  const amoRoot = path.join(workspacePath, AMO_DIR);
  if (isSameOrDescendantPath(amoRoot, sourcePath)) {
    throw httpError(400, "document_mapping_inside_amo", "Folders inside .amo cannot be mapped back into the AMO vault.");
  }
  if (isSameOrDescendantPath(sourcePath, vaultRoot)) {
    throw httpError(400, "document_mapping_recursive", "The selected folder contains the AMO vault and would create a recursive mapping.");
  }
}

function resolveConfiguredVaultRoot(workspacePath, workspaceConfig) {
  const configured = normalizeText(workspaceConfig?.vaultRoot || workspaceConfig?.vault_root);
  if (!configured) {
    throw httpError(409, "workspace_vault_missing", "Workspace metadata does not define vaultRoot. Redeploy the workspace first.");
  }
  const vaultRoot = path.isAbsolute(configured)
    ? path.resolve(configured)
    : path.resolve(workspacePath, AMO_DIR, configured);
  if (!isDirectory(vaultRoot)) {
    throw httpError(409, "workspace_vault_not_found", `AMO vault does not exist: ${vaultRoot}`);
  }
  return vaultRoot;
}

function serializableMapping(mapping) {
  return {
    sourceRelativePath: mapping.sourceRelativePath,
    targetRelativePath: mapping.targetRelativePath,
    type: mapping.type || "junction",
    ...(mapping.createdAt ? { createdAt: mapping.createdAt } : {}),
    ...(mapping.updatedAt ? { updatedAt: mapping.updatedAt } : {}),
  };
}

function mappingResult(workspacePath, vaultRoot, changed, status) {
  return {
    ok: true,
    schemaVersion: AMO_SCHEMA_VERSION,
    changed,
    workspacePath,
    vaultRoot,
    documentMappings: status,
  };
}

function recordMappingEvent(options, event, data) {
  const recordDebugLog = typeof options.recordDebugLog === "function" ? options.recordDebugLog : () => {};
  recordDebugLog("broker", event, data);
}

function pathExists(targetPath) {
  try {
    fs.lstatSync(targetPath);
    return true;
  } catch {
    return false;
  }
}

function isDirectory(targetPath) {
  try {
    return fs.statSync(targetPath).isDirectory();
  } catch {
    return false;
  }
}

function isExpectedLink(targetPath, sourcePath) {
  try {
    if (!fs.lstatSync(targetPath).isSymbolicLink()) return false;
    return pathKey(fs.realpathSync(targetPath)) === pathKey(fs.realpathSync(sourcePath));
  } catch {
    return false;
  }
}

function pathKey(value) {
  const normalized = path.resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function workspaceRelativePath(workspacePath, targetPath) {
  return path.relative(workspacePath, targetPath).split(path.sep).join("/");
}

module.exports = {
  inspectWorkspaceDocumentMappings,
  updateWorkspaceDocumentMapping,
  validateSourcePath,
};
