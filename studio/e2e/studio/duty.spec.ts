import { expect, test } from "@playwright/test";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

// 设置 → 值守 (2026-10-31, plans/issues.md): a new item runs a command or starts a session at its times; 立即运行 runs
// it now and the card says how it went; it can be turned off, edited and removed.

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

test("值守: make a command item and a session item, run them now, edit and remove", async () => {
  studio = await launchStudio();
  const { page, app } = studio;
  await page.getByRole("button", { name: "设置" }).click();
  const dialog = page.getByRole("dialog", { name: "设置" });
  await dialog.getByRole("tab", { name: "值守" }).click();
  await expect(dialog.getByTestId("duty-list")).toContainText("还没有值守项");

  // A command, every 2 minutes.
  await dialog.getByTestId("duty-new").click();
  const form = dialog.getByTestId("duty-form");
  await form.getByLabel("值守项名字").fill("报个平安");
  await form.getByLabel("间隔", { exact: true }).fill("2");
  await form.getByLabel("间隔单位").selectOption({ label: "分钟" });
  await form.getByRole("radio", { name: "跑命令" }).click();
  await form.getByLabel("命令", { exact: true }).fill(`node -e "console.log('值守好了')"`);
  await form.getByTestId("duty-save").click();
  const command = dialog.getByTestId("duty-item").filter({ hasText: "报个平安" });
  await expect(command).toContainText("每 2 分钟");
  await expect(command).toContainText("下次");
  await command.getByRole("button", { name: "立即运行" }).click();
  await expect(command.getByTestId("duty-run")).toContainText("✓ 完成");
  await expect(command.getByTestId("duty-run")).toContainText("完成：值守好了");

  // A session, daily, in a new task each time.
  await dialog.getByTestId("duty-new").click();
  await form.getByLabel("值守项名字").fill("早上看一眼");
  await form.getByRole("radio", { name: "每天定时" }).click();
  await form.getByLabel("每天几点").fill("9:30");
  await form.getByLabel("开会话时说的话").fill("看一下有没有新问题");
  await form.getByTestId("duty-save").click();
  const session = dialog.getByTestId("duty-item").filter({ hasText: "早上看一眼" });
  await expect(session).toContainText("每天 09:30");
  await expect(session).toContainText("每次新建任务");
  await session.getByRole("button", { name: "立即运行" }).click();
  await expect(session.getByTestId("duty-run")).toContainText("✓ 完成", { timeout: 30_000 });
  await screenshot(app, "studio", "settings-duty", page);

  // Turned off: no next time. Edited: the new name shows. Removed: gone.
  // The box follows the Host's answer (it is not flipped before the Host has it).
  await command.getByRole("checkbox").click();
  await expect(command.getByRole("checkbox")).not.toBeChecked();
  await expect(command).not.toContainText("下次");
  await command.getByRole("button", { name: "编辑" }).click();
  await command.getByLabel("值守项名字").fill("报平安");
  await command.getByTestId("duty-save").click();
  const renamed = dialog.getByTestId("duty-item").filter({ hasText: "报平安" });
  await expect(renamed).toContainText("命令：node -e");
  page.once("dialog", (d) => void d.accept());
  await renamed.getByRole("button", { name: "删除" }).click();
  await expect(dialog.getByTestId("duty-item")).toHaveCount(1);
});
