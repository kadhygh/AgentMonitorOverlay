const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { httpError } = require("./http");
const { resolveWorkspacePath, readJsonFile } = require("./filesystem");
const { AMO_DIR } = require("./amo-constants");
const { resolveCodexProvider } = require("./codex-provider");
const { normalizeCliLaunchEnvironment } = require("./cli-environments");
const { hash } = require("./session-frameworks/common");
const schema = require("./card-components/schema");
const { canonicalFrameworkId } = require("./session-frameworks");
const runFile = promisify(execFile);
const launchComponent = (card) => card.components.find((c) => schema.isType(c, "amo.launch"));
const sameWorkspace = (a, b) => typeof a === "string" && typeof b === "string" && (process.platform === "win32" ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));

function createTaskLauncher(context) {
  let queue = Promise.resolve();
  const active = new Set();
  function normalize(payload) {
    schema.object(payload, ["operationId", "workspacePath", "groupId", "title", "prompt", "codexProvider", "reasoningEffort", "launchEnvironment", "afterLaunch"], "task launch request");
    schema.identifier(payload.operationId, 256); schema.identifier(payload.groupId, 100);
    schema.string(payload.prompt, 8000, "first prompt", true);
    if (payload.prompt.includes("\0")) throw httpError(400, "invalid_prompt", "Prompt cannot contain NUL");
    if (!["medium", "high", "xhigh"].includes(payload.reasoningEffort)) throw httpError(400, "invalid_reasoning_effort", "Select a supported reasoning effort");
    if (!["cli", "amo"].includes(payload.afterLaunch)) throw httpError(400, "invalid_after_launch", "Select a launch destination");
    if (payload.title !== undefined) schema.string(payload.title, 2000, "title", true);
    if (payload.codexProvider) schema.object(payload.codexProvider, ["presetId", "apiKey"], "Codex provider");
    const presetId = payload.codexProvider?.presetId || "openai-default";
    schema.identifier(presetId, 128);
    return { operationId: payload.operationId, workspacePath: resolveWorkspacePath(payload.workspacePath), groupId: payload.groupId, title: payload.title?.trim() || payload.prompt.trim().split(/\r?\n/u)[0].slice(0, 120) || "New Codex task", prompt: payload.prompt, presetId, reasoningEffort: payload.reasoningEffort, launchEnvironment: normalizeCliLaunchEnvironment(payload.launchEnvironment), afterLaunch: payload.afterLaunch };
  }
  async function receipt(cardId) {
    const card = await context.cardStore.get(cardId);
    const component = launchComponent(card);
    if (!component) throw httpError(404, "task_launch_not_found", "Card was not created by the task launcher");
    const data = component.data;
    const launch = context.launchStore.list().find((item) => item.launchId === data.launchId) || null;
    const processing = card.components.find((c) => schema.isType(c, "amo.processing"));
    const session = card.components.find((c) => schema.isType(c, "amo.session") && c.componentId === processing?.data.sourceComponentId);
    const candidateId = session?.data.sessionRef.frameworkId === "codex" ? session.data.sessionRef.sessionId : null;
    const runtime = candidateId ? context.sessions?.get(candidateId) : null;
    const owned = runtime?.sessionId === candidateId && canonicalFrameworkId(runtime.tool) === "codex" && runtime.launchRelation === "owner" && runtime.launchId === data.launchId && runtime.workspaceId === data.workspaceId && sameWorkspace(runtime.workspacePath, data.workspacePath);
    const sessionId = owned && candidateId === (launch?.ownerSessionId || launch?.currentSessionId || launch?.claimedSessionId) ? candidateId : null;
    const state = card.archivedAt || (sessionId && (runtime.archivedAt || runtime.dismissedAt)) ? "archived" : sessionId ? "connected" : active.has(cardId) ? "launching" : launch?.state === "waiting_hook" ? "waiting_session" : launch?.state === "failed" && launch.spawnOutcome === "not-spawned" ? "failed_retryable" : "unknown";
    const message = state === "archived" ? "This Card or Session is archived; no new launch will be attempted." : state === "connected" ? "Session connected to this Card" : state === "launching" ? "Opening managed CLI" : state === "failed_retryable" ? launch?.errorCode === "task_prompt_too_long" ? "No terminal process started. The encoded command exceeds the Windows limit; create a new task with a shorter first prompt." : "No terminal process started. You may retry this Card explicitly." : state === "waiting_session" ? "Terminal launch returned; waiting for Session hook. The first prompt has not been confirmed." : "Launch outcome is uncertain. Check the existing terminal before starting another task; this request will not execute again.";
    // Only expose target-identification metadata, never environment, args or credentials.
    const safeLaunch = launch ? { launchId: launch.launchId, titleToken: launch.titleToken, windowHwnd: launch.windowHwnd || null, windowPid: launch.windowPid || null, state: launch.state } : null;
    return { ok: true, task: { cardId, launchId: data.launchId, state, workspacePath: data.workspacePath, title: card.title, sessionId, execution: sessionId ? { state: runtime.state || null, reviewRequired: Boolean(runtime.reviewRequired), archivedAt: runtime.archivedAt || null } : null, promptState: data.prompt ? "unconfirmed" : "empty", afterLaunch: data.afterLaunch, message, launch: safeLaunch } };
  }
  async function launch(payload) {
    const request = normalize(payload);
    const fingerprint = hash(request); // Deliberately excludes ephemeral credentials.
    const work = async () => {
      const existing = (await context.cardStore.list()).cards.find((card) => launchComponent(card)?.data.operationId === request.operationId);
      if (existing) {
        if (launchComponent(existing).data.fingerprint !== fingerprint) throw httpError(409, "task_launch_operation_conflict", "Operation belongs to a different launch request");
        return receipt(existing.cardId);
      }
      // Validate credentials before allocating persistent work; no credentials enter CardStore.
      resolveCodexProvider(payload.codexProvider);
      let cardId = null;
      try {
        await context.launchWorkspace({ workspacePath: request.workspacePath, adapterId: "codex-cli", launchMode: "managed", codexProvider: payload.codexProvider, launchEnvironment: request.launchEnvironment }, {
          launchStore: context.launchStore,
          launchCliInTerminal: context.launchCliInTerminal,
          // Terminal implementations may log command text; task-entry commands include private prompts.
          recordDebugLog: () => {},
          taskEntry: { prompt: request.prompt, reasoningEffort: request.reasoningEffort },
          onPrepared: async (managedLaunch) => {
            const prepared = await context.cardStore.prepareTaskLaunch({ title: request.title, groupId: request.groupId, launch: { operationId: request.operationId, fingerprint, launchId: managedLaunch.launchId, workspaceId: managedLaunch.workspaceId, workspacePath: request.workspacePath, prompt: request.prompt, presetId: request.presetId, reasoningEffort: request.reasoningEffort, afterLaunch: request.afterLaunch, launchEnvironment: request.launchEnvironment, attempts: [{ operationId: request.operationId, launchId: managedLaunch.launchId }] } });
            if (!prepared.created) throw httpError(409, "task_launch_already_prepared", "Launch is already recorded");
            cardId = prepared.card.cardId;
            active.add(cardId);
          },
        });
      } catch (error) {
        if (!cardId) throw error;
        // Once dispatch was attempted, a failure is not proof that nothing started.
      } finally { if (cardId) active.delete(cardId); }
      return receipt(cardId);
    };
    const result = queue.then(work); queue = result.catch(() => {}); return result;
  }
  function retry(cardId, payload) {
    schema.object(payload, ["operationId", "apiKey"], "task launch retry"); schema.identifier(payload.operationId, 256);
    const work = async () => {
      const card = await context.cardStore.get(cardId); const data = launchComponent(card)?.data;
      if (!data) throw httpError(404, "task_launch_not_found", "Card has no launch");
      if (data.attempts.some((a) => a.operationId === payload.operationId)) return receipt(cardId);
      if ((await receipt(cardId)).task.state !== "failed_retryable") throw httpError(409, "task_launch_retry_unsafe", "The previous attempt may have started; automatic retry is unsafe");
      const codexProvider = { presetId: data.presetId, apiKey: payload.apiKey };
      resolveCodexProvider(codexProvider);
      let prepared = false;
      try {
        await context.launchWorkspace({ workspacePath: data.workspacePath, adapterId: "codex-cli", codexProvider, launchEnvironment: data.launchEnvironment }, {
          launchStore: context.launchStore, launchCliInTerminal: context.launchCliInTerminal, recordDebugLog: () => {}, taskEntry: { prompt: data.prompt, reasoningEffort: data.reasoningEffort },
          onPrepared: async (managedLaunch) => {
            await context.cardStore.prepareTaskRetry({ cardId, expectedLaunchId: data.launchId, launchId: managedLaunch.launchId, operationId: payload.operationId });
            prepared = true; active.add(cardId);
          },
        });
      } catch (error) { if (!prepared) throw error; }
      finally { active.delete(cardId); }
      return receipt(cardId);
    };
    const result = queue.then(work); queue = result.catch(() => {}); return result;
  }
  async function getContext() {
    const groupState = await context.cardStore.listGroups();
    const entries = context.workspaceRegistry.list();
    const workspaces = new Array(entries.length);
    let cursor = 0;
    const deadline = Date.now() + 4500;
    async function worker() { while (cursor < entries.length) {
      const index = cursor++; const entry = entries[index];
      const metadata = readJsonFile(path.join(entry.workspacePath, AMO_DIR, "workspace.json"), null);
      const enrollment = readJsonFile(path.join(entry.workspacePath, AMO_DIR, "enrollment.json"), null);
      const enrolled = metadata?.workspaceId === entry.workspaceId && Boolean(enrollment?.adapters?.some((a) => a.id === "codex-cli"));
      let branch = null;
      if (enrolled && index < 100 && Date.now() < deadline) { try { const result = await runFile("git", ["-C", entry.workspacePath, "symbolic-ref", "--short", "HEAD"], { timeout: Math.min(1500, Math.max(1, deadline - Date.now())), maxBuffer: 4096, windowsHide: true }); branch = result.stdout.trim() || null; } catch {} }
      workspaces[index] = { workspaceId: entry.workspaceId, workspacePath: entry.workspacePath, label: entry.workspaceLabel || entry.projectName || path.basename(entry.workspacePath), branch, enrolled, unavailableReason: enrolled ? null : "Managed Codex is not enrolled at this location" };
    } }
    await Promise.all(Array.from({ length: Math.min(4, entries.length) }, () => worker()));
    return { ok: true, workspaces, groups: groupState.groups, reviewGroupId: groupState.reviewGroupId };
  }
  return { launch, retry, receipt, getContext };
}
module.exports = { createTaskLauncher };
