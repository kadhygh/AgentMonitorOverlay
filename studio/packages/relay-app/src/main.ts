import { app, BrowserWindow, clipboard, ipcMain, Menu, nativeImage, nativeTheme, Notification, protocol, safeStorage, shell, Tray } from "electron";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  normalizeServer,
  relayHome,
  settingsPath,
  SHELL_VERSION,
  writeSettings,
  type ClientManifest,
  type Health,
  type McpHookup,
  type ShellInfo,
  type UpdateInfo,
} from "@amo-studio/relay";
import { readAccount } from "@amo-studio/account";
import { Accounts } from "./accounts.js";
import { newShellText, readBuildMode, stableExe } from "./build-mode.js";
import { ContentStore, fetchManifest, type InstalledContent } from "./content.js";
import { LOADER_HTML, type LoaderState } from "./loader.js";

// AMO 中转's desktop client (plans/relay.md). This shell is fixed; what people see — login, conversations — is content
// the service hands out (packages/relay-ui), kept in <home>/client and updated without a restart:
//   start → loader (connect, check the version, download content — the first time, or a newer version) → the content's
//   login screen. A version published while it runs is applied by the content when nothing would be lost (it asks the
//   shell to download it, switch, and reload the window). The loader tries an unreachable service again every few seconds.
// The shell also keeps saved accounts (passwords encrypted by the OS), writes the identity this machine's MCP uses,
// runs that MCP with its own exe as Node (no Node install needed), and sits in the tray with notifications.
// Env: AMO_RELAY_HOME (default %APPDATA%\AMO Relay — a second one runs a second client), AMO_RELAY_TEST=1 (window
// off-screen, never focused). Args: --server <address> fills in the address the first time (AMO 平台 passes its own).
// Installed by AMO 平台 (build-mode.ts, 2026-10-28) it never writes into its program folder and has no 更新桌面程序: the
// platform updates the shell; the content still comes from the service.

const here = dirname(fileURLToPath(import.meta.url));
const testMode = process.env.AMO_RELAY_TEST === "1";
const home = relayHome();
const buildMode = readBuildMode(here);
const byPlatform = buildMode === "platform";
const ICON = [join(here, "..", "assets", "icon.png"), join(here, "..", "..", "app", "assets", "icon.png")].find((p) => existsSync(p)) ?? "";
const SCHEME = "relay-app";
const CONTENT_URL = `${SCHEME}://content/index.html`;
const LOADER_URL = `${SCHEME}://shell/loader.html`;

app.setPath("userData", join(home, "electron"));
if (process.platform === "win32") app.setAppUserModelId("AMO.Relay");
protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, supportFetchAPI: true, corsEnabled: true } }]);

const store = new ContentStore(home);
const accounts = new Accounts(home, {
  available: () => safeStorage.isEncryptionAvailable(),
  encrypt: (t) => safeStorage.encryptString(t).toString("base64"),
  decrypt: (d) => safeStorage.decryptString(Buffer.from(d, "base64")),
});

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let server: string | null = null;
let content: InstalledContent | null = null;
let latest: ClientManifest | null = null;
let unread = 0;

/** This desktop program's build (written by relay-release --shell next to main.js); undefined in a dev build. A platform
 * install has none: its version is the platform's (resources/app/package.json), and a stamp left in dist by an earlier
 * relay-release --shell would only be compared with the service's portable zip. */
const BUILD = (() => {
  if (byPlatform) return undefined;
  try {
    return (JSON.parse(readFileSync(join(here, "build.json"), "utf8")) as { build?: string }).build;
  } catch {
    return undefined;
  }
})();

// ---- config (the service address, and the last few connected to: offered when asking for one)

