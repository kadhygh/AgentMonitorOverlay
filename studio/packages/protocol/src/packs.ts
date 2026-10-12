// Project extension packs: `<workspace>/.amo/packs/<name>/pack.json`. A pack comes from the project's files (possibly
// committed by someone else), so everything in it is treated as untrusted: it is only read, never run; paths cannot
// leave the pack or the workspace; texts are bounded. Format: design/pack-format.md.

export const PACK_SCHEMA_VERSION = 1;
export const PACKS_DIR = ".amo/packs";
export const PACK_MANIFEST = "pack.json";

export interface PackDoc {
  id: string;
  title: string;
  /** Relative to the pack directory. */
  path: string;
  summary?: string;
}

export interface PackTemplate {
  id: string;
  title: string;
  /** Put in front of the task title, e.g. "[武器] ". */
  titlePrefix?: string;
  description?: string;
  /** The task's checklist. */
  steps: string[];
}

export interface PackPreset {
  id: string;
  title: string;
  /** A model profile id; Studio falls back to the default profile when it is unknown. */
  profile?: string;
  /** The first message; may use the variables in PRESET_VARIABLES ({{pack.dir}} is relative to the workspace). */
  prompt: string;
  /** Relative to the workspace; listed in the prompt for the agent to read. */
  contextFiles?: string[];
}

/** Reserved: project-specific MCP tools. Listed, never run (stage 6). */
export interface PackTool {
  name: string;
  description?: string;
}

export interface PackManifest {
  schemaVersion: 1;
  name: string;
  title: string;
  description?: string;
  docs: PackDoc[];
  templates: PackTemplate[];
  presets: PackPreset[];
  tools: PackTool[];
}

export type PackValidation = { ok: true; manifest: PackManifest; warnings: string[] } | { ok: false; errors: string[]; warnings: string[] };

export const PRESET_VARIABLES = ["task.title", "workspace.path", "pack.dir"] as const;

export const PACK_LIMITS = {
  items: 50,
  steps: 50,
  contextFiles: 20,
  title: 100,
  description: 2000,
  step: 500,
  prompt: 8000,
  path: 260,
  // Read by the Host:
  packs: 20,
  manifestBytes: 256 * 1024,
  docBytes: 512 * 1024,
} as const;

const ID = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const KNOWN_KEYS = ["schemaVersion", "name", "title", "description", "docs", "templates", "presets", "tools"];

/**
 * A relative path that stays inside its base, normalised to forward slashes; null when it is absolute, has a drive or
 * stream (":"), climbs out ("..") or is otherwise unusable. Symbolic links are checked by whoever reads the file.
 */
export function safeRelativePath(value: string): string | null {
  if (!value || value.length > PACK_LIMITS.path || value.includes("\0") || value.includes(":")) return null;
  const p = value.replace(/\\/g, "/");
  if (p.startsWith("/") || p.startsWith("~")) return null;
  const parts = p.split("/").filter((s) => s !== "" && s !== ".");
  if (!parts.length || parts.some((s) => s === "..")) return null;
  return parts.join("/");
}

/** `{{name}}` variables used in a preset prompt. */
export function presetVariables(prompt: string): string[] {
  return [...prompt.matchAll(/\{\{\s*([^{}]*?)\s*\}\}/g)].map((m) => m[1] ?? "");
}

export function renderPresetPrompt(prompt: string, values: Record<(typeof PRESET_VARIABLES)[number], string>): string {
  return prompt.replace(/\{\{\s*([^{}]*?)\s*\}\}/g, (all, name: string) => (name in values ? values[name as keyof typeof values] : all));
}

class Checker {
  errors: string[] = [];
  warnings: string[] = [];

  text(where: string, value: unknown, max: number, required: boolean): string | undefined {
    if (value === undefined && !required) return undefined;
    if (typeof value !== "string" || (required && !value.trim())) {
      this.errors.push(`${where}: ${required ? "必填，" : ""}应为字符串`);
      return undefined;
    }
    if (value.length > max) {
      this.errors.push(`${where}: 太长（${value.length} 字，最多 ${max}）`);
      return undefined;
    }
    return value.trim();
  }

  id(where: string, value: unknown, seen: Set<string>): string | undefined {
    if (typeof value !== "string" || !ID.test(value)) {
      this.errors.push(`${where}: 应为小写字母、数字、- 或 _，最长 40 个字符`);
      return undefined;
    }
    if (seen.has(value)) this.errors.push(`${where}: 重复的 id "${value}"`);
    seen.add(value);
    return value;
  }

  path(where: string, value: unknown): string | undefined {
    if (typeof value !== "string") {
      this.errors.push(`${where}: 应为字符串路径`);
      return undefined;
    }
    const p = safeRelativePath(value);
    if (!p) this.errors.push(`${where}: 路径 "${value}" 不允许（只能是相对路径，不能含 ".." 或盘符）`);
    return p ?? undefined;
  }

  list(where: string, value: unknown, max: number): unknown[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
      this.errors.push(`${where}: 应为数组`);
      return [];
    }
    if (value.length > max) this.errors.push(`${where}: 太多（${value.length} 项，最多 ${max}）`);
    return value.slice(0, max);
  }

  object(where: string, value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      this.errors.push(`${where}: 应为对象`);
      return null;
    }
    return value as Record<string, unknown>;
  }
}

