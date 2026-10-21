import { expect, test } from "@playwright/test";
import { launchStudio, screenshot, type Studio } from "./studio.js";

// 设置 → 维护 (2026-10-20): Studio says it runs from the git checkout, and opens the person's own Claude Code in a
// terminal at the repo (2026-10-21: no model to choose). Test runs only record the launch.

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

test("维护 shows the source checkout and opens Claude Code at the repo", async () => {
  studio = await launchStudio();
  const { page, app } = studio;
  await page.getByRole("button", { name: "设置" }).click();
  const dialog = page.getByRole("dialog", { name: "设置" });
  await dialog.getByRole("tab", { name: "维护" }).click();
  await expect(dialog.getByTestId("maintenance-mode")).toContainText("源码 · git 工程");
  await expect(dialog.getByTestId("maintenance-claude")).toContainText(/claude\.(exe|cmd)/);
  await screenshot(app, "maintenance", "settings-maintenance", page);
  await dialog.getByTestId("maintenance-open").click();
  await expect(dialog.getByRole("status")).toContainText("打开 Claude Code");
});