const configFile = join(home, "shell.json");
const RECENT_SERVERS = 3;
function readConfig(): { server?: string; recent?: string[] } {
  try {
    return JSON.parse(readFileSync(configFile, "utf8")) as { server?: string; recent?: string[] };
  } catch {
    return {};
  }
}
const readServer = (): string | null => readConfig().server ?? null;
/** Newest first, the last one connected to at the top. */
function recentServers(): string[] {
  const c = readConfig();
  return [...new Set([c.server, ...(c.recent ?? [])].filter((s): s is string => !!s))].slice(0, RECENT_SERVERS);
}
function saveServer(value: string): void {
  mkdirSync(home, { recursive: true });
  const recent = [value, ...recentServers().filter((s) => s !== value)].slice(0, RECENT_SERVERS);
  writeFileSync(configFile, JSON.stringify({ server: value, recent }, null, 2));
}
const argServer = () => {
  const i = process.argv.indexOf("--server");
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
};

// ---- the window and its pages

const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".json": "application/json" };

function serveScheme(): void {
  protocol.handle(SCHEME, (req) => {
    const url = new URL(req.url);
    if (url.host === "shell") return new Response(LOADER_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
    if (url.host === "content" && content) {
      const file = normalize(join(content.dir, decodeURIComponent(url.pathname)));
      if (file.startsWith(content.dir + sep) && existsSync(file)) return new Response(readFileSync(file), { headers: { "content-type": MIME[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" } });
    }
    return new Response("not found", { status: 404 });
  });
}

function createWindow(): BrowserWindow {
  const w = new BrowserWindow({
    width: 1080,
    height: 720,
    minWidth: 720,
    minHeight: 500,
    title: "AMO 中转",
    icon: ICON || undefined,
    // Studio's ground, light or dark as the system is (the loader follows it too).
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#111316" : "#efede8",
    show: false,
    autoHideMenuBar: true,
    // No system title bar (as AMO Studio): the page's top bar is the title bar and draws the window buttons; on a Mac
    // the traffic lights stay, inset into it.
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
    ...(testMode ? { x: -4000, y: 0, skipTaskbar: true } : {}),
    webPreferences: { preload: join(here, "preload.cjs"), sandbox: true, contextIsolation: true },
  });
  w.setMenu(null);
  w.once("ready-to-show", () => (testMode ? w.showInactive() : w.show()));
  w.on("close", (e) => {
    if (quitting) return;
    e.preventDefault();
    w.hide();
  });
  w.on("focus", () => w.flashFrame(false));
  w.on("maximize", () => w.webContents.send("relay:maximized", true));
  w.on("unmaximize", () => w.webContents.send("relay:maximized", false));
  // Links open in the browser, never in this window.
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  w.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith(`${SCHEME}://`)) {
      e.preventDefault();
      if (/^https?:/i.test(url)) void shell.openExternal(url);
    }
  });
  return w;
}

function showWindow(): void {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  if (testMode) win.showInactive();
  else {
    win.show();
    win.focus();
  }
}

// ---- the loader

let loaderReady: (() => void) | null = null;
type LoaderAnswer = { kind: "server"; value: string } | { kind: "retry" } | { kind: "change" };
let loaderAnswer: ((a: LoaderAnswer) => void) | null = null;

function loaderState(s: LoaderState): void {
  win?.webContents.send("relay:loader-state", s);
}

async function openLoader(): Promise<void> {
  const ready = new Promise<void>((resolve) => (loaderReady = resolve));
  await win!.loadURL(LOADER_URL);
  await ready;
}

const wait = () => new Promise<LoaderAnswer>((resolve) => (loaderAnswer = resolve));
const RETRY_MS = 5000;
/** An answer, or a retry by itself after `ms`. */
const waitOrRetry = (ms: number) => Promise.race([wait(), new Promise<LoaderAnswer>((resolve) => setTimeout(() => resolve({ kind: "retry" }), ms))]);

async function health(address: string): Promise<Health> {
  const res = await fetch(`${address}/api/health`, { signal: AbortSignal.timeout(6000) });
  const h = (await res.json().catch(() => null)) as Health | null;
  if (!res.ok || h?.app !== "amo-relay") throw new Error("这个地址上不是 AMO 中转服务");
  return h;
}

const message = (err: unknown) => {
  const text = err instanceof Error ? err.message : String(err);
  return /fetch failed|ECONNREFUSED|timeout|aborted/i.test(text) ? "连不上，检查地址是否正确、服务是否开着、是否在同一个网络里。" : text;
};

/** Start (or start over, for another address): connect, check, download, then the content. */
async function boot(askAddress = false): Promise<void> {
  await openLoader();
  let address = askAddress ? null : (readServer() ?? argServer());
  let askError: string | null = null;
  // What they typed last: kept in the field after a failed try.
  let tried: string | null = null;
  for (;;) {
    if (!address) {
      loaderState({ step: "ask-server", server: tried ?? server ?? readServer() ?? argServer() ?? "", recent: recentServers(), error: askError });
      const a = await wait();
      if (a.kind !== "server") continue;
      address = normalizeServer(a.value);
      tried = a.value;
      loaderState({ step: "progress", text: `正在连接 ${address}…`, progress: null, server: address });
      try {
        await health(address);
      } catch (err) {
        askError = message(err);
        address = null;
        continue;
      }
    }
    loaderState({ step: "progress", text: "正在连接服务器…", progress: null, server: address });
    let manifest: ClientManifest | null = null;
    let problem: string | null = null;
    try {
      await health(address);
      loaderState({ step: "progress", text: "正在检查更新…", progress: null, server: address });
      manifest = await fetchManifest(address);
    } catch (err) {
      problem = message(err);
    }
    const local = store.current();
    if (!manifest && local) {
      // The service is away: start with what is here; the login screen says it cannot connect.
      server = address;
      return loadContent(local, null);
    }
    if (!manifest) {
      loaderState({ step: "error", text: `${address}\n${problem}\n每 ${RETRY_MS / 1000} 秒自动重试一次。`, server: address, download: null });
      const a = await waitOrRetry(RETRY_MS);
      if (a.kind === "change") address = null;
      askError = null;
      continue;
    }
    server = address;
    saveServer(address);
    if (local && local.version !== manifest.version && manifest.minShell <= SHELL_VERSION) {
      // A newer version: installed now, before anyone is using it.
      try {
        const installed = await store.install(address, manifest, (done, total) =>
          loaderState({ step: "progress", text: `正在更新客户端到 ${manifest!.version}…`, progress: total ? done / total : 0, server: address }),
        );
        return loadContent(installed, manifest);
      } catch {
        // Start with the current one; the login screen offers the update again.
        return loadContent(local, manifest);
      }
    }
    if (!local) {
      if (manifest.minShell > SHELL_VERSION) {
        // From the platform there is nothing to download here: the platform has the newer shell (once it is published).
        loaderState({ step: "error", text: byPlatform ? `服务器上的客户端${newShellText(buildMode)}` : "服务器上的客户端需要更新的桌面程序，请重新下载。", server: address, download: byPlatform ? null : address });
        const a = await wait();
        if (a.kind === "change") address = null;
        continue;
      }
      try {
        const installed = await store.install(address, manifest, (done, total) =>
          loaderState({ step: "progress", text: `正在下载客户端 ${manifest!.version}…`, progress: total ? done / total : 0, server: address }),
        );
        return loadContent(installed, manifest);
      } catch (err) {
        loaderState({ step: "error", text: `下载客户端失败：${message(err)}`, server: address, download: null });
        const a = await wait();
        if (a.kind === "change") address = null;
        continue;
      }
    }
    return loadContent(local, manifest);
  }
}

async function loadContent(installed: InstalledContent, manifest: ClientManifest | null): Promise<void> {
  content = installed;
  latest = manifest;
  installCli();
  loaderState({ step: "progress", text: "正在启动…", progress: 1, server });
  await win!.loadURL(CONTENT_URL);
}

function updateInfo(): UpdateInfo | null {
  if (!latest || !content || latest.version === content.version) return null;
  return { current: content.version, latest: latest.version, needShell: latest.minShell > SHELL_VERSION, ...(byPlatform ? { updatedBy: "platform" as const } : {}) };
}

// ---- the MCP and command line, run by this exe as Node

const cliScript = () => join(home, "amo-relay.mjs");
const cliCmd = () => join(home, process.platform === "win32" ? "amo-relay.cmd" : "amo-relay.sh");

/** The exe the command line and the MCP run as Node: a platform install's `current`, not its version folder. */
const nodeExe = () => stableExe(process.execPath, buildMode);

/** The content's amo-relay.mjs to a stable place (MCP configs point there), with a launcher for the command line. */
function installCli(): void {
  if (!content) return;
  const from = join(content.dir, "amo-relay.mjs");
  if (!existsSync(from)) return;
  mkdirSync(home, { recursive: true });
  copyFileSync(from, cliScript());
  const extra = process.env.AMO_RELAY_HOME ? { AMO_RELAY_HOME: home } : {};
  if (process.platform === "win32") {
    const sets = Object.entries({ ELECTRON_RUN_AS_NODE: "1", ...extra }).map(([k, v]) => `set "${k}=${v}"`);
    writeFileSync(cliCmd(), ["@echo off", "setlocal", ...sets, `"${nodeExe()}" "%~dp0amo-relay.mjs" %*`, ""].join("\r\n"));
  } else {
    const sets = Object.entries({ ELECTRON_RUN_AS_NODE: "1", ...extra }).map(([k, v]) => `${k}='${v}'`);
    writeFileSync(cliCmd(), `#!/bin/sh\n${sets.join(" ")} exec "${nodeExe()}" "$(dirname "$0")/amo-relay.mjs" "$@"\n`, { mode: 0o755 });
  }
}

function hookup(): McpHookup {
  const env: Record<string, string> = { ELECTRON_RUN_AS_NODE: "1" };
  if (process.env.AMO_RELAY_HOME) env.AMO_RELAY_HOME = home;
  return { command: nodeExe(), args: [cliScript(), "mcp"], env, cli: cliCmd() };
}

// ---- IPC

function wire(): void {
  ipcMain.on("relay:loader-ready", () => (loaderReady?.(), (loaderReady = null)));
  ipcMain.on("relay:loader-server", (_e, value: string) => loaderAnswer?.({ kind: "server", value }));
  ipcMain.on("relay:loader-retry", () => loaderAnswer?.({ kind: "retry" }));
  ipcMain.on("relay:change-server", () => {
    if (loaderAnswer) loaderAnswer({ kind: "change" });
    else void boot(true);
  });
  ipcMain.on("relay:open-external", (_e, url: string) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
  });

  ipcMain.handle("relay:update-shell", () => updateShell());
  ipcMain.handle("relay:info", (): ShellInfo => ({ shellVersion: SHELL_VERSION, shellBuild: BUILD, ...(byPlatform ? { updatedBy: "platform" as const } : {}), contentVersion: content?.version ?? "", server: server ?? "", update: updateInfo(), platform: process.platform }));
  // The team login AMO 平台 keeps (%APPDATA%\AMO\account.json, the key DPAPI-encrypted; AGENTS.md rule 7, 2026-10-29):
  // the content signs in with it instead of a login of its own. Read each time asked, so a change in the platform shows.
  ipcMain.handle("relay:platform-account", async () => {
    const a = await readAccount().catch(() => null);
    return a ? { server: a.server, name: a.name, key: a.key } : null;
  });
  ipcMain.handle("relay:accounts", () => accounts.list());
  ipcMain.handle("relay:save-account", (_e, a: { server: string; name: string; password: string | null }) => accounts.save(a));
  ipcMain.handle("relay:forget-account", (_e, s: string, name: string) => accounts.forget(s, name));
  ipcMain.handle("relay:signed-in", (_e, identity: { server: string; name: string; key: string } | null) => {
    if (identity) writeSettings(identity, home);
    else rmSync(settingsPath(home), { force: true });
  });
  ipcMain.handle("relay:mcp", () => hookup());
  ipcMain.handle("relay:copy", (_e, text: string) => clipboard.writeText(text));
  ipcMain.on("relay:notify", (_e, n: { title: string; body: string; threadId: string }) => {
    if (win && !win.isFocused()) win.flashFrame(true);
    if (testMode || !Notification.isSupported()) return;
    const note = new Notification({ title: n.title, body: n.body, icon: ICON || undefined, silent: false });
    note.on("click", () => {
      showWindow();
      win?.webContents.send("relay:open-thread", n.threadId);
    });
    note.show();
  });
  ipcMain.on("relay:unread", (_e, count: number) => {
    unread = count;
    tray?.setToolTip(unread ? `AMO 中转 · ${unread} 条未读` : "AMO 中转");
  });
  // The page's window buttons (the window has no system title bar). 关闭 hides it to the tray, as before.
  ipcMain.on("relay:window", (_e, action: unknown) => {
    if (!win) return;
    if (action === "minimize") win.minimize();
    else if (action === "maximize") (win.isMaximized() ? win.unmaximize() : win.maximize());
    else if (action === "close") win.close();
  });
  ipcMain.handle("relay:window-maximized", () => !!win?.isMaximized());
  ipcMain.handle("relay:in-use", () => !!win && win.isVisible() && !win.isMinimized() && win.isFocused());
  // The usage text as a file next to the command line: agents are pointed at it instead of being pasted the whole text.
  ipcMain.handle("relay:write-usage", (_e, text: string) => {
    const file = join(home, "AMO中转用法.md");
    mkdirSync(home, { recursive: true });
    writeFileSync(file, `<!-- AMO 中转客户端自动生成，登录、成员或团队流程变化时会更新；${new Date().toLocaleString()} -->

${String(text)}`);
    return file;
  });
  ipcMain.handle("relay:check-update", async () => {
    if (!server) return null;
    try {
      latest = await fetchManifest(server);
    } catch {
      return null;
    }
    return updateInfo();
  });
  ipcMain.handle("relay:apply-update", async () => {
    if (!server) throw new Error("没有连上服务器");
    const manifest = await fetchManifest(server);
    if (manifest.minShell > SHELL_VERSION) throw new Error(`这个版本${newShellText(buildMode)}`);
    const installed = await store.install(server, manifest, (done, total) => win?.webContents.send("relay:update-progress", { done, total }));
    await loadContent(installed, manifest);
  });
}

// ---- 更新桌面程序: this program replaced by the service's newer build, without downloading and unpacking by hand.
// The zip is fetched and its hash checked, unpacked next to it (tar, in Windows 10 and later), its files put in place
// of this program's while it runs (replaceProgram), and the program restarted (app.relaunch). No helper process has to
// outlive it: Windows may end a program's children with it. The data (%APPDATA%\AMO Relay) is untouched.

let shellUpdating = false;

/** What 更新桌面程序 did, kept in the data folder (update.log) to look at when it went wrong. */
function updateLog(line: string): void {
  try {
    appendFileSync(join(home, "update.log"), `${new Date().toISOString()} ${line}
`);
  } catch {
    // no log
  }
}

async function updateShell(): Promise<void> {
  // Installed by the platform: its files are the platform's (Electron's hard-linked with the other tools), never
  // swapped from here. Content from before 10-28 may still offer the button; it gets this instead.
  if (byPlatform) throw new Error("这个 AMO 中转是 AMO 平台装的，桌面程序在 AMO 平台的「工具」里更新。");
  if (process.platform !== "win32") throw new Error("自动更新桌面程序目前只支持 Windows；请从下载页下载新版");
  if (!server) throw new Error("没有连上服务器");
  if (shellUpdating) throw new Error("正在更新");
  shellUpdating = true;
  const progress = (step: string, done = 0, total = 0) => win?.webContents.send("relay:shell-progress", { step, done, total });
  try {
    const h = await health(server);
    const want = h.shell;
    if (!want) throw new Error("服务器上没有桌面程序可以更新");
    const dir = join(tmpdir(), "amo-relay-update", want.build.replace(/[^\w.-]/g, "_"));
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const zip = join(dir, "AMO-Relay-win.zip");
    const res = await fetch(`${server}/downloads/AMO-Relay-win.zip`);
    if (!res.ok || !res.body) throw new Error(`下载失败：HTTP ${res.status}`);
    const hash = createHash("sha256");
    const out = createWriteStream(zip);
    let done = 0;
    let last = 0;
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      hash.update(chunk);
      done += chunk.length;
      if (!out.write(chunk)) await new Promise<void>((r) => out.once("drain", () => r()));
      if (done - last > 1024 * 1024) (progress("download", done, want.size), (last = done));
    }
    await new Promise<void>((ok, fail) => (out.once("error", fail), out.end(ok)));
    progress("check", want.size, want.size);
    if (hash.digest("hex") !== want.sha256) throw new Error("下载的文件校验不对，请重试");
    progress("unpack");
    // Windows' own tar (bsdtar reads zip); a "tar" earlier on the PATH (Git's) may not.
    const tar = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
    await promisify(execFile)(tar, ["-xf", zip, "-C", dir], { windowsHide: true });
    const fresh = join(dir, "AMO Relay");
    if (!existsSync(join(fresh, "AMO Relay.exe"))) throw new Error("下载的文件里没有 AMO Relay.exe");
    progress("replace", 0, 1);
    updateLog(`update ${BUILD ?? "?"} -> ${want.build}`);
    await replaceProgram(fresh, dirname(process.execPath), (done, total) => progress("replace", done, total));
    progress("restart");
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    // Started with arguments (another server, say): started again with them.
    app.relaunch({ args: process.argv.slice(1).filter((a) => !a.startsWith("--remote-debugging") && !a.startsWith("--inspect")) });
    quitting = true;
    tray?.destroy();
    setTimeout(() => app.quit(), 300);
  } finally {
    shellUpdating = false;
  }
}