/** Checks a parsed pack.json. Unknown top-level keys are warnings (a newer format), everything else is an error. */
export function validatePackManifest(raw: unknown): PackValidation {
  const c = new Checker();
  const m = c.object("pack.json", raw);
  if (!m) return { ok: false, errors: c.errors, warnings: c.warnings };
  if (m.schemaVersion !== PACK_SCHEMA_VERSION) c.errors.push(`schemaVersion: 应为 ${PACK_SCHEMA_VERSION}`);
  for (const key of Object.keys(m)) if (!KNOWN_KEYS.includes(key)) c.warnings.push(`未知字段 "${key}"，已忽略`);
  const name = c.id("name", m.name, new Set());
  const title = c.text("title", m.title, PACK_LIMITS.title, true);
  const description = c.text("description", m.description, PACK_LIMITS.description, false);

  const docIds = new Set<string>();
  const docs: PackDoc[] = [];
  c.list("docs", m.docs, PACK_LIMITS.items).forEach((d, i) => {
    const o = c.object(`docs[${i}]`, d);
    if (!o) return;
    const doc = {
      id: c.id(`docs[${i}].id`, o.id, docIds),
      title: c.text(`docs[${i}].title`, o.title, PACK_LIMITS.title, true),
      path: c.path(`docs[${i}].path`, o.path),
      summary: c.text(`docs[${i}].summary`, o.summary, PACK_LIMITS.description, false),
    };
    if (doc.id && doc.title && doc.path) docs.push({ id: doc.id, title: doc.title, path: doc.path, ...(doc.summary ? { summary: doc.summary } : {}) });
  });

  const templateIds = new Set<string>();
  const templates: PackTemplate[] = [];
  c.list("templates", m.templates, PACK_LIMITS.items).forEach((t, i) => {
    const o = c.object(`templates[${i}]`, t);
    if (!o) return;
    const id = c.id(`templates[${i}].id`, o.id, templateIds);
    const tTitle = c.text(`templates[${i}].title`, o.title, PACK_LIMITS.title, true);
    const titlePrefix = c.text(`templates[${i}].titlePrefix`, o.titlePrefix, PACK_LIMITS.title, false);
    const tDescription = c.text(`templates[${i}].description`, o.description, PACK_LIMITS.description, false);
    const steps = c.list(`templates[${i}].steps`, o.steps, PACK_LIMITS.steps).map((s, j) => c.text(`templates[${i}].steps[${j}]`, s, PACK_LIMITS.step, true));
    if (!steps.length) c.errors.push(`templates[${i}].steps: 至少要有一步`);
    if (id && tTitle && steps.length && steps.every(Boolean)) {
      templates.push({ id, title: tTitle, ...(titlePrefix ? { titlePrefix: `${titlePrefix} ` } : {}), ...(tDescription ? { description: tDescription } : {}), steps: steps as string[] });
    }
  });

  const presetIds = new Set<string>();
  const presets: PackPreset[] = [];
  c.list("presets", m.presets, PACK_LIMITS.items).forEach((p, i) => {
    const o = c.object(`presets[${i}]`, p);
    if (!o) return;
    const id = c.id(`presets[${i}].id`, o.id, presetIds);
    const pTitle = c.text(`presets[${i}].title`, o.title, PACK_LIMITS.title, true);
    const profile = c.text(`presets[${i}].profile`, o.profile, PACK_LIMITS.title, false);
    const prompt = c.text(`presets[${i}].prompt`, o.prompt, PACK_LIMITS.prompt, true);
    for (const v of prompt ? presetVariables(prompt) : []) {
      if (!(PRESET_VARIABLES as readonly string[]).includes(v)) c.errors.push(`presets[${i}].prompt: 未知变量 {{${v}}}（可用：${PRESET_VARIABLES.join("、")}）`);
    }
    const files = c.list(`presets[${i}].contextFiles`, o.contextFiles, PACK_LIMITS.contextFiles).map((f, j) => c.path(`presets[${i}].contextFiles[${j}]`, f));
    if (id && pTitle && prompt && files.every(Boolean)) {
      presets.push({ id, title: pTitle, ...(profile ? { profile } : {}), prompt, ...(files.length ? { contextFiles: files as string[] } : {}) });
    }
  });

  const tools: PackTool[] = [];
  c.list("tools", m.tools, PACK_LIMITS.items).forEach((t, i) => {
    const o = c.object(`tools[${i}]`, t);
    if (!o) return;
    const tName = c.text(`tools[${i}].name`, o.name, PACK_LIMITS.title, true);
    const tDescription = c.text(`tools[${i}].description`, o.description, PACK_LIMITS.description, false);
    if (tName) tools.push({ name: tName, ...(tDescription ? { description: tDescription } : {}) });
  });
  if (tools.length) c.warnings.push("tools: 专用工具目前只是预留，不会运行");

  if (c.errors.length || !name || !title) return { ok: false, errors: c.errors, warnings: c.warnings };
  return { ok: true, manifest: { schemaVersion: 1, name, title, ...(description ? { description } : {}), docs, templates, presets, tools }, warnings: c.warnings };
}

/** A pack as the Host found it in a workspace: the manifest when it is valid, its problems otherwise. */
export interface WorkspacePack {
  /** The directory name under .amo/packs. */
  dirName: string;
  /** Absolute directory of the pack. */
  dir: string;
  manifest: PackManifest | null;
  errors: string[];
  warnings: string[];
}

/** One pack document, read. */
export interface PackDocContent {
  pack: string;
  id: string;
  title: string;
  path: string;
  text: string;
}

/** A session preset filled in for one task: what the new-session form is prefilled with, for the person to confirm. */
export interface PresetDraft {
  presetId: string;
  title: string;
  /** The workspace the session would run in (where the pack is). */
  workspaceId: string;
  /** The preset's model profile, or null to use the default (none given, or unknown here). */
  profileId: string | null;
  /** The prompt with variables filled in, followed by the context files to read. */
  text: string;
  contextFiles: string[];
  warnings: string[];
}
