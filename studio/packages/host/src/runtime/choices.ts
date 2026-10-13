import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ModelOption, PermissionOption } from "@amo-studio/protocol";

// What each CLI lets a session choose besides the profile: permission settings (named as the CLIs name them) and,
// where the CLI cannot be asked, built-in model lists. Codex lists its models through app-server `model/list`;
// Claude Code through `supportedModels()` (see the runtimes).

// ---- Codex ------------------------------------------------------------------------------------------------------

export interface CodexPermission {
  approvalPolicy: "untrusted" | "on-request" | "never";
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
}

const CODEX_PERMISSION_SETTINGS: Record<string, CodexPermission> = {
  ask: { approvalPolicy: "untrusted", sandbox: "danger-full-access" },
  "on-request": { approvalPolicy: "on-request", sandbox: "danger-full-access" },
  "full-auto": { approvalPolicy: "never", sandbox: "danger-full-access" },
  "workspace-write": { approvalPolicy: "on-request", sandbox: "workspace-write" },
  "read-only": { approvalPolicy: "on-request", sandbox: "read-only" },
};

export const CODEX_DEFAULT_PERMISSION = "ask";

/** The Codex settings behind a permission id (unknown ids fall back to the default). */
export function codexPermission(id: string | undefined): CodexPermission {
  return CODEX_PERMISSION_SETTINGS[id ?? CODEX_DEFAULT_PERMISSION] ?? CODEX_PERMISSION_SETTINGS[CODEX_DEFAULT_PERMISSION]!;
}

/** `[windows] sandbox = "…"` in the person's Codex config (read only), or null. */
export function codexWindowsSandbox(codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex")): string | null {
  const file = join(codexHome, "config.toml");
  if (!existsSync(file)) return null;
  let section = "";
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) section = header[1]!.trim();
    else if (section === "windows") {
      const m = /^sandbox\s*=\s*"([^"]*)"/.exec(line);
      if (m) return m[1]!;
    }
  }
  return null;
}

export function codexPermissions(windowsSandbox: string | null = process.platform === "win32" ? codexWindowsSandbox() : null): PermissionOption[] {
  // Spikes S9-01/S9-02: under the "unelevated" Windows sandbox every sandboxed command fails to start.
  const broken = windowsSandbox === "unelevated" ? "你的 Codex 配置用的是 unelevated Windows 沙箱，在它里面命令会启动失败" : undefined;
  return [
    { id: "ask", label: "逐条询问", description: "不进沙箱；除了少数已知安全的只读命令，每条命令都先问你（Codex：untrusted）" },
    { id: "on-request", label: "需要时询问", description: "不进沙箱；agent 觉得有风险时才问（Codex：on-request）" },
    { id: "full-auto", label: "完全访问", description: "不进沙箱，也不再询问，命令直接执行（Codex：never + danger-full-access）" },
    { id: "workspace-write", label: "工作区可写", description: "在 Codex 沙箱里运行，只能写工作区，越界时询问（Codex 的 Auto）", ...(broken ? { unavailable: broken } : {}) },
    { id: "read-only", label: "只读", description: "在 Codex 沙箱里只读运行，要改东西时询问（Codex 的 Read Only）", ...(broken ? { unavailable: broken } : {}) },
  ];
}

// ---- Claude Code ------------------------------------------------------------------------------------------------

export type ClaudePermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";

export const CLAUDE_DEFAULT_PERMISSION: ClaudePermissionMode = "default";

/** Claude Code's permission modes (Shift+Tab in the CLI). */
export const CLAUDE_PERMISSIONS: PermissionOption[] = [
  { id: "default", label: "每次询问", description: "改文件、运行命令前都先问你（Claude Code：default）" },
  { id: "acceptEdits", label: "自动接受编辑", description: "改文件不再问，运行命令仍然问（Claude Code：acceptEdits）" },
  { id: "plan", label: "只做计划", description: "只读代码、给出计划，不改文件也不运行命令（Claude Code：plan）" },
  { id: "bypassPermissions", label: "全部允许", description: "所有操作都不再询问（Claude Code：bypassPermissions）" },
];

export function claudePermissionMode(id: string | undefined): ClaudePermissionMode {
  return CLAUDE_PERMISSIONS.some((p) => p.id === id) ? (id as ClaudePermissionMode) : CLAUDE_DEFAULT_PERMISSION;
}

/** Claude Code's effort levels (/effort). */
export const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

/** When Claude Code cannot be asked (no token yet): its model aliases. */
export const CLAUDE_BUILTIN_MODELS: ModelOption[] = [
  { id: "default", label: "默认（推荐）", efforts: CLAUDE_EFFORTS, isDefault: true },
  { id: "opus", label: "Opus", efforts: CLAUDE_EFFORTS },
  { id: "sonnet", label: "Sonnet", efforts: CLAUDE_EFFORTS },
  { id: "fable", label: "Fable", efforts: CLAUDE_EFFORTS },
  { id: "haiku", label: "Haiku", efforts: CLAUDE_EFFORTS },
];

/** GLM's models through its Anthropic-compatible endpoint (old AMO's GLM presets). */
export const GLM_MODELS: ModelOption[] = [
  { id: "glm-5.3[1m]", label: "GLM-5.3（1M 上下文）", efforts: CLAUDE_EFFORTS },
  { id: "glm-5.3", label: "GLM-5.3", efforts: CLAUDE_EFFORTS },
  { id: "glm-5.2", label: "GLM-5.2", efforts: CLAUDE_EFFORTS },
  { id: "glm-4.7", label: "GLM-4.7", efforts: CLAUDE_EFFORTS },
];

