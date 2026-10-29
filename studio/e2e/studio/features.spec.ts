import { expect, test } from "@playwright/test";
import type { Topic, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

// 设置 → 功能: optional features turned off disappear from the workbench (tabs, panels, the canvas sidebar) and come
// back when turned on again.

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

test("turn extension packs and planning off and on again", async () => {
  studio = await launchStudio();
  const { page } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  await studio.api<Topic>("POST", "/api/topics", { title: "专题甲" });

  // On by default: the project's 扩展包 tab and the canvas's 整体待办.
  await page.getByTestId(`scope-ws-${ws.name}`).click();
  await expect(page.getByRole("button", { name: "扩展包" })).toBeVisible();
  await page.getByRole("button", { name: "画布" }).click();
  await expect(page.getByRole("tab", { name: "整体待办" })).toBeVisible();

  // Off: both go away; the dialog lists them.
  await page.getByRole("button", { name: "设置" }).click();
  const dialog = page.getByRole("dialog", { name: "设置" });
  await dialog.getByRole("tab", { name: "功能" }).click();
  await dialog.getByTestId("feature-packs").uncheck();
  await dialog.getByTestId("feature-planning").uncheck();
  await expect(dialog.getByTestId("feature-planning")).not.toBeChecked();
  await screenshot(studio.app, "stage-11", "R4-features-off", page);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("tab", { name: "整体待办" })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "沟通" })).toBeVisible();
  await page.getByTestId(`scope-ws-${ws.name}`).click();
  await expect(page.getByRole("button", { name: "扩展包" })).toHaveCount(0);
  expect((await studio.api<{ disabledFeatures: string[] }>("GET", "/api/settings")).disabledFeatures).toEqual(["packs", "planning"]);

  // On again.
  await page.getByRole("button", { name: "设置" }).click();
  await dialog.getByTestId("feature-packs").check();
  await dialog.getByTestId("feature-planning").check();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "扩展包" })).toBeVisible();
});
