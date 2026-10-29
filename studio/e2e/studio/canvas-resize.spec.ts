import { expect, test, type Locator, type Page } from "@playwright/test";
import type { CanvasDoc, CanvasNode, StateSnapshot, Task, Topic, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

// 2026-10-29 (the user): groups and every kind of card take the size they are dragged to, kept across a reopen; a small
// card cuts its text instead of spilling. Deleting a group asks whether its cards go too — a task's card then only leaves
// the canvas, the task stays. 删除 is coloured like 归档.

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 4 });
  await page.mouse.up();
}

const theme = (page: Page, which: "light" | "dark") => page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), which);

/** Every text part of a card lies inside the card (nothing spills when it is made small; a long line ends in an ellipsis). */
async function fitsInside(card: Locator): Promise<boolean> {
  return card.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const parts = [...el.querySelectorAll<HTMLElement>(".canvas-card-title, .canvas-card-meta, .canvas-card-desc, .canvas-note-text, .item-head, .item-summary, .item-activity")];
    return parts.every((p) => {
      const r = p.getBoundingClientRect();
      return r.left >= box.left - 1 && r.right <= box.right + 1 && r.top >= box.top - 1 && r.bottom <= box.bottom + 1;
    });
  });
}

/** A topic with a group, a task card with a description, a note, a reference card and a review item. */
async function setup(s: Studio) {
  const ws = await s.api<Workspace>("POST", "/api/workspaces", { path: s.workspace("alpha") });
  const topic = await s.api<Topic>("POST", "/api/topics", { title: "大小" });
  const other = await s.api<Topic>("POST", "/api/topics", { title: "别的专题" });
  const { task } = await s.api<{ task: Task }>("POST", "/api/tasks", { title: "整理导入流程，把重试和日志都理一遍", workspaceId: ws.id, topicId: topic.id });
  const { task: after } = await s.api<{ task: Task }>("POST", "/api/tasks", { title: "跑一遍校验", workspaceId: ws.id, topicId: topic.id });
  const { task: elsewhere } = await s.api<{ task: Task }>("POST", "/api/tasks", { title: "别处的任务", workspaceId: ws.id, topicId: other.id });
  await s.api("PATCH", `/api/tasks/${task.id}`, { description: "先看现在的导入在哪一步失败，重试几次，日志写到哪里；再决定要不要拆成两个任务，各自有自己的说明和验收。" });
  const canvas = () => s.api<CanvasDoc>("GET", `/api/topics/${topic.id}/canvas`);
  const empty = await canvas();
  await s.api("PUT", `/api/topics/${topic.id}/canvas`, {
    ...empty,
    groups: [{ id: "g1", title: "导入", workspaceId: null, rect: { x: 20, y: 50, w: 600, h: 360 } }],
    nodes: [
      { id: "n-task", kind: "task", taskId: task.id, groupId: "g1", pos: { x: 40, y: 100 } },
      { id: "n-note", kind: "note", text: "先问策划：重试三次够不够？\n日志要不要带上请求号？\n还有导入失败后要不要通知人。", groupId: "g1", pos: { x: 380, y: 100 } },
      { id: "n-ref", kind: "ref", taskId: elsewhere.id, groupId: "g1", pos: { x: 40, y: 280 } },
      { id: "n-item", kind: "item", num: 1, title: "重试次数写死在代码里", body: "现在是 3 次，配置里改不了；要么挪到设置，要么写清楚为什么是 3。", status: "todo", sessionId: null, groupId: "g1", pos: { x: 300, y: 270 } },
      { id: "n-after", kind: "task", taskId: after.id, groupId: null, pos: { x: 40, y: 470 } },
    ],
    edges: [{ id: "e1", kind: "depends", from: task.id, to: after.id }],
  });
  return { topic, task, after, elsewhere, canvas };
}

async function openCanvas(page: Page) {
  await page.getByRole("button", { name: "画布", exact: true }).click();
  await page.getByRole("button", { name: "复位" }).click();
  await expect(page.getByTestId("canvas-group")).toHaveCount(1);
  const vbox = (await page.getByTestId("canvas-viewport").boundingBox())!;
  return (x: number, y: number) => ({ x: vbox.x + 1 + x, y: vbox.y + 1 + y });
}

const nodeOf = (doc: CanvasDoc, id: string) => doc.nodes.find((n) => n.id === id) as CanvasNode;

