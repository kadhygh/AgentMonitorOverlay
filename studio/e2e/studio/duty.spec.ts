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
  // The profile's own permissions, to pick one that does not stop to ask (2026-10-31).
  const permission = form.getByLabel("值守会话的权限");
  await permission.selectOption({ index: 1 });
  const chosen = await permission.inputValue();
  expect(chosen).not.toBe("");
  // Checks first (2026-10-31): Studio's 问题页 check is offered; a check command is what this item uses (it prints
  // nothing, so no session starts), then it is changed to no check.
  await form.getByRole("radio", { name: "Studio 自带检查" }).click();
  await expect(form.getByLabel("Studio 自带检查")).toHaveValue("issues.pending");
  await form.getByRole("radio", { name: "跑检查命令" }).click();
  await form.getByLabel("检查命令", { exact: true }).fill(`node -e ""`);
  await expect(form).toContainText("AMO_DUTY_DONE");
  await form.getByLabel("AI 做完可以关掉值守").check();
  await screenshot(app, "studio", "settings-duty-form", page);
  await form.getByTestId("duty-save").click();
  const checked = dialog.getByTestId("duty-item").filter({ hasText: "早上看一眼" });
  await expect(checked).toContainText("先跑检查命令");
  await expect(checked).toContainText("做完了 AI 可以关掉它");
  await checked.getByRole("button", { name: "立即运行" }).click();
  await expect(checked.getByTestId("duty-run")).toContainText("○ 跳过");
  await expect(checked.getByTestId("duty-run")).toContainText("检查过了，没有要做的");
  await checked.getByRole("button", { name: "编辑" }).click();
  await checked.getByRole("radio", { name: "不检查，到点就开" }).click();
  await checked.getByTestId("duty-save").click();
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

  // 值守 outside 设置 (2026-10-31): the top bar's button and dialog; the session an item started is marked, and so is
  // the task an item opens its sessions in (now the one its run made).
  await session.getByRole("button", { name: "编辑" }).click();
  await session.getByLabel("在哪个任务里开会话").selectOption({ index: 1 });
  await session.getByTestId("duty-save").click();
  await expect(session).toContainText("在任务「早上看一眼");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("topbar-duty")).toContainText("1 项开着");
  await expect(page.getByTestId("card-duty")).toHaveCount(1);
  await page.getByTestId("topbar-duty").click();
  const panel = page.getByTestId("duty-dialog");
  await expect(panel.getByTestId("duty-dialog-item")).toContainText("早上看一眼");
  await expect(panel.getByTestId("duty-dialog-item")).toContainText("✓ 完成");
  await screenshot(app, "studio", "duty-dialog", page);
  await panel.getByTestId("duty-dialog-session").click();
  await expect(panel).toBeHidden();
  await expect(page.getByTestId("session-duty")).toHaveText("值守开的");
  await expect(page.getByTestId("task-duty")).toContainText("早上看一眼");
  await screenshot(app, "studio", "duty-marks", page);
  await page.getByTestId("task-duty").click();
  await expect(panel).toBeVisible();
});

test("值守: an item hangs under another, shown under it; the parent off turns it off (2026-11-01)", async () => {
  studio = await launchStudio();
  const { page, app } = studio;
  await page.getByRole("button", { name: "设置" }).click();
  const dialog = page.getByRole("dialog", { name: "设置" });
  await dialog.getByRole("tab", { name: "值守" }).click();
  const make = async (name: string, under?: string) => {
    await dialog.getByTestId("duty-new").click();
    const form = dialog.getByTestId("duty-form");
    await form.getByLabel("值守项名字").fill(name);
    await form.getByRole("radio", { name: "跑命令" }).click();
    await form.getByLabel("命令", { exact: true }).fill(`node -e ""`);
    if (under) await form.getByLabel("挂在哪个值守项下面").selectOption({ label: `「${under}」下面` });
    await form.getByTestId("duty-save").click();
    await expect(dialog.getByTestId("duty-form")).toHaveCount(0);
  };
  await make("日常值守");
  await make("别的");
  await make("自动打包", "日常值守");
  // Listed right under its parent, marked so.
  await expect(dialog.getByTestId("duty-item")).toHaveText([/日常值守/, /自动打包/, /别的/]);
  const child = dialog.getByTestId("duty-item").filter({ hasText: "自动打包" });
  await expect(child).toContainText("挂在「日常值守」下");
  await screenshot(app, "studio", "settings-duty-child", page);

  // The parent off: the child goes off with it and cannot be turned on alone.
  const parent = dialog.getByTestId("duty-item").filter({ hasText: "日常值守" }).first();
  await parent.getByRole("checkbox").click();
  await expect(child.getByRole("checkbox")).not.toBeChecked();
  await expect(child.getByRole("checkbox")).toBeDisabled();
  await page.keyboard.press("Escape");
  await page.getByTestId("topbar-duty").click();
  const panel = page.getByTestId("duty-dialog");
  await expect(panel.getByTestId("duty-dialog-item").filter({ hasText: "自动打包" })).toContainText("挂在「日常值守」下");
  await screenshot(app, "studio", "duty-dialog-child", page);
});
