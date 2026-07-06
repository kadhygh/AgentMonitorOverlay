const fs = require("fs");
const path = require("path");
const { httpError } = require("./http");

function resolveWorkspacePath(value) {
  const rawPath = normalizeText(value);
  if (!rawPath) {
    throw httpError(400, "missing_workspace_path", "Payload must include workspacePath");
  }

  const workspacePath = path.resolve(rawPath);
  let stat;
  try {
    stat = fs.statSync(workspacePath);
  } catch {
    throw httpError(404, "workspace_not_found", `Workspace path does not exist: ${workspacePath}`);
  }

  if (!stat.isDirectory()) {
    throw httpError(400, "workspace_not_directory", `Workspace path must be a directory: ${workspacePath}`);
  }

  return fs.realpathSync(workspacePath);
}

function resolveDirectoryPath(value, label, code) {
  const rawPath = normalizeText(value);
  if (!rawPath) {
    throw httpError(400, `missing_${code}`, `Payload must include ${label}`);
  }

  const targetPath = path.resolve(rawPath);
  let stat;
  try {
    stat = fs.statSync(targetPath);
  } catch {
    throw httpError(404, `${code}_not_found`, `${label} does not exist: ${targetPath}`);
  }

  if (!stat.isDirectory()) {
    throw httpError(400, `${code}_not_directory`, `${label} must be a directory: ${targetPath}`);
  }

  return fs.realpathSync(targetPath);
}

function findNearestGitRoot(startPath) {
  let current = path.resolve(startPath);
  while (true) {
    if (resolveGitDirectoryPath(current)) {
      return fs.realpathSync(current);
    }
    const parent = path.dirname(current);
    if (parent === current) return "";
    current = parent;
  }
}

function resolveGitDirectoryPath(gitRootPath) {
  const dotGitPath = path.join(gitRootPath, ".git");
  if (!fs.existsSync(dotGitPath)) return "";

  try {
    const stat = fs.statSync(dotGitPath);
    if (stat.isDirectory()) return fs.realpathSync(dotGitPath);
    if (!stat.isFile()) return "";

    const text = fs.readFileSync(dotGitPath, "utf8");
    const match = text.match(/^gitdir:\s*(.+)\s*$/imu);
    if (!match) return "";

    const gitDirCandidate = path.isAbsolute(match[1]) ? match[1] : path.resolve(gitRootPath, match[1]);
    const gitDirStat = fs.statSync(gitDirCandidate);
    return gitDirStat.isDirectory() ? fs.realpathSync(gitDirCandidate) : "";
  } catch {
    return "";
  }
}

function isSameOrDescendantPath(parentPath, childPath) {
  const relative = path.relative(parentPath, childPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function ensureInsideDirectory(root, target) {
  const normalizedRoot = path.resolve(root);
  const normalizedTarget = path.resolve(target);
  const relative = path.relative(normalizedRoot, normalizedTarget);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw httpError(400, "unsafe_path", `Refusing to clean path outside vault: ${normalizedTarget}`);
  }
}

function isWritableDirectory(dirPath) {
  try {
    fs.accessSync(dirPath, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function readDirectoryNames(dirPath) {
  try {
    return fs.readdirSync(dirPath);
  } catch {
    return [];
  }
}

function readJsonFile(filePath, fallback) {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }

  try {
    return JSON.parse(readJsonTextFile(filePath));
  } catch {
    return fallback;
  }
}

function readJsonFileStrict(filePath) {
  try {
    return JSON.parse(readJsonTextFile(filePath));
  } catch (error) {
    throw httpError(409, "invalid_existing_json", `${filePath} is not valid JSON: ${error.message}`);
  }
}

function readJsonTextFile(filePath) {
  return fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/u, "");
}

function writeJsonFile(filePath, payload) {
  writeTextFile(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

function writeTextFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpFile = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpFile, content, "utf8");
  fs.renameSync(tmpFile, filePath);
}

function normalizeText(value) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

module.exports = {
  ensureInsideDirectory,
  findNearestGitRoot,
  isSameOrDescendantPath,
  isWritableDirectory,
  readDirectoryNames,
  readJsonFile,
  readJsonFileStrict,
  readJsonTextFile,
  resolveDirectoryPath,
  resolveGitDirectoryPath,
  resolveWorkspacePath,
  writeJsonFile,
  writeTextFile,
};
