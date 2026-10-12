/// <reference lib="dom" />
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron, type ElectronApplication, type Page } from "@playwright/test";
import { MOCK_MODEL_CATALOG, removeTempDir, startMockModel, type MockModelServer } from "@amo-studio/testkit";

// Launch helper for Studio end-to-end tests: temp data dir, hidden window, attached Host on an ephemeral port, and by
// default the mock model as the only model (no budget, no real Codex home).

const here = dirname(fileURLToPath(import.meta.url));
export const studioRoot = resolve(here, "..", "..");
const require = createRequire(import.meta.url);
const electronPath = require("electron") as unknown as string;

export interface Studio {
  app: ElectronApplication;
  page: Page;
  dataDir: string;
  /** Temp root; `workspace(name)` dirs live here. */
  root: string;
  mock: MockModelServer | null;
  /** Creates an empty project dir under the sandbox root. */
  workspace(name: string): string;
  /** Calls the Host API directly (setup and assertions), with the token from the data dir. */
  api<T = unknown>(method: string, path: string, body?: unknown): Promise<T>;
  /** `keepData` leaves the temp root in place so a second launch can reuse it (`launchStudio({ root })`). */
  close(options?: { keepData?: boolean }): Promise<void>;
}

export async function launchStudio(options: { mockModel?: boolean; env?: Record<string, string>; root?: string } = {}): Promise<Studio> {
  const root = options.root ?? mkdtempSync(join(tmpdir(), "amo-studio-e2e-"));
  const dataDir = join(root, "data");
  const codexHome = join(root, "codex-home");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  const mock = options.mockModel === false ? null : await startMockModel();
  const mockEnv: Record<string, string> = mock
    ? { AMO_STUDIO_TEST_PROVIDER_URL: mock.baseUrl, AMO_STUDIO_TEST_CATALOG: MOCK_MODEL_CATALOG, AMO_STUDIO_TEST_CODEX_HOME: codexHome }
    : {};
  const app = await _electron.launch({
    executablePath: electronPath,
    args: [join(studioRoot, "packages", "app", "dist", "main.js")],
    env: { ...process.env, AMO_STUDIO_TEST: "1", AMO_STUDIO_DATA_DIR: dataDir, AMO_STUDIO_PORT: "0", ...mockEnv, ...options.env },
  });
  const page = await app.firstWindow();

  async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const info = JSON.parse(readFileSync(join(dataDir, "host.json"), "utf8")) as { url: string };
    const token = readFileSync(join(dataDir, "host-token"), "utf8").trim();
    const res = await fetch(`${info.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = (await res.json()) as T;
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(data)}`);
    return data;
  }

  return {
    app,
    page,
    dataDir,
    root,
    mock,
    workspace(name) {
      const dir = join(root, "workspaces", name);
      mkdirSync(dir, { recursive: true });
      return dir;
    },
    api,
    close: async ({ keepData = false } = {}) => {
      await app.close();
      await mock?.close();
      if (!keepData) removeTempDir(root);
    },
  };
}

/** Saves a PNG of the (hidden) main window to studio/screenshots/<stage>/<name>.png. */
export async function screenshot(app: ElectronApplication, stage: string, name: string, page?: Page): Promise<string> {
  if (page) await settlePaint(page);
  const base64 = await app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]!;
    return (await win.webContents.capturePage()).toPNG().toString("base64");
  });
  const file = join(studioRoot, "screenshots", stage, `${name}.png`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, Buffer.from(base64, "base64"));
  return file;
}

/** Window state used to assert the red line: test windows never take focus and stay off every display. */
export function windowState(app: ElectronApplication) {
  return app.evaluate(({ BrowserWindow, screen }) => {
    const win = BrowserWindow.getAllWindows()[0]!;
    const b = win.getBounds();
    const onScreen = screen.getAllDisplays().some((d) => {
      const a = d.bounds;
      return b.x < a.x + a.width && b.x + b.width > a.x && b.y < a.y + a.height && b.y + b.height > a.y;
    });
    return { visible: win.isVisible(), focused: win.isFocused(), anyFocused: BrowserWindow.getFocusedWindow() !== null, onScreen };
  });
}

/** Waits until the renderer has painted the current state, so capturePage does not return a stale frame. */
export async function settlePaint(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
}
