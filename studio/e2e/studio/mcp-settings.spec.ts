import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { Session, StateSnapshot, Task, Workspace } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

// MCP 设置 (2026-11-04, plans/mcp.md): 设置 → MCP (the person's own Claude Code servers and Studio's, pasted as JSON),
// 编辑项目's MCP (its .mcp.json), the composer's MCP button; a DSH session gets them, and a change from its next message.

let studio: Studio | undefined;
let root: string | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
  if (root) removeTempDir(root);
  root = undefined;
});

test("MCP: settings page, a project's .mcp.json, a session's own choice", async () => {
  root = mkdtempSync(join(tmpdir(), "amo-studio-e2e-mcp-"));
  const config = join(root, "claude.json");
  writeFileSync(config, JSON.stringify({ mcpServers: { figma: { type: "http", url: "https://mcp.figma.com/mcp" }, "amo-relay": { command: "node", args: ["relay-mcp.mjs"] } } }));
  studio = await launchStudio({ dsh: true, env: { AMO_STUDIO_TEST_CLAUDE_CONFIG: config } });
  const { page, app } = studio;
  const folder = studio.workspace("alpha");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, ".mcp.json"), JSON.stringify({ mcpServers: { "shared-new": { command: "npx", args: ["shared-mcp"] } } }));
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: folder });

  // 设置 → MCP: the person's own servers (amo-relay off by default), and one added by pasting a whole mcpServers block.
  await page.getByRole("button", { name: "设置" }).click();
  const dialog = page.getByRole("dialog", { name: "设置" });
  await dialog.getByRole("tab", { name: "MCP" }).click();
  await expect(dialog.getByTestId("mcp-load-local")).toBeChecked();
  await expect(dialog.getByTestId("mcp-entry-figma")).toContainText("本机 · 用户级");
  await expect(dialog.getByTestId("mcp-entry-amo-relay")).toContainText("默认不启用");
  await expect(dialog.getByTestId("mcp-choice-amo-relay-follow")).toHaveText("默认（关）");
  await dialog.getByTestId("mcp-add").click();
  await dialog.getByTestId("mcp-form-json").fill(JSON.stringify({ mcpServers: { img: { command: "npx", args: ["-y", "img-mcp"], env: { IMG_KEY: "sk-test" } } } }, null, 2));
  await dialog.getByTestId("mcp-form-save").click();
  await expect(dialog.getByTestId("mcp-entry-img")).toContainText("npx -y img-mcp");
  await screenshot(app, "studio", "mcp-settings", page);
  // Editing shows the stored key masked, never the key.
  await dialog.getByTestId("mcp-edit-img").click();
  await expect(dialog.getByTestId("mcp-form-json")).not.toHaveValue(/sk-test/);
  await dialog.getByRole("button", { name: "取消" }).click();
  await dialog.getByRole("button", { name: "关闭设置" }).click();

  // A DSH session gets amo, Studio's and the person's servers; not the unapproved .mcp.json one.
  const { session } = await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", { title: "MCP 任务", workspaceId: ws.id, firstSession: { profileId: "dsh-mock", text: "[[mcp-list]]" } });
  await page.getByTestId("task-card").filter({ hasText: "MCP 任务" }).click();
  await expect(page.getByTestId("msg-agent").last()).toContainText("MCP-LIST amo:http,figma:http,img:stdio", { timeout: 30_000 });

  // 编辑项目: the project's .mcp.json, not approved in Claude Code, turned on for this project.
  await page.getByTestId("scope-ws-alpha").click({ button: "right" });
  await page.getByTestId("edit-project-item").click();
  const edit = page.getByTestId("edit-project");
  await expect(edit.getByTestId("mcp-entry-shared-new")).toContainText("还没批准");
  await edit.getByTestId("mcp-choice-shared-new-on").click();
  await expect(edit.getByTestId("mcp-choice-shared-new-on")).toHaveAttribute("aria-pressed", "true");
  await screenshot(app, "studio", "mcp-project", page);
  await edit.getByRole("button", { name: "取消" }).click();

  // The composer's MCP: figma off for this session alone; from its next message.
  await page.getByTestId("switch-mcp").click();
  const tray = page.getByTestId("mcp-tray");
  await expect(tray.getByTestId("mcp-tray-shared-new")).toBeVisible();
  await tray.getByTestId("mcp-tray-figma").locator("input").uncheck();
  await expect(page.getByTestId("mcp-tray-note")).toContainText("从下一条消息起生效");
  await expect(tray.getByTestId("mcp-tray-figma")).toContainText("本会话单独关掉的");
  await screenshot(app, "studio", "mcp-session-tray", page);
  await page.keyboard.press("Escape");
  const composer = page.getByLabel("输入消息");
  await composer.fill("[[mcp-list]]");
  await composer.press("Enter");
  await expect(page.getByTestId("msg-agent").last()).toContainText("MCP-LIST amo:http,img:stdio,shared-new:stdio", { timeout: 30_000 });
  expect((await studio.api<StateSnapshot>("GET", "/api/state")).sessions.find((x) => x.id === session.id)?.options.mcp).toEqual({ figma: false });

  // 管理 MCP… opens 设置 on its MCP page.
  await page.getByTestId("switch-mcp").click();
  await page.getByTestId("mcp-manage").click();
  await expect(page.getByRole("dialog", { name: "设置" }).getByRole("tab", { name: "MCP" })).toHaveAttribute("aria-selected", "true");
});
