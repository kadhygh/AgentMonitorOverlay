import { expect, test } from "@playwright/test";
import type { CanvasDoc, Session, Task, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "./studio.js";

// Managed sessions get the AMO MCP automatically: a Codex session (over HTTP with an MCP-only token) and a Claude
// session (in-process) each read the canvas and quote it in their reply. Mock models only.

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

test("Codex and Claude sessions read the canvas through the AMO MCP", async () => {
  studio = await launchStudio();
  const { page } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  const canvas = await studio.api<CanvasDoc>("GET", "/api/canvas");
  await studio.api("PUT", "/api/canvas", { ...canvas, groups: [{ id: "g1", title: "掉落表", workspaceId: ws.id, rect: { x: 0, y: 0, w: 400, h: 300 } }] });

  for (const [profileId, title] of [
    ["codex-mock", "Codex 读画布"],
    ["claude-mock", "Claude 读画布"],
  ] as const) {
    await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", {
      title,
      scope: { kind: "workspace", workspaceId: ws.id },
      firstSession: { profileId, text: "[[mcp: canvas_read]]" },
    });
    await page.getByRole("button", { name: "← 看板" }).click().catch(() => undefined);
    await page.getByTestId("task-card").filter({ hasText: title }).click();
    try {
      await expect(page.getByTestId("msg-agent").last()).toContainText("MOCK-MCP:", { timeout: 60_000 });
    } catch (err) {
      const tools = profileId === "codex-mock" ? studio.mock!.requests.at(-1)?.tools : studio.claudeMock!.requests.at(-1)?.tools;
      console.log(`${profileId} offered tools:`, JSON.stringify(tools));
      throw err;
    }
    await expect(page.getByTestId("msg-agent").last()).toContainText("分组「掉落表」（工作区 alpha）");
  }
  await screenshot(studio.app, "stage-4", "S4-07-mcp-canvas", page);
});

test("Codex and Claude sessions record progress on their own task through the AMO MCP", async () => {
  studio = await launchStudio();
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  for (const [profileId, title] of [
    ["codex-mock", "Codex 记进度"],
    ["claude-mock", "Claude 记进度"],
  ] as const) {
    const { task, session } = await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", {
      title,
      scope: { kind: "workspace", workspaceId: ws.id },
      firstSession: { profileId, text: `[[mcp: task_note_add {"text":"${title}：导入已改完"}]]` },
    });
    // Writing to its own task needs no approval; the note carries the session that wrote it.
    await expect
      .poll(async () => (await studio!.api<Array<{ sessionId: string | null; text: string }>>("GET", `/api/tasks/${task.id}/notes`)).map((n) => [n.sessionId, n.text]), { timeout: 60_000 })
      .toEqual([[session.id, `${title}：导入已改完`]]);
    const items = await studio.api<Array<{ type: string }>>("GET", `/api/sessions/${session.id}/items`);
    expect(items.some((i) => i.type === "approval")).toBe(false);
  }
});

test("canvas changes from Codex and Claude sessions wait for the person's approval", async () => {
  studio = await launchStudio();
  const { page } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  const groups = async () => (await studio!.api<CanvasDoc>("GET", "/api/canvas")).groups.map((g) => g.title);
  for (const [profileId, title] of [
    ["codex-mock", "Codex 建的组"],
    ["claude-mock", "Claude 建的组"],
  ] as const) {
    await studio.api("POST", "/api/tasks", {
      title,
      scope: { kind: "workspace", workspaceId: ws.id },
      firstSession: { profileId, text: `[[mcp: canvas_group_create {"title":"${title}"}]]` },
    });
    await page.getByRole("button", { name: "← 看板" }).click().catch(() => undefined);
    await page.getByTestId("task-card").filter({ hasText: title }).click();
    // Codex asks through an MCP elicitation, Claude through canUseTool: both become the same approval card.
    const card = page.getByTestId("approval").last();
    await expect(card).toHaveAttribute("data-state", "pending", { timeout: 60_000 });
    await expect(card).toContainText("canvas_group_create");
    expect(await groups()).not.toContain(title);
    await card.getByRole("button", { name: "批准" }).click();
    await expect(page.getByTestId("msg-agent").last()).toContainText("MOCK-MCP:", { timeout: 60_000 });
    expect(await groups()).toContain(title);
  }
  await page.getByRole("button", { name: "画布", exact: true }).click();
  await expect(page.locator(".group-title", { hasText: "Claude 建的组" })).toBeVisible();
  await expect(page.locator(".group-title", { hasText: "Codex 建的组" })).toBeVisible();
  await screenshot(studio.app, "stage-5", "S5-05-canvas-writes", page);
});