test("canvas sizes: a group and each kind of card keep the size they are dragged to, and a small card cuts its text", async () => {
  studio = await launchStudio();
  const { page } = studio;
  const { canvas } = await setup(studio);
  let screen = await openCanvas(page);
  const before = await canvas();
  const card = (id: string) => page.locator(`[data-node-id="${id}"]`);

  // The group, larger then smaller from its corner: the cards in it stay where they are.
  const r = before.groups[0]!.rect;
  await drag(page, screen(r.x + r.w - 6, r.y + r.h - 6), screen(r.x + r.w + 54, r.y + r.h + 34));
  await expect.poll(async () => (await canvas()).groups[0]!.rect).toEqual({ ...r, w: r.w + 60, h: r.h + 40 });
  await drag(page, screen(r.x + r.w + 54, r.y + r.h + 34), screen(r.x + r.w - 46, r.y + r.h - 16));
  await expect.poll(async () => (await canvas()).groups[0]!.rect).toEqual({ ...r, w: r.w - 40, h: r.h - 10 });
  expect((await canvas()).nodes.map((n) => [n.id, n.pos, n.groupId])).toEqual(before.nodes.map((n) => [n.id, n.pos, n.groupId]));
  await drag(page, screen(r.x + r.w - 46, r.y + r.h - 16), screen(r.x + r.w + 14, r.y + r.h + 24));
  await expect.poll(async () => (await canvas()).groups[0]!.rect).toEqual({ ...r, w: r.w + 20, h: r.h + 30 });

  // A task card from its bottom-right corner (220×102 with its description): wider and taller, then as small as it goes —
  // the description gives way, the title keeps an ellipsis, nothing spills.
  const handle = (id: string) => card(id).getByTestId("canvas-card-resize");
  await card("n-task").hover();
  await expect(handle("n-task")).toBeVisible();
  let box = (await handle("n-task").boundingBox())!;
  await drag(page, { x: box.x + 6, y: box.y + 6 }, { x: box.x + 86, y: box.y + 56 });
  await expect.poll(async () => nodeOf(await canvas(), "n-task").size).toEqual({ w: 300, h: 152 });
  await expect(card("n-task").getByTestId("canvas-card-desc")).toBeVisible();
  expect(await fitsInside(card("n-task"))).toBe(true);
  box = (await handle("n-task").boundingBox())!;
  await drag(page, { x: box.x + 6, y: box.y + 6 }, { x: box.x - 300, y: box.y - 300 });
  await expect.poll(async () => nodeOf(await canvas(), "n-task").size).toEqual({ w: 140, h: 66 });
  await expect(card("n-task").getByTestId("canvas-card-desc")).toHaveCount(0);
  expect(await fitsInside(card("n-task"))).toBe(true);
  // Its place and its group did not change.
  expect(nodeOf(await canvas(), "n-task")).toMatchObject({ pos: { x: 40, y: 100 }, groupId: "g1" });

  // A note made smaller than its text: cut to the lines that fit (the task card's 详情框, floating over the note, put away).
  await page.keyboard.press("Escape");
  await card("n-note").hover();
  box = (await handle("n-note").boundingBox())!;
  await drag(page, { x: box.x + 6, y: box.y + 6 }, { x: box.x + 46, y: box.y - 40 });
  await expect.poll(async () => nodeOf(await canvas(), "n-note").size?.w).toBeGreaterThan(180);
  await expect(card("n-note")).toHaveClass(/is-sized/);
  expect(await fitsInside(card("n-note"))).toBe(true);

  // A reference card and a review item, smaller (each resized card's 详情框 put away before the next).
  await page.keyboard.press("Escape");
  await card("n-ref").hover();
  box = (await handle("n-ref").boundingBox())!;
  await drag(page, { x: box.x + 6, y: box.y + 6 }, { x: box.x - 44, y: box.y + 36 });
  await expect.poll(async () => nodeOf(await canvas(), "n-ref").size).toEqual({ w: 170, h: 96 });
  expect(await fitsInside(card("n-ref"))).toBe(true);
  await page.keyboard.press("Escape");
  await card("n-item").hover();
  box = (await handle("n-item").boundingBox())!;
  await drag(page, { x: box.x + 6, y: box.y + 6 }, { x: box.x - 34, y: box.y - 24 });
  await expect.poll(async () => nodeOf(await canvas(), "n-item").size).toEqual({ w: 200, h: 94 });
  expect(await fitsInside(card("n-item"))).toBe(true);

  // The task card a little larger again for the pictures.
  await page.keyboard.press("Escape");
  await card("n-task").hover();
  box = (await handle("n-task").boundingBox())!;
  await drag(page, { x: box.x + 6, y: box.y + 6 }, { x: box.x + 46, y: box.y + 26 });
  await expect.poll(async () => nodeOf(await canvas(), "n-task").size).toEqual({ w: 180, h: 86 });
  expect(await fitsInside(card("n-task"))).toBe(true);
  const saved = await canvas();

  // Reopened: the same sizes, drawn as saved.
  await page.reload();
  screen = await openCanvas(page);
  await expect(card("n-task")).toHaveCSS("width", "180px");
  await expect(card("n-task")).toHaveCSS("height", "86px");
  await expect(card("n-ref")).toHaveCSS("width", "170px");
  await expect(card("n-item")).toHaveCSS("height", "94px");
  await expect(page.getByTestId("canvas-group")).toHaveCSS("width", `${r.w + 20}px`);
  expect((await canvas()).nodes).toEqual(saved.nodes);
  await page.mouse.click(screen(680, 200).x, screen(680, 200).y); // nothing selected
  await theme(page, "light");
  await card("n-task").hover();
  await screenshot(studio.app, "studio", "canvas-resize-light", page);
  await theme(page, "dark");
  await card("n-task").hover();
  await screenshot(studio.app, "studio", "canvas-resize-dark", page);

  // A double-click on the corner gives a card back its own size.
  await handle("n-note").dblclick();
  await expect.poll(async () => nodeOf(await canvas(), "n-note").size).toBeUndefined();
  await expect(card("n-note")).not.toHaveClass(/is-sized/);
});

