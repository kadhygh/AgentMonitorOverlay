import { RUNTIME_LABELS, type ModelProfile } from "@amo-studio/protocol";

/** "Codex · DeepSeek", "Codex · GPT", "Claude · GLM", "DSH · DeepSeek" — the account behind a model. */
export function profileLabel(p: ModelProfile): string {
  return `${RUNTIME_LABELS[p.runtime] ?? p.runtime} · ${p.label}`;
}

/** Short model name for session rows and chat headers. */
export function shortModel(p: ModelProfile | undefined): string {
  return p ? p.label : "未知模型";
}

const LAST_PROFILE_KEY = "amo.lastProfile";
const LAST_WORKSPACE_KEY = "amo.lastWorkspace";

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // per-viewer convenience only
  }
}

/**
 * What the model pickers offer: the profiles not hidden in 设置 → 模型 and able to start sessions (a DSH profile needs
 * its clone set up), plus the one already chosen.
 */
export function pickable(profiles: readonly ModelProfile[], keep?: string | null): ModelProfile[] {
  return profiles.filter((p) => (!p.hidden && !p.unavailable) || p.id === keep);
}

/** Last used profile, else the first routed (non-default) profile, else the first one; never a hidden one. */
export function defaultProfile(all: readonly ModelProfile[]): ModelProfile | undefined {
  const profiles = pickable(all);
  const last = read(LAST_PROFILE_KEY);
  return profiles.find((p) => p.id === last) ?? profiles.find((p) => p.provider) ?? profiles[0] ?? all[0];
}
export const rememberProfile = (id: string) => write(LAST_PROFILE_KEY, id);
export const lastWorkspace = () => read(LAST_WORKSPACE_KEY);
export const rememberWorkspace = (id: string) => write(LAST_WORKSPACE_KEY, id);

const DEFAULT_FOLDER_KEY = "amo.defaultFolder";

/**
 * 设置 → 项目与目录 → 默认路径 (2026-10-17, in place of the 10-15 默认项目): where 选择文件夹 starts when adding a
 * project; per machine.
 */
export const defaultFolder = (): string => read(DEFAULT_FOLDER_KEY) ?? "";
export const setDefaultFolder = (path: string) => write(DEFAULT_FOLDER_KEY, path.trim());
/** 选择文件夹, starting at the default path. */
export const pickFolder = (): Promise<string | null> => window.amo?.pickDirectory?.(defaultFolder() || null) ?? Promise.resolve(null);
