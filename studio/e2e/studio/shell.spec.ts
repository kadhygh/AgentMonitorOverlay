import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { launchStudio, screenshot, windowState, type Studio } from "../support/studio.js";

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

test("starts the Host, connects the UI and never takes focus", async () => {
  studio = await launchStudio({ mockModel: false });
  await expect(studio.page.getByTestId("host-status")).toHaveText("Host 运行中");
  expect((await studio.api<{ profiles: Array<{ id: string }> }>("GET", "/api/state")).profiles.map((p) => p.id)).toEqual(["codex-default", "codex-deepseek-flash", "claude-glm", "claude-subscription", "dsh-deepseek"]);
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

test("resize trace: each drag of a window is summarised in logs/resize-trace.log, with what the page saw", async () => {
  studio = await launchStudio({ env: { AMO_STUDIO_TRACE_RESIZE: "1" } });
  const { app, page, dataDir } = studio;
  await expect(page.getByTestId("host-status")).toBeVisible();
  await app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((w) => w.getTitle() === "AMO Studio")!;
    const b = win.getBounds();
    for (let i = 1; i <= 12; i++) {
      win.setBounds({ ...b, width: b.width + i * 8, height: b.height + i * 5 });
      await new Promise((r) => setTimeout(r, 16));
    }
  });
  const log = join(dataDir, "logs", "resize-trace.log");
  await expect.poll(() => (existsSync(log) ? readFileSync(log, "utf8") : ""), { timeout: 10_000 }).toMatch(/ main burst \d+ms .* resize=\d+/);
  await expect.poll(() => readFileSync(log, "utf8"), { timeout: 10_000 }).toMatch(/ main page \{"where":.*"frames":\d+/);
});
