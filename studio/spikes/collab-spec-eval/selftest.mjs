// No model: drives the simulated 协作 tools through a real MCP client, as a lead and as an executor, and checks the
// spec's rules hold (receipts, 待你处理, refusals, retract / supersede).   node spikes/collab-spec-eval/selftest.mjs
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Collab } from "./collab.mjs";
import { startMcp } from "./mcp.mjs";

const dir = mkdtempSync(path.join(os.tmpdir(), "collab-selftest-"));
const C = new Collab(path.join(dir, "state.json"), { title: "t", ref: "cowork:t", goal: "g", decisions: ["d1"], people: { 小王: { side: "W" }, 老李: { side: "L" } }, onOrigin: (h) => ["abc1234", "def5678"].includes(h) });
C.addAgent({ key: "WM", name: "小王的主控", role: "lead", side: "W", person: "小王" });
C.addAgent({ key: "LM", name: "老李的主控", role: "lead", side: "L", person: "老李" });
const started = [];
const mcp = await startMcp({
  collab: C,
  hooks: {
    roleCard: (k) => `card ${k}`,
    onSessionStart(lead, m, title, text) {
      const e = C.addAgent({ key: "X1", name: title, title, role: "exec", side: lead.side, lead: lead.key, matter: m.no });
      m.binds.exec.push("X1");
      C.execStarted(m, "X1", "绑执行");
      e.delegateSeq = C.post({ from: lead.key, where: m.no, body: text, kind: "delegate", to: ["X1"] }).seq;
      started.push(e);
      return e;
    },
    onSessionSend() {},
  },
});
async function as(key) {
  const c = new Client({ name: "t", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${mcp.url}/mcp/${key}`)));
  return async (name, args = {}) => {
    const r = await c.callTool({ name, arguments: args });
    return { text: r.content[0].text, error: !!r.isError };
  };
}
const wm = await as("WM");
const lm = await as("LM");

const tools = (await (async () => {
  const c = new Client({ name: "t", version: "0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${mcp.url}/mcp/WM`)));
  return (await c.listTools()).tools.map((t) => t.name);
})());
assert.deepEqual(tools.sort(), ["amo_whoami", "cowork_ask", "cowork_board", "cowork_conclude", "cowork_mark", "cowork_matter", "cowork_note", "cowork_post", "cowork_read", "cowork_retract", "session_send", "session_start"]);

