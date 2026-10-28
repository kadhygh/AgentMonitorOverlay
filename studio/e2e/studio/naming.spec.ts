import { expect, test } from "@playwright/test";
import type { CanvasDoc, Session, StateSnapshot, Task, Topic, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

// Names and references: a task named at creation and renamed later, a session renamed in its own runtime, a task @-ed
// in a conversation, and a canvas group removed from its title bar.

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

test("tasks and sessions are renamed in place; a task can be @-ed in a conversation", async () => {
  studio = await launchStudio();
  const { page } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  await studio.api("POST", "/api/tasks", { title: "掉落表概率校验", workspaceId: ws.id });

  // A name given at creation (optional) is the task's title, not the first sentence.
  await page.getByRole("button", { name: "+ 新任务" }).click();
  await page.getByLabel("任务名").fill("导入重试");
  await page.getByRole("group", { name: "项目" }).getByRole("button", { name: "alpha" }).click();
  await page.getByLabel("第一句话").fill("先看看现状");
  await page.getByLabel("第一句话").press("Enter");
  await expect(page.getByTestId("task-title")).toHaveText("导入重试");
  await expect(page.getByTestId("msg-agent")).toContainText("MOCK: 先看看现状", { timeout: 30_000 });

  // Rename the task and the session where their names are shown.
  await page.getByTestId("task-title").getByRole("button").click();
  await page.getByLabel("任务名").fill("导入器失败重试");
  await page.getByLabel("任务名").press("Enter");
  await expect(page.getByTestId("task-title")).toHaveText("导入器失败重试");
  await page.getByTestId("thread-head").getByRole("button", { name: "先看看现状" }).click();
  await page.getByLabel("会话名").fill("摸底");
  await page.getByLabel("会话名").press("Enter");
  // A task just made hides its session list; 会话 shows it.
  await page.getByTestId("sessions-toggle").click();
  await expect(page.getByTestId("session-row").first()).toContainText("摸底");
  const state = await studio.api<StateSnapshot>("GET", "/api/state");
  expect(state.tasks.find((t: Task) => t.title === "导入器失败重试")).toBeDefined();
  expect(state.sessions.find((s: Session) => s.title === "摸底")).toBeDefined();

  // @ in the composer lists tasks; the sent message says which AMO task the name is.
  const composer = page.getByLabel("输入消息");
  await composer.pressSequentially("参考 @掉落");
  await expect(page.getByTestId("suggest")).toContainText("掉落表概率校验");
  await screenshot(studio.app, "stage-10", "S10-at-task", page);
  await composer.press("Enter");
  await expect(composer).toHaveValue("参考 @掉落表概率校验 ");
  await composer.press("Enter");
  const target = state.tasks.find((t: Task) => t.title === "掉落表概率校验")!;
  // Since 2026-10-28 (12bce21) the name is coloured in the bubble and what the model was told of it is behind a tag.
  const bubble = page.getByTestId("msg-user").last();
  await expect(bubble.getByTestId("msg-mention")).toHaveText("@掉落表概率校验");
  await expect(bubble.getByTestId("msg-mention-brief")).toHaveAttribute("title", new RegExp(`AMO 任务 ${target.id}`));
});

test("a canvas group is removed from its title bar or with Delete; its cards stay", async () => {
  studio = await launchStudio();
  const { page } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  const topic = await studio.api<Topic>("POST", "/api/topics", { title: "画布" });
  const { task } = await studio.api<{ task: { id: string } }>("POST", "/api/tasks", { title: "整理导入流程", workspaceId: ws.id, topicId: topic.id });
  await studio.api("PUT", `/api/tasks/${task.id}/canvas`, { onCanvas: true }); // shown on the canvas (S11-A: not automatic)
  const canvas = () => studio!.api<CanvasDoc>("GET", `/api/topics/${topic.id}/canvas`);
  await page.getByRole("button", { name: "画布", exact: true }).click();
  await expect(page.getByTestId("canvas-card")).toHaveCount(1);
  const current = await canvas();
  await studio.api("PUT", `/api/topics/${topic.id}/canvas`, {
    ...current,
    groups: [
      { id: "g1", title: "一组", workspaceId: null, rect: { x: 40, y: 40, w: 300, h: 200 } },
      { id: "g2", title: "二组", workspaceId: null, rect: { x: 400, y: 40, w: 300, h: 200 } },
    ],
    nodes: current.nodes.map((n) => ({ ...n, groupId: "g1" })),
  });
  await expect(page.getByTestId("canvas-group")).toHaveCount(2);

  await page.getByRole("button", { name: "删除分组 一组" }).click();
  await page.getByTestId("delete-group-confirm").getByTestId("confirm-action").click(); // unticked: the card stays
  await expect(page.getByTestId("canvas-group")).toHaveCount(1);
  await expect(page.getByTestId("canvas-card")).toHaveCount(1);
  await expect.poll(async () => (await canvas()).nodes.every((n) => n.groupId === null)).toBe(true);

  // Select the other group by its title bar, then Delete.
  await page.locator('[data-group-id="g2"] .group-title').click();
  await page.keyboard.press("Delete");
  await expect(page.getByTestId("canvas-group")).toHaveCount(0);
  await expect.poll(async () => (await canvas()).groups.length).toBe(0);
});
