import { expect, test } from "@playwright/test";
import type { Session, Task, Topic, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

// The left column: pinned topics and projects come first and stay when a section is folded; long lists scroll between
// the fixed top and the footer; the footer opens the subscription usage.

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

test("pin, fold and scroll the left column; open the usage footer", async () => {
  studio = await launchStudio();
  const { page } = studio;
  for (const name of ["alpha", "beta"]) await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace(name) });
  for (let i = 1; i <= 24; i++) await studio.api<Topic>("POST", "/api/topics", { title: `专题 ${String(i).padStart(2, "0")}` });
  await expect(page.locator('[data-testid^="scope-topic-"]')).toHaveCount(24);

  // Long lists scroll inside the middle area; the footer stays put.
  const scroller = page.locator(".nav-scroll");
  expect(await scroller.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  await expect(page.getByTestId("host-status")).toBeInViewport();

  // Pin the last topic: it moves to the top.
  const last = page.locator(".nav-item").filter({ has: page.getByTestId("scope-topic-专题 24") });
  await last.hover();
  await last.getByTestId("pin").click();
  await expect(page.locator('[data-testid^="scope-topic-"]').first()).toHaveText(/专题 24/);

  // Fold topics: only the pinned one stays, with a way back to the rest.
  await page.getByTestId("fold-topic").click();
  await expect(page.locator('[data-testid^="scope-topic-"]')).toHaveCount(1);
  await expect(page.getByRole("button", { name: "还有 23 个专题" })).toBeVisible();
  await screenshot(studio.app, "stage-10", "S10-nav-pins", page);

  // The pin carries over to the new-task page's topic row (2026-10-29: no more #): pinned first, the rest behind 更多…,
  // where it heads 置顶.
  await page.getByRole("button", { name: "+ 新任务" }).click();
  const topicRow = page.getByRole("group", { name: "专题" });
  await expect(topicRow.getByRole("button").nth(1)).toHaveText("专题 24");
  await topicRow.getByTestId("more-专题").click();
  const picker = page.getByTestId("choice-picker");
  await expect(picker.locator(".choice-picker-h").first()).toHaveText("置顶");
  await expect(picker.getByRole("option").first()).toContainText("专题 24");
  await picker.getByLabel("搜索专题").press("Escape");
  await page.getByRole("button", { name: "返回看板" }).click();

  // Usage: the test Claude subscription runs on a token, which cannot read the account's quota; the panel says so
  // instead of showing numbers it does not have.
  await page.getByTestId("host-status").click();
  await expect(page.getByTestId("usage-account")).toContainText("查不到用量百分比");
});

test("the left column and the task's session list are as wide as dragged, and stay so; double-click resets", async () => {
  studio = await launchStudio({ taskSidebar: false });
  const { page } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  await studio.api("POST", "/api/tasks", { title: "拖宽度", workspaceId: ws.id, firstSession: { profileId: "codex-mock", text: "hi" } });
  const nav = page.locator("nav.scope-nav");
  const width = async (l: typeof nav) => Math.round((await l.boundingBox())!.width);
  const drag = async (handle: ReturnType<typeof page.getByRole>, dx: number) => {
    const b = (await handle.boundingBox())!;
    await page.mouse.move(b.x + b.width / 2, b.y + 200);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2 + dx, b.y + 200, { steps: 5 });
    await page.mouse.up();
  };

  const before = await width(nav);
  await drag(page.getByRole("separator", { name: "调整左栏宽度" }), 80);
  await expect.poll(() => width(nav)).toBe(before + 80);

  await page.getByTestId("task-card").filter({ hasText: "拖宽度" }).click();
  const list = page.locator("aside.session-list");
  const listBefore = await width(list);
  await drag(page.getByRole("separator", { name: "调整会话列表宽度" }), 60);
  await expect.poll(() => width(list)).toBe(listBefore + 60);

  // A reload comes back to the same task (2026-10-15: the place is remembered).
  await page.reload();
  await expect(page.locator(".page-head")).toContainText("拖宽度");
  await expect.poll(() => width(nav)).toBe(before + 80);
  await expect.poll(() => width(list)).toBe(listBefore + 60);
  await page.getByRole("separator", { name: "调整左栏宽度" }).dblclick();
  await expect.poll(() => width(nav)).toBe(before);
});

test("a reload comes back where the workbench was left: the task and its session, or the canvas", async () => {
  studio = await launchStudio();
  const { page } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  const topic = await studio.api<Topic>("POST", "/api/topics", { title: "回到原处" });
  const { task } = await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", { title: "记住位置", workspaceId: ws.id, topicId: topic.id, firstSession: { profileId: "codex-mock", text: "第一个" } });
  await studio.api<Session>("POST", `/api/tasks/${task.id}/sessions`, { profileId: "codex-mock", text: "第二个" });

  await page.getByTestId("task-card").filter({ hasText: "记住位置" }).click();
  const rows = page.getByTestId("session-row");
  await expect(rows).toHaveCount(2);
  // The second session (the first one opens by default).
  await rows.filter({ hasText: "第二个" }).first().click();
  await expect(page.locator('[data-testid="session-row"][aria-current="true"]')).toContainText("第二个");

  await page.reload();
  await expect(page.locator(".page-head")).toContainText("记住位置");
  await expect(page.locator('[data-testid="session-row"][aria-current="true"]')).toContainText("第二个");

  // The topic's canvas, in that topic's scope.
  await page.getByTestId(`scope-topic-${topic.title}`).click();
  await page.getByRole("button", { name: "画布", exact: true }).click();
  await expect(page.getByRole("button", { name: "画布", exact: true })).toHaveAttribute("aria-current", "page");
  await page.reload();
  await expect(page.getByRole("button", { name: "画布", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId(`scope-topic-${topic.title}`)).toHaveAttribute("aria-current", "true");
});
