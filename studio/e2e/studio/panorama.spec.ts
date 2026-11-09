import { expect, test, type Page } from "@playwright/test";
import type { CanvasDoc, Session, StateSnapshot, Task, Topic, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

// 全景 (设置 → 测试功能, 2026-11-01): off by default; turned on, it shows every live topic's tasks as lanes on a deck.gl
// map, sessions as nodes, the ones waiting on the person with signs. Every click on the map is a real mouse click
// (page.mouse): the prototype once passed with clicks made by calling page functions while a person could not click at
// all, so the page only tells where things are (window.__panorama) and the mouse does the rest.
//
// P1 (2026-11-02): each task a tree — a dependency drawn on the canvas is an arc, a task's sessions are its rounds.
// 11-04 (plans/userlayer/framework.md 第 0 步): the world looks (地形岛 by default, 地铁 by a switch in the corner,
// remembered on this machine), every live topic a region and the tasks in no topic one more; opened from the left
// column under 全部任务 (the column stays), no longer a tab.

let studio: Studio | undefined;

/** What the page tells about the map (engine.ts EngineProbe): where things are, whether the camera still moves. */
type Probe = { screenOf(id: string): [number, number] | null; blockHead(title: string): [number, number] | null; busy: boolean; selected: string | null; signs: number; zoom: number };
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

/** Every region is on the map: its name has a place. */
async function regions(page: Page, titles: string[]): Promise<void> {
  for (const title of titles) expect(await page.evaluate((t) => (window as unknown as WithProbe).__panorama!.blockHead(t), title), `region ${title}`).not.toBeNull();
}

test("全景: off by default, turned on in 测试功能, opened from the left column over every topic, waiting sessions and nodes clicked with the mouse", async () => {
  studio = await launchStudio();
  const { page, app } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  const ws2 = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("beta") });
  const topic = await studio.api<Topic>("POST", "/api/topics", { title: "全景测试", workspaceIds: [ws.id] });
  const topic2 = await studio.api<Topic>("POST", "/api/topics", { title: "第二个专题", workspaceIds: [ws2.id], description: "另一块地" });
  // Two tasks with a session waiting for approval (the mock Codex asks before a shell command), one that just talked.
  const a = await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", { title: "掉落表校验", workspaceId: ws.id, topicId: topic.id, firstSession: { profileId: "codex-mock", text: "[[shell: cmd /c echo pn-a]]" } });
  const b = await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", { title: "整理关卡数据", workspaceId: ws.id, topicId: topic.id, firstSession: { profileId: "codex-mock", text: "你好" } });
  const c = await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", { title: "第三个任务", workspaceId: ws.id, topicId: topic.id, firstSession: { profileId: "codex-mock", text: "[[shell: cmd /c echo pn-c]]" } });
  // A second session on one task: its lane has two nodes, in the order they started.
  const b2 = await studio.api<Session>("POST", `/api/tasks/${b.task.id}/sessions`, { profileId: "codex-mock", text: "再整理一遍" });
  // Another topic with a task, and a task in no topic (its own region, 「没归专题的任务」).
  await studio.api("POST", "/api/tasks", { title: "另一块地的任务", workspaceId: ws2.id, topicId: topic2.id, firstSession: { profileId: "codex-mock", text: "你好" } });
  await studio.api("POST", "/api/tasks", { title: "没归专题的一件事", workspaceId: ws2.id, topicId: null, firstSession: { profileId: "codex-mock", text: "你好" } });
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

  // Off by default: no entry in the left column, and no tab either.
  const entry = page.getByTestId("nav-panorama");
  await expect(page.getByTestId("scope-all")).toBeVisible();
  await expect(entry).toHaveCount(0);
  await expect(page.locator(".view-tab", { hasText: "全景" })).toHaveCount(0);
  expect((await studio.api<{ experimentalFeatures: string[] }>("GET", "/api/settings")).experimentalFeatures).toEqual([]);

  // 设置 → 测试功能 → 全景.
  await page.getByRole("button", { name: "设置" }).click();
  const dialog = page.getByRole("dialog", { name: "设置" });
  await dialog.getByRole("tab", { name: "测试功能" }).click();
  const toggle = dialog.getByTestId("experimental-panorama");
  await expect(toggle).not.toBeChecked();
  // Both still being built (2026-11-09): 「开发中」 beside the name; 脉络 off and left alone here.
  await expect(dialog.getByTestId("experimental-panorama-stage")).toHaveText("开发中");
  await expect(dialog.getByTestId("experimental-tracks-stage")).toHaveText("开发中");
  await expect(dialog.getByTestId("experimental-tracks")).not.toBeChecked();
  await toggle.check();
  await expect(toggle).toBeChecked();
  await expect.poll(async () => (await studio!.api<{ experimentalFeatures: string[] }>("GET", "/api/settings")).experimentalFeatures).toEqual(["panorama"]);
  await screenshot(app, "studio", "panorama-settings", page);
  await page.keyboard.press("Escape");

  // 「全景」 right under 全部任务; the tab row stays as it was.
  await expect(entry).toBeVisible();
  await expect(entry).toHaveText("全景");
  await expect(page.locator(".view-tab", { hasText: "全景" })).toHaveCount(0);
  const allBox = (await page.getByTestId("scope-all").boundingBox())!;
  const entryBox = (await entry.boundingBox())!;
  expect(entryBox.y).toBeGreaterThan(allBox.y);
  expect(entryBox.y - allBox.y).toBeLessThan(allBox.height * 2);
  await screenshot(app, "studio", "panorama-entry", page);
  await entry.click();

  // The map draws (WebGL in the test window) in the main area, the left column still there: three regions, 2 waiting.
  const pano = page.getByTestId("panorama");
  await expect(pano).toHaveAttribute("data-mode", "map", { timeout: 20_000 });
  await expect(pano).toHaveAttribute("data-theme", "terrain");
  await expect(page.locator(".scope-nav")).toBeVisible();
  await expect(entry).toHaveAttribute("aria-current", "true");
  await expect(page.getByTestId("scope-all")).toHaveAttribute("aria-current", "false");
  await expect(pano.locator(".pn-k")).toHaveText("全景 · 3 个专题");
  await expect(pano.locator(".pn-ttl")).toHaveText("全部专题");
  await expect(pano.locator(".pn-ttl")).toHaveAttribute("title", "全景测试\n第二个专题\n没归专题的任务");
  await expect(pano.locator(".pn-row")).toContainText("5 个任务 · 6 个会话");
  await expect(page.getByTestId("panorama-need")).toContainText("2 件等你");
  await settle(page);
  const probe = () => page.evaluate(() => { const p = (window as unknown as WithProbe).__panorama!; return { signs: p.signs, zoom: p.zoom }; });
  await regions(page, ["全景测试", "第二个专题", "没归专题的任务"]);
  expect((await probe()).signs).toBeGreaterThanOrEqual(2);
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

  // The wheel (11-04): from the whole map a quick spin goes in (each notch adds to where the zoom is going), about the
  // pointer — the node under it stays under it.
  await page.getByRole("button", { name: "重置视角" }).click();
  await settle(page);
  const z0 = (await probe()).zoom;
  const under = await nodeOnPage(page, b.session.id);
  await page.mouse.move(under.x, under.y);
  for (let i = 0; i < 6; i++) await page.mouse.wheel(0, -100);
  await page.waitForTimeout(200);
  await settle(page);
  expect((await probe()).zoom).toBeGreaterThan(z0 + 1);
  const stayed = await nodeOnPage(page, b.session.id);
  expect(Math.hypot(stayed.x - under.x, stayed.y - under.y)).toBeLessThan(12);

  // Up close, an ordinary node takes a click: its first round.
  await page.mouse.move(stayed.x - 40, stayed.y - 40);
  await page.mouse.click(stayed.x, stayed.y);
  await expect(win).toBeVisible();
  await expect(win).toContainText("整理关卡数据");
  await expect(win).toContainText("第 1 轮");
  await expect(win).not.toHaveClass(/need/);
  // Its second round started later, so it sits elsewhere along the trunk.
  expect(await page.evaluate(([x, y]: string[]) => { const p = (window as unknown as WithProbe).__panorama!; const [u, v] = [p.screenOf(x!)!, p.screenOf(y!)!]; return Math.hypot(u[0] - v[0], u[1] - v[1]); }, [b.session.id, b2.id])).toBeGreaterThan(4);
  await settle(page);
  await screenshot(app, "studio", "panorama-node", page);

  // 「打开任务」 opens the task on that session, the left column still showing 全景 as where it came from; "←" comes back.
  await win.getByTestId("panorama-open-task").click();
  await expect(page.getByTestId("task-title")).toHaveText("整理关卡数据");
  await expect(entry).toHaveAttribute("aria-current", "true");
  await expect(page.getByTestId("back")).toHaveAccessibleName("返回全景");
  await page.getByTestId("back").click();
  await expect(pano).toHaveAttribute("data-mode", "map", { timeout: 20_000 });

  // 地铁 from the switch in the corner: the map is drawn again that way, and it is remembered.
  const looks = pano.getByRole("group", { name: "样式" });
  await expect(looks.getByRole("button", { name: "地形岛" })).toHaveAttribute("aria-pressed", "true");
  await looks.getByRole("button", { name: "地铁" }).click();
  await expect(pano).toHaveAttribute("data-theme", "metro");
  await expect(looks.getByRole("button", { name: "地铁" })).toHaveAttribute("aria-pressed", "true");
  await expect(pano).toHaveAttribute("data-mode", "map", { timeout: 20_000 });
  await settle(page);
  expect(await page.evaluate(() => localStorage.getItem("amo.panorama.look"))).toBe("metro");
  await regions(page, ["全景测试", "第二个专题", "没归专题的任务"]);
  await screenshot(app, "studio", "panorama-metro", page);
  await page.getByTestId("scope-all").click();
  await entry.click();
  await expect(pano).toHaveAttribute("data-theme", "metro");

  // Without WebGL the page is a list, not a blank area.
  await page.evaluate(() => localStorage.setItem("amo.panorama.noWebgl", "1"));
  await page.getByTestId("scope-all").click();
  await entry.click();
  await expect(page.getByTestId("panorama-list")).toBeVisible();
  await expect(page.getByTestId("panorama-list")).toContainText("2 件等你");
  await screenshot(app, "studio", "panorama-list", page);
  await page.evaluate(() => localStorage.removeItem("amo.panorama.noWebgl"));

  // Off again: the entry goes, and the page in front falls back to the board.
  await page.getByRole("button", { name: "设置" }).click();
  await dialog.getByRole("tab", { name: "测试功能" }).click();
  await dialog.getByTestId("experimental-panorama").uncheck();
  await page.keyboard.press("Escape");
  await expect(entry).toHaveCount(0);
  await expect(pano).toHaveCount(0);
  expect((await studio.api<{ experimentalFeatures: string[] }>("GET", "/api/settings")).experimentalFeatures).toEqual([]);
});
