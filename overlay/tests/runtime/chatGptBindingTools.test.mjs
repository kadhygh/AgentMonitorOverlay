import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const overlayRoot = fileURLToPath(new URL("../..", import.meta.url));
const workspacePanel = readFileSync(`${overlayRoot}/src/components/WorkspacePanel.tsx`, "utf8");
const workspacePanelsHook = readFileSync(`${overlayRoot}/src/hooks/useWorkspacePanels.ts`, "utf8");

test("Workspace Tools exposes unbind only for a ChatGPT task binding", () => {
  assert.match(workspacePanel, /state\.session\.targetBinding\?\.type === "codex-app-thread"/);
  assert.match(workspacePanel, /\{chatGptBinding \? \(/);
  assert.match(workspacePanel, /onClick=\{onUnbindChatGpt\}/);
  assert.match(workspacePanel, /Unbind ChatGPT/);
});

test("the ChatGPT Workspace Tools action uses the generic target-unbind endpoint", () => {
  assert.match(workspacePanelsHook, /targetBindingForSession\(session\)\?\.type !== "codex-app-thread"/);
  assert.match(workspacePanelsHook, /brokerSessionTargetBindingClearUrl\(session\.sessionId\)/);
  assert.match(workspacePanelsHook, /workspace\.target_unbind\.ok/);
});

test("Workspace Tools derives name sync state from AMO and provider names", () => {
  assert.match(workspacePanel, /const namesMatch = Boolean\(amoTaskTitle && providerTitle && amoTaskTitle === providerTitle\)/);
  assert.match(workspacePanel, /Names synced/);
  assert.match(workspacePanel, /Names differ/);
  assert.match(workspacePanel, /Sync to Session/);
  assert.match(workspacePanel, /canSyncProviderName.*isCodexSession/);
});

test("provider name sync is explicit and sends the current AMO task name", () => {
  assert.match(workspacePanelsHook, /brokerSessionProviderNameSyncUrl\(session\.sessionId\)/);
  assert.match(workspacePanelsHook, /\{ expectedTaskTitle: taskTitle \}/);
  assert.match(workspacePanelsHook, /workspace\.provider_name_sync\.ok/);
});