const OLD = /\.amo-old-\d+$/;

/** The new program's files put in place of this one's while it runs: Windows lets a running program's files be renamed,
 * not overwritten, so each is moved aside (…amo-old-<time>, removed at the next start) and the new one copied in. On
 * any failure everything is put back as it was. */
async function replaceProgram(fresh: string, target: string, onFile: (done: number, total: number) => void): Promise<void> {
  const stamp = `.amo-old-${Date.now()}`;
  const moved: Array<[string, string]> = [];
  const added: string[] = [];
  // Only what changed: between two builds usually the program's own code, while Electron (the exe, its DLLs) stays the
  // same — and the running exe is best left alone.
  const files: string[] = [];
  for (const rel of filesUnder(fresh)) if (!(await sameFile(join(fresh, rel), join(target, rel)))) files.push(rel);
  updateLog(`replacing ${files.length} changed files in ${target}`);
  // Electron itself changed (outside resources\): swapping a running exe and its DLLs is not done in place.
  const core = files.filter((f) => !f.startsWith(`resources${sep}`));
  if (core.length) {
    updateLog(`not in place: ${core.slice(0, 5).join(", ")}`);
    throw new Error("MANUAL:这次新版连 Electron 本体也换了，不能在运行中替换");
  }
  try {
    // Asynchronously, a file at a time: thousands of them blocking the main process for a minute get it ended.
    for (const rel of files) {
      const from = join(fresh, rel);
      const to = join(target, rel);
      await fsp.mkdir(dirname(to), { recursive: true });
      if (existsSync(to)) {
        await fsp.rename(to, to + stamp);
        moved.push([to, to + stamp]);
      }
      await fsp.copyFile(from, to);
      added.push(to);
      if (added.length % 20 === 0) onFile(added.length, files.length);
    }
    updateLog(`replaced ${added.length} files`);
  } catch (err) {
    updateLog(`failed after ${added.length} files: ${err instanceof Error ? err.stack : String(err)}`);
    for (const f of added) await fsp.rm(f, { force: true });
    for (const [was, now] of moved.reverse()) {
      try {
        await fsp.rename(now, was);
      } catch {
        // left as …amo-old: the next start does not remove it while the original is missing
      }
    }
    throw new Error(`MANUAL:换文件时出错（${err instanceof Error ? err.message : String(err)}），程序没有改动`);
  }
}

