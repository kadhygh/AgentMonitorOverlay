import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { launchStudio, screenshot, windowState, type Studio } from "./studio.js";

let studio: Studio;

test.afterEach(async () => {
  await studio?.close();
});

test("starts the Host, connects the UI and never takes focus", async () => {
  studio = await launchStudio();
  await expect(studio.page.getByTestId("host-status")).toHaveText(/已连接 Host · 0 个工作区 · 2 个模型配置/);
  expect(await windowState(studio.app)).toEqual({ visible: false, focused: false, anyFocused: false });

  const info = JSON.parse(readFileSync(join(studio.dataDir, "host.json"), "utf8")) as { url: string };
  expect(info.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  // The token reaches the page only through the preload bridge, not the URL.
  expect(studio.page.url()).not.toContain(readFileSync(join(studio.dataDir, "host-token"), "utf8").trim());

  const file = await screenshot(studio.app, "stage-1", "S1-08-shell");
  expect(existsSync(file)).toBe(true);
});

test("stops an attached Host when the app quits in test mode", async () => {
  studio = await launchStudio();
  await expect(studio.page.getByTestId("host-status")).toHaveText(/已连接 Host/);
  const dataDir = studio.dataDir;
  await studio.close();
  await expect.poll(() => existsSync(join(dataDir, "host.lock")), { timeout: 15_000 }).toBe(false);
});
