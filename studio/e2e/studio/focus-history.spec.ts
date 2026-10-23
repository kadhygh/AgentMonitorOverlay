import { expect, test } from "@playwright/test";
import type { Session, Task, Workspace } from "@amo-studio/protocol";
import { selectAndRelease } from "../support/selection.js";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

// 2026-10-20: Focus's 进行中 (what works now, with the task's 说明) and 历史 (what needed the person lately, handled or
// not, a click away); a reply that ends on the session the workbench shows still reaches Focus when nobody is there;
// the annotation bubble moves by its head.

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

test("Focus shows what works now and what needed the person lately; a reply ending on the open session still shows", async () => {
  studio = await launchStudio();
  const { page, app } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  const opened = app.waitForEvent("window");
  await page.getByRole("button", { name: /^Focus/ }).click();
  const focus = await opened;
  await expect(focus.getByTestId("focus-needs")).toHaveText("没有待处理", { timeout: 30_000 });
  await expect(focus.getByTestId("focus-history")).toHaveCount(0);

  // 进行中: the working session, under its task's name and the first line of its 说明.
  const { task } = await studio.api<{ task: Task }>("POST", "/api/tasks", { title: "调掉落", workspaceId: ws.id });
  await studio.api("PATCH", `/api/tasks/${task.id}`, { description: "让中期掉落更平滑\n先在测试服验证" });
  const session = await studio.api<Session>("POST", `/api/tasks/${task.id}/sessions`, { profileId: "codex-mock", text: "[[slow]] 慢慢回复" });
  const working = focus.getByTestId("focus-working-entry");
  await expect(working).toHaveCount(1, { timeout: 30_000 });
  await expect(working).toContainText("调掉落");
  await expect(working).toContainText("让中期掉落更平滑");
  await expect(working).not.toContainText("先在测试服验证");
  await screenshot(app, "stage-18", "S18-focus-working", focus, "focus");

  // It ends while the board shows: 完成待审核, and a record in 历史 that waits.
  await expect(working).toHaveCount(0, { timeout: 60_000 });
  const entry = focus.getByTestId("focus-entry");
  await expect(entry).toContainText("完成待审核");
  await focus.getByTestId("focus-history-toggle").click();
  const records = focus.getByTestId("focus-history-entry");
  await expect(records).toHaveCount(1);
  await expect(records.first()).toContainText("调掉落");
  await expect(records.first()).toContainText("完成待审核 · 未处理");

  // Looked at in Focus: it leaves the list; its record stays, handled.
  await entry.getByRole("button").first().click();
  await expect(entry).toHaveCount(0, { timeout: 15_000 });
  await expect(records.first()).toContainText("完成待审核 · 已处理");
  await screenshot(app, "stage-18", "S18-focus-history", focus, "focus");

  // A record pins its task, as 进行中 does (10-22): on top in 置顶, the record's pin lit; a second click lets it go.
  const pin = records.first().getByTestId("focus-pin");
  await records.first().hover();
  await pin.click();
  await expect(focus.getByTestId("focus-pinned")).toContainText("调掉落");
  await expect(pin).toHaveAttribute("aria-pressed", "true");
  await pin.click();
  await expect(focus.getByTestId("focus-pinned")).toHaveCount(0);
  await expect(pin).toHaveAttribute("aria-pressed", "false");

  // A record goes to its session in the workbench.
  await records.first().locator(".focus-row").click();
  await expect(page.getByTestId("task-title")).toHaveText("调掉落");

  // The workbench now shows that session. Another reply ends there while the person does nothing in the window (test
  // windows never take focus): Focus still says so; before, the window merely being visible counted as seen.
  await studio.api("POST", `/api/sessions/${session.id}/messages`, { text: "再回复一次" });
  await expect(page.getByTestId("msg-agent").last()).toContainText("MOCK: 再回复一次", { timeout: 60_000 });
  await expect(entry).toHaveCount(1, { timeout: 15_000 });
  await expect(entry).toContainText("完成待审核");
  await expect(records).toHaveCount(2);
});

test("the annotation bubble moves by its head and keeps what is written", async () => {
  studio = await launchStudio();
  const { page } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  await studio.api("POST", "/api/tasks", { title: "批注", workspaceId: ws.id, firstSession: { profileId: "codex-mock", text: "[[markdown]]" } });
  await page.getByTestId("task-card").first().click();
  const reply = page.getByTestId("msg-agent").first();
  await expect(reply.locator("table.md-table")).toBeVisible({ timeout: 30_000 });
  await selectAndRelease(reply, "发现 3 张表");
  await page.getByTestId("selection-bar").getByRole("button", { name: "批注" }).click();
  const bubble = page.getByTestId("annotation-bubble");
  await bubble.getByLabel("批注内容").fill("说明是哪三张");

  // The bubble keeps where it was put as an offset from its place by the passage (it still scrolls with the text).
  const head = (await bubble.getByTestId("annotation-bubble-drag").boundingBox())!;
  await page.mouse.move(head.x + 20, head.y + head.height / 2);
  await page.mouse.down();
  await page.mouse.move(head.x + 80, head.y + head.height / 2 + 90, { steps: 8 });
  await page.mouse.up();
  await expect(bubble).toHaveAttribute("style", /translate\(60px, 90px\)/);
  // Still open, still holding the note; it saves as before.
  await expect(bubble.getByLabel("批注内容")).toHaveValue("说明是哪三张");
  await bubble.getByRole("button", { name: "保存" }).click();
  await expect(bubble).toHaveCount(0);
  await expect(page.getByTestId("annotation-count")).toHaveText("1");
});
