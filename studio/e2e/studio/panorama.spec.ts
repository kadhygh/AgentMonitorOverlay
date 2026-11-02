import { expect, test, type Page } from "@playwright/test";
import type { CanvasDoc, Session, StateSnapshot, Task, Topic, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

// 全景 (设置 → 测试功能, 2026-11-01): off by default; turned on, a tab after 画布 shows the topic's tasks as lanes on a
// deck.gl map, sessions as nodes, the ones waiting on the person with signs. Every click on the map is a real mouse
// click (page.mouse): the prototype once passed with clicks made by calling page functions while a person could not
// click at all, so the page only tells where things are (window.__panorama) and the mouse does the rest.
//
// P1 (2026-11-02): each task a tree — the map opens on 远 (start, trunk, goal; nodes come in at 中), a dependency
// drawn on the canvas is an arc, and a task's sessions are its rounds.

let studio: Studio | undefined;

/** What the page tells about the map (engine.ts EngineProbe): where nodes are, whether the camera still moves. */
type Probe = { screenOf(id: string): [number, number] | null; regionNameOf(laneId: string): [number, number] | null; busy: boolean; selected: string | null; signs: number; level: "far" | "mid"; flows: number; arcs: number };
type WithProbe = { __panorama?: Probe };

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

/** Until the camera has stopped and the signs are placed. */
async function settle(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => { const p = (window as unknown as WithProbe).__panorama; return !!p && !p.busy; }), { timeout: 20_000 }).toBe(true);
  await page.waitForTimeout(250);
}

/** A node's place on the page (its place on the map plus where the map is). */
async function nodeOnPage(page: Page, id: string): Promise<{ x: number; y: number }> {
  const box = (await page.getByTestId("panorama-map").boundingBox())!;
  const xy = await page.evaluate((i) => (window as unknown as WithProbe).__panorama?.screenOf(i) ?? null, id);
  expect(xy, `node ${id} on the map`).not.toBeNull();
  return { x: box.x + xy![0], y: box.y + xy![1] };
}

async function clickCenter(page: Page, testId: string): Promise<void> {
  const b = (await page.getByTestId(testId).boundingBox())!;
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
}