/** Whether two files have the same bytes (sizes first, then their hashes). */
async function sameFile(a: string, b: string): Promise<boolean> {
  const [sa, sb] = await Promise.all([fsp.stat(a), fsp.stat(b).catch(() => null)]);
  if (!sb || sa.size !== sb.size) return false;
  const hash = async (f: string) => createHash("sha256").update(await fsp.readFile(f)).digest("hex");
  return (await hash(a)) === (await hash(b));
}

/** Every file under `root`, relative (walked by hand: Electron's fs lists only part of a tree with `recursive`). */
function filesUnder(root: string, rel = ""): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
    const path = rel ? join(rel, e.name) : e.name;
    if (e.isDirectory()) out.push(...filesUnder(root, path));
    else if (e.isFile()) out.push(path);
  }
  return out;
}

/** What an update moved aside, removed once the program runs again (only those whose replacement is there). */
async function removeOldFiles(): Promise<void> {
  if (!BUILD || byPlatform) return;
  const root = dirname(process.execPath);
  try {
    for (const rel of filesUnder(root)) {
      if (!OLD.test(rel)) continue;
      const file = join(root, rel);
      if (existsSync(file.replace(OLD, ""))) await fsp.rm(file, { force: true }).catch(() => undefined);
    }
  } catch {
    // tried again next start
  }
}

