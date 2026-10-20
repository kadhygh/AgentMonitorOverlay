import { expect, test } from "@playwright/test";
import { launchStudio, screenshot, type Studio } from "./studio.js";

// 设置 → 维护 (2026-10-20): Studio says it runs from the git checkout, and opens a model's CLI in a terminal at the
// repo. Test runs only record the launch.

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

test("维护 shows the source checkout and opens the chosen model's CLI at the repo", async () => {
  studio = await launchStudio();
  const { page, app } = studio;
  await page.getByRole("button", { name: "设置" }).click();
  const dialog = page.getByRole("dialog", { name: "设置" });
  await dialog.getByRole("tab", { name: "维护" }).click();
  await expect(dialog.getByTestId("maintenance-mode")).toContainText("源码 · git 工程");
  const models = dialog.getByRole("radiogroup", { name: "维护用的模型" });
  await expect(models.getByRole("radio").first()).toHaveAttribute("aria-checked", "true");
  await screenshot(app, "maintenance", "settings-maintenance", page);
  await dialog.getByTestId("maintenance-open").click();
  await expect(dialog.getByRole("status")).toContainText("已在");
});
