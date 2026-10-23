import { HostApiError, type HostLink } from "../host/client.js";

// The 便签 program's own routes (packages/notes/src/server.ts, 2026-10-23): not Host routes, so not in HostRoute.

export interface NotesSettings {
  workFolder: string | null;
  shortcut: string;
  safeNewlines: boolean;
  openAtLogin: boolean;
  importedAt: string | null;
  importNoticeSeen: boolean;
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

export async function notesCall<T = NotesInfo>(link: HostLink, method: "GET" | "PATCH" | "POST", path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${link.url}/api/notes${path}`, {
    method,
    headers: { authorization: `Bearer ${link.token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = (await res.json()) as T & { error?: { code: string; message: string } };
  if (!res.ok) throw new HostApiError(res.status, data.error?.code ?? "internal", data.error?.message ?? res.statusText);
  return data;
}

/** 3.4 MB, 18 KB, 0 B. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