// ---- tray

/** The tray icon at each scale Windows may ask for: assets/icon-16…32.png (scripts/make-icons.mjs; 16–24 px are the
 *  simplified cut, 2026-10-28), else the window icon shrunk. */
function trayImage(): Electron.NativeImage {
  const image = nativeImage.createEmpty();
  for (const [size, scaleFactor] of [
    [16, 1],
    [20, 1.25],
    [24, 1.5],
    [32, 2],
  ] as const) {
    const file = join(here, "..", "assets", `icon-${size}.png`);
    if (existsSync(file)) image.addRepresentation({ scaleFactor, buffer: readFileSync(file) });
  }
  return image.isEmpty() ? nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }) : image;
}

/** Started by AMO 平台 (2026-10-29, the user: too many tray icons): the platform's tray menu has 打开中转 / 退出中转, so
 *  this one makes no icon. Started on its own it keeps its tray (constraint 1). */
const trayByPlatform = process.argv.includes("--amo-tray=platform");

function createTray(): void {
  if (!ICON || trayByPlatform) return;
  tray = new Tray(trayImage());
  tray.setToolTip("AMO 中转");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "显示 AMO 中转", click: showWindow },
      { type: "separator" },
      { label: "退出", click: () => ((quitting = true), app.quit()) },
    ]),
  );
  tray.on("click", showWindow);
}

