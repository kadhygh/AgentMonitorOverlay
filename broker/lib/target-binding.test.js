const assert = require("node:assert/strict");
const test = require("node:test");
const {
  clearTargetBindingState,
  isManagedLaunchWindowTarget,
  resolveSessionTargetBinding,
  targetBindingFromWindowHint,
} = require("./target-binding");

const managedWindowHint = {
  hwnd: 4242,
  pid: 99,
  process: "WindowsTerminal.exe",
  boundBy: "managed-launch",
  boundLabel: "Codex CLI managed launch",
};

test("managed launch window hints remain routing evidence instead of target bindings", () => {
  assert.equal(targetBindingFromWindowHint(managedWindowHint, "2026-07-16T00:00:00.000Z"), null);
  assert.equal(
    resolveSessionTargetBinding({
      payload: {},
      existing: null,
      sessionId: "session-managed",
      tool: "codex",
      cwd: "C:\\Projects\\demo",
      boundAt: "2026-07-16T00:00:00.000Z",
      windowHint: managedWindowHint,
    }),
    null,
  );
});

test("legacy managed window targets are discarded while managed hints are preserved", () => {
  const legacyTarget = {
    type: "window",
    hwnd: 4242,
    processId: 99,
    boundBy: "managed-launch",
  };

  assert.equal(isManagedLaunchWindowTarget(legacyTarget), true);
  assert.equal(
    resolveSessionTargetBinding({
      payload: {},
      existing: { targetBinding: legacyTarget },
      sessionId: "session-managed",
      tool: "codex",
      cwd: "C:\\Projects\\demo",
      boundAt: "2026-07-16T00:00:00.000Z",
      windowHint: managedWindowHint,
    }),
    null,
  );
});

test("manual window hints still become explicit target bindings", () => {
  const target = targetBindingFromWindowHint(
    {
      ...managedWindowHint,
      boundBy: "overlay-target-menu",
      boundLabel: "Selected Codex CLI",
    },
    "2026-07-16T00:00:00.000Z",
  );

  assert.equal(target.type, "window");
  assert.equal(target.hwnd, 4242);
  assert.equal(target.processId, 99);
  assert.equal(target.boundBy, "overlay-target-menu");
});

test("an explicit user target survives a managed window hint", () => {
  const target = resolveSessionTargetBinding({
    payload: {},
    existing: {
      targetBinding: {
        type: "codex-app-thread",
        label: "ChatGPT",
        threadId: "session-managed",
        uri: "codex://threads/session-managed",
        boundBy: "overlay-target-menu",
      },
    },
    sessionId: "session-managed",
    tool: "codex",
    cwd: "C:\\Projects\\demo",
    boundAt: "2026-07-16T00:00:00.000Z",
    windowHint: managedWindowHint,
  });

  assert.equal(target.type, "codex-app-thread");
  assert.equal(target.boundBy, "overlay-target-menu");
});

test("clearing a legacy managed target preserves the managed window identity", () => {
  const cleared = clearTargetBindingState({
    cwd: "C:\\Projects\\demo",
    windowHint: managedWindowHint,
    targetBinding: {
      type: "window",
      hwnd: 4242,
      processId: 99,
      boundBy: "managed-launch",
    },
  });

  assert.equal(cleared.targetBinding, null);
  assert.equal(cleared.clearedWindow, false);
  assert.equal(cleared.windowHint.hwnd, 4242);
  assert.equal(cleared.windowHint.pid, 99);
});

test("clearing a manual target removes its window identity", () => {
  const cleared = clearTargetBindingState({
    cwd: "C:\\Projects\\demo",
    windowHint: {
      ...managedWindowHint,
      boundBy: "overlay-target-menu",
    },
    targetBinding: {
      type: "window",
      hwnd: 4242,
      processId: 99,
      boundBy: "overlay-target-menu",
    },
  });

  assert.equal(cleared.targetBinding, null);
  assert.equal(cleared.clearedWindow, true);
  assert.equal(cleared.windowHint.hwnd, null);
  assert.equal(cleared.windowHint.pid, null);
});

test("clearing a legacy CLI session target removes its non-managed window hint", () => {
  const cleared = clearTargetBindingState({
    cwd: "C:\\Projects\\demo",
    windowHint: {
      ...managedWindowHint,
      boundBy: "hook-default-target",
    },
    targetBinding: {
      type: "codex-cli-session",
      sessionId: "session-managed",
      boundBy: "hook-default-target",
    },
  });

  assert.equal(cleared.targetBinding, null);
  assert.equal(cleared.clearedWindow, true);
  assert.equal(cleared.windowHint.hwnd, null);
  assert.equal(cleared.windowHint.pid, null);
});
