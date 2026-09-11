import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { createRequire } from "node:module";

const source = readFileSync(new URL("../../src/runtime/focusCommandRouter.ts", import.meta.url), "utf8");
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { createFocusCommandRouter, focusFrameworkId } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
const session = { sessionId: "one", tool: "codex", workspaceId: "workspace", reviewRequired: true };
const command = { requestId: "request-1", action: "activate", sessionId: "one", frameworkId: "codex", cardId: "card-one", sessionComponentId: "session", conversationComponentId: "conversation" };
const card = { cardId: "card-one", archivedAt: null, components: [
  { componentId: "session", type: "amo.session", schemaVersion: 1, data: { sessionRef: { frameworkId: "codex", sessionId: "one" } } },
  { componentId: "conversation", type: "amo.conversation", schemaVersion: 1, data: { sessionComponentId: "session" } },
  { componentId: "processing", type: "amo.processing", schemaVersion: 1, data: { sourceComponentId: "session" } },
] };
function fixture(overrides = {}) {
  const calls = [];
  const route = createFocusCommandRouter({ loadSession: async () => ({ ...session }), loadCard: async () => structuredClone(card), revealMain: async () => calls.push("reveal"), activate: async value => calls.push(["activate", value]), resume: async value => calls.push(["resume", value]), ...overrides });
  return { calls, route };
}
test("Focus routes the fresh session to the existing command owner without acknowledging review", async () => {
  const { route, calls } = fixture();
  const result = await route(command);
  assert.equal(result.ok, true);
  assert.match(result.message, /handed to AMO/);
  assert.equal(calls[0], "reveal");
  assert.equal(calls[1][1].reviewRequired, true);
});
test("duplicate command IDs do not resume twice and altered reuse is rejected", async () => {
  const { route, calls } = fixture();
  const request = { ...command, action: "resume" };
  const results = await Promise.all([route(request), route(request)]);
  assert.deepEqual(results[0], results[1]);
  assert.equal(calls.filter(call => call[0] === "resume").length, 1);
  assert.equal((await route(command)).ok, false);
});
test("stale framework, archived and missing session references cannot invoke a command", async () => {
  for (const value of [{ ...session, tool: "claude" }, { ...session, archivedAt: "2026-09-11" }, { ...session, sessionId: "different" }]) {
    const { route, calls } = fixture({ loadSession: async () => value });
    assert.equal((await route(command)).ok, false);
    assert.equal(calls.length, 0);
  }
  const { route } = fixture({ loadSession: async () => { throw new Error("Session not found"); } });
  assert.match((await route(command)).message, /not found/);
});
test("unknown framework and malformed commands fail before native work", async () => {
  const { route, calls } = fixture();
  for (const value of [null, {}, { ...command, frameworkId: "unknown" }, { ...command, action: "delete" }, { ...command, injected: true }]) assert.equal((await route(value)).ok, false);
  assert.equal(calls.length, 0);
});
test("overlapping requests for a session do not launch competing commands", async () => {
  let release;
  const block = new Promise(resolve => { release = resolve; });
  const { route } = fixture({ loadSession: async () => { await block; return session; } });
  const pending = route(command);
  assert.equal((await route({ ...command, requestId: "another" })).ok, false);
  release();
  assert.equal((await pending).ok, true);
});

test("native routing accepts the canonical aliases exposed by each built-in framework component", () => {
  const require = createRequire(import.meta.url);
  for (const name of ["codex", "claude", "grok"]) {
    const component = require(`../../../broker/lib/session-frameworks/${name}.js`);
    for (const alias of component.aliases) assert.equal(focusFrameworkId(` ${alias.toUpperCase()} `), component.frameworkId, alias);
  }
});

test("removed or retargeted Card components cannot invoke a stale native command", async () => {
  for (const current of [
    { ...card, archivedAt: "2026-09-11" },
    { ...card, components: card.components.filter(value => value.type !== "amo.conversation") },
    { ...card, components: card.components.map(value => value.type === "amo.processing" ? { ...value, data: { sourceComponentId: "other" } } : value) },
  ]) {
    const { route, calls } = fixture({ loadCard: async () => current });
    assert.equal((await route(command)).ok, false);
    assert.equal(calls.length, 0);
  }
});

test("a fresh GUI App binding prevents a stale CLI resume request", async () => {
  const { route, calls } = fixture({ loadSession: async () => ({ ...session, targetBinding: { type: "codex-app-thread", threadId: "one" } }) });
  assert.equal((await route({ ...command, action: "resume" })).ok, false);
  assert.equal(calls.length, 0);
});
