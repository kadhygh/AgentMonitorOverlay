import { request, type HostLink } from "../host/client.js";

// The 便签 program's own routes (packages/notes/src/server.ts, 2026-10-23): not Host routes, so not in HostRoute.

export interface NotesSettings {
  workFolder: string | null;
  shortcut: string;
  safeNewlines: boolean;
  openAtLogin: boolean;
  importedAt: string | null;
  importNoticeSeen: boolean;
  /** 界面大小 of its windows (its own, not Studio's). */
  uiScale: number;
  /** 主题 (2026-10-29): the program sets it for all its windows. */
  theme: "light" | "dark" | "system";
  /** 使用待办 (2026-11-01): on unless turned off. */
  useTodo: boolean;
  /** 已完成保留 (days; 0 = 一直留着). */
  todoKeepDays: number;
}

export interface NotesInfo {
  settings: NotesSettings;
  home: string;
  settingsFile: string;
  folder: string;
  defaultFolder: string;
  cacheDir: string;
  usage: { pages: number; images: number; cache: number };
  shortcut: { wanted: string; active: string; error: string | null };
}

/** Whether this window belongs to the 便签 program (not to Studio). */
export const inNotesProgram = (): boolean => !!window.amo?.notes;

export const notesCall = <T = NotesInfo>(link: HostLink, method: "GET" | "PATCH" | "POST", path: string, body?: unknown): Promise<T> =>
  request<T>(link, method, `/api/notes${path}`, body);

