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

/** Last used profile, else the first routed (non-default) profile, else the first one. */
export function defaultProfile(profiles: readonly ModelProfile[]): ModelProfile | undefined {
  const last = read(LAST_PROFILE_KEY);
  return profiles.find((p) => p.id === last) ?? profiles.find((p) => p.provider) ?? profiles[0];
}
export const rememberProfile = (id: string) => write(LAST_PROFILE_KEY, id);
export const lastWorkspace = () => read(LAST_WORKSPACE_KEY);
export const rememberWorkspace = (id: string) => write(LAST_WORKSPACE_KEY, id);