test("canvas: deleting a group asks whether its cards go too; a task's card only leaves the canvas, the task stays", async () => {
  studio = await launchStudio();
  const { page } = studio;
  const { topic, task, after, elsewhere, canvas } = await setup(studio);
  await openCanvas(page);
  const group = page.getByTestId("canvas-group");
  const dialog = page.getByTestId("delete-group-confirm");
  const before = await canvas();

  // The × asks; left unticked, only the group goes and its four cards stay where they are.
  await group.hover();
  await expect(page.getByTestId("group-remove")).toHaveClass(/soft-danger/);
  await page.getByTestId("group-remove").click();
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("删除分组「导入」？");
  await expect(dialog).toContainText("同时删除组里的 4 张卡片");
  await expect(page.getByTestId("delete-group-cards")).not.toBeChecked();
  await expect(page.getByTestId("delete-group-what")).toContainText("4 张卡片留在原处");
  await theme(page, "light");
  await screenshot(studio.app, "studio", "canvas-delete-group-light", page);
  await dialog.getByTestId("confirm-action").click();
  await expect(dialog).toHaveCount(0);
  await expect(group).toHaveCount(0);
  await expect.poll(async () => (await canvas()).groups.length).toBe(0);
  expect((await canvas()).nodes.map((n) => [n.id, n.pos, n.groupId])).toEqual(before.nodes.map((n) => [n.id, n.pos, null]));

  // Back in a group; this time from the menu, ticked: the task's card leaves the canvas (the task and its dependency
  // stay), the note, the reference card and the review item are deleted; the card outside the group is untouched.
  const now = await canvas();
  await studio.api("PUT", `/api/topics/${topic.id}/canvas`, { ...now, groups: before.groups, nodes: before.nodes });
  await expect(group).toHaveCount(1);
  await group.locator(".canvas-group-bar").click({ button: "right" });
  await page.getByTestId("menu-delete-group").click();
  await expect(dialog).toBeVisible();
  await page.getByTestId("delete-group-cards").check();
  const what = page.getByTestId("delete-group-what");
  await expect(what).toContainText("1 张任务卡片从画布上拿掉，任务本身不删");
  await expect(what).toContainText("1 张便签会删除");
  await expect(what).toContainText("1 张引用卡片会删除，引用的任务不受影响");
  await expect(what).toContainText("1 条审阅条目会删除");
  await expect(dialog.getByTestId("confirm-action")).toHaveText("删除分组和 4 张卡片");
  await expect(dialog.getByTestId("confirm-action")).toHaveClass(/btn-danger/);
  await theme(page, "dark");
  await screenshot(studio.app, "studio", "canvas-delete-group-dark", page);
  // Cancel first: nothing changes.
  await dialog.getByRole("button", { name: "取消" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(group).toHaveCount(1);
  await group.locator(".canvas-group-bar").click({ button: "right" });
  await page.getByTestId("menu-delete-group").click();
  await page.getByTestId("delete-group-cards").check();
  await dialog.getByTestId("confirm-action").click();
  await expect(group).toHaveCount(0);
  await expect.poll(async () => (await canvas()).nodes.map((n) => n.id)).toEqual(["n-after"]);
  const doc = await canvas();
  expect(doc.groups).toEqual([]);
  expect(doc.edges).toEqual(before.edges);
  const state = await studio.api<StateSnapshot>("GET", "/api/state");
  for (const id of [task.id, after.id, elsewhere.id]) expect(state.tasks.find((t) => t.id === id)?.archivedAt ?? null).toBeNull();
  expect(state.tasks.find((t) => t.id === task.id)!.topicId).toBe(topic.id);

  // The sidebar's delete buttons look like 归档 (the same soft-danger face).
  await page.getByTestId("canvas-card").first().click();
  const remove = page.getByRole("group", { name: "任务详情" }).getByRole("button", { name: "从画布上拿掉（任务不变）" });
  await expect(remove).toHaveClass(/soft-danger/);
  await theme(page, "light");
  await screenshot(studio.app, "studio", "canvas-sidebar-remove-light", page);
});
