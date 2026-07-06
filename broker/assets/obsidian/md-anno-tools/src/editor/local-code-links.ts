import { DEFAULT_SETTINGS } from "../core/constants";

export interface LocalCodeLink {
  filePath: string;
  line: number;
  column: number | null;
}

export const LOCAL_CODE_LINK_TEXT_REGEX = /\b[A-Za-z]:[\\/][^\s<>"'`]+?:\d+(?::\d+)?/gu;

const MARKDOWN_LINK_WITH_TARGET_REGEX = /!?\[[^\]]*?\]\((<[^>]+>|[^\s)]+)(?:\s+["'][^"']*["'])?\)/gu;

export function findLocalCodeLinkTargetInLine(lineText: string, offset: number) {
  const text = String(lineText || "");
  const safeOffset = Number.isFinite(offset) ? Math.max(0, Math.min(text.length, offset)) : 0;

  MARKDOWN_LINK_WITH_TARGET_REGEX.lastIndex = 0;
  for (const match of text.matchAll(MARKDOWN_LINK_WITH_TARGET_REGEX) as Iterable<RegExpMatchArray>) {
    const fullMatch = match[0] || "";
    const linkTarget = match[1] || "";
    const start = match.index || 0;
    const end = start + fullMatch.length;
    if (start <= safeOffset && safeOffset <= end && parseLocalCodeLink(linkTarget, linkTarget)) {
      MARKDOWN_LINK_WITH_TARGET_REGEX.lastIndex = 0;
      return linkTarget;
    }
  }
  MARKDOWN_LINK_WITH_TARGET_REGEX.lastIndex = 0;

  LOCAL_CODE_LINK_TEXT_REGEX.lastIndex = 0;
  for (const match of text.matchAll(LOCAL_CODE_LINK_TEXT_REGEX) as Iterable<RegExpMatchArray>) {
    const linkTarget = match[0] || "";
    const start = match.index || 0;
    const end = start + linkTarget.length;
    if (start <= safeOffset && safeOffset <= end && parseLocalCodeLink(linkTarget, linkTarget)) {
      LOCAL_CODE_LINK_TEXT_REGEX.lastIndex = 0;
      return linkTarget;
    }
  }
  LOCAL_CODE_LINK_TEXT_REGEX.lastIndex = 0;

  return "";
}

