import { expect, test } from "@playwright/test";
import type { CanvasCallout, Session, SessionItem, Task, Topic, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, windowState, type Studio } from "../support/studio.js";

// 画布审阅 stage 3 (2026-10-27): Focus lists a canvas's waiting questions and opens the workbench on that canvas with
// the question open; the 画布小窗 keeps a topic's canvas on top, where a question is answered too. Mock models only.

let studio: Studio | undefined;
test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

test("Focus lists a canvas question and opens it in the workbench; the 画布小窗 shows the canvas and answers there", async () => {
  studio = await launchStudio();
  const { page, app } = studio;
  const s = studio;
  const ws = await s.api<Workspace>("POST", "/api/workspaces", { path: s.workspace("alpha") });
  const topic = await s.api<Topic>("POST", "/api/topics", { title: "relay 审阅" });
  const { session } = await s.api<{ task: Task; session: Session }>("POST", "/api/tasks", {
    title: "审阅 relay",
    workspaceId: ws.id,
    topicId: topic.id,
    firstSession: { profileId: "codex-mock", text: `[[mcp: canvas_items_post ${JSON.stringify({ group: "本周", items: [{ title: "协议加了 seq" }, { title: "重连退避" }] })}]]` },
  });
  const agentReplies = async () => (await s.api<SessionItem[]>("GET", `/api/sessions/${session.id}/items`)).filter((i) => i.type === "agent").length;
  await expect.poll(agentReplies, { timeout: 60_000 }).toBe(1);
  await s.api("POST", `/api/sessions/${session.id}/messages`, { text: `[[mcp: canvas_callout ${JSON.stringify({ target: "#2", kind: "question", text: "退避上限定多少？", options: ["30 秒", "60 秒"] })}]]` });
  await expect.poll(async () => (await s.api<CanvasCallout[]>("GET", `/api/topics/${topic.id}/callouts`)).length, { timeout: 60_000 }).toBe(1);
  await expect.poll(agentReplies, { timeout: 60_000 }).toBe(2);

  // Focus: the question, under its topic.
  const opened = app.waitForEvent("window");
  await page.getByRole("button", { name: /^Focus/ }).click();
  const focus = await opened;
  const ask = focus.getByTestId("focus-canvas-ask");
  await expect(ask).toContainText("画布问题 · relay 审阅", { timeout: 30_000 });
  await expect(ask).toContainText("退避上限定多少？");
  await screenshot(app, "review-canvas", "RC-5-focus", focus, "focus");

  // Its click: the workbench on that topic's canvas, the question open.
  await ask.getByRole("button").click();
  const dialog = page.getByTestId("callout-dialog");
  await expect(dialog).toContainText("#2 重连退避");
  await expect(page.getByTestId("canvas-viewport")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  // 小窗: a small window on top with the canvas alone (no sidebar), fitted; the question answered there.
  const mini = app.waitForEvent("window");
  await page.getByTestId("canvas-open-mini").click();
  const win = await mini;
  await expect(win.getByTestId("canvas-mini")).toBeVisible();
  await expect.poll(() => windowState(app, "canvas-mini")).toMatchObject({ alwaysOnTop: true, onScreen: false, anyFocused: false });
  await expect(win.getByTestId("canvas-item")).toHaveCount(2);
  await expect(win.locator(".canvas-side")).toHaveCount(0);
  await expect(win.getByTestId("canvas-mini-topic")).toHaveValue(topic.id);
  await expect(win.getByTestId("canvas-asking")).toHaveText("? 1 个问题待你确认");
  await screenshot(app, "review-canvas", "RC-6-mini", win, "canvas-mini");
  await win.getByTestId("canvas-asking").click();
  const miniDialog = win.getByTestId("callout-dialog");
  await miniDialog.getByRole("button", { name: "60 秒" }).click();
  await miniDialog.getByTestId("callout-send").click();
  await expect(win.getByTestId("callout-answered")).toBeVisible();
  // Answered: Focus has nothing left to ask about it.
  await expect(focus.getByTestId("focus-canvas-ask")).toHaveCount(0, { timeout: 30_000 });
  await expect
    .poll(async () => (await s.api<SessionItem[]>("GET", `/api/sessions/${session.id}/items`)).some((i) => i.type === "user" && i.text.includes("人的回答：60 秒")), { timeout: 30_000 })
    .toBe(true);

  // 置顶 can be turned off from the window.
  await win.getByTestId("canvas-mini-top").click();
  await expect.poll(() => windowState(app, "canvas-mini")).toMatchObject({ alwaysOnTop: false });
});