// LM opens a 事项 waiting on WM: it is in WM's 待你处理.
let r = await lm("cowork_matter", { action: "open", title: "规则", waiting: ["小王的主控"], body: "规则定了请贴这里" });
assert.match(r.text, /事项 1/);
assert.equal(C.pendingFor("WM").filter((i) => i.kind === "matter").length, 1);
assert.equal(C.pendingFor("WM").filter((i) => i.kind === "msg").length, 1);
// WM replies in it: the replied one is 处理了.
r = await wm("cowork_post", { threadId: "事项 1", body: "16 个", replyTo: "#1" });
assert.ok(!r.error, r.text);
assert.ok(C.msg(1).rc.WM.done);
// LM has read it (cowork_read with threadId) → WM cannot retract it any more; supersede instead.
await lm("cowork_read", { threadId: 1 });
r = await wm("cowork_retract", { seq: 2, action: "edit", body: "x" });
assert.match(r.text, /已经看过/);
r = await wm("cowork_post", { threadId: 1, body: "改分块", supersedes: 2 });
assert.equal(C.msg(2).supersededBy, 3);
assert.equal(C.s.reminders.filter((x) => x.to === "LM").length, 1);
// WM owns nothing yet; LM's 事项 cannot host WM's executor.
r = await wm("session_start", { matter: 1, title: "数值表", text: "改表" });
assert.ok(r.error);
r = await wm("cowork_matter", { action: "open", title: "数值表加字段" });
r = await wm("session_start", { matter: "事项 2", title: "数值表", text: "改表" });
assert.ok(!r.error, r.text);
const x1 = await as("X1");
// The executor: no 群聊, no @ people, no status, no conclusions, no asks — all refused and logged.
for (const [name, args] of [
  ["cowork_post", { body: "hi" }],
  ["cowork_post", { threadId: 2, body: "hi", mentions: ["小王"] }],
  ["cowork_post", { threadId: 1, body: "hi" }],
  ["cowork_matter", { action: "update", matter: 2, status: "已推送" }],
  ["cowork_matter", { action: "close", matter: 2, conclusion: "done" }],
  ["cowork_ask", { to: "小王", title: "t", body: "b" }],
]) {
  r = await x1(name, args);
  assert.ok(r.error, `${name} should be refused`);
}
assert.equal(C.s.violations.length, 6);
assert.equal(C.matter(2).status, "在做");
r = await x1("cowork_post", { threadId: "事项 2", body: "提交 abc1234" });
assert.ok(!r.error, r.text);
assert.ok(C.pendingFor("WM").some((i) => i.seq === C.s.seq));
// Status follows events (第 0 节): a pushed commit → 已推送; an executor's @ of the other side → 等对方 on it; its answer
// (with a basis) clears it; a passing check → 待核对 in the owner's 待你处理; 已验 is the lead's; a hand change lasts
// until the next event.
assert.equal(C.matter(2).status, "已推送");
r = await x1("cowork_post", { threadId: 2, body: "盾兵怎么算？", agentMentions: ["老李的主控"] });
assert.ok(!r.error, r.text);
assert.equal(C.matter(2).status, "等对方");
assert.deepEqual(C.matter(2).waiting, ["LM"]);
r = await lm("cowork_post", { threadId: 2, body: "打中就停", replyTo: C.s.seq, basis: "confirmed", basisRef: "已定的事第 1 条" });
assert.ok(!r.error, r.text);
assert.equal(C.msg(C.s.seq).basis.kind, "confirmed");
assert.equal(C.msg(C.s.seq).basis.person, "老李");
assert.equal(C.matter(2).status, "等对方", "a reply to the executor waits on it");
r = await x1("cowork_post", { threadId: 2, body: "提交 def5678，npm test 5 passed、0 failed" });
assert.equal(C.matter(2).status, "待核对");
assert.ok(C.pendingFor("WM").some((i) => i.kind === "verify" && i.matter === 2));
r = await x1("cowork_matter", { action: "update", matter: 2, status: "已验" });
assert.ok(r.error);
assert.equal(C.s.violations.length, 7);
r = await wm("cowork_matter", { action: "update", matter: 2, status: "在做" });
assert.equal(C.matter(2).status, "在做");
assert.ok(C.matter(2).hist.at(-1).manual);
r = await x1("cowork_post", { threadId: 2, body: "补充：def5678 的测试 5 passed" });
assert.equal(C.matter(2).status, "待核对", "the next event ends the hand change");
r = await wm("cowork_matter", { action: "update", matter: 2, status: "已验" });
assert.equal(C.matter(2).status, "已验");
assert.equal(C.matter(2).hist.at(-1).cause, "核对");
assert.ok(!C.pendingFor("WM").some((i) => i.kind === "verify"));
// WM closes 事项 2: the conclusion goes to 已定的事, its messages are 处理了.
r = await wm("cowork_matter", { action: "close", matter: 2, conclusion: "表改好了" });
assert.equal(C.s.cowork.decisions.at(-1).text, "表改好了");
assert.equal(C.pendingFor("WM").filter((i) => i.matter === 2).length, 0);
// cowork_ask opens a 等人确认 事项 waiting on the person.
r = await wm("cowork_ask", { to: "小王", title: "等小王确认：两块", body: "从三块改两块" });
assert.equal(C.matter(3).kind, "confirm");
assert.deepEqual(C.matter(3).waiting, ["小王"]);
assert.equal(C.matter(3).status, "等人确认");
C.post({ from: "小王", where: 3, body: "不改", replyTo: C.s.seq });
assert.equal(C.matter(3).status, "在做");
// Reading marks seen; overview lists 待你处理.
r = await wm("cowork_read", {});
assert.match(r.text, /【一 · 待你处理】[\s\S]*【二 · 概况】[\s\S]*【三 · 事项细节】/);
r = await wm("cowork_mark", { matter: 1 });
assert.ok(!C.pendingFor("WM").some((i) => i.kind === "msg" && i.matter === 1));
console.log("selftest ok:", C.s.calls.length, "calls,", C.s.violations.length, "refusals");
await mcp.close();
process.exit(0);
