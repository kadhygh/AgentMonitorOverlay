import { expect, test } from "@playwright/test";
import type { CanvasDoc, Session, Task, Topic, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

// Stage 16 (2026-10-17): a task's description on its canvas card and task page; colour marks on cards, notes and
// groups; the canvas's right-click menus (after Obsidian Canvas): the empty canvas, a card, a note, a group, a line.

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

test("canvas right-click: descriptions, colour marks, 连依赖, notes and groups (2026-10-17)", async () => {
  studio = await launchStudio();
  const { page } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  const topic = await studio.api<Topic>("POST", "/api/topics", { title: "迁移" });
  const made: Task[] = [];
  for (const title of ["伤害统计", "装甲车"]) {
    const { task } = await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", { title, workspaceId: ws.id, topicId: topic.id, firstSession: { profileId: "codex-mock" } });
    await studio.api("PUT", `/api/tasks/${task.id}/canvas`, { onCanvas: true });
    made.push(task);
  }
  const [damage, tank] = made as [Task, Task];
  await studio.api("PATCH", `/api/tasks/${damage.id}`, { description: "把伤害统计从旧分支迁过来\n先做数据，再做界面" });
  const canvas = () => studio!.api<CanvasDoc>("GET", `/api/topics/${topic.id}/canvas`);

  await page.getByRole("button", { name: "画布", exact: true }).click();
  await page.getByRole("button", { name: "复位" }).click();
  const card = (title: string) => page.getByTestId("canvas-card").filter({ hasText: title });
  await expect(card("伤害统计").getByTestId("canvas-card-desc")).toContainText("把伤害统计从旧分支迁过来");
  await expect(card("装甲车").getByTestId("canvas-card-desc")).toHaveCount(0);

  // A colour mark from the card's menu: its outline, saved on the canvas.
  const menu = page.getByTestId("canvas-menu");
  await card("伤害统计").click({ button: "right" });
  await expect(menu).toHaveAttribute("aria-label", "任务卡片");
  await menu.getByRole("menuitemradio", { name: "标红色" }).click();
  await expect(menu).toHaveCount(0);
  await expect(card("伤害统计")).toHaveAttribute("data-color", "red");
  await expect.poll(async () => (await canvas()).nodes.find((n) => n.kind === "task" && n.taskId === damage.id)?.color).toBe("red");

  // 添加说明… writes the task's own description.
  await card("装甲车").click({ button: "right" });
  await menu.getByTestId("menu-describe").click();
  const dialog = page.getByTestId("description-dialog");
  await dialog.getByLabel("说明内容").fill("迁移装甲车和弹射闪电");
  await dialog.getByTestId("description-save").click();
  await expect(dialog).toHaveCount(0);
  await expect(card("装甲车").getByTestId("canvas-card-desc")).toHaveText("迁移装甲车和弹射闪电");
  expect((await studio.api<{ tasks: Task[] }>("GET", "/api/state")).tasks.find((t) => t.id === tank.id)?.description).toBe("迁移装甲车和弹射闪电");

  // 连依赖: the card picked second waits for the first (the cards apart first, so the line between them can be clicked).
  const box = (await card("装甲车").boundingBox())!;
  await page.mouse.move(box.x + 40, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(box.x + 200, box.y + 120, { steps: 6 });
  await page.mouse.move(box.x + 360, box.y + 220, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => (await canvas()).nodes.find((n) => n.kind === "task" && n.taskId === tank.id)?.pos.x).toBeGreaterThan(300);
  await card("伤害统计").click({ button: "right" });
  await menu.getByTestId("menu-link").click();
  await expect(page.getByTestId("canvas-linking")).toContainText("伤害统计");
  await card("装甲车").click();
  await expect(page.getByTestId("canvas-linking")).toHaveCount(0);
  await expect(page.getByTestId("canvas-edge")).toHaveCount(1);
  await expect.poll(async () => (await canvas()).edges.map((e) => [e.from, e.to])).toEqual([[damage.id, tank.id]]);
  await screenshot(studio.app, "stage-16", "S16-B-canvas-marks", page);

  // The line's own menu: reverse it, then delete it (the selected card's 详情框 put away first: it floats over the line).
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("canvas-detail")).toHaveCount(0);
  await page.getByTestId("canvas-edge-hit").click({ button: "right" });
  await expect(menu).toHaveAttribute("aria-label", "依赖");
  await menu.getByRole("menuitem", { name: "反过来" }).click();
  await expect.poll(async () => (await canvas()).edges.map((e) => [e.from, e.to])).toEqual([[tank.id, damage.id]]);
  await page.getByTestId("canvas-edge-hit").click({ button: "right" });
  await menu.getByRole("menuitem", { name: "删除依赖" }).click();
  await expect(page.getByTestId("canvas-edge")).toHaveCount(0);

  // The empty canvas: a note where it was clicked; its menu marks it, copies it, deletes it.
  const vbox = (await page.getByTestId("canvas-viewport").boundingBox())!;
  await page.mouse.click(vbox.x + 120, vbox.y + vbox.height - 140, { button: "right" });
  await expect(menu).toHaveAttribute("aria-label", "画布");
  await menu.getByTestId("menu-new-note").click();
  const notes = page.getByTestId("canvas-note");
  await expect(notes).toHaveCount(1);
  await page.getByRole("textbox", { name: "便签内容" }).fill("先问策划");
  await page.getByRole("textbox", { name: "便签内容" }).blur();
  await notes.first().click({ button: "right" });
  await menu.getByRole("menuitemradio", { name: "标绿色" }).click();
  await expect(notes.first()).toHaveAttribute("data-color", "green");
  await notes.first().click({ button: "right" });
  await menu.getByRole("menuitem", { name: "复制一份" }).click();
  await expect(notes).toHaveCount(2);
  await expect.poll(async () => (await canvas()).nodes.filter((n) => n.kind === "note").map((n) => [n.kind === "note" && n.text, n.color])).toEqual([
    ["先问策划", "green"],
    ["先问策划", "green"],
  ]);
  await notes.last().click({ button: "right" });
  await menu.getByRole("menuitem", { name: "删除便签" }).click();
  await expect(notes).toHaveCount(1);

  // A group from the empty canvas; marked blue; deleted from its menu — empty, it goes at once (no question), tasks untouched.
  await page.mouse.click(vbox.x + vbox.width / 2, vbox.y + 160, { button: "right" });
  await menu.getByTestId("menu-new-group").click();
  const group = page.getByTestId("canvas-group");
  await expect(group).toHaveCount(1);
  await group.locator(".canvas-group-bar").click({ button: "right" });
  await expect(menu).toHaveAttribute("aria-label", "分组");
  await menu.getByRole("menuitemradio", { name: "标蓝色" }).click();
  await expect(group).toHaveAttribute("data-color", "blue");
  await group.locator(".canvas-group-bar").click({ button: "right" });
  await menu.getByTestId("menu-delete-group").click();
  await expect(page.getByTestId("delete-group-confirm")).toHaveCount(0);
  await expect(group).toHaveCount(0);
  await expect(page.getByTestId("canvas-card")).toHaveCount(2);

  // 全部显示 fits what is on the canvas; Escape closes a menu.
  await page.mouse.click(vbox.x + vbox.width - 60, vbox.y + vbox.height - 60, { button: "right" });
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await page.mouse.click(vbox.x + vbox.width - 60, vbox.y + vbox.height - 60, { button: "right" });
  await menu.getByTestId("menu-fit").click();
  await expect(page.getByTestId("zoom-label")).not.toHaveText("");

  // The task page shows the description, and edits it from ⋯.
  await card("装甲车").dblclick();
  await expect(page.getByTestId("task-description")).toHaveText(/迁移装甲车和弹射闪电/);
  await page.getByTestId("task-more").click();
  await page.getByTestId("task-describe").click();
  await dialog.getByLabel("说明内容").fill("");
  await dialog.getByTestId("description-save").click();
  await expect(page.getByTestId("task-description")).toHaveCount(0);
});
