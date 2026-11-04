import { RUNTIME_LABELS, type ModelProfile } from "@amo-studio/protocol";
import { pickDirectory } from "../folders/FolderPicker.js";
import { readStored, writeStored } from "./stored.js";

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

const read = readStored;
const write = (key: string, value: string): void => writeStored(key, value);

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
/**
 * The pick a form should switch to once its model is hidden in 设置 → 模型 (or can no longer start sessions), or `null`
 * to leave it. 2026-11-03 (问题 #14, the user): the default was chosen once, when the form opened, so hiding Codex left
 * Codex picked on 新建任务 and 新会话 until Studio restarted. An empty pick (profiles not loaded yet) takes the default too.
 */
export function repick(all: readonly ModelProfile[], id: string): string | null {
  if (!all.length) return null;
  const p = all.find((x) => x.id === id);
  if (p && !p.hidden && !p.unavailable) return null;
  const next = defaultProfile(all)?.id ?? "";
  return next !== id ? next : null;
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
/** 选择文件夹 (Studio's own picker since 2026-10-25), starting at the default path. */
export const pickFolder = (): Promise<string | null> => pickDirectory(defaultFolder() || null);
