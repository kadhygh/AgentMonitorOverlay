import { expect, test, type Locator, type Page } from "@playwright/test";
import type { CanvasDoc, StateSnapshot, Task, Topic, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

// 2026-10-29 (the user): the canvas sidebar has a 侧栏 switch and a width to drag like the task page's, both kept; the
// details of the selected card float in a box beside it (not modal) instead of a sidebar tab — following the card as the
// canvas pans, closed by ×, Esc or a click on the empty canvas; the sidebar's tabs fit one row.

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

type Box = { x: number; y: number; width: number; height: number };
const overlaps = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const inside = (a: Box, b: Box) => a.x >= b.x - 1 && a.y >= b.y - 1 && a.x + a.width <= b.x + b.width + 1 && a.y + a.height <= b.y + b.height + 1;

/** A topic with a group holding a task card (with a description) and a review item, and two more task cards. */
async function setup(s: Studio) {
  const ws = await s.api<Workspace>("POST", "/api/workspaces", { path: s.workspace("alpha") });
  const topic = await s.api<Topic>("POST", "/api/topics", { title: "详情框" });
  const made: Task[] = [];
  for (const title of ["拆表", "改导入", "跑校验"]) made.push((await s.api<{ task: Task }>("POST", "/api/tasks", { title, workspaceId: ws.id, topicId: topic.id })).task);
  const [split, imp, check] = made as [Task, Task, Task];
  await s.api("PATCH", `/api/tasks/${imp.id}`, { description: "先看现在的导入在哪一步失败，再决定要不要拆成两个任务。" });
  const canvas = () => s.api<CanvasDoc>("GET", `/api/topics/${topic.id}/canvas`);
  const empty = await canvas();
  await s.api("PUT", `/api/topics/${topic.id}/canvas`, {
    ...empty,
    groups: [{ id: "g1", title: "导入", workspaceId: null, rect: { x: 20, y: 60, w: 300, h: 300 } }],
    nodes: [
      { id: "n-imp", kind: "task", taskId: imp.id, groupId: "g1", pos: { x: 40, y: 110 } },
      { id: "n-item", kind: "item", num: 1, title: "重试次数写死在代码里", body: "现在是 3 次，配置里改不了；要么挪到设置，要么写清楚为什么是 3。", refs: ["src/import/retry.ts"], status: "todo", sessionId: null, groupId: "g1", pos: { x: 40, y: 220 } },
      { id: "n-split", kind: "task", taskId: split.id, groupId: null, pos: { x: 560, y: 110 } },
      { id: "n-check", kind: "task", taskId: check.id, groupId: null, pos: { x: 560, y: 420 } },
    ],
    edges: [],
  });
  return { topic, split, imp, check, canvas };
}

async function openCanvas(page: Page) {
  await page.getByRole("button", { name: "画布", exact: true }).click();
  await page.getByRole("button", { name: "复位" }).click();
  await expect(page.getByTestId("canvas-group")).toHaveCount(1);
}

const card = (page: Page, id: string) => page.locator(`[data-node-id="${id}"]`);

/** The box is beside its card: not over it, and inside the canvas. */
async function besideCard(page: Page, target: Locator) {
  const detail = page.getByTestId("canvas-detail");
  await expect(detail).toBeVisible();
  const d = (await detail.boundingBox())!;
  const c = (await target.boundingBox())!;
  const v = (await page.getByTestId("canvas-viewport").boundingBox())!;
  expect(overlaps(d, c)).toBe(false);
  expect(inside(d, v)).toBe(true);
  return { d, c };
}

test("the canvas sidebar: 侧栏 shows and hides it and is kept; its width is dragged and kept; the tabs fit one row", async () => {
  studio = await launchStudio();
  const { page } = studio;
  await setup(studio);
  await openCanvas(page);
  const side = page.getByTestId("canvas-side");
  const toggle = page.getByTestId("canvas-sidebar-toggle");

  // Shown at first, 320 wide, its five tabs in one row (no 详情 any more).
  await expect(side).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(side).toHaveCSS("width", "320px");
  const tabs = side.getByRole("tab");
  await expect(tabs).toHaveText(["整体待办", "沟通", "文档", "书签", "agent 视角"], { useInnerText: true });
  await expect(page.getByRole("tab", { name: "详情" })).toHaveCount(0);
  const tops = await tabs.evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
  expect(new Set(tops).size).toBe(1);
  await theme(page, "light");
  await screenshot(studio.app, "studio", "canvas-side-open-light", page);
  await theme(page, "dark");
  await screenshot(studio.app, "studio", "canvas-side-open-dark", page);

  // Hidden: the canvas takes the room; kept after a reload.
  const wide = (await page.getByTestId("canvas-viewport").boundingBox())!.width;
  await toggle.click();
  await expect(side).toHaveCount(0);
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect.poll(async () => (await page.getByTestId("canvas-viewport").boundingBox())!.width).toBeGreaterThan(wide + 300);
  await theme(page, "light");
  await screenshot(studio.app, "studio", "canvas-side-closed-light", page);
  await theme(page, "dark");
  await screenshot(studio.app, "studio", "canvas-side-closed-dark", page);
  await page.reload();
  await openCanvas(page);
  await expect(page.getByTestId("canvas-side")).toHaveCount(0);
  await page.getByTestId("canvas-sidebar-toggle").click();
  await expect(side).toBeVisible();

  // The width: dragged at the left edge (wider to the left), at most 560, at least 260; kept after a reload.
  const handle = page.getByRole("separator", { name: "调整画布侧栏宽度" });
  let h = (await handle.boundingBox())!;
  await drag(page, { x: h.x + 3, y: h.y + 200 }, { x: h.x - 97, y: h.y + 200 });
  await expect(side).toHaveCSS("width", "420px");
  h = (await handle.boundingBox())!;
  await drag(page, { x: h.x + 3, y: h.y + 200 }, { x: h.x - 600, y: h.y + 200 });
  await expect(side).toHaveCSS("width", "560px");
  h = (await handle.boundingBox())!;
  await drag(page, { x: h.x + 3, y: h.y + 200 }, { x: h.x + 600, y: h.y + 200 });
  await expect(side).toHaveCSS("width", "260px");
  // Narrow: the long names shorten, still one row.
  await expect(tabs).toHaveText(["待办", "沟通", "文档", "书签", "agent"], { useInnerText: true });
  const narrowTops = await tabs.evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
  expect(new Set(narrowTops).size).toBe(1);
  expect(await side.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await page.getByRole("tab", { name: "agent 视角" }).click();
  await theme(page, "light");
  await screenshot(studio.app, "studio", "canvas-side-narrow-light", page);
  await theme(page, "dark");
  await screenshot(studio.app, "studio", "canvas-side-narrow-dark", page);
  await page.reload();
  await openCanvas(page);
  await expect(page.getByTestId("canvas-side")).toHaveCSS("width", "260px");
  // The tab is kept too.
  await expect(page.getByRole("tab", { name: "agent 视角" })).toHaveAttribute("aria-selected", "true");
});

test("the 详情框: beside the selected card, follows a pan, closed by Esc, × or a click on the empty canvas; its actions work", async () => {
  studio = await launchStudio();
  const { page } = studio;
  const { canvas, split, imp, check } = await setup(studio);
  await openCanvas(page);
  const detail = page.getByTestId("canvas-detail");
  await expect(detail).toHaveCount(0);

  // A task card: its box on its right, not over it.
  await card(page, "n-imp").click();
  const first = await besideCard(page, card(page, "n-imp"));
  await expect(detail).toHaveAttribute("data-side", "right");
  await expect(detail.getByRole("group", { name: "任务详情" })).toContainText("改导入");
  await expect(detail.getByTestId("side-description")).toContainText("先看现在的导入");

  // A pan (dragging the empty canvas) keeps the selection; the box moves with the card.
  const v = (await page.getByTestId("canvas-viewport").boundingBox())!;
  await drag(page, { x: v.x + v.width - 120, y: v.y + v.height - 120 }, { x: v.x + v.width - 60, y: v.y + v.height - 90 });
  await expect(detail).toBeVisible();
  const moved = (await detail.boundingBox())!;
  const movedCard = (await card(page, "n-imp").boundingBox())!;
  expect(Math.round(movedCard.x - first.c.x)).toBe(60);
  expect(Math.round(moved.x - first.d.x)).toBe(60);
  expect(Math.round(moved.y - first.d.y)).toBe(30);
  await page.getByRole("button", { name: "复位" }).click();

  // Not modal: the canvas around it still takes clicks — another card's box replaces it.
  await card(page, "n-check").click();
  await besideCard(page, card(page, "n-check"));
  await expect(detail).toContainText("跑校验");

  // A click on the empty canvas closes it; so do Esc and ×.
  await page.mouse.click(v.x + v.width - 80, v.y + v.height - 160);
  await expect(detail).toHaveCount(0);
  await card(page, "n-check").click();
  await expect(detail).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(detail).toHaveCount(0);
  await card(page, "n-check").click();
  await detail.getByTestId("canvas-detail-close").click();
  await expect(detail).toHaveCount(0);

  // 前置任务: added and removed from the box.
  await card(page, "n-check").click();
  await detail.getByLabel("添加前置任务").selectOption({ label: "改导入" });
  await detail.getByRole("button", { name: "添加", exact: true }).click();
  await expect(detail.getByTestId("dependency")).toHaveText(/改导入/);
  await expect.poll(async () => (await canvas()).edges.map((e) => [e.from, e.to])).toEqual([[imp.id, check.id]]);
  await expect(page.getByTestId("canvas-edge")).toHaveCount(1);
  await detail.getByRole("button", { name: "移除前置任务 改导入" }).click();
  await expect.poll(async () => (await canvas()).edges.length).toBe(0);

  // 添加说明 opens the description dialog; its Esc closes the dialog only, the box stays.
  await detail.getByRole("button", { name: "添加说明" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(detail).toBeVisible();

  // The task card with a description, light and dark.
  await card(page, "n-imp").click();
  await theme(page, "light");
  await screenshot(studio.app, "studio", "canvas-detail-task-light", page);
  await theme(page, "dark");
  await screenshot(studio.app, "studio", "canvas-detail-task-dark", page);

  // 打开任务: the task page; back to the canvas.
  await detail.getByRole("button", { name: "打开任务" }).click();
  await expect(page.getByTestId("task-title")).toHaveText("改导入");
  await page.getByRole("button", { name: "返回画布" }).click();
  await expect(page.getByTestId("canvas-group")).toHaveCount(1);

  // A review item's details.
  await card(page, "n-item").click();
  await besideCard(page, card(page, "n-item"));
  await expect(detail.getByRole("group", { name: "审阅条目" })).toContainText("src/import/retry.ts");
  await theme(page, "light");
  await screenshot(studio.app, "studio", "canvas-detail-item-light", page);
  await theme(page, "dark");
  await screenshot(studio.app, "studio", "canvas-detail-item-dark", page);

  // A group: renamed in the box; a click on the empty canvas keeps the typed name and closes the box.
  const group = page.getByTestId("canvas-group");
  await group.locator(".canvas-group-bar").click();
  await besideCard(page, group);
  const name = detail.getByRole("group", { name: "分组设置" }).getByLabel("分组名称");
  await name.fill("导入流程");
  await theme(page, "light");
  await screenshot(studio.app, "studio", "canvas-detail-group-light", page);
  await theme(page, "dark");
  await screenshot(studio.app, "studio", "canvas-detail-group-dark", page);
  await theme(page, "light");
  await page.mouse.click(v.x + v.width - 80, v.y + v.height - 160);
  await expect(detail).toHaveCount(0);
  await expect.poll(async () => (await canvas()).groups[0]!.title).toBe("导入流程");
  await expect(group).toContainText("导入流程");
  // Esc while typing leaves the field (the name kept); a second Esc closes the box.
  await group.locator(".canvas-group-bar").click();
  await name.fill("导入");
  await page.keyboard.press("Escape");
  await expect(detail).toBeVisible();
  await expect(name).not.toBeFocused();
  await expect.poll(async () => (await canvas()).groups[0]!.title).toBe("导入");
  await page.keyboard.press("Escape");
  await expect(detail).toHaveCount(0);

  // Dragging a card hides its box until it is let go.
  const s = (await card(page, "n-split").boundingBox())!;
  await page.mouse.move(s.x + 40, s.y + 20);
  await page.mouse.down();
  await page.mouse.move(s.x + 80, s.y + 60, { steps: 4 });
  await expect(detail).toBeHidden();
  await page.mouse.move(s.x + 120, s.y + 100, { steps: 4 });
  await page.mouse.up();
  await besideCard(page, card(page, "n-split"));

  // 从画布上拿掉: only the card goes; the task stays.
  await detail.getByRole("button", { name: "从画布上拿掉（任务不变）" }).click();
  await expect(detail).toHaveCount(0);
  await expect.poll(async () => (await canvas()).nodes.some((n) => n.id === "n-split")).toBe(false);
  const state = await studio.api<StateSnapshot>("GET", "/api/state");
  expect(state.tasks.find((t) => t.id === split.id)?.archivedAt ?? null).toBeNull();
});
