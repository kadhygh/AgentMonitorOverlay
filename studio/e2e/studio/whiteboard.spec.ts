/// <reference lib="dom" />
import { expect, test } from "@playwright/test";
import type { Session, Task, WhiteboardData, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

// 白板 (2026-11-16; 设置 → 测试功能 → 白板; plans/whiteboard.md, the user: 给 ai 来做数据临时存储。ai 通过快速调整 html 的方式，
// 直接展示这个 board 里的相关内容…人只是看这个白板加批注，这个批注可以加在白板上的任意位置，或者选中任意白板上的节点): a
// session's whiteboard in the conversation's place, the composer still under it. Its AI writes the nodes
// (whiteboard_update — the mock model calls the tool it is told to) and may give the page that draws them
// (whiteboard_view); the person pins notes on a node or at a place, which go to the AI with their next message and
// which it answers.

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

test("a session's 白板: its AI writes it, the person pins notes on a node and at a place, they go with the next message and are answered", async () => {
  studio = await launchStudio();
  const { page } = studio;
  await studio.api("PUT", "/api/settings", { experimentalFeatures: ["whiteboard"] });
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  const { task, session } = await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", { title: "熔岩巨像二阶段", workspaceId: ws.id, firstSession: { profileId: "claude-mock", text: "先聊聊二阶段怎么做" } });
  const board = () => studio!.api<WhiteboardData>("GET", `/api/sessions/${session.id}/whiteboard`);
  const idle = async () => (await studio!.api<{ sessions: Session[] }>("GET", "/api/state")).sessions.filter((s) => s.taskId === task.id).every((s) => s.status === "idle");
  const say = async (text: string) => {
    await page.getByLabel("输入消息").fill(text);
    await page.getByRole("button", { name: "发送", exact: true }).click();
  };
  await expect.poll(idle, { timeout: 60_000 }).toBe(true);

  await page.getByTestId("task-card").first().click();
  await expect(page.getByTestId("msg-agent")).toHaveCount(1, { timeout: 30_000 });
  // 脉络 is off: the row has 对话 | 白板 only.
  await expect(page.getByTestId("tower-switch")).toBeVisible();
  await expect(page.getByTestId("tower-view-tower")).toHaveCount(0);
  await expect(page.getByTestId("tower-on")).toHaveCount(0);
  await page.getByTestId("view-whiteboard").click();
  const view = page.getByTestId("wb-view");
  await expect(view).toContainText("这个会话还没开白板");
  await expect(page.getByLabel("输入消息")).toBeVisible();
  await page.getByTestId("wb-on").click();
  await expect(view).toContainText("白板开着");
  expect((await board()).on).toBe(true);

  // The person goes on under the whiteboard: its AI is told what it is with that message, and writes three nodes.
  const nodes = [
    { id: "goal", kind: "goal", title: "二阶段：血量 50% 时换形态", group: "任务内容", status: "done" },
    { id: "a", kind: "suggestion", title: "方案 A：加一层阶段状态机", body: "改动集中在 BossController\n- 要动存档", group: "推进计划", after: ["goal"], status: "waiting" },
    { id: "b", kind: "suggestion", title: "方案 B：叠 Buff", body: "不动状态机，换形态做成一个 Buff", group: "推进计划", after: ["goal"] },
  ];
  await say(`[[mcp: whiteboard_update ${JSON.stringify({ set: nodes })}]]`);
  await expect.poll(async () => (await board()).nodes.length, { timeout: 60_000 }).toBe(3);
  const told = (await studio.api<Array<{ type: string; text?: string }>>("GET", `/api/sessions/${session.id}/items`)).filter((i) => i.type === "user").at(-1)!;
  expect(told.text).toContain("这个会话开了「白板」");
  await expect.poll(idle, { timeout: 60_000 }).toBe(true);

  // Drawn by Studio's own page in the frame: a column per group, a card per node, what the person has not seen marked.
  const frame = page.frameLocator('[data-testid="wb-frame"]');
  await expect(frame.locator("[data-node]")).toHaveCount(3, { timeout: 30_000 });
  await expect(frame.locator('[data-node="a"]')).toContainText("方案 A：加一层阶段状态机");
  await expect(frame.locator('[data-node="a"]')).toContainText("等你");
  await expect(frame.locator(".b-col h2").first()).toContainText("任务内容");
  await expect(frame.locator(".b-new")).toHaveCount(3);
  await expect(page.getByTestId("wb-unseen")).toContainText("有 3 个节点");
  await expect(view).toContainText("点一个节点，或在任意位置点右键，写批注");
  await page.waitForTimeout(400);
  await screenshot(studio.app, "studio", "whiteboard", page);

  // A note on a node: the node is clicked, the note written beside the board.
  await frame.locator('[data-node="a"] .b-title').click();
  const editor = page.getByTestId("wb-note-editor");
  await expect(editor).toContainText("在「方案 A：加一层阶段状态机」上");
  await page.getByTestId("wb-note-input").fill("存档不能动，换个做法");
  await page.getByTestId("wb-note-save").click();
  await expect(page.getByTestId("wb-note")).toHaveCount(1);
  await expect(frame.locator(".amo-pin.draft")).toHaveCount(1);
  // A note at a place of the page: right click on the empty board…
  const box = (await page.getByTestId("wb-frame").boundingBox())!;
  await page.mouse.click(box.x + box.width - 60, box.y + box.height - 60, { button: "right" });
  await expect(editor).toContainText("在白板的一个位置上");
  await page.getByTestId("wb-note-input").fill("这里加一栏「风险」");
  await page.getByTestId("wb-note-input").press("Control+Enter");
  await expect(page.getByTestId("wb-note")).toHaveCount(2);
  // …and on some words of a node: the note is beside the node and says which words.
  await frame.locator('[data-node="b"] .b-body p').click({ button: "right" });
  await expect(editor).toContainText("在「方案 B：叠 Buff」旁边：「不动状态机，换形态做成一个 Buff」");
  await page.getByTestId("wb-note-input").fill("会不会和冰冻冲突");
  await page.getByTestId("wb-note-save").click();
  await expect(page.getByTestId("wb-note")).toHaveCount(3);
  await expect(frame.locator(".amo-pin.draft")).toHaveCount(3);
  const drafts = (await board()).notes;
  expect(drafts.map((n) => [n.id, n.nodeId, n.x === undefined, n.quote, n.state])).toEqual([
    ["c1", "a", true, undefined, "draft"],
    ["c2", undefined, false, undefined, "draft"],
    ["c3", "b", false, "不动状态机，换形态做成一个 Buff", "draft"],
  ]);

  // They gather until the person sends: one message carries all three to the AI.
  await page.getByTestId("wb-send").click();
  await expect.poll(async () => (await board()).notes.map((n) => n.state), { timeout: 60_000 }).toEqual(["sent", "sent", "sent"]);
  const carried = (await studio.api<Array<{ type: string; text?: string }>>("GET", `/api/sessions/${session.id}/items`)).filter((i) => i.type === "user").at(-1)!;
  expect(carried.text).toContain("看一下白板上的 3 条批注。");
  expect(carried.text).toContain("· c1，在节点 a「方案 A：加一层阶段状态机」上：存档不能动，换个做法");
  expect(carried.text).toContain("· c3，在节点 b「方案 B：叠 Buff」旁边（那里的字：「不动状态机，换形态做成一个 Buff」）：会不会和冰冻冲突");
  await expect(page.getByTestId("wb-send")).toHaveCount(0);
  await expect.poll(idle, { timeout: 60_000 }).toBe(true);

  // 都看过了, then the AI answers a note and changes the node it is about: only that node is marked as changed.
  await page.getByTestId("wb-seen").click();
  await expect(page.getByTestId("wb-unseen")).toHaveCount(0);
  await expect(frame.locator(".b-new")).toHaveCount(0);
  await say(`[[mcp: whiteboard_update ${JSON.stringify({ replies: [{ note: "c1", text: "改成只在内存里记阶段，存档不动" }], set: [{ id: "a", body: "阶段状态只在内存里，不进存档", status: "doing" }] })}]]`);
  await expect(page.getByTestId("wb-note-reply")).toContainText("改成只在内存里记阶段，存档不动", { timeout: 60_000 });
  await expect(frame.locator('[data-node="a"]')).toContainText("阶段状态只在内存里，不进存档");
  await expect(frame.locator(".b-new")).toHaveCount(1);
  await expect(page.getByTestId("wb-unseen")).toContainText("有 1 个节点");
  await expect(frame.locator(".amo-pin.answered")).toHaveCount(1);
  await expect.poll(idle, { timeout: 60_000 }).toBe(true);
  await page.waitForTimeout(400);
  await screenshot(studio.app, "studio", "whiteboard-notes", page);
  // The person is done with that note: it is put away, and its pin goes.
  await page.locator('[data-testid="wb-note"][data-state="answered"]').getByTestId("wb-note-close").click();
  await expect(page.locator('[data-testid="wb-note"][data-state="closed"]')).toHaveCount(1);
  await expect(frame.locator(".amo-pin")).toHaveCount(2);

  // The AI gives its own page (whiteboard_view): the frame draws the same data with it, the notes' pins still on the nodes.
  const html = "<h1 id=cap></h1><div id=p></div><script>window.renderBoard = function (b) { document.getElementById('cap').textContent = '共 ' + b.nodes.length + ' 个节点'; document.getElementById('p').innerHTML = b.nodes.map(function (n) { return '<p data-node=' + n.id + '>' + b.kinds[n.kind] + ' · ' + n.title + '</p>'; }).join(''); };</script>";
  await say(`[[mcp: whiteboard_view ${JSON.stringify({ html })}]]`);
  await expect(view).toContainText("画法：AI 自己画的页面", { timeout: 60_000 });
  await expect(frame.locator("#cap")).toHaveText("共 3 个节点");
  await expect(frame.locator('p[data-node="b"]')).toHaveText("建议 · 方案 B：叠 Buff");
  await expect(frame.locator(".amo-pin")).toHaveCount(2);
  expect((await board()).view.own).toBe(true);
  await expect.poll(idle, { timeout: 60_000 }).toBe(true);
  await page.waitForTimeout(400);
  await screenshot(studio.app, "studio", "whiteboard-own-page", page);

  // The theme changes: the page's colours follow (the frame is told, it cannot read the workbench's styles).
  const frameBg = () => frame.locator("html").evaluate((el) => getComputedStyle(el).backgroundColor);
  const light = await frameBg();
  await page.evaluate(() => (document.documentElement.dataset.theme = "dark"));
  await expect.poll(frameBg).not.toBe(light);
  await frame.locator('p[data-node="a"]').click();
  await page.waitForTimeout(300);
  await screenshot(studio.app, "studio", "whiteboard-dark", page);
  await page.getByTestId("wb-note-input").press("Escape");
  await page.evaluate(() => (document.documentElement.dataset.theme = "light"));

  // Back in the conversation the board counts as looked at; when the AI writes it again, 「白板」 carries a dot.
  await page.getByTestId("tower-view-chat").click();
  await expect(view).toHaveCount(0);
  await expect.poll(async () => { const b = await board(); return b.rev - b.seenRev; }).toBe(0);
  await expect(page.getByTestId("wb-dot")).toHaveCount(0);
  await say(`[[mcp: whiteboard_update ${JSON.stringify({ set: [{ kind: "decision", title: "定了：走方案 A，存档不动", group: "定下来的事" }] })}]]`);
  await expect(page.getByTestId("wb-dot")).toBeVisible({ timeout: 60_000 });
  await page.getByTestId("view-whiteboard").click();
  await expect(frame.locator("#cap")).toHaveText("共 4 个节点", { timeout: 30_000 });
});

test("with 脉络 on too, the row above the conversation goes between 对话, 白板 and 脉络", async () => {
  studio = await launchStudio();
  const { page } = studio;
  await studio.api("PUT", "/api/settings", { experimentalFeatures: ["tracks", "whiteboard"] });
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  const { task } = await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", { title: "三种看法", workspaceId: ws.id, firstSession: { profileId: "claude-mock", text: "开始" } });
  await expect.poll(async () => (await studio!.api<{ sessions: Session[] }>("GET", "/api/state")).sessions.filter((s) => s.taskId === task.id).every((s) => s.status === "idle"), { timeout: 60_000 }).toBe(true);
  await page.getByTestId("task-card").first().click();
  await expect(page.getByTestId("msg-agent")).toHaveCount(1, { timeout: 30_000 });
  const tabs = page.getByTestId("tower-switch").getByRole("tab");
  await expect(tabs).toHaveText(["对话", "白板", "脉络"]);
  await expect(page.getByTestId("tower-on")).toBeVisible();
  // The building, then the whiteboard in its place (the 脉络会话 tick is the building's: not shown beside the whiteboard).
  await page.getByTestId("tower-view-tower").click();
  await expect(page.getByTestId("tower-view")).toBeVisible();
  await page.getByTestId("view-whiteboard").click();
  await expect(page.getByTestId("wb-view")).toBeVisible();
  await expect(page.getByTestId("tower-view")).toHaveCount(0);
  await expect(page.getByTestId("tower-on")).toHaveCount(0);
  await expect(page.getByTestId("view-whiteboard")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByLabel("输入消息")).toBeVisible();
  // Back to the building, and to the conversation.
  await page.getByTestId("tower-view-tower").click();
  await expect(page.getByTestId("tower-view")).toBeVisible();
  await expect(page.getByTestId("wb-view")).toHaveCount(0);
  await page.getByTestId("view-whiteboard").click();
  await page.getByTestId("tower-view-chat").click();
  await expect(page.getByTestId("thread-cover")).toHaveCount(0);
  await expect(page.getByTestId("tower-view-chat")).toHaveAttribute("aria-selected", "true");
});
