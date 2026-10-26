import { expect, test } from "@playwright/test";
import type { CanvasCallout, CanvasDoc, CanvasItem, Session, SessionItem, Task, Topic, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

// 画布审阅 (2026-10-27, plans/review-canvas.md): an agent lays a review out on its topic's canvas and asks on a card;
// the person answers in the question window, the question folds away, the answer reaches the session; the person
// marks an item and opens a session to talk one item over. Mock models only.

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

const items = (doc: CanvasDoc) => doc.nodes.filter((n): n is CanvasItem => n.kind === "item");

test("an agent's review on the canvas: items, a question answered in its window, status, 就这条展开聊", async () => {
  studio = await launchStudio();
  const { page } = studio;
  const s = studio;
  const ws = await s.api<Workspace>("POST", "/api/workspaces", { path: s.workspace("alpha") });
  const topic = await s.api<Topic>("POST", "/api/topics", { title: "relay 审阅" });
  const post = {
    group: "本周提交",
    items: [
      { title: "协议加了 seq 字段", body: "客户端和服务端要一起升级，旧客户端会丢消息。", refs: ["packages/relay/src/protocol.ts"] },
      { title: "断线重连改成指数退避", body: "最长 30 秒。" },
      { title: "日志去掉了密码字段", status: "confirmed" },
    ],
  };
  const { session } = await s.api<{ task: Task; session: Session }>("POST", "/api/tasks", {
    title: "审阅 relay",
    workspaceId: ws.id,
    topicId: topic.id,
    lead: true,
    firstSession: { profileId: "codex-mock", text: `[[mcp: canvas_items_post ${JSON.stringify(post)}]]` },
  });
  const canvas = () => s.api<CanvasDoc>("GET", `/api/topics/${topic.id}/canvas`);
  await expect.poll(async () => items(await canvas()).length, { timeout: 60_000 }).toBe(3);
  const say = async (text: string) => {
    const before = (await s.api<SessionItem[]>("GET", `/api/sessions/${session.id}/items`)).filter((i) => i.type === "agent").length;
    await s.api("POST", `/api/sessions/${session.id}/messages`, { text });
    await expect.poll(async () => (await s.api<SessionItem[]>("GET", `/api/sessions/${session.id}/items`)).filter((i) => i.type === "agent").length, { timeout: 60_000 }).toBeGreaterThan(before);
  };
  await say(`[[mcp: canvas_callout ${JSON.stringify({ target: "#1", kind: "question", text: "要不要兼容旧客户端一个版本？", options: ["兼容一个版本", "不兼容"], detail: "旧客户端还有 **3 台**在用。" })}]]`);
  await say(`[[mcp: canvas_callout ${JSON.stringify({ target: "#2", text: "退避上限比原来长，注意测试超时" })}]]`);
  await expect.poll(async () => (await s.api<CanvasCallout[]>("GET", `/api/topics/${topic.id}/callouts`)).length, { timeout: 30_000 }).toBe(2);

  // The left column says the topic has a question waiting.
  await expect(page.getByTestId("scope-topic-relay 审阅").getByTestId("nav-asking")).toHaveText("? 1");

  // The canvas: three item cards in their group, the question highlighted, the toolbar says one is waiting.
  await page.getByRole("button", { name: "画布", exact: true }).click();
  await expect(page.getByTestId("canvas-item")).toHaveCount(3);
  const first = page.getByTestId("canvas-item").filter({ hasText: "#1" });
  await expect(first).toHaveAttribute("data-callout", "question");
  await expect(page.getByTestId("canvas-item").filter({ hasText: "#2" })).toHaveAttribute("data-callout", "note");
  await expect(page.getByTestId("canvas-item").filter({ hasText: "#3" }).getByTestId("item-status")).toContainText("已确认");
  await expect(page.getByTestId("callout-question")).toContainText("要不要兼容旧客户端一个版本？");
  await expect(page.getByTestId("callout-note")).toContainText("退避上限");
  await expect(page.getByTestId("canvas-asking")).toHaveText("? 1 个问题待你确认");
  await expect(page.getByTestId("side-tab-talk")).toHaveText("沟通 1");
  await page.getByRole("button", { name: "全部", exact: true }).click();
  await screenshot(s.app, "review-canvas", "RC-1-canvas", page);

  // The toolbar opens the question; an option fills the answer; sending folds the question away.
  await page.getByTestId("canvas-asking").click();
  const dialog = page.getByTestId("callout-dialog");
  await expect(dialog).toContainText("#1 协议加了 seq 字段");
  await expect(dialog.locator(".md")).toContainText("3 台");
  await screenshot(s.app, "review-canvas", "RC-2-question", page);
  await dialog.getByRole("button", { name: "兼容一个版本" }).click();
  await expect(dialog.getByLabel("你的回答")).toHaveValue("兼容一个版本");
  await dialog.getByTestId("callout-send").click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId("callout-question")).toHaveCount(0);
  await expect(page.getByTestId("callout-answered")).toBeVisible();
  await expect(page.getByTestId("canvas-asking")).toHaveCount(0);
  await expect(page.getByTestId("nav-asking")).toHaveCount(0);
  await expect(first).not.toHaveAttribute("data-callout", "question");
  // The answer reached the session that asked.
  await expect
    .poll(async () => (await s.api<SessionItem[]>("GET", `/api/sessions/${session.id}/items`)).some((i) => i.type === "user" && i.text.includes("【画布回答】") && i.text.includes("人的回答：兼容一个版本")), { timeout: 30_000 })
    .toBe(true);

  // 沟通: how far the review is, and what was answered.
  await page.getByTestId("side-tab-talk").click();
  await expect(page.getByTestId("talk-progress")).toContainText("审阅 3 条");
  await expect(page.getByTestId("talk-row").filter({ hasText: "答：兼容一个版本" })).toBeVisible();
  await screenshot(s.app, "review-canvas", "RC-3-answered", page);

  // The person marks #2 from its menu; the remark on it is put away from the card.
  await page.getByTestId("canvas-item").filter({ hasText: "#2" }).click({ button: "right" });
  await page.getByTestId("menu-item-discuss").click();
  await expect(page.getByTestId("canvas-item").filter({ hasText: "#2" }).getByTestId("item-status")).toContainText("要讨论");
  await expect.poll(async () => items(await canvas()).find((i) => i.num === 2)?.status).toBe("discuss");
  await page.getByRole("button", { name: "全部", exact: true }).click();
  await page.getByTestId("callout-note").getByRole("button", { name: "收起说明" }).click();
  await expect(page.getByTestId("callout-note")).toHaveCount(0);

  // 详情 of #1, then 就这条展开聊: a new session in the task, opened, listed on the item.
  await first.click();
  await expect(page.getByRole("group", { name: "审阅条目" })).toContainText("packages/relay/src/protocol.ts");
  await screenshot(s.app, "review-canvas", "RC-4-detail", page);
  await page.getByTestId("item-discuss").click();
  await expect.poll(async () => items(await canvas()).find((i) => i.num === 1)?.threads?.length ?? 0, { timeout: 30_000 }).toBe(1);
  const threadId = items(await canvas()).find((i) => i.num === 1)!.threads![0]!;
  const thread = (await s.api<{ sessions: Session[] }>("GET", "/api/state")).sessions.find((x) => x.id === threadId)!;
  expect(thread).toMatchObject({ taskId: session.taskId, title: "#1 协议加了 seq 字段" });
  await expect(page.getByTestId("msg-user").first()).toContainText("【就这条展开聊】", { timeout: 30_000 });
});
