import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { launchStudio, screenshot, windowState, type Studio } from "./studio.js";

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

test("starts the Host, connects the UI and never takes focus", async () => {
  studio = await launchStudio({ mockModel: false });
  await expect(studio.page.getByTestId("host-status")).toHaveText("Host 运行中");
  expect((await studio.api<{ profiles: unknown[] }>("GET", "/api/state")).profiles).toHaveLength(2);
  expect(await windowState(studio.app)).toMatchObject({ focused: false, anyFocused: false, onScreen: false });

  const info = JSON.parse(readFileSync(join(studio.dataDir, "host.json"), "utf8")) as { url: string };
  expect(info.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  // The token reaches the page only through the preload bridge, not the URL.
  expect(studio.page.url()).not.toContain(readFileSync(join(studio.dataDir, "host-token"), "utf8").trim());

  const file = await screenshot(studio.app, "stage-1", "S1-08-shell", studio.page);
  expect(existsSync(file)).toBe(true);
});

test("stops an attached Host when the app quits in test mode", async () => {
  studio = await launchStudio({ mockModel: false });
  await expect(studio.page.getByTestId("host-status")).toHaveText("Host 运行中");
  const dataDir = studio.dataDir;
  await studio.app.close();
  await expect.poll(() => existsSync(join(dataDir, "host.lock")), { timeout: 15_000 }).toBe(false);
});
