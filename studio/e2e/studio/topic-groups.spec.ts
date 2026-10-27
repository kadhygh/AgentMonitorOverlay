import { expect, test } from "@playwright/test";
import type { Session, SessionItem, Topic, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

// 专题分组 (2026-10-27): topics go into groups the way projects do — from their right-click menu or by dragging onto a
// group's heading; a folded group shows a dot when a question waits on one of its canvases. Project groups stay apart.

let studio: Studio | undefined;
test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

test("topics go into groups from their menu or by dragging; a folded group shows what waits; kept apart from project groups", async () => {
  studio = await launchStudio();
  const { page, app } = studio;
  const made: Topic[] = [];
  for (const title of ["画布", "中转", "Focus"]) made.push(await studio.api<Topic>("POST", "/api/topics", { title }));
  const nav = page.getByRole("navigation", { name: "范围", exact: true });
  const topics = nav.getByRole("region", { name: "专题", exact: true });
  const row = (title: string) => nav.getByTestId(`scope-topic-${title}`);
  const group = (name: string) => topics.getByRole("group", { name, exact: true });
  const members = (name: string) => group(name).locator(".nav-group-body .nav-row .name");
  await expect(row("Focus")).toBeVisible();

  // 新建分组… from a topic's menu.
  await row("画布").click({ button: "right" });
  await page.getByTestId("join-group-item").click();
  await page.getByTestId("new-group-item").click();
  await expect(page.getByTestId("edit-group-description")).toHaveAttribute("placeholder", /画布、中转/);
  await page.getByTestId("edit-group-name").fill("Studio");
  await page.getByTestId("edit-group-save").click();
  await expect(members("Studio")).toHaveText(["画布"]);

  // An existing group from the menu, another topic dragged onto the heading.
  await row("中转").click({ button: "right" });
  await page.getByTestId("join-group-item").click();
  await page.getByTestId("join-group").filter({ hasText: "Studio" }).click();
  await expect(members("Studio")).toHaveText(["画布", "中转"]);
  await row("Focus").dragTo(nav.getByTestId("topic-group-Studio"));
  await expect(members("Studio")).toHaveCount(3);

  // 移出分组.
  await row("Focus").click({ button: "right" });
  await page.getByTestId("leave-group-item").click();
  await expect(members("Studio")).toHaveText(["画布", "中转"]);

  // Folded: its topics are hidden. With a question waiting on one of its canvases, the heading has a dot.
  await nav.getByTestId("topic-group-Studio").click();
  await expect(row("画布")).toHaveCount(0);
  await expect(nav.getByTestId("topic-group-Studio").getByTestId("group-alert")).toHaveCount(0);
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  const ask = { target: "#1", kind: "question", text: "先做哪个？" };
  const { session } = await studio.api<{ session: Session }>("POST", "/api/tasks", {
    title: "审阅",
    workspaceId: ws.id,
    topicId: made[0]!.id,
    firstSession: { profileId: "codex-mock", text: `[[mcp: canvas_items_post ${JSON.stringify({ items: [{ title: "一条" }] })}]]` },
  });
  await expect.poll(async () => (await studio!.api<SessionItem[]>("GET", `/api/sessions/${session.id}/items`)).filter((i) => i.type === "agent").length, { timeout: 60_000 }).toBe(1);
  await studio.api("POST", `/api/sessions/${session.id}/messages`, { text: `[[mcp: canvas_callout ${JSON.stringify(ask)}]]` });
  await expect(nav.getByTestId("topic-group-Studio").getByTestId("group-alert")).toBeVisible({ timeout: 60_000 });
  await nav.getByTestId("topic-group-Studio").click();

  // Kept by the Host, as topic groups only.
  await page.reload();
  await expect(nav.getByTestId("topic-group-Studio")).toBeVisible();
  const settings = await studio.api<{ topicGroups: Array<{ name: string; topicIds: string[] }>; projectGroups: unknown[] }>("GET", "/api/settings");
  expect(settings.topicGroups).toEqual([expect.objectContaining({ name: "Studio", topicIds: [made[0]!.id, made[1]!.id] })]);
  expect(settings.projectGroups).toEqual([]);
  await screenshot(app, "review-canvas", "TG-topic-groups", page);

  // 解散分组: the topics stay.
  await nav.getByTestId("topic-group-Studio").click({ button: "right" });
  await page.getByTestId("dissolve-group").click();
  await expect(nav.getByTestId("topic-group-Studio")).toHaveCount(0);
  await expect(row("画布")).toBeVisible();
});
