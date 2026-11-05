import { expect, test } from "@playwright/test";
import type { Topic } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

// 设置 → 功能: optional features turned off disappear from the workbench (tabs, panels, the canvas sidebar) and come
// back when turned on again.

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

test("turn planning off and on again", async () => {
  studio = await launchStudio();
  const { page } = studio;
  await studio.api<Topic>("POST", "/api/topics", { title: "专题甲" });

  // On by default: the canvas's 整体待办.
  await page.getByRole("button", { name: "画布" }).click();
  await expect(page.getByRole("tab", { name: "整体待办" })).toBeVisible();

  // Off: it goes away; the dialog lists it.
  await page.getByRole("button", { name: "设置" }).click();
  const dialog = page.getByRole("dialog", { name: "设置" });
  await dialog.getByRole("tab", { name: "功能", exact: true }).click();
  // 扩展包 was removed (2026-10-31).
  await expect(dialog.getByTestId("feature-packs")).toHaveCount(0);
  await dialog.getByTestId("feature-planning").uncheck();
  await expect(dialog.getByTestId("feature-planning")).not.toBeChecked();
  await screenshot(studio.app, "stage-11", "R4-features-off", page);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("tab", { name: "整体待办" })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "沟通" })).toBeVisible();
  expect((await studio.api<{ disabledFeatures: string[] }>("GET", "/api/settings")).disabledFeatures).toEqual(["planning"]);

  // On again.
  await page.getByRole("button", { name: "设置" }).click();
  await dialog.getByTestId("feature-planning").check();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("tab", { name: "整体待办" })).toBeVisible();
});

// 命令行适配 (2026-11-06): Python's UTF-8 variables and the Windows command lines for every agent, on by default; one
// switch turns both off for sessions started from then on.
test("命令行适配 is on by default and can be turned off", async () => {
  studio = await launchStudio();
  const { page } = studio;
  expect((await studio.api<{ shellHelp: boolean }>("GET", "/api/settings")).shellHelp).toBe(true);
  await page.getByRole("button", { name: "设置" }).click();
  const dialog = page.getByRole("dialog", { name: "设置" });
  await dialog.getByRole("tab", { name: "功能", exact: true }).click();
  const box = dialog.getByTestId("shell-help");
  await box.scrollIntoViewIfNeeded();
  await expect(box).toBeChecked();
  await screenshot(studio.app, "studio", "shell-help-setting", page);
  await box.uncheck();
  await expect.poll(async () => (await studio!.api<{ shellHelp: boolean }>("GET", "/api/settings")).shellHelp).toBe(false);
  await box.check();
  await expect.poll(async () => (await studio!.api<{ shellHelp: boolean }>("GET", "/api/settings")).shellHelp).toBe(true);
});
