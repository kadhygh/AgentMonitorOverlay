import { expect, test } from "@playwright/test";
import type { Session, Task, Workspace } from "@amo-studio/protocol";
import { launchStudio, longTurn, screenshot, showMainWindow, type Studio } from "./studio.js";

// 后退 / 前进 (2026-10-19, after VS Code): reading a session, Focus takes the workbench to a finished task; Alt+← comes
// back to the session, read to where it was; Alt+→ and the top bar's arrows go the other way.

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

const filler = (n: number) => Array.from({ length: n }, (_, i) => `第${i}句话用来把对话撑长。`).join("");

test("Alt+← returns to the session that was being read, at the place it was read to", async () => {
  studio = await launchStudio();
  const { page, app } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  const a = await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", { title: "读到一半", workspaceId: ws.id, firstSession: { profileId: "codex-mock", text: filler(120) } });
  const b = await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", { title: "刚完成", workspaceId: ws.id, firstSession: { profileId: "codex-mock", text: "好了" } });
  await expect(page.getByTestId("nav-back")).toBeDisabled();

  await page.getByTestId("task-card").filter({ hasText: "读到一半" }).click();
  await expect(page.getByTestId("msg-agent").first()).toContainText("第119句", { timeout: 30_000 });
  const thread = page.getByTestId("thread");
  await thread.evaluate((el) => (el.scrollTop = 300));
  await expect.poll(() => thread.evaluate((el) => Math.round(el.scrollTop))).toBe(300);

  // Focus's 在工作台打开 (the shell sends the same navigate).
  await app.evaluate(({ BrowserWindow }, target) => BrowserWindow.getAllWindows()[0]!.webContents.send("amo:navigate", target), { taskId: b.task.id, sessionId: b.session.id });
  await expect(page.getByTestId("task-title")).toHaveText("刚完成");
  await expect(page.getByTestId("nav-back")).toBeEnabled();
  await expect(page.getByTestId("nav-forward")).toBeDisabled();

  await page.keyboard.press("Alt+ArrowLeft");
  await expect(page.getByTestId("task-title")).toHaveText("读到一半");
  await expect.poll(() => page.getByTestId("thread").evaluate((el) => Math.round(el.scrollTop))).toBe(300);
  await expect(page.getByTestId("nav-forward")).toBeEnabled();
  await screenshot(app, "stage-18", "S18-nav-back", page);

  await page.keyboard.press("Alt+ArrowRight");
  await expect(page.getByTestId("task-title")).toHaveText("刚完成");
  await page.getByTestId("nav-back").click();
  await expect(page.getByTestId("task-title")).toHaveText("读到一半");
  // Further back: the board it was opened from.
  await page.keyboard.press("Alt+ArrowLeft");
  await expect(page.getByTestId("task-card").first()).toBeVisible();
  await expect(page.getByTestId("nav-back")).toBeDisabled();
  expect(a.task.id).not.toBe(b.task.id);
});

test("Alt+← returns to the same words of a long conversation whose turns are not drawn yet (2026-10-20)", async () => {
  // Shown and folded as for a person: the page comes back anew, its turns standing in at 300px until drawn (chat.css),
  // so the old scrollTop was another part of the conversation (11,800px off).
  studio = await launchStudio({ transcriptView: "standard" });
  const { page, app } = studio;
  await showMainWindow(app);
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  const a = await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", { title: "读到一半", workspaceId: ws.id, firstSession: { profileId: "codex-mock", text: longTurn(1) } });
  const b = await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", { title: "刚完成", workspaceId: ws.id, firstSession: { profileId: "codex-mock", text: "好了" } });
  await page.getByTestId("task-card").filter({ hasText: "读到一半" }).click();
  const replies = page.getByTestId("msg-agent");
  await expect(replies).toHaveCount(1, { timeout: 30_000 });
  for (let n = 2; n <= 9; n++) {
    await studio.api("POST", `/api/sessions/${a.session.id}/messages`, { text: longTurn(n) });
    await expect(replies).toHaveCount(n, { timeout: 30_000 });
  }
  // The last turn over (its end can still scroll a conversation that follows the bottom).
  await expect
    .poll(async () => (await studio!.api<{ sessions: Session[] }>("GET", "/api/state")).sessions.find((s) => s.id === a.session.id)?.status, { timeout: 30_000 })
    .toBe("idle");
  await page.waitForTimeout(300);

  // Reading the 4th reply's 10th paragraph, 100px below the top of the view.
  const words = replies.nth(3).getByText("第 4 轮第 10 段");
  const below = () => words.evaluate((el) => Math.round(el.getBoundingClientRect().top - el.closest(".thread")!.getBoundingClientRect().top));
  await expect
    .poll(async () => {
      await words.evaluate((el) => {
        const t = el.closest<HTMLElement>(".thread")!;
        t.scrollTop += el.getBoundingClientRect().top - t.getBoundingClientRect().top - 100;
      });
      return below();
    })
    .toBe(100);
  await page.waitForTimeout(300);
  expect(await below()).toBe(100);

  await app.evaluate(({ BrowserWindow }, target) => BrowserWindow.getAllWindows()[0]!.webContents.send("amo:navigate", target), { taskId: b.task.id, sessionId: b.session.id });
  await expect(page.getByTestId("task-title")).toHaveText("刚完成");
  await page.keyboard.press("Alt+ArrowLeft");
  await expect(page.getByTestId("task-title")).toHaveText("读到一半");
  await expect.poll(below).toBe(100);
  await page.waitForTimeout(600);
  expect(await below()).toBe(100);
});
