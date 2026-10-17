const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createCardStore } = require("./card-store");
const { createLaunchStore } = require("./launch-store");
const { createTaskLauncher } = require("./task-launch");
const { launchWorkspace } = require("./workspace-launch");
const { SessionCollection } = require("./session-collection");

async function fixture(t, fake) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "amo-task-entry-"));
  fs.mkdirSync(path.join(dir, ".amo"));
  fs.writeFileSync(path.join(dir, ".amo", "workspace.json"), JSON.stringify({ workspaceId: "fixture-workspace" }));
  fs.writeFileSync(path.join(dir, ".amo", "enrollment.json"), JSON.stringify({ adapters: [{ id: "codex-cli" }] }));
  const cardFile = path.join(dir, "cards.json"); const launchFile = path.join(dir, "launches.json");
  const sessions = new SessionCollection(); const calls = [];
  let cardStore = createCardStore({ dataFile: cardFile, coalesceMs: 60000 }); cardStore.attach(sessions);
  let launchStore = createLaunchStore({ dataFile: launchFile });
  const groups = await cardStore.executeGroups({ operationId: "group", expectedRevision: 0, commands: [{ type: "create", name: "Work", dragOnly: false }] });
  const context = { cardStore, launchStore, sessions, launchWorkspace, workspaceRegistry: { list: () => [{ workspaceId: "fixture-workspace", workspacePath: dir, projectName: "Fixture" }] }, launchCliInTerminal: async (options) => { calls.push(options); return fake ? fake(options, context) : { pid: 123, command: "fake", args: [] }; } };
  const api = createTaskLauncher(context);
  const request = { operationId: "op-one", workspacePath: dir, groupId: groups.groups[0].groupId, prompt: "你好\n' \" $(Write-Output injection) -c bad", reasoningEffort: "high", afterLaunch: "amo", codexProvider: { presetId: "openai-default" } };
  t.after(async () => { await context.cardStore.dispose(); fs.rmSync(dir, { recursive: true, force: true }); });
  async function restart() { await context.cardStore.dispose(); context.cardStore = createCardStore({ dataFile: cardFile, coalesceMs: 60000 }); context.cardStore.attach(sessions); context.launchStore = createLaunchStore({ dataFile: launchFile }); return createTaskLauncher(context); }
  return { api, request, context, calls, dir, restart };
}
function owner(context, options, sessionId = "owner") {
  const payload = { event: "SessionStart", sessionId, tool: "codex", launchId: options.environment.AMO_LAUNCH_ID, workspaceId: "fixture-workspace", cwd: options.workspacePath };
  context.launchStore.claim(payload, { sessions: context.sessions });
  context.sessions.set(sessionId, { ...payload, workspacePath: options.workspacePath, state: "running", updatedAt: new Date().toISOString() });
}
test("task launch persists Card before dispatch, safely passes literal prompt, replays across restart", async (t) => {
  const f = await fixture(t, async (options, context) => {
    const cards = (await context.cardStore.list()).cards;
    assert.equal(cards.length, 1); assert.equal(cards[0].components.some((c) => c.type === "amo.session"), false);
    assert.equal(options.args.at(-2), "--");
    assert.equal(options.args.at(-1), f.request.prompt);
    assert.ok(options.args.includes('model_reasoning_effort="high"'));
    return { pid: 123 };
  });
  const first = await f.api.launch(f.request);
  assert.equal(first.task.state, "waiting_session"); assert.equal(first.task.promptState, "unconfirmed");
  const second = await f.api.launch(f.request); assert.equal(first.task.cardId, second.task.cardId);
  const restarted = await f.restart(); await restarted.launch(f.request); assert.equal(f.calls.length, 1);
  await assert.rejects(restarted.launch({ ...f.request, prompt: "changed" }), { code: "task_launch_operation_conflict" });
});
test("hook before spawn response binds one Card and keeps connected launch, child cannot take it", async (t) => {
  const f = await fixture(t, async (options, context) => { owner(context, options); await context.cardStore.flush(); return { pid: 123 }; });
  const result = await f.api.launch(f.request);
  assert.equal(result.task.state, "connected"); assert.equal(result.task.sessionId, "owner");
  assert.equal((await f.context.cardStore.list()).cards.length, 1);
  owner(f.context, f.calls[0], "child");
  const cards = (await f.context.cardStore.list()).cards;
  assert.equal(cards.length, 2); assert.equal((await f.api.receipt(result.task.cardId)).task.sessionId, "owner");
});
test("empty prompt uses interactive CLI with no prompt positional arg", async (t) => {
  const f = await fixture(t); const result = await f.api.launch({ ...f.request, prompt: "" });
  assert.equal(result.task.promptState, "empty"); assert.equal(f.calls[0].args.includes("--"), false);
});
test("unknown dispatch cannot retry; repeated simultaneous requests execute once", async (t) => {
  const f = await fixture(t, async () => { throw new Error("uncertain"); });
  const [a,b] = await Promise.all([f.api.launch(f.request), f.api.launch(f.request)]);
  assert.equal(a.task.state, "unknown"); assert.equal(a.task.cardId,b.task.cardId); assert.equal(f.calls.length,1);
  await assert.rejects(f.api.retry(a.task.cardId, { operationId: "retry" }), { code: "task_launch_retry_unsafe" });
});
test("definite no-spawn retry keeps Card, changes launch id, persists replay", async (t) => {
  let fail = true;
  const f = await fixture(t, async () => { if (fail) throw Object.assign(new Error("not spawned"), { spawnOutcome: "not-spawned" }); return { pid: 456 }; });
  const first = await f.api.launch(f.request); assert.equal(first.task.state, "failed_retryable"); fail = false;
  const retried = await f.api.retry(first.task.cardId, { operationId: "retry" });
  assert.equal(retried.task.cardId, first.task.cardId); assert.notEqual(retried.task.launchId, first.task.launchId);
  const restarted = await f.restart(); await restarted.retry(first.task.cardId, { operationId: "retry" }); assert.equal(f.calls.length, 2);
  await restarted.launch(f.request); assert.equal(f.calls.length, 2);
});
test("missing group, invalid prompt and credentials never dispatch; secrets absent persisted data", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.api.launch({ ...f.request, prompt: "a".repeat(8001) }));
  await assert.rejects(f.api.launch({ ...f.request, groupId: "missing" }));
  await assert.rejects(f.api.launch({ ...f.request, codexProvider: { presetId: "dxx" } }));
  assert.equal(f.calls.length, 0);
  const secret = "SECRET-test-key-unique";
  const result = await f.api.launch({ ...f.request, codexProvider: { presetId: "dxx", apiKey: secret } });
  assert.equal(result.task.state,"waiting_session");
  for (const name of ["cards.json", "launches.json"]) assert.equal(fs.readFileSync(path.join(f.dir,name),"utf8").includes(secret),false);
  await f.api.launch({ ...f.request, codexProvider: { presetId: "dxx" } }); assert.equal(f.calls.length,1);
});
test("foreign workspace and removed processing source do not poison CardStore or bind launch Card", async (t) => {
  const f = await fixture(t); const result = await f.api.launch(f.request);
  let card = await f.context.cardStore.get(result.task.cardId);
  card = await f.context.cardStore.execute(card.cardId, { operationId:"remove",expectedRevision:card.revision,commands:[{type:"remove-component",componentId:"processing"}] });
  owner(f.context,f.calls[0]);
  assert.equal((await f.api.receipt(card.cardId)).task.sessionId,null);
  assert.equal((await f.context.cardStore.list()).cards.length,2);
  await assert.rejects(f.context.cardStore.execute(card.cardId,{operationId:"forge",expectedRevision:card.revision,commands:[{type:"remove-component",componentId:"launch"}]}));
});
test("startup after persisted spawning stays unknown and never resends", async (t) => {
  const f = await fixture(t); const result = await f.api.launch(f.request);
  f.context.launchStore.update(result.task.launchId, { state: "spawning" });
  const restarted = await f.restart();
  assert.equal((await restarted.receipt(result.task.cardId)).task.state, "unknown");
  await restarted.launch(f.request); assert.equal(f.calls.length, 1);
});
test("receipt does not invent live session after deletion or generic rebind", async (t) => {
  const f = await fixture(t, async (options, context) => { owner(context, options); return { pid: 123 }; });
  const result = await f.api.launch(f.request);
  f.context.sessions.set("owner", { ...f.context.sessions.get("owner"), archivedAt: new Date().toISOString() });
  assert.equal((await f.api.receipt(result.task.cardId)).task.state, "archived");
  f.context.sessions.delete("owner");
  assert.equal((await f.api.receipt(result.task.cardId)).task.state, "unknown");
});
test("owner hook wins over late dispatch failure and cannot become retryable", async (t) => {
  const f = await fixture(t, async (options, context) => { owner(context, options); throw new Error("late terminal failure"); });
  const result = await f.api.launch(f.request);
  assert.equal(result.task.state, "connected");
  assert.equal(result.task.launch.state, "connected");
  await assert.rejects(f.api.retry(result.task.cardId,{operationId:"retry"}), { code: "task_launch_retry_unsafe" });
});
test("same launch ID with foreign workspace never binds pending launch Card", async (t) => {
  const f = await fixture(t); const result = await f.api.launch(f.request);
  f.context.sessions.set("foreign", { sessionId:"foreign",tool:"codex",launchRelation:"owner",launchId:result.task.launchId, workspaceId:"fixture-workspace",workspacePath:path.join(f.dir,"different"), state:"running",updatedAt:new Date().toISOString() });
  const card = await f.context.cardStore.get(result.task.cardId);
  assert.equal(card.components.some((c) => c.type === "amo.session"),false);
  assert.equal(f.context.cardStore.status().error,null);
});
test("generic Card creation cannot inject a managed launch of any version", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.context.cardStore.create({operationId:"forged",title:"Forged",components:[{componentId:"forged",type:"amo.launch",schemaVersion:2,data:{launchId:"forged"}}]}));
});
