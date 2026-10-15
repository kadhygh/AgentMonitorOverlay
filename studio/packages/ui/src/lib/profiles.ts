import type { ModelProfile } from "@amo-studio/protocol";

/** "Codex · DeepSeek", "Codex · GPT", "Claude · GLM" — the account behind a model. */
export function profileLabel(p: ModelProfile): string {
  return `${p.runtime === "codex" ? "Codex" : "Claude"} · ${p.label}`;
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

/** What the model pickers offer: the profiles not hidden in 设置 → 模型, plus the one already chosen. */
export function pickable(profiles: readonly ModelProfile[], keep?: string | null): ModelProfile[] {
  return profiles.filter((p) => !p.hidden || p.id === keep);
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

const DEFAULT_PROJECT_KEY = "amo.defaultProject";

/** 设置 → 项目与目录 → 默认项目 (2026-10-15): the project a new task starts in unless opened from another one; per machine. */
export const defaultProjectSetting = (): string | null => read(DEFAULT_PROJECT_KEY) || null;
export const setDefaultProject = (id: string | null) => write(DEFAULT_PROJECT_KEY, id ?? "");

/** The default project if it is still one of these (not removed or archived); else none (the common folder). */
export function defaultProjectFor(projects: ReadonlyArray<{ id: string }>): string | null {
  const id = defaultProjectSetting();
  return id && projects.some((p) => p.id === id) ? id : null;
}
