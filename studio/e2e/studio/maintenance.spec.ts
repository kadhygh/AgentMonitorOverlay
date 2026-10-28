import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { expect, test } from "@playwright/test";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

// 设置 → 维护 (2026-10-20): Studio says it runs from the git checkout, and opens the person's own Claude Code in a
// terminal at the repo (2026-10-21: no model to choose), or their own Codex (2026-10-28). Test runs only record the launch.

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

test("维护 shows the source checkout and opens Claude Code or Codex at the repo", async () => {
  studio = await launchStudio();
  const { page, app } = studio;
  await page.getByRole("button", { name: "设置" }).click();
  const dialog = page.getByRole("dialog", { name: "设置" });
  await dialog.getByRole("tab", { name: "维护" }).click();
  await expect(dialog.getByTestId("maintenance-mode")).toContainText("源码 · git 工程");
  await expect(dialog.getByTestId("maintenance-claude")).toContainText(/claude\.(exe|cmd)/);
  await screenshot(app, "studio", "settings-maintenance", page);
  await dialog.getByTestId("maintenance-open-claude").click();
  await expect(dialog.getByRole("status")).toContainText("打开 Claude Code");
  // 2026-10-28: the person's own codex from PATH, when there is one on this machine; else the button says why it is off.
  const codex = dialog.getByTestId("maintenance-open-codex");
  if (await codex.isEnabled()) {
    await codex.click();
    await expect(dialog.getByRole("status")).toContainText("打开 Codex");
  } else {
    await expect(dialog.getByTestId("maintenance-codex-missing")).toContainText("没有找到 Codex");
  }
});

test("维护 says plainly when there is no codex on PATH, and its button stays off", async () => {
  // PATH without the folders that hold a codex (the Host looks there only, as the person's terminal would).
  const key = Object.keys(process.env).find((k) => /^path$/i.test(k)) ?? "PATH";
  const path = (process.env[key] ?? "").split(delimiter).filter((d) => d && !["codex.exe", "codex.cmd"].some((n) => existsSync(join(d, n)))).join(delimiter);
  studio = await launchStudio({ env: { [key]: path } });
  const { page, app } = studio;
  await page.getByRole("button", { name: "设置" }).click();
  const dialog = page.getByRole("dialog", { name: "设置" });
  await dialog.getByRole("tab", { name: "维护" }).click();
  await expect(dialog.getByTestId("maintenance-codex")).toHaveText("没有找到");
  await expect(dialog.getByTestId("maintenance-codex-missing")).toContainText("PATH 上没有 codex");
  await expect(dialog.getByTestId("maintenance-open-codex")).toBeDisabled();
  await screenshot(app, "studio", "settings-maintenance-no-codex", page);
});
