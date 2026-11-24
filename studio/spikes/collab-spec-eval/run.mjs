// Checks plans/collab-agent-spec.md with real models before the product implements it (the spec's 验收 section; the
// user, 2026-11-23: sonnet、gpt6.2sol、dxx-ds may be used for testing). This script plays the two people (小王, 老李:
// their lines are fixed in scenario.mjs), the Host's patrol (第 2 节's wake message, only on a change; a lead in a turn
// is woken when it ends) and the server (executors' limits in mcp.mjs, the 30-round cap in collab.mjs). The models run
// through their own CLIs (runners.mjs) and see only this spike's MCP server.
//
//   node spikes/collab-spec-eval/run.mjs --model sonnet [--turns 60] [--minutes 70] [--tag before] [--dry]
//
// Everything runs in %TEMP%\amo-studio-sandbox\collab-spec-<run>\ (a bare origin.git, a clone per session, the
// model CLIs' own homes for Codex and DSH; Claude uses this computer's login with CLAUDE.md and auto memory off).
// Every turn is counted in budget.json before it starts. Results: studio/out/collab-spec-eval/<run>/ (not in git):
// state.json (事项, messages and receipts, tool calls, refusals), turns.json (every turn: why it was woken, the prompt,
// the final reply, tools used, tokens), push.log, git.txt, log.txt. score.mjs counts the spec's seven points from them.

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { countTurn, SANDBOX_ROOT, sleep } from "../lib.mjs";
import { Collab, hhmm } from "./collab.mjs";
import { describeItem, startMcp, useToolTextV1, useToolTextV4 } from "./mcp.mjs";
import { spawnSync } from "node:child_process";
import { BUDGET, makeRunner, MODEL_NOTES } from "./run-lib.mjs";
import * as SC from "./scenario.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const studio = path.resolve(here, "..", "..");
// --spec: run an earlier version (e.g. a v1 run's spec-used.md) to compare before and after.
const specFile = path.resolve(process.argv.includes("--spec") ? process.argv[process.argv.indexOf("--spec") + 1] : path.join(studio, "plans", "collab-agent-spec.md"));

const args = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const model = arg("model", "sonnet");
const maxTurns = Number(arg("turns", "60"));
const maxMinutes = Number(arg("minutes", "70"));
const tag = arg("tag", "");
const dry = args.includes("--dry");
const PATROL_MS = Number(arg("patrol", "20")) * 1000; // the Host's 2 minutes, shortened
const QUIET_MS = 75_000;
const MAX_PARALLEL = 3;
if (!BUDGET[model]) throw new Error(`unknown model ${model}`);
if (arg("tooltext", "") === "v1") useToolTextV1();
// --tooltext v4: the tool texts and the old one-layer cowork_read of before 11-25 (with --spec <a v4 spec-used.md>).
const layered = !["v1", "v4"].includes(arg("tooltext", ""));
if (arg("tooltext", "") === "v4") useToolTextV4();
// 久没动静 after 2 hours, scaled to the run (default 6 minutes); --takeover none|LM|WM: who gets a new session mid-run.
const STALE_MS = Number(arg("stale", "6")) * 60_000;
const TAKEOVER = arg("takeover", "LM");

try {
  os.setPriority(os.constants.priority.PRIORITY_BELOW_NORMAL);
} catch {}

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const runName = `${stamp}-${model}${tag ? `-${tag}` : ""}`;
const root = path.join(SANDBOX_ROOT, `collab-spec-${runName}`);
const outDir = path.join(studio, "out", "collab-spec-eval", runName);
mkdirSync(root, { recursive: true });
mkdirSync(outDir, { recursive: true });
const t0 = Date.now();
const logLines = [];
const log = (...p) => {
  const line = `[${((Date.now() - t0) / 1000).toFixed(1).padStart(7)}s] ${p.join(" ")}`;
  logLines.push(line);
  console.log(line);
};

