import { expect, test, type Locator, type Page } from "@playwright/test";
import type { CanvasDoc, Session, Task, Topic, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

// 2026-10-19: dragging empty canvas moves the camera (the dot grid moves with the cards); 连线 as on an Obsidian
// canvas: four handles on a card's sides, a line dragged to another card, its label written on it, reversed, and gone
// with a card taken off.

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

/** Middle of an SVG path on screen. */
async function middleOf(path: Locator): Promise<{ x: number; y: number }> {
  return path.evaluate((el) => {
    const p = el as SVGPathElement;
    const at = p.getPointAtLength(p.getTotalLength() / 2);
    const m = p.getScreenCTM()!;
    return { x: at.x * m.a + m.e, y: at.y * m.d + m.f };
  });
}

async function dragBy(page: Page, from: { x: number; y: number }, dx: number, dy: number) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + dx / 2, from.y + dy / 2, { steps: 5 });
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 5 });
  await page.mouse.up();
}

test("dragging empty canvas moves the grid too; 连线 between cards with a label, reversed, gone with a card", async () => {
  studio = await launchStudio();
  const { page, app } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  const topic = await studio.api<Topic>("POST", "/api/topics", { title: "迁移" });
  const made: Task[] = [];
  for (const title of ["伤害统计", "装甲车"]) {
    const { task } = await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", { title, workspaceId: ws.id, topicId: topic.id, firstSession: { profileId: "codex-mock" } });
    await studio.api("PUT", `/api/tasks/${task.id}/canvas`, { onCanvas: true });
    made.push(task);
  }
  const canvas = () => studio!.api<CanvasDoc>("GET", `/api/topics/${topic.id}/canvas`);
  await page.getByRole("button", { name: "画布", exact: true }).click();
  await page.getByRole("button", { name: "复位" }).click();
  const card = (title: string) => page.getByTestId("canvas-card").filter({ hasText: title });
  await expect(card("装甲车")).toBeVisible();

  // The cards apart, so a line has room between them.
  const tank = (await card("装甲车").boundingBox())!;
  await dragBy(page, { x: tank.x + 40, y: tank.y + 20 }, 340, 160);

  // Empty space: the grid moves with the cards (a camera move), not under them.
  const viewport = page.getByTestId("canvas-viewport");
  const grid = () => viewport.evaluate((el) => getComputedStyle(el).backgroundPosition);
  const before = await grid();
  const vbox = (await viewport.boundingBox())!;
  await dragBy(page, { x: vbox.x + 30, y: vbox.y + vbox.height - 60 }, 50, -30);
  expect(await grid()).not.toBe(before);
  expect(await grid()).toBe("50px -30px");

  // A line from 伤害统计's right handle to 装甲车 (dropped on the card: its nearest side).
  const damage = card("伤害统计");
  await damage.hover();
  const handle = damage.locator('[data-testid="canvas-handle"][data-side="right"]');
  await expect(handle).toHaveCSS("opacity", "1");
  const h = (await handle.boundingBox())!;
  const t = (await card("装甲车").boundingBox())!;
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(t.x + 60, t.y + 30, { steps: 8 });
  await expect(page.getByTestId("canvas-link-drawing")).toHaveCount(1);
  await page.mouse.move(t.x + 30, t.y + 20, { steps: 4 });
  await page.mouse.up();
  await expect(page.getByTestId("canvas-link")).toHaveCount(1);
  await expect(page.getByTestId("canvas-link-drawing")).toHaveCount(0);
  const [damageNode, tankNode] = made.map((task) => task.id);
  await expect.poll(async () => (await canvas()).links).toEqual([
    expect.objectContaining({ fromSide: "right", toSide: expect.stringMatching(/^(left|top)$/) }),
  ]);
  const saved = (await canvas()).links![0]!;
  const nodes = (await canvas()).nodes;
  expect(nodes.find((n) => n.id === saved.from)).toMatchObject({ taskId: damageNode });
  expect(nodes.find((n) => n.id === saved.to)).toMatchObject({ taskId: tankNode });

  // Double-click the line: its label.
  const at = await middleOf(page.getByTestId("canvas-link-hit"));
  await page.mouse.dblclick(at.x, at.y);
  const input = page.getByTestId("canvas-link-input");
  await input.fill("先迁数据");
  await input.press("Enter");
  await expect(page.getByTestId("canvas-link-label")).toHaveText("先迁数据");
  await expect.poll(async () => (await canvas()).links?.[0]?.label).toBe("先迁数据");
  await screenshot(app, "stage-18", "S18-canvas-links", page);

  // Right-click: 反过来 swaps the ends (and sides); 编辑文字 again, emptied, takes the label off.
  const menu = page.getByTestId("canvas-menu");
  await page.getByTestId("canvas-link-label").click({ button: "right" });
  await expect(menu).toHaveAttribute("aria-label", "连线");
  await menu.getByRole("menuitem", { name: "反过来" }).click();
  await expect.poll(async () => (await canvas()).links?.[0]).toMatchObject({ from: saved.to, to: saved.from, fromSide: saved.toSide, toSide: saved.fromSide, label: "先迁数据" });
  await page.getByTestId("canvas-link-label").click({ button: "right" });
  await menu.getByTestId("menu-link-label").click();
  await page.getByTestId("canvas-link-input").fill("");
  await page.getByTestId("canvas-link-input").press("Enter");
  await expect(page.getByTestId("canvas-link-label")).toHaveCount(0);
  await expect.poll(async () => (await canvas()).links?.[0]?.label).toBeUndefined();

  // A card taken off the canvas takes its lines with it.
  await card("装甲车").click({ button: "right" });
  await menu.getByRole("menuitem", { name: /从画布上拿掉/ }).click();
  await expect(page.getByTestId("canvas-link")).toHaveCount(0);
  await expect.poll(async () => (await canvas()).links).toEqual([]);
});
