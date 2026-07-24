import * as fs from "fs";
import * as path from "path";
import { normalizeVaultFilePath } from "../core/paths";
import { getVaultRoot, messageFromError } from "../core/ui-utils";
import { normalizeLocalCodeLinkHref } from "./local-code-links";

interface MappedMarkdownLink {
  filePath: string;
}

interface DocumentMapping {
  sourceRelativePath?: string;
  source_relative_path?: string;
  targetRelativePath?: string;
  target_relative_path?: string;
}

interface WorkspaceConfig {
  workspacePath?: string;
  workspace_path?: string;
  documentMappings?: DocumentMapping[];
  document_mappings?: DocumentMapping[];
}
const MARKDOWN_LINK_WITH_TARGET_REGEX = /!?\[[^\]]*?\]\((<[^>]+>|[^\s)]+)(?:\s+["''][^"'']*["''])?\)/gu;


export function parseAbsoluteMarkdownLink(rawHref: string, absoluteHref: string): MappedMarkdownLink | null {
  const candidates = [rawHref, absoluteHref].filter((value) => typeof value === "string" && value.trim().length > 0);
  for (const candidate of candidates) {
    const normalized = normalizeLocalCodeLinkHref(candidate).replace(/[?#].*$/u, "");
    if (/^[A-Za-z]:[\\/][\s\S]*\.md$/iu.test(normalized)) {
      return { filePath: path.resolve(normalized) };
    }
  }
  return null;
}
export function findAbsoluteMarkdownLinkTargetInLine(lineText: string, offset: number) {
  const text = String(lineText || "");
  const safeOffset = Number.isFinite(offset) ? Math.max(0, Math.min(text.length, offset)) : 0;

  MARKDOWN_LINK_WITH_TARGET_REGEX.lastIndex = 0;
  for (const match of text.matchAll(MARKDOWN_LINK_WITH_TARGET_REGEX) as Iterable<RegExpMatchArray>) {
    const fullMatch = match[0] || "";
    const linkTarget = match[1] || "";
    const start = match.index || 0;
    const end = start + fullMatch.length;
    if (start <= safeOffset && safeOffset <= end && parseAbsoluteMarkdownLink(linkTarget, linkTarget)) {
      MARKDOWN_LINK_WITH_TARGET_REGEX.lastIndex = 0;
      return linkTarget;
    }
  }
  MARKDOWN_LINK_WITH_TARGET_REGEX.lastIndex = 0;
  return "";
}

export function openMappedMarkdownLinkTarget(
  plugin: any,
  rawHref: string,
  sourcePath = "",
  newLeaf = false,
  phase = "unknown"
) {
  const link = parseAbsoluteMarkdownLink(rawHref, rawHref);
  if (!link) return false;
  const vaultPath = resolveMappedMarkdownVaultPath(plugin, link.filePath);
  if (!vaultPath) return false;

  plugin.debugLog("markdown_link.open", { phase, sourcePath, rawHref, filePath: link.filePath, vaultPath, newLeaf });
  void plugin.app.workspace.openLinkText(vaultPath, sourcePath || "", newLeaf).catch((error) => {
    plugin.debugLog("markdown_link.open_error", {
      phase,
      sourcePath,
      rawHref,
      filePath: link.filePath,
      vaultPath,
      message: messageFromError(error),
    });
  });
  return true;
}


export function rewriteMappedMarkdownLinks(plugin: any, root: HTMLElement, sourcePath = "") {
  if (!(root instanceof HTMLElement)) return 0;

  const anchors = Array.from(root.querySelectorAll("a[href], a[data-href]")) as HTMLElement[];
  if (root.matches("a[href], a[data-href]")) anchors.unshift(root);
  let rewrittenCount = 0;

  for (const anchor of anchors) {
    const rawHref = anchor.getAttribute("data-href") || anchor.getAttribute("href") || "";
    const absoluteHref = anchor instanceof HTMLAnchorElement ? anchor.href : rawHref;
    const link = parseAbsoluteMarkdownLink(rawHref, absoluteHref);
    if (!link) continue;

    const vaultPath = resolveMappedMarkdownVaultPath(plugin, link.filePath);
    if (!vaultPath) {
      plugin.debugLog("markdown_link.mapping_miss", { sourcePath, rawHref, filePath: link.filePath });
      continue;
    }

    anchor.classList.remove("external-link");
    anchor.classList.add("internal-link");
    anchor.setAttribute("data-href", vaultPath);
    anchor.setAttribute("href", vaultPath);
    anchor.removeAttribute("target");
    anchor.removeAttribute("rel");
    anchor.setAttribute("data-amo-mapped-markdown", vaultPath);

    anchor.addEventListener(
      "click",
      (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        openMappedMarkdownLinkTarget(plugin, rawHref, sourcePath, true, "reading");
      },
      { capture: true }
    );

    plugin.debugLog("markdown_link.rewritten", { sourcePath, rawHref, filePath: link.filePath, vaultPath });
    rewrittenCount += 1;
  }

  return rewrittenCount;
}

export function resolveMappedMarkdownVaultPath(plugin: any, filePath: string) {
  const vaultRoot = getVaultRoot(plugin.app);
  if (!vaultRoot) return "";

  const directVaultPath = relativeDescendantPath(vaultRoot, filePath);
  if (directVaultPath != null) return normalizeVaultFilePath(directVaultPath);

  const config = readWorkspaceConfig(vaultRoot);
  if (!config) return "";
  const workspacePath = config.workspacePath || config.workspace_path;
  if (!workspacePath) return "";

  const mappings = config.documentMappings || config.document_mappings || [];
  for (const mapping of mappings) {
    const sourceRelativePath = mapping.sourceRelativePath || mapping.source_relative_path;
    const targetRelativePath = mapping.targetRelativePath || mapping.target_relative_path;
    if (!sourceRelativePath || !targetRelativePath) continue;

    const sourceRoot = path.resolve(workspacePath, ...sourceRelativePath.split(/[\\/]+/u));
    const relativePath = relativeDescendantPath(sourceRoot, filePath);
    if (relativePath == null) continue;
    return normalizeVaultFilePath(path.posix.join(targetRelativePath.replace(/\\/gu, "/"), relativePath));
  }

  return "";
}

function readWorkspaceConfig(vaultRoot: string): WorkspaceConfig | null {
  const configPath = path.resolve(vaultRoot, "..", "workspace.json");
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    return null;
  }
}

function relativeDescendantPath(rootPath: string, targetPath: string) {
  const relativePath = path.relative(path.resolve(rootPath), path.resolve(targetPath));
  if (relativePath === "") return "";
  if (relativePath === ".." || relativePath.startsWith(".." + path.sep) || path.isAbsolute(relativePath)) return null;
  return relativePath.split(path.sep).join("/");
}