const spec = SC.readSpec(specFile);
copyFileSync(specFile, path.join(outDir, "spec-used.md"));
const repo = SC.makeRepo(root);
// Is a commit in the shared repository (for 已推送), and does the suite pass at it (to check 待核对 and 已验 against).
const onOrigin = (h) => spawnSync("git", ["--git-dir", repo.origin, "cat-file", "-e", `${h}^{commit}`], { stdio: "ignore" }).status === 0;
const checkDir = path.join(root, "check");
/** Of several commits, the one the others lead to (the most commits behind it). */
function newest(hashes) {
  let best = null, n = -1;
  for (const h of hashes) {
    const c = Number(spawnSync("git", ["--git-dir", repo.origin, "rev-list", "--count", h], { encoding: "utf8" }).stdout?.trim() || -1);
    if (c > n) [best, n] = [h, c];
  }
  return best;
}
function testAt(hash) {
  try {
    if (!existsSync(checkDir)) SC.git(root, "clone", "-q", repo.origin, checkDir);
    SC.git(checkDir, "fetch", "-q", "origin", "+refs/heads/*:refs/remotes/origin/*");
    SC.git(checkDir, "checkout", "-q", "--detach", hash);
    const r = spawnSync(process.execPath, ["--test"], { cwd: checkDir, encoding: "utf8", timeout: 60_000 });
    return { pass: r.status === 0, tail: (r.stdout ?? "").split("\n").filter((l) => /^(#|ℹ) (pass|fail) \d/.test(l)).join(" ") };
  } catch (e) {
    return { pass: false, tail: `(${e.message.split("\n")[0]})` };
  }
}
const C = new Collab(path.join(root, "state.json"), { title: SC.TITLE, ref: SC.REF, goal: SC.GOAL, decisions: SC.DECISIONS, people: SC.PEOPLE, onOrigin, staleMs: STALE_MS });
const WM = C.addAgent({ key: "WM", name: "小王的主控", role: "lead", side: "W", person: "小王" });
const LM = C.addAgent({ key: "LM", name: "老李的主控", role: "lead", side: "L", person: "老李" });

const rt = {}; // key -> { runner, cwd, busy, urgent: [], personQueue: [], execQueue: [], presented: Set, patrolNoted, turns }
const turns = [];
const placeholderMisses = new Set();
let execNo = 0;

function roleCard(key) {
  const a = C.agent(key);
  if (a.role === "lead") {
    const other = C.leads().find((x) => x.key !== key);
    const execs = Object.values(C.s.agents).filter((x) => x.lead === key).map((x) => `「${x.name}」（事项 ${x.matter}）`);
    const r = SC.fill(spec.leadCard, { 我: a.person, 标题: SC.TITLE, "cowork 引用": SC.REF, 对方主控显示名: other.name, "列表或「还没有」": execs.join("、") || "还没有" });
    r.missing.forEach((m) => placeholderMisses.add(m));
    return r.text;
  }
  const m = C.matter(a.matter);
  const r = SC.fill(spec.execCard, { 主控显示名: C.nameOf(a.lead), 标题: SC.TITLE, N: String(m.no), 事项标题: m.title });
  r.missing.forEach((x) => placeholderMisses.add(x));
  return r.text;
}
const cardWithRules = (key) => `${roleCard(key)}\n\n—— 协作的规则（下面是规格第 0、4、5 节的原文）——\n\n${spec.rules}`;

function newRuntime(key, cwd) {
  rt[key] = { runner: makeRunner(model, { key, cwd, mcpUrl: `${mcp.url}/mcp/${key}`, dir: root, root }), cwd, busy: false, urgent: [], personQueue: [], execQueue: [], presented: new Set(), patrolNoted: false, turns: 0 };
}

// ---- the MCP server, with the hooks that start executors

const mcp = await startMcp({
  collab: C,
  log,
  layered,
  hooks: {
    roleCard: (key) => cardWithRules(key),
    onSessionStart(lead, m, title, text) {
      const key = `X${++execNo}`;
      let name = title;
      while (Object.values(C.s.agents).some((x) => x.name === name)) name += "·2";
      const cwd = SC.cloneFor(root, repo.origin, key, name);
      const e = C.addAgent({ key, name, title, role: "exec", side: lead.side, lead: lead.key, matter: m.no });
      m.binds.exec.push(key);
      C.execStarted(m, key, "绑执行");
      const d = C.post({ from: lead.key, where: m.no, body: text, kind: "delegate", to: [key] });
      e.delegateSeq = d.seq;
      newRuntime(key, cwd);
      rt[key].execQueue.push({ kind: "first", text: `${cardWithRules(key)}\n\n—— ${lead.name} 派给你的活（session_start）——\n\n${text}` });
      log(`${lead.name} started executor ${key}「${name}」 on 事项 ${m.no}`);
      C.save();
      return e;
    },
    onSessionSend(lead, e, text) {
      rt[e.key].execQueue.push({ kind: "send", text: `【${lead.name} 补充（session_send）】\n${text}` });
    },
  },
});
log(`model ${model}; mcp ${mcp.url}; sandbox ${root}`);
newRuntime("WM", SC.cloneFor(root, repo.origin, "WM", "小王的主控"));
newRuntime("LM", SC.cloneFor(root, repo.origin, "LM", "老李的主控"));

// @ and supersede reminders wake at once (the Host delivers an @ without the patrol); the rest waits for the patrol.
C.on((ev) => {
  if (ev.kind !== "post") return;
  const m = ev.msg;
  const from = C.isPerson(m.from) ? m.from : C.nameOf(m.from);
  for (const k of m.agentMentions) {
    const a = C.agent(k);
    if (!a || !rt[k]) continue;
    if (a.role === "lead") rt[k].urgent.push(`${from} @ 了你（#${m.seq}）`);
    else rt[k].execQueue.push({ kind: "at", seq: m.seq, reason: `${from} @ 了你（#${m.seq}）` });
  }
  const rt0 = m.replyTo ? C.msg(m.replyTo) : null;
  if (rt0 && C.agent(rt0.from)?.role === "exec" && rt0.from !== m.from && !m.agentMentions.includes(rt0.from) && rt[rt0.from] && m.kind !== "report")
    rt[rt0.from].execQueue.push({ kind: "at", seq: m.seq, reason: `${from} 回了你（#${m.seq}）` });
  if (m.derived?.pass) {
    const mt = C.matter(m.where);
    const h = newest(m.derived.pushed);
    const t = testAt(h);
    mt.checks.push({ at: Date.now(), kind: "claim", seq: m.seq, commit: h, by: m.from, ...t });
    log(`check 事项 ${mt.no} ${h} (executor says it passes): ${t.pass ? "pass" : "FAIL"} ${t.tail}`);
  }
  if (m.supersedes) {
    for (const r of C.s.reminders.filter((x) => x.newSeq === m.seq)) {
      const a = C.agent(r.to);
      if (a.role === "lead") rt[r.to].urgent.push(`你看过的 #${r.oldSeq} 已被 #${r.newSeq} 取代`);
      else rt[r.to].execQueue.push({ kind: "reminder", reason: `你看过的 #${r.oldSeq} 已被 #${r.newSeq} 取代` });
    }
  }
});

C.on((ev) => {
  if (ev.kind !== "matter-update" || ev.fields?.status !== "已验") return;
  const mt = ev.matter;
  const h = newest(mt.binds.commits);
  const t = h ? testAt(h) : { pass: false, tail: "（没有绑定的提交）" };
  mt.checks.push({ at: Date.now(), kind: "verified", commit: h ?? null, by: ev.by, ...t });
  log(`check 事项 ${mt.no} ${h} (lead marked 已验): ${t.pass ? "pass" : "FAIL"} ${t.tail}`);
});

// ---- the wake message (第 2 节)

function wakeText(key, reasons, items) {
  const lastWake = rt[key].lastWakeAt ?? 0;
  const otherChat = C.s.messages.filter((m) => m.where === "chat" && m.at > lastWake && m.from !== key && !m.agentMentions.includes(key) && !(m.replyTo && C.msg(m.replyTo)?.from === key)).length;
  const lines = [`【协作 · 待你处理】「${SC.TITLE}」（${SC.REF}）`, `为什么现在叫你：${reasons.join("；")}`, `待你处理（${items.length}）：`, ...items.map((i) => "- " + describeItem(C, i, key))];
  if (C.agent(key).role === "lead" && otherChat) lines.push(`另有 ${otherChat} 条群聊新消息没 @ 你，只是进度；要看用 cowork_read。`);
  lines.push(spec.wakeTail);
  for (const i of items) {
    if (i.kind === "msg" && (i.full || C.msg(i.seq).kind === "report")) C.seen(C.msg(i.seq), key);
    if (i.kind === "reminder") i.reminder.delivered = Date.now();
  }
  C.save();
  return lines.join("\n");
}

// ---- turns

const writeTools = /cowork_(post|matter|conclude|ask|mark|retract|note|board)|session_(start|send)/;
let running = 0;
let stopping = "";

async function runTurn(key, prompt, meta) {
  const a = C.agent(key);
  const r = rt[key];
  r.busy = true;
  running++;
  const n = turns.length + 1;
  a.turn = n;
  r.turns++;
  r.lastWakeAt = Date.now();
  countTurn(`collab-spec-eval ${runName}: ${a.name} #${r.turns} (${meta.kind})`, BUDGET[model]);
  if (a.role === "exec") C.execStarted(C.matter(a.matter), key, "执行开始干");
  const rec = { n, key, name: a.name, role: a.role, side: a.side, turnOfAgent: r.turns, kind: meta.kind, reasons: meta.reasons ?? [], items: meta.items ?? [], prompt, startedAt: Date.now(), takeover: meta.takeover || undefined, session: r.session ?? 1 };
  turns.push(rec);
  log(`turn ${n} ${a.name} (${meta.kind}${meta.reasons?.length ? `: ${meta.reasons.join("；")}` : ""}) start`);
  let out;
  try {
    out = await r.runner.turn(prompt);
  } catch (err) {
    out = { text: "", usage: null, tools: [], error: err.message };
  }
  Object.assign(rec, { endedAt: Date.now(), text: out.text, usage: out.usage, tools: out.tools, error: out.error });
  const calls = C.s.calls.filter((c) => c.turn === n);
  rec.writes = calls.filter((c) => c.ok && writeTools.test(c.tool)).map((c) => c.tool);
  rec.refused = calls.filter((c) => !c.ok).map((c) => `${c.tool}: ${c.error}`);
  rec.gitPush = out.tools.some((t) => /git\b[^|;&]*\b(push|commit|merge)\b/.test(JSON.stringify(t.input ?? "")));
  a.turn = null;
  log(`turn ${n} ${a.name} end ${((rec.endedAt - rec.startedAt) / 1000).toFixed(0)}s writes=[${rec.writes.join(",")}] refused=${rec.refused.length} tokens=${JSON.stringify(out.usage ?? {})}${out.error ? ` ERROR ${out.error}` : ""}`);
  if (a.role === "exec") {
    // Its reply goes to its lead as a message in its 事项 (a reply to the 派活), and wakes the lead.
    const m = C.matter(a.matter);
    const body = (out.text || (out.error ? `（这一轮出错：${out.error}）` : "（这一轮没有回复）")).trim();
    C.post({ from: key, where: m.no, body: body.length > 4000 ? body.slice(0, 4000) + "…（截断）" : body, kind: "report", replyTo: a.delegateSeq, to: [a.lead] });
    rt[a.lead].urgent.push(`你的执行会话「${a.name}」交回了结果`);
  }
  r.busy = false;
  running--;
  writeOut();
}

function leadWake(key, { patrol }) {
  const r = rt[key];
  const items = C.pendingFor(key).filter((i) => !r.presented.has(i.key));
  const person = r.personQueue.length > 0;
  if (!person && !items.length) {
    r.urgent = [];
    return null;
  }
  if (!person && !r.urgent.length && !patrol && !r.patrolNoted) return null;
  const reasons = [...new Set(r.urgent)];
  if (!reasons.length && items.length) reasons.push(`巡检 ${hhmm()} 发现有变化`);
  r.urgent = [];
  r.patrolNoted = false;
  for (const i of items) r.presented.add(i.key);
  let text = "";
  if (items.length) text = wakeText(key, reasons, items);
  if (person) {
    const said = r.personQueue.splice(0).map((p) => `【${C.agent(key).person}（你的人）】${p}`).join("\n\n");
    text = text ? `${text}\n\n${said}` : said;
  }
  // Brought into the 协作 (第 1 节): the role card first, then what is already waiting, then the person.
  if (r.turns === 0) text = `${cardWithRules(key)}\n\n——————\n\n${text}`;
  // A new session taking the role over (第 6 节): the whole card again, then the Host's sentence, then the wake.
  let takeover = false;
  if (r.freshSession) {
    r.freshSession = false;
    takeover = true;
    text = `${cardWithRules(key)}\n\n——————\n\n${spec.takeover}\n\n——————\n\n${text}`;
  }
  return { text, meta: { kind: person ? (r.turns === 0 ? "first" : "person") : "wake", reasons, items: items.map((i) => i.key), takeover } };
}

function execWake(key) {
  const r = rt[key];
  if (!r.execQueue.length) return null;
  const q = r.execQueue.splice(0);
  const first = q.find((x) => x.kind === "first");
  const sends = q.filter((x) => x.kind === "send").map((x) => x.text);
  const reasons = q.filter((x) => x.reason).map((x) => x.reason);
  const items = C.pendingFor(key).filter((i) => !r.presented.has(i.key));
  for (const i of items) r.presented.add(i.key);
  const parts = [];
  if (first) parts.push(first.text);
  if (reasons.length && items.length) parts.push(wakeText(key, reasons, items));
  parts.push(...sends);
  if (!parts.length) return null;
  return { text: parts.join("\n\n"), meta: { kind: first ? "first" : sends.length && !reasons.length ? "person" : "wake", reasons, items: items.map((i) => i.key) } };
}

// ---- the people

const P = { started: false, lmJoined: false, friday: false, ruleChange: 0, aside: false, twoBlocks: 0, answered: new Set(), answers: [] };

function personSay(who, where, body, { replyTo = null, agentMentions = [], mentions = [] } = {}) {
  const m = C.post({ from: who, where, body, replyTo, agentMentions, mentions });
  log(`${who} says (${C.where(m)} #${m.seq}): ${body.slice(0, 60)}`);
  return m;
}

function people() {
  const now = Date.now();
  if (!P.started) {
    P.started = true;
    C.post({ from: "服务器", body: "小王 发起了协作，拉进 老李；小王 把「小王的主控」拉进来，当小王这一方的主控。", kind: "event", to: [] });
    P.fridaySeq = personSay("小王", "chat", SC.LINES.askFriday, { mentions: ["老李"] }).seq;
    WM.joined = true;
    rt.WM.personQueue.push(SC.BRIEF.小王);
  }
  if (!P.lmJoined && ((rt.WM.turns >= 1 && !rt.WM.busy) || now - t0 > 120_000)) {
    P.lmJoined = true;
    C.post({ from: "服务器", body: "老李 加入协作，把「老李的主控」拉进来，当老李这一方的主控。", kind: "event", to: [] });
    LM.joined = true;
    rt.LM.personQueue.push(SC.BRIEF.老李);
  }
  if (P.lmJoined && !P.friday && rt.LM.turns >= 1 && !rt.LM.busy) {
    P.friday = true;
    personSay("老李", "chat", SC.LINES.friday, { replyTo: P.fridaySeq });
  }
  const lExec = Object.values(C.s.agents).some((a) => a.role === "exec" && a.side === "L");
  if (!P.ruleChange && (lExec || now - t0 > 8 * 60_000) && rt.WM.turns >= 1) {
    P.ruleChange = now;
    rt.WM.personQueue.push(SC.LINES.ruleChange);
    log("小王 tells their lead: rule change (blocks)");
  }
  const aiChat = C.s.messages.filter((m) => m.where === "chat" && C.agent(m.from)).length;
  if (!P.aside && aiChat >= 4) {
    P.aside = true;
    personSay("小王", "chat", SC.LINES.aside);
  }
  if (P.ruleChange && !P.twoBlocks) {
    // After 程序's side reported code on the blocks rule (so three blocks is what was agreed and built).
    const lReport = C.s.messages.find((m) => m.kind === "report" && m.at > P.ruleChange && C.agent(m.from)?.side === "L" && /\b[0-9a-f]{7,40}\b/.test(m.body) && /block_|分块|三块|3 块|按块|倍率|120\s*\/\s*90/.test(m.body));
    if (lReport || now - P.ruleChange > 15 * 60_000) {
      P.twoBlocks = now;
      if (TAKEOVER !== "none" && !P.takeoverAsked) [P.takeoverPending, P.takeoverAsked] = [TAKEOVER, "两块的提议"];
      personSay("老李", "chat", SC.LINES.twoBlocks, { agentMentions: ["LM"] });
    }
  }
  // Fallback: the takeover happens even if the run gets far without the two-blocks request.
  if (TAKEOVER !== "none" && !P.takeoverAsked && rt[TAKEOVER]?.turns >= 7) [P.takeoverPending, P.takeoverAsked] = [TAKEOVER, "第 7 轮"];
  // 等人确认 事项 and questions @-ing a person: the person answers a few seconds later, by what it is about.
  for (const m of C.s.messages) {
    if (P.answered.has(m.seq) || m.retracted || !C.agent(m.from) || now - m.at < 6000) continue;
    const mt = m.where === "chat" ? null : C.matter(m.where);
    for (const person of Object.keys(SC.PEOPLE)) {
      const confirm = mt && mt.kind === "confirm" && mt.status !== "关闭" && mt.waiting.includes(person) && m.to.includes(person);
      // gpt6.2sol-v3 @-ed 老李 in every 进度 line and 「…确认的…」 made the person answer them as questions (11-25):
      // a progress line is not a question; a person answers only something asked of them.
      const atPerson = m.mentions.includes(person) && !/^\s*进度/.test(m.body) && /[?？]|请你?.{0,8}(确认|拍板)|可以吗|行不行|是否/.test(m.body);
      if (!confirm && !atPerson) continue;
      P.answered.add(m.seq);
      // 「跨两块」(a big enemy over two blocks) is not the two-blocks request.
      const about = `${mt?.title ?? ""}\n${m.body}`.replace(/跨(了)?两(块|格|段)/g, "跨块");
      let topic = "other";
      let line = SC.LINES.generic;
      const twoBlocksAsk = P.twoBlocks && m.at > P.twoBlocks && SC.CLASSIFY.caliber.test(about);
      // Several things asked at once (鹰眼 and 石像 and 冰冻…): 小王 answers each.
      const parts = [];
      if (person === "小王" && !SC.CLASSIFY.merge.test(mt?.title ?? "") && !twoBlocksAsk) {
        if (SC.CLASSIFY.shield.test(about)) parts.push(["shield-asked", SC.LINES.shieldAgain]);
        if (SC.CLASSIFY.frozen.test(about)) parts.push(["frozen-asked", SC.LINES.frozen]);
        if (SC.CLASSIFY.boundary.test(about)) parts.push(["boundary", SC.LINES.boundaryOk]);
        if (SC.CLASSIFY.ownChange.test(mt?.title ?? m.body) && !parts.length) parts.push(["own-change", SC.LINES.ownChange]);
      }
      // Merge first: a merge request also lists the rules it brings (鹰眼, 两块…).
      if (SC.CLASSIFY.merge.test(mt?.title ?? "") || (SC.CLASSIFY.merge.test(about) && !SC.CLASSIFY.caliber.test(mt?.title ?? ""))) [topic, line] = ["merge", person === "老李" ? SC.LINES.merge : SC.LINES.mergeOther];
      else if (parts.length) [topic, line] = [parts.map((x) => x[0]).join("+"), parts.map((x) => x[1]).join(" ")];
      else if (person === "老李" && (SC.CLASSIFY.shield.test(about) || SC.CLASSIFY.frozen.test(about))) [topic, line] = ["boundary-wrong-person", SC.LINES.notMineBoundary];
      else if (person === "小王" && twoBlocksAsk) [topic, line] = ["caliber", SC.LINES.keepThree];
      // 小王 asked to confirm the blocks rule he gave himself (gpt6.2sol-v1 did): he says yes, as a person would.
      else if (person === "小王" && SC.CLASSIFY.ownChange.test(mt?.title ?? m.body)) [topic, line] = ["own-change", SC.LINES.ownChange];
      else if (person === "小王" && SC.CLASSIFY.boundary.test(about)) [topic, line] = ["boundary", SC.LINES.boundaryOk];
      else if (person === "老李" && SC.CLASSIFY.merge.test(about)) [topic, line] = ["merge", SC.LINES.merge];
      else if (person === "老李" && SC.CLASSIFY.caliber.test(about)) [topic, line] = ["caliber-wrong-person", SC.LINES.notMine];
      else if (atPerson && !confirm && !/[?？]|确认|拍板/.test(m.body)) continue;
      const reply = personSay(person, m.where, line, { replyTo: m.seq });
      P.answers.push({ at: now, person, topic, via: confirm ? "cowork_ask" : "@", matter: mt?.no ?? null, askSeq: m.seq, replySeq: reply.seq, asker: m.from, ask: m.body.slice(0, 300), title: mt?.title ?? null });
    }
  }
}

// ---- output

function gitState() {
  const g = (...a) => {
    try {
      return SC.git(root, "--git-dir", repo.origin, ...a);
    } catch (e) {
      return `(${e.message.split("\n")[0]})`;
    }
  };
  return [`== master\n${g("log", "--format=%h %an %ad %s", "--date=format:%H:%M:%S", "master")}`, `== feature/kunai-pierce\n${g("log", "--format=%h %an %ad %s", "--date=format:%H:%M:%S", "feature/kunai-pierce")}`, `== branches\n${g("branch", "-a", "-v")}`].join("\n\n");
}
function writeOut() {
  writeFileSync(path.join(outDir, "turns.json"), JSON.stringify({ run: runName, model, note: MODEL_NOTES[model], maxTurns, maxMinutes, patrolMs: PATROL_MS, stopped: stopping, minutes: +((Date.now() - t0) / 60000).toFixed(1), people: P.answers, takeover: P.takeover ?? null, staleMs: STALE_MS, layered, placeholderMisses: [...placeholderMisses], startedAt: t0, turns }, null, 1));
  copyFileSync(C.file, path.join(outDir, "state.json"));
}

// ---- the loop

if (dry) {
  people();
  console.log(rt.WM.personQueue[0]);
  console.log("\n----- wake sample -----\n" + spec.wake);
  await mcp.close();
  process.exit(0);
}

let lastPatrol = Date.now();
let quietSince = 0;
try {
  while (!stopping) {
    await sleep(1000);
    people();
    const patrol = Date.now() - lastPatrol >= PATROL_MS;
    if (patrol) lastPatrol = Date.now();
    for (const key of Object.keys(rt)) {
      const r = rt[key];
      const a = C.agent(key);
      if (r.busy) {
        if (patrol && a.role === "lead" && C.pendingFor(key).some((i) => !r.presented.has(i.key))) r.patrolNoted = true;
        continue;
      }
      if (P.takeoverPending === key) {
        // 第 6 节 / 验收 9: a new session takes the role over; nothing of the old conversation goes with it, and what was
        // already presented to the old one is not presented again (the Host would not either) — cowork_read has to do it.
        P.takeoverPending = null;
        const old = r.runner;
        r.session = (r.session ?? 1) + 1;
        r.runner = makeRunner(model, { key: `${key}s${r.session}`, cwd: r.cwd, mcpUrl: `${mcp.url}/mcp/${key}`, dir: root, root });
        r.freshSession = true;
        old.close().catch(() => {});
        const owned = C.s.matters.filter((m) => m.status !== "关闭" && (m.owner === key || m.waiting.includes(key)));
        P.takeover = { at: Date.now(), key, name: a.name, session: r.session, pending: C.pendingFor(key).map((i) => ({ ...i, line: describeItem(C, i, key) })), open: owned.map((m) => ({ no: m.no, title: m.title, status: m.status, waiting: m.waiting, owner: m.owner, exec: m.binds.exec })), decisions: C.s.cowork.decisions.length, matters: C.s.matters.length, seq: C.s.seq };
        log(`takeover: ${a.name} gets a new session (${r.session}); ${P.takeover.pending.length} pending, ${owned.length} open 事项 on it`);
        r.urgent.push("你是接手这个角色的新会话");
      }
      if (running >= MAX_PARALLEL) continue;
      if (a.role === "lead" && !a.joined) continue;
      if (turns.length >= maxTurns) break;
      const w = a.role === "lead" ? leadWake(key, { patrol }) : execWake(key);
      if (w) runTurn(key, w.text, w.meta);
    }
    if (turns.length >= maxTurns && running === 0) stopping = `turn cap ${maxTurns}`;
    if (Date.now() - t0 > maxMinutes * 60_000) stopping = `time cap ${maxMinutes} min`;
    const waiting = Object.values(rt).some((r) => r.busy || r.personQueue.length || r.execQueue.length) || C.s.messages.some((m) => !P.answered.has(m.seq) && Date.now() - m.at < 8000);
    const unseen = C.leads().some((l) => C.pendingFor(l.key).some((i) => !rt[l.key].presented.has(i.key)));
    if (waiting || unseen) quietSince = 0;
    else if (!quietSince) quietSince = Date.now();
    else if (Date.now() - quietSince > QUIET_MS) stopping = `quiet for ${QUIET_MS / 1000} s`;
  }
  log(`stopping: ${stopping}; waiting for running turns`);
  const end = Date.now() + 10 * 60_000;
  while (running > 0 && Date.now() < end) await sleep(1000);
} catch (err) {
  stopping = `error: ${err.message}`;
  log(err.stack);
  process.exitCode = 1;
} finally {
  writeOut();
  writeFileSync(path.join(outDir, "git.txt"), gitState());
  if (existsSync(repo.pushLog)) copyFileSync(repo.pushLog, path.join(outDir, "push.log"));
  writeFileSync(path.join(outDir, "log.txt"), logLines.join("\n") + "\n");
  for (const r of Object.values(rt)) await r.runner.close();
  await mcp.close();
  log(`out: ${outDir}`);
  setTimeout(() => process.exit(), 3000);
}
