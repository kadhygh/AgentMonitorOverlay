import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { removeTempDir } from "@amo-studio/testkit";
import { launchFirstRun, launchStudio, screenshot, type Studio } from "../support/studio.js";

// The portable build's first run: choose the data dir (saved next to the exe), then Studio starts with it.

let studio: Studio | undefined;
let portable: string | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
  if (portable) removeTempDir(portable);
  portable = undefined;
});

test("first run of the portable build asks where data goes, then starts with it", async () => {
  portable = mkdtempSync(join(tmpdir(), "amo-studio-e2e-portable-"));
  const { app, page } = await launchFirstRun(portable);
  await expect(page.getByLabel("数据目录")).toHaveValue(join(portable, "data"));
  await expect(page.locator("#checks")).toContainText("测试模式不检查");
  await screenshot(app, "stage-8", "S8-02-setup", page);

  // A bad choice is explained; a relative one is saved relative to the exe's folder.
  await page.getByLabel("数据目录").fill(" ");
  await page.getByRole("button", { name: "开始使用" }).click();
  await expect(page.locator("#error")).toHaveText("请填写数据目录");
  await page.getByLabel("数据目录").fill("my-data");
  const closed = app.waitForEvent("close");
  await page.getByRole("button", { name: "开始使用" }).click();
  await closed;
  expect(JSON.parse(readFileSync(join(portable, "amo-studio.json"), "utf8"))).toEqual({ dataDir: "my-data" });
  expect(existsSync(join(portable, "my-data"))).toBe(true);
  // Nothing of the setup run landed in the default place.
  expect(existsSync(join(portable, "data"))).toBe(false);

  // The next start goes straight to the workbench with that data dir.
  studio = await launchStudio({ root: portable, portable: { dir: portable, dataDir: join(portable, "my-data") } });
  await expect(studio.page.getByRole("button", { name: "+ 新任务" })).toBeVisible();
  expect(existsSync(join(portable, "my-data", "host.json"))).toBe(true);
  expect(existsSync(join(portable, "my-data", "electron"))).toBe(true);
});
