import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron, type ElectronApplication, type Page } from "@playwright/test";

// Launch helper for Studio end-to-end tests: temp data dir, hidden window, attached Host on an ephemeral port.

const here = dirname(fileURLToPath(import.meta.url));
export const studioRoot = resolve(here, "..", "..");
const require = createRequire(import.meta.url);
const electronPath = require("electron") as unknown as string;

export interface Studio {
  app: ElectronApplication;
  page: Page;
  dataDir: string;
  root: string;
  close(): Promise<void>;
}

export async function launchStudio(extraEnv: Record<string, string> = {}): Promise<Studio> {
  const root = mkdtempSync(join(tmpdir(), "amo-studio-e2e-"));
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  const app = await _electron.launch({
    executablePath: electronPath,
    args: [join(studioRoot, "packages", "app", "dist", "main.js")],
    env: { ...process.env, AMO_STUDIO_TEST: "1", AMO_STUDIO_DATA_DIR: dataDir, AMO_STUDIO_PORT: "0", ...extraEnv },
  });
  const page = await app.firstWindow();
  return {
    app,
    page,
    dataDir,
    root,
    close: async () => {
      await app.close();
    },
  };
}

/** Saves a PNG of the (hidden) main window to studio/screenshots/<stage>/<name>.png. */
export async function screenshot(app: ElectronApplication, stage: string, name: string): Promise<string> {
  const base64 = await app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]!;
    return (await win.webContents.capturePage()).toPNG().toString("base64");
  });
  const file = join(studioRoot, "screenshots", stage, `${name}.png`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, Buffer.from(base64, "base64"));
  return file;
}

/** Window state used to assert the red line: tests never show or focus a window. */
export function windowState(app: ElectronApplication) {
  return app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]!;
    return { visible: win.isVisible(), focused: win.isFocused(), anyFocused: BrowserWindow.getFocusedWindow() !== null };
  });
}
