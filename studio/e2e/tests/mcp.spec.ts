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
