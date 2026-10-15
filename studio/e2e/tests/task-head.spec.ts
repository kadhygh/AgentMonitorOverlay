import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { StateSnapshot, Task, Topic, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "./studio.js";

// The task page head (2026-10-14, 方案 A): the title, and under it status · project · branch · topic as quiet words
// that open their own pickers; the right column hidden until 侧栏; 编辑项目 from the project word and the left column.

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-c", "user.name=AMO Test", "-c", "user.email=amo@test.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", windowsHide: true });
}

test("status, topic and project from the line under the title; the right column waits behind 侧栏", async () => {
  studio = await launchStudio({ taskSidebar: false });
  const { page, app } = studio;
  const dir = studio.workspace("mining");
  writeFileSync(join(dir, "a.txt"), "a\n");
  git(dir, "init", "-q", "-b", "feature/drops");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "first");
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: dir });
  await studio.api<Topic>("POST", "/api/topics", { title: "数值" });
  const { task } = await studio.api<{ task: Task }>("POST", "/api/tasks", { title: "掉落表", workspaceId: ws.id, firstSession: { profileId: "codex-mock", text: "hello" } });
  await page.getByTestId("task-card").filter({ hasText: "掉落表" }).click();

  const meta = page.getByTestId("task-meta");
  await expect(page.getByTestId("task-status")).toHaveText("进行中");
  await expect(page.getByTestId("task-project")).toHaveText("mining");
  await expect(page.getByTestId("task-branch")).toHaveText("feature/drops");
  await expect(page.getByTestId("task-topic")).toHaveText("—");
  await expect(meta).toContainText("·");
  // Project and branch are only shown; status and topic are the parts that open something.
  await expect(meta.getByRole("button")).toHaveCount(2);
  // The right column is off by default; 侧栏 brings it.
  await expect(page.getByText("进度", { exact: true })).toHaveCount(0);
  await screenshot(app, "stage-14", "S14-E-task-head", page);

  // Status: a small menu, also by number.
  await page.getByTestId("task-status").click();
  await expect(page.getByTestId("status-menu")).toBeVisible();
  await page.keyboard.press("4");
  await expect(page.getByTestId("task-status")).toHaveText("完成");

  // Topic: a search box; a name that matches none makes the topic.
  await page.getByTestId("task-topic").click();
  const picker = page.getByTestId("topic-picker");
  await expect(picker.getByTestId("topic-option")).toHaveCount(2);
  await picker.getByRole("textbox").fill("关卡");
  await expect(picker.getByTestId("topic-option")).toHaveText(["+新建专题「关卡」并放进去"]);
  await screenshot(app, "stage-14", "S14-E-topic-picker", page);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("task-topic")).toHaveText("关卡");
  const state = await studio.api<StateSnapshot>("GET", "/api/state");
  expect(state.topics.find((t) => t.id === state.tasks.find((x) => x.id === task.id)!.topicId)!.title).toBe("关卡");

  // Project: its name in AMO and a note, from the left column.
  await page.getByTestId("scope-ws-mining").click({ button: "right" });
  await page.getByTestId("edit-project-item").click();
  const edit = page.getByTestId("edit-project");
  await edit.getByTestId("edit-project-name").fill("挖矿主工程");
  await edit.getByTestId("edit-project-description").fill("Unity 主工程，策划表在 Docs/");
  await screenshot(app, "stage-14", "S14-E-edit-project", page);
  await edit.getByTestId("edit-project-save").click();
  await expect(page.getByTestId("task-project")).toHaveText("挖矿主工程");
  await expect(page.getByTestId("scope-ws-挖矿主工程")).toBeVisible();
  const after = await studio.api<StateSnapshot>("GET", "/api/state");
  expect(after.workspaces.find((w) => w.id === ws.id)).toMatchObject({ name: "挖矿主工程", description: "Unity 主工程，策划表在 Docs/" });

  // The left column folds to a strip; 会话 in the head hides the session list completely (no strip), and is
  // remembered; 新会话 brings the list back with its form.
  await page.getByTestId("nav-collapse").click();
  await expect(page.getByTestId("scope-all")).toHaveCount(0);
  const sessionsToggle = page.getByTestId("sessions-toggle");
  await expect(sessionsToggle).toHaveAttribute("aria-pressed", "true");
  await sessionsToggle.click();
  await expect(sessionsToggle).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByRole("complementary", { name: "会话" })).toHaveCount(0);
  await expect(page.getByTestId("session-row")).toHaveCount(0);
  await screenshot(app, "stage-14", "S14-I-sessions-hidden", page);
  await page.getByTestId("new-session-toggle").click();
  await expect(page.getByRole("button", { name: "开始新会话" })).toBeVisible();
  await expect(page.getByTestId("session-row")).toHaveCount(1);
  await expect(sessionsToggle).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("new-session-toggle").click();
  await sessionsToggle.click();
  await page.reload();
  // Back on the same task after the reload (2026-10-15: the place is remembered).
  await expect(page.locator(".page-head")).toContainText("掉落表");
  await expect(page.getByTestId("session-row")).toHaveCount(0);
  await page.getByTestId("sessions-toggle").click();
  await expect(page.getByTestId("session-row")).toHaveCount(1);
  await page.getByTestId("nav-expand").click();
  await expect(page.getByTestId("scope-all")).toBeVisible();

  // 侧栏 shows the right column, and is remembered.
  await page.getByTestId("sidebar-toggle").click();
  await expect(page.getByTestId("sidebar-toggle")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("note-count")).toBeVisible();
  // What is being written in the session's box survives a reload (2026-10-15: a restart emptied it).
  await page.getByLabel("输入消息").fill("写到一半的话");
  await page.reload();
  await expect(page.getByTestId("note-count")).toBeVisible();
  await expect(page.getByLabel("输入消息")).toHaveValue("写到一半的话");

  // The session bar: the openers as one group, 分支 with the git-branch glyph, ⋯ (标记, 归档会话 in deep red); no 仅工作台.
  await expect(page.getByTestId("writer")).toHaveCount(0);
  const bar = page.getByTestId("thread-head");
  await expect(bar.getByRole("group", { name: "在外部打开" }).getByRole("button", { name: "在终端打开" })).toBeVisible();
  await expect(bar.getByTestId("session-fork").locator("svg circle")).toHaveCount(3);
  const forkBox = await bar.getByTestId("session-fork").boundingBox();
  expect(forkBox!.height).toBeGreaterThanOrEqual(30);
  await screenshot(app, "stage-14", "S14-I-session-bar", page);
  await page.getByTestId("session-more").click();
  await expect(page.getByTestId("session-menu").getByRole("menuitem")).toHaveText(["文件标记", "归档会话"]);
  await expect(page.getByTestId("session-archive")).toHaveClass(/menu-danger/);
  await page.getByTestId("session-archive").hover();
  await screenshot(app, "stage-14", "S14-I-archive-danger", page);
});

