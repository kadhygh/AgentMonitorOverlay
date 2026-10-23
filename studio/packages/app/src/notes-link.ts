import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { app, ipcMain } from "electron";

// Studio and AMO 便签 (2026-10-23): the scratchpad is a program of its own (packages/notes), so restarting Studio
// never closes it. Studio starts it with itself (in the tray), brings it up from the title bar's 便签, opens its
// settings from 设置 → 便签, and the first time hands it the pages Studio kept. It finds the running one through the
// running.json the program writes in its home.

export interface NotesLinkOptions {
  /** Studio's folder: the program is packages/notes in it, its UI packages/ui/dist. */
  studioRoot: string;
  /** Studio's data dir: the attachments of the pages handed over (and the program's home in tests). */
  dataDir: string;
  host: { url: string; token: string };
  testMode: boolean;
  /** Studio's 界面大小: the 便签 takes the same. */
  uiScale(): number;
  log(line: string): void;
}

export interface NotesLink {
  /** Tells a running 便签 Studio's 界面大小 (after it changed). */
  syncLook(): void;
}

interface Link {
  url: string;
  token: string;
}

export interface NotesStatus {
  running: boolean;
  /** The shortcut it has registered ("" none); what its settings ask for. */
  active?: string;
  wanted?: string;
  error?: string | null;
}

const START_WAIT_MS = 20_000;

export function installNotesLink(o: NotesLinkOptions): NotesLink {
  // Tests keep the program's home in the test's data dir (and stop the program with Studio).
  const home = process.env.AMO_NOTES_HOME ?? (o.testMode ? join(o.dataDir, "notes-home") : join(app.getPath("appData"), "AMO Notes"));
  const appDir = join(o.studioRoot, "packages", "notes");
  let child: ChildProcess | null = null;
  let starting: Promise<Link | null> | null = null;

  const request = async <T>(link: Link, method: string, path: string, body?: unknown, timeoutMs = 3000): Promise<T> => {
    const res = await fetch(`${link.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${link.token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = (await res.json()) as T & { error?: { message?: string } };
    if (!res.ok) throw Object.assign(new Error(data.error?.message ?? `${res.status}`), { status: res.status });
    return data;
  };

  /** The running program, if running.json names one that answers. */
  async function running(): Promise<Link | null> {
    try {
      const file = join(home, "running.json");
      if (!existsSync(file)) return null;
      const r = JSON.parse(readFileSync(file, "utf8")) as Partial<Link>;
      if (!r.url || !r.token) return null;
      const link = { url: r.url, token: r.token };
      await request(link, "GET", "/api/notes", undefined, 1500);
      return link;
    } catch {
      return null;
    }
  }

  /** Starts the program and waits until it answers. */
  async function launch(hidden: boolean): Promise<Link | null> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(AMO_STUDIO_|ELECTRON_RUN_AS_NODE$)/.test(k)) env[k] = v;
    env.AMO_NOTES_HOME = home;
    env.AMO_NOTES_UI_DIR = join(o.studioRoot, "packages", "ui", "dist");
    if (o.testMode) env.AMO_NOTES_TEST = "1";
    const args = [appDir, ...(hidden ? ["--hidden"] : [])];
    if (o.testMode) {
      child = spawn(process.execPath, args, { env, stdio: "ignore", windowsHide: true });
    } else {
      // Through `start`, so it is not Studio's child: ending Studio (even its whole process tree) leaves it running.
      const quote = (s: string) => `"${s}"`;
      const cmd = ["start", '""', quote(process.execPath), ...args.map(quote)].join(" ");
      const p = spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `"${cmd}"`], { env, stdio: "ignore", windowsHide: true, detached: true, windowsVerbatimArguments: true });
      p.unref();
    }
    const deadline = Date.now() + START_WAIT_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
      const link = await running();
      if (link) return link;
    }
    o.log("AMO 便签 did not start");
    return null;
  }

  /** The running program, started (in the tray) when it is not. */
  function ensure(hidden: boolean): Promise<Link | null> {
    starting ??= (async () => (await running()) ?? (await launch(hidden)))().finally(() => (starting = null));
    return starting;
  }

  /** Once: the pages Studio kept go to the program, with their images (only into an empty one). */
  async function handOver(link: Link): Promise<void> {
    try {
      const info = await request<{ settings: { importedAt: string | null } }>(link, "GET", "/api/notes");
      if (info.settings.importedAt) return;
      const doc = await request<{ pages: Array<{ text: string; attachments: string[] }>; activePage: number }>(o.host, "GET", "/api/scratchpad");
      if (doc.pages.every((p) => !p.text && !p.attachments.length)) return;
      const images = doc.pages.flatMap((p) => p.attachments).flatMap((id) => {
        try {
          return [JSON.parse(readFileSync(join(o.dataDir, "attachments", `${id}.json`), "utf8")) as { id: string; name: string; mime: string; path: string; createdAt?: string }];
        } catch {
          return [];
        }
      });
      await request(link, "POST", "/api/notes/import", { pages: doc.pages, pageCount: doc.pages.length, activePage: doc.activePage, images });
      o.log("AMO 便签: Studio's pages handed over");
    } catch (err) {
      // 409: the program has notes of its own already; anything else is tried again next time.
      if ((err as { status?: number }).status !== 409) o.log(`AMO 便签: hand-over failed: ${String(err)}`);
    }
  }

  /** Studio's 界面大小 to the program (it applies it when it differs). */
  async function look(link: Link): Promise<void> {
    await request(link, "POST", "/api/notes/look", { uiScale: o.uiScale() }).catch((err: unknown) => o.log(`AMO 便签: look not sent: ${String(err)}`));
  }

  async function show(): Promise<void> {
    const link = await ensure(false);
    if (!link) throw new Error("便签没有启动起来");
    await look(link);
    await handOver(link);
    await request(link, "POST", "/api/notes/show");
  }

  async function openSettings(): Promise<void> {
    const link = await ensure(true);
    if (!link) throw new Error("便签没有启动起来");
    await look(link);
    await request(link, "POST", "/api/notes/settings-window");
  }

  async function status(): Promise<NotesStatus> {
    const link = await running();
    if (!link) return { running: false };
    const info = await request<{ shortcut: { active: string; wanted: string; error: string | null } }>(link, "GET", "/api/notes").catch(() => null);
    return { running: true, ...(info ? { active: info.shortcut.active, wanted: info.shortcut.wanted, error: info.shortcut.error } : {}) };
  }

  ipcMain.handle("amo:scratchpad-open", () => show());
  ipcMain.handle("amo:notes-status", () => status());
  ipcMain.handle("amo:notes-settings", () => openSettings());
  ipcMain.handle("amo:notes-start", async () => {
    const link = await ensure(true);
    if (link) await Promise.all([look(link), handOver(link)]);
    return status();
  });

  // Studio opening starts it too (in the tray), and hands the pages over the first time. Not in tests: each would
  // start a program; the ones about it press 便签.
  if (!o.testMode) void ensure(true).then((link) => link && Promise.all([look(link), handOver(link)]));
  // Tests stop the program they started; for the person it keeps running when Studio ends.
  if (o.testMode) app.on("will-quit", () => child?.kill());

  return {
    syncLook: () => void running().then((link) => link && look(link)),
  };
}