test("全景: off by default, turned on in 测试功能, waiting sessions flown to and nodes clicked with the mouse", async () => {
  studio = await launchStudio();
  const { page, app } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  const topic = await studio.api<Topic>("POST", "/api/topics", { title: "全景测试", workspaceIds: [ws.id] });
  // Two tasks with a session waiting for approval (the mock Codex asks before a shell command), one that just talked.
  const a = await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", { title: "掉落表校验", workspaceId: ws.id, topicId: topic.id, firstSession: { profileId: "codex-mock", text: "[[shell: cmd /c echo pn-a]]" } });
  const b = await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", { title: "整理关卡数据", workspaceId: ws.id, topicId: topic.id, firstSession: { profileId: "codex-mock", text: "你好" } });
  const c = await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", { title: "第三个任务", workspaceId: ws.id, topicId: topic.id, firstSession: { profileId: "codex-mock", text: "[[shell: cmd /c echo pn-c]]" } });
  // A second session on one task: its lane has two nodes, in the order they started.
  const b2 = await studio.api<Session>("POST", `/api/tasks/${b.task.id}/sessions`, { profileId: "codex-mock", text: "再整理一遍" });
  await expect
    .poll(async () => (await studio!.api<StateSnapshot>("GET", "/api/state")).sessions.filter((s) => s.status === "awaiting-approval").length, { timeout: 30_000 })
    .toBe(2);
  // On the canvas, c waits for a: an arc from a's goal to c's start.
  const doc = await studio.api<CanvasDoc>("GET", `/api/topics/${topic.id}/canvas`);
  await studio.api("PUT", `/api/topics/${topic.id}/canvas`, {
    ...doc,
    nodes: [
      { id: "n-a", kind: "task", taskId: a.task.id, groupId: null, pos: { x: 40, y: 40 } },
      { id: "n-c", kind: "task", taskId: c.task.id, groupId: null, pos: { x: 400, y: 40 } },
    ],
    edges: [{ id: "e1", kind: "depends", from: a.task.id, to: c.task.id }],
  });

  // Off by default: no tab.
  const tab = page.locator(".view-tab", { hasText: "全景" });
  await expect(page.locator(".view-tab", { hasText: "画布" })).toBeVisible();
  await expect(tab).toHaveCount(0);
  expect((await studio.api<{ experimentalFeatures: string[] }>("GET", "/api/settings")).experimentalFeatures).toEqual([]);

  // 设置 → 测试功能 → 全景.
  await page.getByRole("button", { name: "设置" }).click();
  const dialog = page.getByRole("dialog", { name: "设置" });
  await dialog.getByRole("tab", { name: "测试功能" }).click();
  const toggle = dialog.getByTestId("experimental-panorama");
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await expect(toggle).toBeChecked();
  await expect.poll(async () => (await studio!.api<{ experimentalFeatures: string[] }>("GET", "/api/settings")).experimentalFeatures).toEqual(["panorama"]);
  await screenshot(app, "studio", "panorama-settings", page);
  await page.keyboard.press("Escape");

  // The tab is there, right after 画布.
  await expect(tab).toBeVisible();
  expect(await page.locator(".view-tab").allTextContents()).toEqual(expect.arrayContaining(["画布", "全景"]));
  const tabs = await page.locator(".view-tab").allTextContents();
  expect(tabs.indexOf("全景")).toBe(tabs.indexOf("画布") + 1);
  await tab.click();

  // The map draws (WebGL in the test window), with the topic and 2 waiting.
  const pano = page.getByTestId("panorama");
  await expect(pano).toHaveAttribute("data-mode", "map", { timeout: 20_000 });
  await expect(pano.locator(".pn-ttl")).toHaveText("全景测试");
  await expect(pano.locator(".pn-row")).toHaveText("3 个任务 · 4 个会话");
  await expect(page.getByTestId("panorama-need")).toContainText("2 件等你");
  await settle(page);
  const probe = () => page.evaluate(() => { const p = (window as unknown as WithProbe).__panorama!; return { signs: p.signs, level: p.level, flows: p.flows, arcs: p.arcs }; });
  // 远: the whole topic, the 等你 signs, the dependency's arc.
  expect(await probe()).toMatchObject({ level: "far", arcs: 1 });
  expect((await probe()).signs).toBeGreaterThanOrEqual(2);
  await expect(page.locator(".pn-readout")).toContainText("远");
  await screenshot(app, "studio", "panorama-far", page);

  // 「N 件等你」 with the mouse: the first waiting one (the oldest wait), its popup, then the next.
  await clickCenter(page, "panorama-need");
  const win = page.getByTestId("panorama-window");
  await expect(win).toBeVisible();
  await expect(win).toContainText("掉落表校验");
  await expect(win).toContainText("待批准");
  await expect.poll(() => page.evaluate(() => (window as unknown as WithProbe).__panorama!.selected)).toBe(a.session.id);
  await expect(page.getByTestId("panorama-need")).toContainText("第 1/2 件");
  await settle(page);
  await screenshot(app, "studio", "panorama-need-1", page);
  await clickCenter(page, "panorama-need");
  await expect(win).toContainText("第三个任务");
  await expect.poll(() => page.evaluate(() => (window as unknown as WithProbe).__panorama!.selected)).toBe(c.session.id);
  await settle(page);

  // While flown in, the waiting node itself takes a mouse click (it is in front, left of the popup).
  await win.getByRole("button", { name: "✕ 关闭" }).click();
  await expect(win).toHaveCount(0);
  const near = await nodeOnPage(page, c.session.id);
  await page.mouse.click(near.x, near.y);
  await expect(win).toContainText("第三个任务");
  await page.keyboard.press("Escape");
  await expect(win).toHaveCount(0);

  // Back to the whole topic (远 again), into b's area by its name (中), then click an ordinary node: its first round.
  await page.getByRole("button", { name: "重置视角" }).click();
  await settle(page);
  expect((await probe()).level).toBe("far");
  const box = (await page.getByTestId("panorama-map").boundingBox())!;
  const name = (await page.evaluate((id) => (window as unknown as WithProbe).__panorama!.regionNameOf(id), b.task.id))!;
  await page.mouse.click(box.x + name[0], box.y + name[1]);
  await page.waitForTimeout(300);
  await settle(page);
  expect((await probe()).level).toBe("mid");
  await expect(page.locator(".pn-readout")).toContainText("中");
  const plain = await nodeOnPage(page, b.session.id);
  await page.mouse.move(plain.x - 40, plain.y - 40);
  await page.mouse.click(plain.x, plain.y);
  await expect(win).toBeVisible();
  await expect(win).toContainText("整理关卡数据");
  await expect(win).toContainText("#2 · 第 1 轮");
  await expect(win).not.toHaveClass(/need/);
  // Its second round started later, so it sits further along the trunk.
  expect(await page.evaluate(([x, y]: string[]) => { const p = (window as unknown as WithProbe).__panorama!; return p.screenOf(y!)![0] - p.screenOf(x!)![0]; }, [b.session.id, b2.id])).not.toBe(0);
  await settle(page);
  await screenshot(app, "studio", "panorama-node", page);

  // 「打开任务」 opens the task on that session; its "←" comes back to 全景.
  await win.getByTestId("panorama-open-task").click();
  await expect(page.getByTestId("task-title")).toHaveText("整理关卡数据");
  await expect(page.getByTestId("back")).toHaveAccessibleName("返回全景");
  await page.getByTestId("back").click();
  await expect(pano).toHaveAttribute("data-mode", "map", { timeout: 20_000 });

  // Without WebGL the page is a list, not a blank area.
  await page.evaluate(() => localStorage.setItem("amo.panorama.noWebgl", "1"));
  await page.locator(".view-tab", { hasText: "看板" }).click();
  await tab.click();
  await expect(page.getByTestId("panorama-list")).toBeVisible();
  await expect(page.getByTestId("panorama-list")).toContainText("2 件等你");
  await screenshot(app, "studio", "panorama-list", page);
  await page.evaluate(() => localStorage.removeItem("amo.panorama.noWebgl"));

  // Off again: the tab goes, and the page in front falls back to the board.
  await page.getByRole("button", { name: "设置" }).click();
  await dialog.getByRole("tab", { name: "测试功能" }).click();
  await dialog.getByTestId("experimental-panorama").uncheck();
  await page.keyboard.press("Escape");
  await expect(tab).toHaveCount(0);
  await expect(pano).toHaveCount(0);
  expect((await studio.api<{ experimentalFeatures: string[] }>("GET", "/api/settings")).experimentalFeatures).toEqual([]);
});
