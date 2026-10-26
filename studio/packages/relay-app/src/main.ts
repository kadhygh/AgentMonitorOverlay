import { app, BrowserWindow, clipboard, ipcMain, Menu, nativeImage, Notification, protocol, safeStorage, shell, Tray } from "electron";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { Accounts } from "./accounts.js";
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
// off-screen, never focused). Args: --server <address> fills in the address the first time.

const here = dirname(fileURLToPath(import.meta.url));
const testMode = process.env.AMO_RELAY_TEST === "1";
const home = relayHome();
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

// ---- config (the service address)

const configFile = join(home, "shell.json");
function readServer(): string | null {
  try {
    return (JSON.parse(readFileSync(configFile, "utf8")) as { server?: string }).server ?? null;
  } catch {
    return null;
  }
}
function saveServer(value: string): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(configFile, JSON.stringify({ server: value }, null, 2));
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
    backgroundColor: "#f1eee7",
    show: false,
    autoHideMenuBar: true,
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
      loaderState({ step: "ask-server", server: tried ?? server ?? readServer() ?? argServer() ?? "", error: askError });
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
        loaderState({ step: "error", text: "服务器上的客户端需要更新的桌面程序，请重新下载。", server: address, download: address });
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
  return { current: content.version, latest: latest.version, needShell: latest.minShell > SHELL_VERSION };
}

// ---- the MCP and command line, run by this exe as Node

const cliScript = () => join(home, "amo-relay.mjs");
const cliCmd = () => join(home, process.platform === "win32" ? "amo-relay.cmd" : "amo-relay.sh");

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
    writeFileSync(cliCmd(), ["@echo off", "setlocal", ...sets, `"${process.execPath}" "%~dp0amo-relay.mjs" %*`, ""].join("\r\n"));
  } else {
    const sets = Object.entries({ ELECTRON_RUN_AS_NODE: "1", ...extra }).map(([k, v]) => `${k}='${v}'`);
    writeFileSync(cliCmd(), `#!/bin/sh\n${sets.join(" ")} exec "${process.execPath}" "$(dirname "$0")/amo-relay.mjs" "$@"\n`, { mode: 0o755 });
  }
}

function hookup(): McpHookup {
  const env: Record<string, string> = { ELECTRON_RUN_AS_NODE: "1" };
  if (process.env.AMO_RELAY_HOME) env.AMO_RELAY_HOME = home;
  return { command: process.execPath, args: [cliScript(), "mcp"], env, cli: cliCmd() };
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

  ipcMain.handle("relay:info", (): ShellInfo => ({ shellVersion: SHELL_VERSION, contentVersion: content?.version ?? "", server: server ?? "", update: updateInfo(), platform: process.platform }));
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
  ipcMain.handle("relay:in-use", () => !!win && win.isVisible() && !win.isMinimized() && win.isFocused());
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
    if (manifest.minShell > SHELL_VERSION) throw new Error("这个版本需要重新下载客户端");
    const installed = await store.install(server, manifest, (done, total) => win?.webContents.send("relay:update-progress", { done, total }));
    await loadContent(installed, manifest);
  });
}

// ---- tray

function createTray(): void {
  if (!ICON) return;
  const image = nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 });
  tray = new Tray(image);
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

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", showWindow);
  app.on("before-quit", () => (quitting = true));
  app.on("window-all-closed", () => undefined);
  void app.whenReady().then(async () => {
    serveScheme();
    wire();
    createTray();
    win = createWindow();
    await boot();
  });
}
