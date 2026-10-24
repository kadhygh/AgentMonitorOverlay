import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { Session, SessionItem, StateSnapshot, Task, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

// A long session is drawn from its last turns (2026-10-24, after dsh-TUI): its earlier ones come on 「显示更早的对话」,
// on a jump to something in them, and on 后退 to a place among them. 完全展开 here, where every turn's work is drawn.

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

const TURNS = 150;

/** Until the session's turn has ended. */
const settled = (studio: Studio, id: string) =>
  expect.poll(async () => (await studio.api<StateSnapshot>("GET", "/api/state")).sessions.find((x) => x.id === id)?.status, { timeout: 30_000 }).not.toBe("running");

test("a long session opens on its last turns; earlier ones on request, on a jump, and on 后退", async () => {
  studio = await launchStudio({ transcriptView: "verbose" });
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  const { task, session } = await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", { title: "很长的会话", workspaceId: ws.id, firstSession: { profileId: "codex-mock", text: "[[think]] 第0轮" } });
  await expect.poll(async () => (await studio!.api<SessionItem[]>("GET", `/api/sessions/${session.id}/items`)).some((i) => i.type === "agent"), { timeout: 30_000 }).toBe(true);
  await settled(studio, session.id);
  const root = studio.root;
  await studio.close({ keepData: true });

  // The one turn, 150 times more (turn ids and item ids made new; the text says which turn).
  const db = new DatabaseSync(join(root, "data", "studio.db"));
  const rows = db.prepare("SELECT seq, id, type, created_at, body FROM items WHERE session_id = ? ORDER BY seq").all(session.id) as Array<{ seq: number; id: string; type: string; created_at: string; body: string }>;
  const turnId = (JSON.parse(rows.find((r) => r.type === "turn")!.body) as { turnId: string }).turnId;
  const insert = db.prepare("INSERT INTO items (session_id, seq, id, type, created_at, body) VALUES (?, ?, ?, ?, ?, ?)");
  const top = rows.at(-1)!.seq;
  db.exec("BEGIN");
  for (let k = 1; k <= TURNS; k++) {
    rows.forEach((r, n) => {
      const body = r.body.replaceAll(turnId, `${turnId}-${k}`).replaceAll(r.id, `${r.id}-${k}`).replaceAll("第0轮", `第${k}轮`);
      insert.run(session.id, top + (k - 1) * rows.length + n + 1, `${r.id}-${k}`, r.type, r.created_at, body);
    });
  }
  db.exec("COMMIT");
  db.close();
  const firstReply = rows.find((r) => r.type === "agent")!.id;

  studio = await launchStudio({ root, transcriptView: "verbose" });
  const { page, app } = studio;
  await page.getByTestId("task-card").filter({ hasText: "很长的会话" }).click();
  await expect(page.getByTestId("msg-agent").last()).toContainText(`第${TURNS}轮`, { timeout: 30_000 });
  const turns = page.getByTestId("turn");
  const drawn = await turns.count();
  expect(drawn).toBeGreaterThanOrEqual(2);
  expect(drawn).toBeLessThan(TURNS + 1);
  const earlier = page.getByTestId("turn-earlier");
  await expect(earlier).toHaveText(`显示更早的对话（还有 ${TURNS + 1 - drawn} 轮）`);

  // More on request, from the top where the button is; the place read stays where it was.
  const firstKey = await turns.first().getAttribute("data-key");
  const thread = page.getByTestId("thread");
  await thread.evaluate((el) => (el.scrollTop = 0));
  await expect(earlier).toBeInViewport();
  await screenshot(app, "stage-18", "S18-long-session-earlier", page);
  await earlier.click();
  await expect.poll(() => turns.count()).toBeGreaterThan(drawn);
  await expect(page.locator(`[data-key="${firstKey}"]`)).toBeInViewport();

  // Read up there, go to the board and back: the same turn, at the top of what is drawn anew.
  await page.locator(`[data-key="${firstKey}"]`).evaluate((el) => el.scrollIntoView({ block: "start" }));
  await page.waitForTimeout(300);
  await page.getByRole("button", { name: "返回看板" }).click();
  await expect(page.getByTestId("task-card").first()).toBeVisible();
  await page.keyboard.press("Alt+ArrowLeft");
  await expect(page.getByTestId("task-title")).toHaveText("很长的会话");
  await expect(page.locator(`[data-key="${firstKey}"]`)).toBeInViewport({ timeout: 10_000 });
  // Drawn from the turn read on, not from all that were shown before.
  expect(await turns.count()).toBeGreaterThanOrEqual(drawn - 1);
  expect(await turns.count()).toBeLessThan(TURNS + 1);
  expect(await thread.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeGreaterThan(200);

  // A jump to the very first reply (a bookmark or an annotation sends this) draws from its turn on.
  await page.evaluate((id) => window.dispatchEvent(new CustomEvent("amo:reveal-item", { detail: id })), firstReply);
  await expect(page.locator(`[data-item-id="${firstReply}"]`)).toHaveCount(1);
  await expect(earlier).toHaveCount(0);
  expect(await turns.count()).toBe(TURNS + 1);
  expect(task.id).toBeTruthy();
});

test("Focus reads only a session's latest items", async () => {
  studio = await launchStudio();
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  const { session } = await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", { title: "尾部", workspaceId: ws.id, firstSession: { profileId: "codex-mock", text: "[[think]] 一" } });
  await settled(studio, session.id);
  const all = await studio.api<SessionItem[]>("GET", `/api/sessions/${session.id}/items`);
  const tail = await studio.api<SessionItem[]>("GET", `/api/sessions/${session.id}/items?tail=2`);
  expect(tail.map((i) => i.id)).toEqual(all.slice(-2).map((i) => i.id));
});