// ---- start

// One client per data folder. Starting another copy of the client (a newly unpacked one, say) takes over: the running
// one is asked to make way and quits, and this one starts once the lock is free. Starting the same copy again just
// shows its window. (A running client from before this rule only shows its window; quit it from the tray once.)
const me = { exe: process.execPath };

function start(): void {
  app.on("second-instance", (_e, argv, _cwd, data) => {
    const other = (data as { exe?: string } | undefined)?.exe;
    // 退出中转 from AMO 平台's tray or card (2026-10-29), whichever copy asks.
    if (argv.includes("--amo-quit") || (other && other.toLowerCase() !== process.execPath.toLowerCase())) {
      quitting = true;
      tray?.destroy();
      app.quit();
    } else showWindow();
  });
  app.on("before-quit", () => (quitting = true));
  app.on("window-all-closed", () => undefined);
  void app.whenReady().then(async () => {
    serveScheme();
    wire();
    createTray();
    win = createWindow();
    setTimeout(() => void removeOldFiles(), 5000);
    await boot();
  });
}

if (process.argv.includes("--amo-quit")) {
  // The platform's 退出中转: the running client hears it through the lock and quits; this one never starts.
  app.requestSingleInstanceLock(me);
  app.quit();
} else if (app.requestSingleInstanceLock(me)) start();
else {
  // Another copy runs; it quits if it is a different one. Wait for the lock a few seconds, else leave it to it.
  let tries = 0;
  const retry = setInterval(() => {
    if (app.requestSingleInstanceLock(me)) {
      clearInterval(retry);
      start();
    } else if (++tries > 16) {
      clearInterval(retry);
      app.quit();
    }
  }, 500);
}
