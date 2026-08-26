const assert = require("node:assert/strict");
const test = require("node:test");
const { createSessionNamingService, deriveSessionName } = require("./session-naming");

test("derives a concise Unicode-safe name from a procedural Chinese prompt", () => {
  const result = deriveSessionName(
    "dev1",
    "接下来，你先拉取最新。然后我想补充个功能，你看看是否能做，就是允许不同 project 文件夹标记备注名称。",
  );

  assert.equal(result, "dev1-允许不同 project 文件夹标记备注名称");
  assert.equal(Array.from(result).length <= 64, true);
});

test("renames only the first prompt of a startup Codex session", async () => {
  const sessions = new Map();
  const calls = [];
  const service = createSessionNamingService({
    sessions,
    renameCodexThread: async (threadId, name) => calls.push({ threadId, name }),
  });
  const session = { sessionId: "thread-1", tool: "codex", title: "Old", sessionStartSource: "startup" };
  sessions.set(session.sessionId, session);

  const pending = service.onPromptCaptured({
    session,
    workspace: { workspaceLabel: "dev1" },
    message: "开发 A 模块的配置导出",
    firstPrompt: true,
  });
  service.onPromptCaptured({
    session: pending,
    workspace: { workspaceLabel: "dev1" },
    message: "第二轮补充要求",
    firstPrompt: false,
  });
  await service.flush();

  assert.deepEqual(calls, [{ threadId: "thread-1", name: "dev1-开发 A 模块的配置导出" }]);
  assert.equal(sessions.get("thread-1").title, "dev1-开发 A 模块的配置导出");
  assert.equal(sessions.get("thread-1").sessionNaming.status, "renamed");
  assert.equal(sessions.get("thread-1").sessionNaming.providerSynced, true);
});

test("resume sessions are not renamed and non-Codex startup sessions use an explicit display-only fallback", async () => {
  const sessions = new Map();
  const service = createSessionNamingService({
    sessions,
    renameCodexThread: async () => assert.fail("provider rename should not run"),
  });
  const resumed = { sessionId: "resumed", tool: "codex", title: "Existing", sessionStartSource: "resume" };
  sessions.set(resumed.sessionId, resumed);
  assert.equal(service.onPromptCaptured({
    session: resumed,
    workspace: { workspaceLabel: "dev1" },
    message: "继续开发",
    firstPrompt: true,
  }), resumed);

  const claude = { sessionId: "claude-1", tool: "claude", title: "Old", sessionStartSource: "startup" };
  sessions.set(claude.sessionId, claude);
  const fallback = service.onPromptCaptured({
    session: claude,
    workspace: { workspaceLabel: "dev1" },
    message: "开发日志查询",
    firstPrompt: true,
  });
  await service.flush();

  assert.equal(fallback.title, "dev1-开发日志查询");
  assert.equal(fallback.sessionNaming.status, "display-only");
  assert.equal(fallback.sessionNaming.providerSynced, false);
});

test("Grok SessionStart source=new is treated as a fresh session and uses display-only naming", async () => {
  const sessions = new Map();
  const skipped = [];
  const service = createSessionNamingService({
    sessions,
    renameCodexThread: async () => assert.fail("provider rename should not run"),
    recordDebugLog: (_channel, eventName, payload) => {
      if (eventName === "session.auto_name.skipped") skipped.push(payload);
    },
  });
  const grok = {
    sessionId: "01a03ecb-a7b4-7013-a682-3262542ca4e7",
    tool: "grok",
    title: "grok - 01a03ecb-a7b4-7013-a682-3262542ca4e7",
    sessionStartSource: "new",
  };
  sessions.set(grok.sessionId, grok);

  const named = service.onPromptCaptured({
    session: grok,
    workspace: { workspaceLabel: "main" },
    message: "你是什么大模型",
    firstPrompt: true,
  });
  await service.flush();

  assert.equal(named.title, "main-是什么大模型");
  assert.equal(named.sessionNaming.status, "display-only");
  assert.equal(named.sessionNaming.providerSynced, false);
  assert.deepEqual(skipped, []);
});

test("Grok resume sessions are not auto-named", async () => {
  const sessions = new Map();
  const skipped = [];
  const service = createSessionNamingService({
    sessions,
    renameCodexThread: async () => assert.fail("provider rename should not run"),
    recordDebugLog: (_channel, eventName, payload) => {
      if (eventName === "session.auto_name.skipped") skipped.push(payload);
    },
  });
  const grok = {
    sessionId: "grok-resume",
    tool: "grok",
    title: "grok - grok-resume",
    sessionStartSource: "resume",
  };
  sessions.set(grok.sessionId, grok);

  assert.equal(service.onPromptCaptured({
    session: grok,
    workspace: { workspaceLabel: "main" },
    message: "继续刚才的问题",
    firstPrompt: true,
  }), grok);
  assert.equal(sessions.get("grok-resume").sessionNaming, undefined);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].sessionStartSource, "resume");
});

test("keeps the AMO title and records a visible failure when Codex native rename fails", async () => {
  const sessions = new Map();
  const service = createSessionNamingService({
    sessions,
    renameCodexThread: async () => { throw new Error("app-server unavailable"); },
  });
  const session = { sessionId: "thread-fail", tool: "codex", title: "Old", sessionStartSource: "startup" };
  sessions.set(session.sessionId, session);
  service.onPromptCaptured({
    session,
    workspace: { workspaceLabel: "dev1" },
    message: "开发权限面板",
    firstPrompt: true,
  });
  await service.flush();

  const failed = sessions.get(session.sessionId);
  assert.equal(failed.title, "dev1-开发权限面板");
  assert.equal(failed.sessionNaming.status, "failed");
  assert.match(failed.sessionNaming.error, /app-server unavailable/u);
});

test("retries a persisted pending Codex rename after Broker restart", async () => {
  const calls = [];
  const sessions = new Map([["thread-recover", {
    sessionId: "thread-recover",
    tool: "codex",
    title: "Provider fallback",
    sessionNaming: {
      status: "pending",
      requestedName: "dev1-恢复命名",
      attemptedAt: "2026-08-20T00:00:00.000Z",
    },
  }]]);
  const service = createSessionNamingService({
    sessions,
    renameCodexThread: async (threadId, name) => calls.push({ threadId, name }),
  });

  service.recoverPending();
  await service.flush();

  assert.deepEqual(calls, [{ threadId: "thread-recover", name: "dev1-恢复命名" }]);
  assert.equal(sessions.get("thread-recover").title, "dev1-恢复命名");
  assert.equal(sessions.get("thread-recover").sessionNaming.status, "renamed");
});