export function parseLocalCodeLink(rawHref: string, absoluteHref: string): LocalCodeLink | null {
  const candidates = [rawHref, absoluteHref].filter((value) => typeof value === "string" && value.trim().length > 0);
  for (const candidate of candidates) {
    const value = normalizeLocalCodeLinkHref(candidate);
    const match = value.match(/^([A-Za-z]:[\\/][\s\S]*?)(?::(\d+)(?::(\d+))?)?(?:[?#].*)?$/u);
    if (!match) continue;

    const line = match[2] ? Number.parseInt(match[2], 10) : null;
    if (!Number.isSafeInteger(line) || line <= 0) continue;

    const column = match[3] ? Number.parseInt(match[3], 10) : null;
    return {
      filePath: match[1],
      line,
      column: Number.isSafeInteger(column) && column > 0 ? column : null,
    };
  }

  return null;
}

export function normalizeLocalCodeLinkHref(value: string) {
  let text = safeDecodeUri(String(value || "").trim());
  if (text.startsWith("<") && text.endsWith(">")) text = text.slice(1, -1).trim();

  if (/^app:\/\/obsidian\.md\//iu.test(text)) {
    try {
      const url = new URL(text);
      text = safeDecodeUri(url.pathname);
    } catch {
      text = text.replace(/^app:\/\/obsidian\.md\/+/iu, "");
    }
  }

  if (/^file:\/\//iu.test(text)) {
    try {
      const url = new URL(text);
      text = safeDecodeUri(url.pathname);
    } catch {
      text = text.replace(/^file:\/+/iu, "");
    }
  }

  text = text.replace(/^\/([A-Za-z]:[\\/])/u, "$1");
  return text;
}

export function looksLikeLocalCodeLinkCandidate(value: string) {
  return /^[A-Za-z]:[\\/]/u.test(normalizeLocalCodeLinkHref(value || ""));
}

function safeDecodeUri(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    try {
      return decodeURI(value);
    } catch {
      return value;
    }
  }
}

export function normalizeLocalCodeLinkEditor(value: string) {
  if (value === "zed" || value === "custom-url") return value;
  return "vscode";
}

export function formatLocalCodeLinkUrl(link: LocalCodeLink, template: string) {
  const pathForUrl = encodeCodeLinkPath(link.filePath);
  const rawPath = String(link.filePath || "").replace(/\\/gu, "/");
  const line = String(link.line || 1);
  const column = String(link.column || 1);
  const sourceTemplate = String(template || DEFAULT_SETTINGS.localCodeLinkUrlTemplate || "").trim();
  const resolvedTemplate = sourceTemplate || DEFAULT_SETTINGS.localCodeLinkUrlTemplate;
  return resolvedTemplate
    .replace(/\{rawPath\}/gu, rawPath)
    .replace(/\{path\}/gu, pathForUrl)
    .replace(/\{line\}/gu, line)
    .replace(/\{column\}/gu, column);
}

export function formatZedCodeLinkTarget(link: LocalCodeLink) {
  const path = normalizeWindowsCodePath(String(link.filePath || ""));
  const line = Number.isSafeInteger(link.line) && link.line > 0 ? link.line : 1;
  const column = Number.isSafeInteger(link.column) && link.column > 0 ? link.column : null;
  return path + ":" + line + (column ? ":" + column : "");
}

function normalizeWindowsCodePath(filePath: string) {
  return /^[A-Za-z]:\//u.test(filePath) ? filePath.replace(/\//gu, "\\") : filePath;
}

export function createLocalCodeLinkElement(target: string) {
  const anchor = document.createElement("a");
  anchor.classList.add("amo-local-code-link");
  anchor.setAttribute("href", target);
  anchor.setAttribute("data-amo-code-link", target);
  anchor.setAttribute("title", "Open in configured code editor");
  anchor.textContent = target;
  return anchor;
}

function encodeCodeLinkPath(filePath: string) {
  return encodeURI(String(filePath || "").replace(/\\/gu, "/")).replace(/#/gu, "%23").replace(/\?/gu, "%3F");
}

export async function openZedCodeLink(link: LocalCodeLink, command: string) {
  const electronRequire = (window as any).require || (globalThis as any).require;
  if (typeof electronRequire !== "function") {
    throw new Error("Zed CLI launch is unavailable in this Obsidian runtime");
  }

  const childProcess = electronRequire("child_process");
  const spawn = childProcess && childProcess.spawn;
  if (typeof spawn !== "function") {
    throw new Error("Zed CLI launch is unavailable in this Obsidian runtime");
  }

  const executable = normalizeExecutableCommand(command) || DEFAULT_SETTINGS.zedCommand;
  const target = formatZedCodeLinkTarget(link);
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let child;
    try {
      child = spawn(executable, [target], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
    } catch (error) {
      reject(error);
      return;
    }

    const settle = (callback, value?) => {
      if (settled) return;
      settled = true;
      callback(value);
    };

    child.once("error", (error) => settle(reject, error));
    child.once("spawn", () => {
      if (typeof child.unref === "function") child.unref();
      settle(resolve);
    });
  });
}

function normalizeExecutableCommand(value: string) {
  return String(value || "")
    .trim()
    .replace(/^"([\s\S]+)"$/u, "$1")
    .replace(/^'([\s\S]+)'$/u, "$1");
}

export async function openExternalCodeUrl(url: string) {
  const electronRequire = (window as any).require || (globalThis as any).require;
  const shell = typeof electronRequire === "function" ? electronRequire("electron")?.shell : null;
  if (shell && typeof shell.openExternal === "function") {
    await shell.openExternal(url);
    return;
  }

  const opened = window.open(url, "_blank");
  if (!opened) {
    throw new Error("No external URL opener is available in this Obsidian runtime");
  }
}