test("编辑项目 from the left column's right-click menu", async () => {
  studio = await launchStudio();
  const { page } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  await page.getByTestId("scope-ws-alpha").click({ button: "right" });
  await page.getByTestId("edit-project-item").click();
  await page.getByTestId("edit-project-name").fill("阿尔法");
  await page.getByTestId("edit-project-save").click();
  await expect(page.getByTestId("scope-ws-阿尔法")).toBeVisible();
  const state = await studio.api<StateSnapshot>("GET", "/api/state");
  expect(state.workspaces.find((w) => w.id === ws.id)!.name).toBe("阿尔法");
});

test("编辑专题 from the left column's right-click menu: name and a note agents read", async () => {
  studio = await launchStudio();
  const { page, app } = studio;
  const topic = await studio.api<Topic>("POST", "/api/topics", { title: "数值" });
  await page.getByTestId(`scope-topic-数值`).click({ button: "right" });
  await page.getByTestId("edit-topic-item").click();
  const dialog = page.getByTestId("edit-topic");
  await dialog.getByTestId("edit-topic-name").fill("第三章数值");
  await dialog.getByTestId("edit-topic-description").fill("中期掉落更平滑，先在测试服验证");
  await screenshot(app, "stage-14", "S14-M-edit-topic", page);
  await dialog.getByTestId("edit-topic-save").click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId("scope-topic-第三章数值")).toBeVisible();
  const state = await studio.api<StateSnapshot>("GET", "/api/state");
  expect(state.topics.find((t) => t.id === topic.id)).toMatchObject({ title: "第三章数值", description: "中期掉落更平滑，先在测试服验证" });
});
