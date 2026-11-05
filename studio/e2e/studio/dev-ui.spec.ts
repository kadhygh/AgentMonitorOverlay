import { cpSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { launchStudio, screenshot, studioRoot, type Studio } from "../support/studio.js";

// 设置 → 测试功能 → 开发界面目录 (2026-11-05, the user: 全景's view will take many rounds, a release for each is too slow):
// the Host serves the UI from a worktree's build instead of the installed one; the window says so in a strip with
// 重新载入 and 恢复安装版. Here the "worktree" is a copy of the build the test runs on, so the window still works.

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

test("开发界面目录: a folder without index.html is refused, a UI build is used after a reload, 恢复安装版 goes back", async () => {
  studio = await launchStudio();
  const { page, app } = studio;
  const empty = studio.workspace("no-build");
  const dev = join(studio.workspace("dev-ui"), "dist");
  mkdirSync(dev, { recursive: true });
  cpSync(join(studioRoot, "packages", "ui", "dist"), dev, { recursive: true });

  await page.getByRole("button", { name: "设置" }).click();
  const dialog = page.getByRole("dialog", { name: "设置" });
  await dialog.getByRole("tab", { name: "测试功能" }).click();
  const field = dialog.getByTestId("dev-ui-dir");
  await field.fill(empty);
  await dialog.getByTestId("dev-ui-use").click();
  await expect(dialog.getByRole("alert")).toContainText("没有 index.html");
  await expect(page.getByTestId("dev-ui-bar")).toHaveCount(0);

  await field.fill(dev);
  await screenshot(app, "studio", "dev-ui-settings", page);
  await dialog.getByTestId("dev-ui-use").click();
  // The window reloads from the folder: the strip says where the UI comes from.
  await expect(page.getByTestId("dev-ui-bar")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("dev-ui-bar")).toContainText(dev);
  expect((await studio.api<{ devUiDir: string | null }>("GET", "/api/settings")).devUiDir).toBe(dev);
  await screenshot(app, "studio", "dev-ui-bar", page);

  await page.getByTestId("dev-ui-reload").click();
  await expect(page.getByTestId("dev-ui-bar")).toBeVisible({ timeout: 15_000 });

  await page.getByTestId("dev-ui-bar-off").click();
  await expect.poll(async () => (await studio!.api<{ devUiDir: string | null }>("GET", "/api/settings")).devUiDir).toBeNull();
  await expect(page.getByRole("button", { name: "设置" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("dev-ui-bar")).toHaveCount(0);
});
