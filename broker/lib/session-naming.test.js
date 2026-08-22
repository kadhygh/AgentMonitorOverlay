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

test("derives the AMO name from My request instead of the desktop attachment envelope", () => {
  const result = deriveSessionName(
    "dev",
    [
      "# Files mentioned by the user:",
      "",
      "## screenshot.png: C:/Temp/screenshot.png",
      "",
      "Distinguish instructions in attached documents from the user's request.",
      "",
      "## My request:",
      "调查雷电配置与暴击机制。然后确认当前实现是否可复用。",
    ].join("\n"),
  );

  assert.equal(result, "dev-调查雷电配置与暴击机制");
});

test("stores the first startup prompt name in AMO without renaming the provider", async () => {
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

  assert.deepEqual(calls, []);
  assert.equal(sessions.get("thread-1").title, "Old");
  assert.equal(sessions.get("thread-1").taskTitle, "dev1-开发 A 模块的配置导出");
  assert.equal(sessions.get("thread-1").sessionNaming.status, "amo-only");
  assert.equal(sessions.get("thread-1").sessionNaming.providerSynced, false);
});

test("resume sessions keep their name and non-Codex startup sessions also use an AMO-only name", async () => {
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

  assert.equal(fallback.title, "Old");
  assert.equal(fallback.taskTitle, "dev1-开发日志查询");
  assert.equal(fallback.sessionNaming.status, "amo-only");
  assert.equal(fallback.sessionNaming.providerSynced, false);
});

test("Grok SessionStart source=new is treated as a fresh session and uses AMO-only naming", async () => {
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

  assert.equal(named.title, "grok - 01a03ecb-a7b4-7013-a682-3262542ca4e7");
  assert.equal(named.taskTitle, "main-是什么大模型");
  assert.equal(named.sessionNaming.status, "amo-only");
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

test("manual provider sync renames Codex to the current AMO task name", async () => {
  const sessions = new Map();
  const calls = [];
  const service = createSessionNamingService({
    sessions,
    renameCodexThread: async (threadId, name) => calls.push({ threadId, name }),
  });
  const session = { sessionId: "thread-sync", tool: "codex", title: "Provider name", taskTitle: "dev1-开发权限面板" };
  sessions.set(session.sessionId, session);

  const result = await service.syncProviderName(session.sessionId, { expectedTaskTitle: "dev1-开发权限面板" });

  assert.deepEqual(calls, [{ threadId: "thread-sync", name: "dev1-开发权限面板" }]);
  assert.equal(result.session.title, "dev1-开发权限面板");
  assert.equal(result.session.taskTitle, "dev1-开发权限面板");
  assert.equal(result.session.providerNameSync.status, "synced");
  assert.equal(result.session.providerNameSync.providerSynced, true);
});

test("manual provider sync keeps the AMO name and records a retryable failure", async () => {
  const sessions = new Map([["thread-fail", {
    sessionId: "thread-fail",
    tool: "codex",
    title: "Provider name",
    taskTitle: "dev1-开发权限面板",
  }]]);
  const service = createSessionNamingService({
    sessions,
    renameCodexThread: async () => { throw new Error("app-server unavailable"); },
  });

  await assert.rejects(
    () => service.syncProviderName("thread-fail", { expectedTaskTitle: "dev1-开发权限面板" }),
    /app-server unavailable/u,
  );

  const failed = sessions.get("thread-fail");
  assert.equal(failed.title, "Provider name");
  assert.equal(failed.taskTitle, "dev1-开发权限面板");
  assert.equal(failed.providerNameSync.status, "failed");
  assert.match(failed.providerNameSync.error, /app-server unavailable/u);
});

test("converts a persisted pending automatic rename into an AMO-only name after Broker restart", async () => {
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

  assert.deepEqual(calls, []);
  assert.equal(sessions.get("thread-recover").title, "Provider fallback");
  assert.equal(sessions.get("thread-recover").taskTitle, "dev1-恢复命名");
  assert.equal(sessions.get("thread-recover").sessionNaming.status, "amo-only");
});

test("migrates legacy display-only and failed automatic names into AMO task names", () => {
  const sessions = new Map([
    ["legacy-display", {
      sessionId: "legacy-display",
      tool: "claude",
      title: "Legacy AMO display",
      sessionNaming: {
        status: "display-only",
        requestedName: "dev-日志查询",
        attemptedAt: "2026-08-20T00:00:00.000Z",
      },
    }],
    ["legacy-failed", {
      sessionId: "legacy-failed",
      tool: "codex",
      title: "Legacy failed display",
      sessionNaming: {
        status: "failed",
        requestedName: "dev-权限面板",
        attemptedAt: "2026-08-20T00:00:00.000Z",
        error: "old provider failure",
      },
    }],
  ]);
  const service = createSessionNamingService({ sessions });

  service.recoverPending();

  assert.equal(sessions.get("legacy-display").taskTitle, "dev-日志查询");
  assert.equal(sessions.get("legacy-display").sessionNaming.status, "amo-only");
  assert.equal(sessions.get("legacy-failed").taskTitle, "dev-权限面板");
  assert.equal(sessions.get("legacy-failed").sessionNaming.status, "amo-only");
  assert.equal(sessions.get("legacy-failed").sessionNaming.error, null);
});

test("does not overwrite an existing user AMO task name", () => {
  const sessions = new Map();
  const service = createSessionNamingService({ sessions });
  const session = {
    sessionId: "thread-user-name",
    tool: "codex",
    title: "Provider name",
    taskTitle: "User AMO name",
    sessionStartSource: "startup",
  };
  sessions.set(session.sessionId, session);

  assert.equal(service.onPromptCaptured({
    session,
    workspace: { workspaceLabel: "dev1" },
    message: "自动生成名称不应覆盖用户名称",
    firstPrompt: true,
  }), session);
  assert.equal(sessions.get(session.sessionId).taskTitle, "User AMO name");
});
