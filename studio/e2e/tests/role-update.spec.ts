import { expect, test } from "@playwright/test";
import type { CanvasDoc, Session, StateSnapshot, Task, Topic, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "./studio.js";

// 2026-10-17: a plain task's session, referenced later on a topic's canvas, hears about it with the next message; the
// conversation shows the person's own words and a small 「AMO 更新」 tag.

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

test("a task referenced on a canvas later: its session is told with the next message", async () => {
  studio = await launchStudio();
  const { page } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  const topic = await studio.api<Topic>("POST", "/api/topics", { title: "迁移" });
  const { task, session } = await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", {
    title: "装甲车",
    workspaceId: ws.id,
    firstSession: { profileId: "claude-mock", text: "开始" },
  });
  const idle = () => expect.poll(async () => (await studio!.api<StateSnapshot>("GET", "/api/state")).sessions.find((s) => s.id === session.id)?.status, { timeout: 60_000 }).toBe("idle");
  await idle();

  // Referenced on the topic's canvas.
  const canvas = await studio.api<CanvasDoc>("GET", `/api/topics/${topic.id}/canvas`);
  await studio.api("PUT", `/api/topics/${topic.id}/canvas`, { ...canvas, nodes: [{ id: "r1", kind: "ref", taskId: task.id, groupId: null, pos: { x: 40, y: 40 } }] });

  await page.getByTestId("task-card").filter({ hasText: "装甲车" }).click();
  const composer = page.getByLabel("输入消息");
  await composer.fill("接着做");
  await composer.press("Enter");
  const bubble = page.getByTestId("msg-user").last();
  await expect(bubble).toContainText("接着做", { timeout: 30_000 });
  await expect(bubble.getByTestId("msg-role-update")).toBeVisible();
  await expect(bubble).not.toContainText("【AMO：你的任务有变化】");
  await expect(bubble.getByTestId("msg-role-update")).toHaveAttribute("title", /任务被引用到了专题「迁移」/);
  await screenshot(studio.app, "stage-16", "S16-F-role-update", page);

  // Said once: the message after carries nothing.
  await idle();
  await composer.fill("再来");
  await composer.press("Enter");
  await expect(page.getByTestId("msg-user").last()).toContainText("再来", { timeout: 30_000 });
  await expect(page.getByTestId("msg-user").last().getByTestId("msg-role-update")).toHaveCount(0);
});
