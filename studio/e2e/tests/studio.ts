/// <reference lib="dom" />
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron, type ElectronApplication, type Page } from "@playwright/test";
import { MOCK_MODEL_CATALOG, removeTempDir, startMockAnthropic, startMockModel, type ClaudeMockServer, type MockModelServer } from "@amo-studio/testkit";

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
  claudeMock: ClaudeMockServer | null;
  /** Creates an empty project dir under the sandbox root. */
  workspace(name: string): string;
  /** Calls the Host API directly (setup and assertions), with the token from the data dir. */
  api<T = unknown>(method: string, path: string, body?: unknown): Promise<T>;
  /** `keepData` leaves the temp root in place so a second launch can reuse it (`launchStudio({ root })`). */
  close(options?: { keepData?: boolean }): Promise<void>;
}

export async function launchStudio(
  options: {
    mockModel?: boolean;
    env?: Record<string, string>;
    root?: string;
    /** Behave as the portable build in this folder, with its saved data dir. */
    portable?: { dir: string; dataDir: string };
    /**
     * 工作步骤展示. Tests default to "verbose" (every work row shown, turns never fold) so they can reach tool rows and
     * answered approvals directly; chat-experience.spec.ts covers the folding views.
     */
    transcriptView?: "compact" | "standard" | "detailed" | "verbose";
    /** Whether the task page's right column (进度、批注…) starts shown; true unless a spec checks the default. */
    taskSidebar?: boolean;
  } = {},
): Promise<Studio> {
  const root = options.root ?? mkdtempSync(join(tmpdir(), "amo-studio-e2e-"));
  const dataDir = options.portable?.dataDir ?? join(root, "data");
  const codexHome = join(root, "codex-home");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  const mock = options.mockModel === false ? null : await startMockModel();
  const claudeMock = options.mockModel === false ? null : await startMockAnthropic();
  const mockEnv: Record<string, string> = mock
    ? {
        AMO_STUDIO_TEST_PROVIDER_URL: mock.baseUrl,
        AMO_STUDIO_TEST_CATALOG: MOCK_MODEL_CATALOG,
        AMO_STUDIO_TEST_CODEX_HOME: codexHome,
        ...(claudeMock ? { AMO_STUDIO_TEST_CLAUDE_URL: claudeMock.baseUrl } : {}),
      }
    : {};
  const app = await _electron.launch({
    executablePath: electronPath,
    args: [join(studioRoot, "packages", "app", "dist", "main.js")],
    env: {
      ...withoutDataDir(process.env),
      AMO_STUDIO_TEST: "1",
      ...(options.portable ? { AMO_STUDIO_PORTABLE_DIR: options.portable.dir } : { AMO_STUDIO_DATA_DIR: dataDir }),
      AMO_STUDIO_PORT: "0",
      ...mockEnv,
      ...options.env,
    },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.evaluate(
    ({ view, sidebar }) => {
      localStorage.setItem("amo.transcriptView", view);
      window.dispatchEvent(new CustomEvent("amo:transcript-view", { detail: view }));
      // The task page's right column is off for people by default; most specs work in it, so it starts on here.
      localStorage.setItem("amo.taskSidebar", sidebar ? "1" : "0");
    },
    { view: options.transcriptView ?? "verbose", sidebar: options.taskSidebar ?? true },
  );

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
    claudeMock,
    workspace(name) {
      const dir = join(root, "workspaces", name);
      mkdirSync(dir, { recursive: true });
      return dir;
    },
    api,
    close: async ({ keepData = false } = {}) => {
      await app.close();
      await mock?.close();
      await claudeMock?.close();
      if (!keepData) removeTempDir(root);
    },
  };
}

/** The environment without a data dir, so a portable launch picks its own. */
export function withoutDataDir(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && k !== "AMO_STUDIO_DATA_DIR") out[k] = v;
  return out;
}

/** Launches the app as the portable build's first run (setup window only; it exits once setup is done). */
export async function launchFirstRun(portableDir: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await _electron.launch({
    executablePath: electronPath,
    args: [join(studioRoot, "packages", "app", "dist", "main.js")],
    env: { ...withoutDataDir(process.env), AMO_STUDIO_TEST: "1", AMO_STUDIO_PORTABLE_DIR: portableDir },
  });
  return { app, page: await app.firstWindow() };
}

/** Which window: the workbench, the Focus window (#focus), the scratchpad window (#scratchpad), a Git Review window (#review?…), the file marks window (#marks…) or a viewer window (#viewer?…). */
export type WindowKind = "main" | "focus" | "scratchpad" | "review" | "marks" | "viewer";

/** Saves a PNG of the (hidden) main window, or another window, to studio/screenshots/<stage>/<name>.png. */
export async function screenshot(app: ElectronApplication, stage: string, name: string, page?: Page, which: WindowKind = "main"): Promise<string> {
  if (page) await settlePaint(page);
  // Entrance animations (popups, notices) finish first; endless ones (spinners) are left alone.
  if (page)
    await page.evaluate(() =>
      Promise.all(document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished.catch(() => undefined))),
    );
  // Several windows of a kind (viewers): the one showing `page`.
  const exact = page && which !== "main" ? page.url() : null;
  const base64 = await app.evaluate(async ({ BrowserWindow }, [kind, url]) => {
    const kindOf = (url: string) => (url.endsWith("#focus") ? "focus" : url.endsWith("#scratchpad") ? "scratchpad" : url.includes("#review") ? "review" : url.includes("#marks") ? "marks" : url.includes("#viewer") ? "viewer" : "main");
    const all = BrowserWindow.getAllWindows();
    const win = (url && all.find((w) => w.webContents.getURL() === url)) || all.find((w) => kindOf(w.webContents.getURL()) === kind)!;
    return (await win.webContents.capturePage()).toPNG().toString("base64");
  }, [which, exact] as const);
  const file = join(studioRoot, "screenshots", stage, `${name}.png`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, Buffer.from(base64, "base64"));
  return file;
}

/** Window state used to assert the red line: test windows never take focus and stay off every display. */
export function windowState(app: ElectronApplication, which: WindowKind = "main") {
  return app.evaluate(({ BrowserWindow, screen }, kind) => {
    const kindOf = (url: string) => (url.endsWith("#focus") ? "focus" : url.endsWith("#scratchpad") ? "scratchpad" : url.includes("#review") ? "review" : url.includes("#marks") ? "marks" : url.includes("#viewer") ? "viewer" : "main");
    const win = BrowserWindow.getAllWindows().find((w) => kindOf(w.webContents.getURL()) === kind)!;
    const b = win.getBounds();
    const onScreen = screen.getAllDisplays().some((d) => {
      const a = d.bounds;
      return b.x < a.x + a.width && b.x + b.width > a.x && b.y < a.y + a.height && b.y + b.height > a.y;
    });
    return {
      visible: win.isVisible(),
      focused: win.isFocused(),
      anyFocused: BrowserWindow.getFocusedWindow() !== null,
      onScreen,
      focusable: win.isFocusable(),
      alwaysOnTop: win.isAlwaysOnTop(),
    };
  }, which);
}

/** Waits until the renderer has painted the current state, so capturePage does not return a stale frame. */
export async function settlePaint(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
}
