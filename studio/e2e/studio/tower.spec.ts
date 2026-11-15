import { expect, test } from "@playwright/test";
import type { Session, Task, TowerData, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

// 脉络的楼 (2026-11-15; 设置 → 测试功能 → 脉络): a session marked 脉络会话 opens as its building (tower.html in an iframe
// over the conversation, the composer still under it) — a floor per round, the session it started as a region, its
// report as a card; its AI titles a round with track_note; 「在对话里看这一轮」 goes back to the conversation.

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

test("a 脉络会话 opens as its building, takes its AI's titles and points, and leads back into the conversation", async () => {
  studio = await launchStudio();
  const { page } = studio;
  await studio.api("PUT", "/api/settings", { experimentalFeatures: ["tracks"] });
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  const start = `[[mcp: session_start ${JSON.stringify({ text: "数一下掉落表有几张", title: "数表", model: "codex-mock", report: true })}]]`;
  const { task, session } = await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", { title: "掉落表", workspaceId: ws.id, firstSession: { profileId: "claude-mock", text: start } });
  const tower = () => studio!.api<TowerData>("GET", `/api/sessions/${session.id}/tracks`);
  // The sub-session's report comes back: a round of its own (the report began it).
  await expect.poll(async () => (await tower()).reports.length, { timeout: 60_000 }).toBe(1);
  await expect.poll(async () => (await studio!.api<{ sessions: Session[] }>("GET", "/api/state")).sessions.filter((s) => s.taskId === task.id).every((s) => s.status === "idle"), { timeout: 60_000 }).toBe(true);

  await page.getByTestId("task-card").first().click();
  const thread = page.getByTestId("thread");
  await expect(thread.getByTestId("msg-origin").filter({ hasText: "子会话「数表」回报" })).toBeVisible({ timeout: 30_000 });
  // Not a 脉络会话 yet: the conversation as ever, with the switch above it.
  await expect(page.getByTestId("tower-switch")).toBeVisible();
  await expect(page.getByTestId("thread-cover")).toHaveCount(0);
  await page.getByTestId("tower-on").click();
  await expect(page.getByTestId("thread-cover")).toBeVisible();
  await expect(page.getByLabel("输入消息")).toBeVisible();
  const frame = page.frameLocator('[data-testid="tower-frame"]');
  const built = await tower();
  expect(built.on).toBe(true);
  expect(built.sessions).toMatchObject([{ key: "A", title: "数表", at: 1 }]);
  // A button per floor and the roof; the session it started is a pin on the front and a card in the side column.
  await expect(frame.locator("#rail button")).toHaveCount(built.rounds.length + 1);
  await expect(frame.locator("#sideBody")).toContainText("开过 1 个子会话");
  await expect(frame.locator(".pin.sess").first()).toBeVisible();
  await page.waitForTimeout(1200);
  await screenshot(studio.app, "studio", "tower-session", page);

  // The person goes on in the composer under the building; the AI is told about 脉络 with that message and titles the
  // round and notes a point (the mock model calls the tool it is told to).
  const note = `[[mcp: track_note ${JSON.stringify({ title: "核对掉落表数量", desc: "一共 3 张，和策划表对上了", points: ["数值一律按策划表来"] })}]]`;
  await page.getByLabel("输入消息").fill(note);
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect.poll(async () => (await tower()).rounds.at(-1)?.title, { timeout: 60_000 }).toBe("核对掉落表数量");
  const after = await tower();
  expect(after.rounds.at(-1)).toMatchObject({ labelled: true, desc: "一共 3 张，和策划表对上了" });
  expect(after.points).toMatchObject([{ text: "数值一律按策划表来", round: after.rounds.length }]);
  const sent = (await studio.api<Array<{ type: string; text?: string }>>("GET", `/api/sessions/${session.id}/items`)).filter((i) => i.type === "user").at(-1)!;
  expect(sent.text).toContain("这个会话开了「脉络」");
  // The building is drawn anew with the new floor and the point.
  await expect(frame.locator("#rail button")).toHaveCount(after.rounds.length + 1, { timeout: 30_000 });
  await expect(frame.locator("#sideBody")).toContainText("数值一律按策划表来");

  // A floor's button: the side column shows that round; from there back into the conversation, at its row.
  await frame.locator(`#rail button[data-f="${after.rounds.length}"]`).click();
  await expect(frame.locator("#sideBody h3")).toHaveText("核对掉落表数量");
  await page.waitForTimeout(1200);
  await screenshot(studio.app, "studio", "tower-floor", page);
  await frame.locator("#openSrc").click();
  await expect(page.getByTestId("thread-cover")).toHaveCount(0);
  await expect(thread.getByTestId("msg-user").last()).toBeInViewport();
  // Back to the building with the switch; unticking 脉络会话 returns the session to a plain conversation.
  await page.getByTestId("tower-view-tower").click();
  await expect(page.getByTestId("thread-cover")).toBeVisible();
  await page.getByTestId("tower-on").click();
  await expect(page.getByTestId("thread-cover")).toHaveCount(0);
  expect((await tower()).on).toBe(false);
});
