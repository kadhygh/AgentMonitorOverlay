// 协作 with real models (plans/cowork.md 第 5 步; the user, 2026-11-23: dxx-ds、gpt6.2sol、sonnet). Everything in a
// sandbox under %TEMP%\amo-studio-sandbox\: a relay service of this checkout's code (port 47900–47949), the accounts
// 「策划」 and 「程序」, two Studio Hosts (this checkout's packages/host/dist/bin.js, each with its own data folder,
// AMO_HOME and CODEX_HOME), a small git repository both clone. Never the person's Studio, .data, ~/.codex settings or the
// team server; Claude runs on this computer's Claude Code login, as the person's own sessions do.
//
//   node spikes/cowork-scenario/run.mjs --planner sonnet --coder gpt6.2sol [--turns 30] [--minutes 40] [--dry]
//
// The people are this script (RelayClient): 策划 starts the 协作 and briefs its AI, 程序 briefs its own; drafts (while
// 「AI 发起 @ 和提问」 is off) are sent by their owner a few seconds later; a 子会话 asking a person is answered, and the
// other person 插话 there; 策划 says something in the 群聊 without @ once, then with @. 「AI 发起 @ 和提问」 goes on
// after the first draft was sent. Every model turn is counted in budget.json (countTurn) the moment it starts — the
// Host starts turns for deliveries by itself, so this is the earliest the script can count; --turns stops the run
// (interrupts both sessions) once that many were counted. Results: studio/out/cowork-scenario/<run>/ (not in git).

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { countTurn, SANDBOX_ROOT, sleep } from "../lib.mjs";
import { MODELS } from "./models.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const studio = path.resolve(here, "..", "..");
const relay = await import(pathToFileURL(path.join(studio, "packages", "relay", "dist", "index.js")).href);
const account = await import(pathToFileURL(path.join(studio, "packages", "account", "dist", "index.js")).href);

// ---- arguments

const args = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const plannerModel = arg("planner", "sonnet");
const coderModel = arg("coder", "gpt6.2sol");
const maxTurns = Number(arg("turns", "30"));
const maxMinutes = Number(arg("minutes", "40"));
// --dry: set everything up (relay, Hosts, channels, sessions, 拉进协作) and stop before any model turn.
const dry = args.includes("--dry");
for (const m of [plannerModel, coderModel]) if (!MODELS[m]) throw new Error(`unknown model ${m}: ${Object.keys(MODELS).join(", ")}`);

// Below normal, so the CLIs it starts (which inherit it on Windows) do not slow the person's desktop.
try {
  os.setPriority(os.constants.priority.PRIORITY_BELOW_NORMAL);
} catch {
  // not allowed: run as is
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const runName = `${stamp}-${plannerModel}-${coderModel}`;
const root = path.join(SANDBOX_ROOT, `cowork-${runName}`);
const outDir = path.join(studio, "out", "cowork-scenario", runName);
mkdirSync(root, { recursive: true });
mkdirSync(outDir, { recursive: true });
const t0 = Date.now();
const logLines = [];
const log = (...parts) => {
  const line = `[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${parts.join(" ")}`;
  logLines.push(line);
  console.log(line);
};

// ---- ports in 47900–47949 (AGENTS.md: tests and tools stay in 47900–47999; 47950–47999 is testkit's random range)

async function freePort(taken) {
  for (let p = 47900; p < 47950; p++) {
    if (taken.has(p)) continue;
    const ok = await new Promise((resolve) => {
      const s = net.createServer();
      s.once("error", () => resolve(false));
      s.listen(p, "127.0.0.1", () => s.close(() => resolve(true)));
    });
    if (ok) {
      taken.add(p);
      return p;
    }
  }
  throw new Error("no free port in 47900–47949");
}

// ---- the repository: a small module both sides change

function git(cwd, ...a) {
  return execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function makeRepo() {
  const seed = path.join(root, "seed");
  mkdirSync(path.join(seed, "src"), { recursive: true });
  mkdirSync(path.join(seed, "test"), { recursive: true });
  writeFileSync(path.join(seed, "package.json"), JSON.stringify({ name: "fire-rate", version: "0.1.0", type: "module", scripts: { test: "node --test" } }, null, 2) + "\n");
  writeFileSync(path.join(seed, "src", "rate.js"), "// 射速（发/秒）。上限现在写死在这里。\nexport const MAX_RATE = 10;\n\nexport function clampRate(rate) {\n  return Math.max(0, Math.min(MAX_RATE, rate));\n}\n");
  writeFileSync(path.join(seed, "test", "rate.test.js"), 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { clampRate } from "../src/rate.js";\n\ntest("clamps to the cap", () => {\n  assert.equal(clampRate(50), 10);\n  assert.equal(clampRate(-1), 0);\n});\n');
  writeFileSync(path.join(seed, "README.md"), "# fire-rate\n\n射速的小模块。`npm test` 跑测试。\n");
  const origin = path.join(root, "origin.git");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  git(seed, "init", "-q", "-b", "main");
  git(seed, "-c", "user.name=seed", "-c", "user.email=seed@example.invalid", "add", ".");
  git(seed, "-c", "user.name=seed", "-c", "user.email=seed@example.invalid", "commit", "-q", "-m", "fire-rate: 射速上限写死在 src/rate.js");
  git(seed, "remote", "add", "origin", origin);
  git(seed, "push", "-q", "origin", "main");
  const clone = (who, name) => {
    const dir = path.join(root, who, "repo");
    git(root, "clone", "-q", origin, dir);
    git(dir, "config", "user.name", name);
    git(dir, "config", "user.email", `${who}@example.invalid`);
    return dir;
  };
  return { origin, planner: clone("planner", "策划"), coder: clone("coder", "程序") };
}

// ---- a Host of this checkout, in its own folders

async function startHost(who, port, relayUrl, name, key) {
  const dir = path.join(root, who);
  const dataDir = path.join(dir, "data");
  const amoHome = path.join(dir, "amo");
  const env = {
    ...process.env,
    AMO_STUDIO_DATA_DIR: dataDir,
    AMO_STUDIO_PORT: String(port),
    AMO_HOME: amoHome,
    AMO_LOCAL_HOME: path.join(dir, "amo-local"),
    CODEX_HOME: path.join(dir, "codex-home"),
    AMO_STUDIO_VERSION: "cowork-scenario",
  };
  for (const k of Object.keys(env)) if (/^(CLAUDE|ANTHROPIC)/.test(k) || k === "AMO_STUDIO_TEST") delete env[k];
  mkdirSync(env.CODEX_HOME, { recursive: true });
  await account.saveAccount({ server: relayUrl, name, key }, { env: { AMO_HOME: amoHome } });
  const logFile = path.join(dir, "host.log");
  const out = [];
  const child = spawn(process.execPath, [path.join(studio, "packages", "host", "dist", "bin.js")], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  child.stdout.on("data", (d) => out.push(String(d)));
  child.stderr.on("data", (d) => out.push(String(d)));
  const tokenFile = path.join(dataDir, "host-token");
  const end = Date.now() + 60_000;
  while (!existsSync(tokenFile) || !existsSync(path.join(dataDir, "host.json"))) {
    if (child.exitCode !== null) throw new Error(`${who} Host exited ${child.exitCode}: ${out.join("").slice(-2000)}`);
    if (Date.now() > end) throw new Error(`${who} Host did not start: ${out.join("").slice(-2000)}`);
    await sleep(200);
  }
  const token = readFileSync(tokenFile, "utf8").trim();
  const url = `http://127.0.0.1:${port}`;
  const api = async (method, p, body) => {
    const res = await fetch(`${url}${p}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", connection: "close" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await res.json().catch(() => ({}));
    if (res.status !== 200) throw new Error(`${who} ${method} ${p} -> ${res.status} ${JSON.stringify(data).slice(0, 400)}`);
    return data;
  };
  for (;;) {
    try {
      await api("GET", "/api/health");
      break;
    } catch (err) {
      if (Date.now() > end) throw err;
      await sleep(300);
    }
  }
  return { who, url, api, child, flush: () => writeFileSync(logFile, out.join("")) };
}

/** The profile a session of this model runs on, set up in that Host (a channel, or DSH's clone). */
async function profileFor(host, model) {
  const m = MODELS[model];
  if (m.channel) {
    const ch = await host.api("POST", "/api/channels", m.channel);
    return ch.id;
  }
  if (m.dsh) {
    await host.api("PUT", "/api/dsh", { path: m.dsh.path, source: "clone" });
    const s = await host.api("POST", "/api/dsh/check");
    if (!s.check?.ok) throw new Error(`DSH check failed: ${s.check?.message ?? JSON.stringify(s).slice(0, 300)}`);
  }
  const p = (await host.api("GET", "/api/state")).profiles.find((x) => x.id === m.profileId);
  if (!p) throw new Error(`${host.who}: no profile ${m.profileId}`);
  if (p.unavailable) throw new Error(`${host.who}: profile ${m.profileId} unavailable: ${p.unavailable}`);
  return p.id;
}

// ---- the briefs (what each person tells their own AI)

const GOAL = [
  "射速上限现在写死在 src/rate.js 的 MAX_RATE 里，要改成策划能在表里调：",
  "1. 上限从 config/rate.json 读（字段 maxRate，单位 发/秒）；",
  "2. 文件没有、读不出来或数不对（不是正数）时用默认值 10，并 console.warn 一句；",
  "3. 有测试覆盖读到、没文件、填错三种情况（npm test）；",
  "4. 给策划看的说明 docs/rate.md：字段、单位、默认值、改了以后怎么生效。",
].join("\n");

const plannerBrief = (title) =>
  [
    `我是策划。我在 AMO 中转上开了协作「${title}」，已经把你拉进来了；程序和他的 AI 也在里面。需求是协作的目标（cowork_read 能看到）。`,
    "请你来带这件事：",
    "1. 先 cowork_read 看一下协作；",
    "2. 把需求拆成 3～4 小步，写到协作白板上（cowork_board，每步一张卡）；",
    "3. 在群聊里 @ 程序的 AI（agentMentions 写它的 mark），请它按白板一步一步做，每做完一步提交、推送、用 cowork_note 记提交，再在群聊里 @ 你；",
    "4. docs/rate.md 由你写：在这个仓库里写好，git pull --rebase 后提交、推送（git push），再 cowork_note 记一下；",
    "5. maxRate 允许填的最大值是多少，要程序（人）拍板：开一个子会话（cowork_ask）问程序（人），他回复后用 cowork_conclude 给这个子会话定结论，再按结论更新白板；别的拿不准要人定的事也这样问。",
    "全部做完后在群聊里总结一句。期间不用再问我。",
  ].join("\n");

const coderBrief = (title) =>
  [
    `我是程序。协作「${title}」里策划的 AI 会 @ 你安排活，按它的安排在这个仓库里做，不用等我确认：`,
    "- 每步开始前 git pull --rebase；做完跑 npm test，提交，git push；",
    "- 推完用 cowork_note 记提交（commit 写提交号，files 写改了的文件），再在群聊里回复、@ 策划的 AI；",
    "- 白板上对应的卡做完了可以标一下（cowork_board）；",
    "- 要人拍板的事，开子会话（cowork_ask）问策划（人）。",
    "现在先 cowork_read 看一下协作，然后结束这一轮，等它 @ 你。",
  ].join("\n");

// ---- the run

const ports = new Set();
const relayPort = await freePort(ports);
const store = new relay.RelayStore(path.join(root, "relay", "relay.db"));
const server = await relay.startRelayServer({ store, filesDir: path.join(root, "relay", "files"), host: "127.0.0.1", port: relayPort, name: "协作场景" });
log(`relay ${server.url}; sandbox ${root}`);
const plannerAcc = store.register("策划", `pw-${Math.random().toString(36).slice(2, 10)}`);
const coderAcc = store.register("程序", `pw-${Math.random().toString(36).slice(2, 10)}`);
const planner = new relay.RelayClient(server.url, plannerAcc.key);
const coder = new relay.RelayClient(server.url, coderAcc.key);
const repo = makeRepo();

const hosts = {};
const turns = []; // { at, who, model, sessionId, note }
const actions = []; // the people's scripted steps
let stopping = "";
const sessions = {};

try {
  hosts.planner = await startHost("planner", await freePort(ports), server.url, "策划", plannerAcc.key);
  hosts.coder = await startHost("coder", await freePort(ports), server.url, "程序", coderAcc.key);
  log("hosts up", hosts.planner.url, hosts.coder.url);

  const sides = [
    { who: "planner", host: hosts.planner, model: plannerModel, repo: repo.planner, title: "射速需求（策划）" },
    { who: "coder", host: hosts.coder, model: coderModel, repo: repo.coder, title: "射速实现（程序）" },
  ];
  for (const s of sides) {
    const profileId = await profileFor(s.host, s.model);
    const ws = await s.host.api("POST", "/api/workspaces", { path: s.repo });
    const { session } = await s.host.api("POST", "/api/tasks", { title: s.title, workspaceId: ws.id, firstSession: { profileId, title: s.title, options: MODELS[s.model].options } });
    sessions[s.who] = { ...s, sessionId: session.id, profileId, counted: 0, autoCounted: 0, status: "idle" };
    log(`${s.who}: ${s.model} (${profileId}) session ${session.id} in ${s.repo}`);
  }

  const title = "射速上限可配";
  const c = await planner.createCowork({ title, goal: GOAL, repo: "fire-rate", branch: "main", members: ["程序"] });
  log(`cowork ${c.id}`);
  for (const s of Object.values(sessions)) {
    const j = await s.host.api("POST", "/api/cowork/join", { sessionId: s.sessionId, coworkId: c.id, label: s.who === "planner" ? "需求" : "实现" });
    s.mark = j.mark;
    log(`${s.who} joined as ${j.name} (${j.mark})`);
  }

  if (dry) {
    stopping = "dry run: set up, no model turn";
    const d = await planner.cowork(c.id);
    log(`agents: ${d.cowork.agents.map((a) => `${a.name} ${a.state}`).join(", ")}`);
    throw Object.assign(new Error("dry"), { dry: true });
  }

  const send = async (s, text, note) => {
    countTurn(`cowork scenario ${runName}: ${note}`, MODELS[s.model].budget);
    s.counted = (s.counted ?? 0) + 1;
    await s.host.api("POST", `/api/sessions/${s.sessionId}/messages`, { text });
    actions.push({ at: Date.now() - t0, who: s.who === "planner" ? "策划" : "程序", what: note });
  };
  // The coder's brief first (its AI reads the 协作 and waits), then the planner's.
  await send(sessions.coder, coderBrief(title), "程序 briefs their AI");
  await send(sessions.planner, plannerBrief(title), "策划 briefs their AI");

  // ---- watch: turns, drafts, 子会话 to answer, the scripted 插话

  const answered = new Set();
  const draftSeen = new Map();
  let aiInitiate = false;
  const sentDrafts = [];
  let chatNoAt = false;
  let chatWithAt = false;
  let quietSince = 0;
  const deadline = t0 + maxMinutes * 60_000;
  const turnCount = () => turns.length + Object.values(sessions).reduce((n, s) => n + (s.counted ?? 0), 0);

  while (!stopping) {
    await sleep(1500);
    // Turns: one counted for each turn item not seen yet that the script did not start itself.
    for (const s of Object.values(sessions)) {
      const turnItems = (await s.host.api("GET", `/api/sessions/${s.sessionId}/items`)).filter((i) => i.type === "turn");
      const auto = Math.max(0, turnItems.length - (s.counted ?? 0) - (s.autoCounted ?? 0));
      for (let i = 0; i < auto; i++) {
        countTurn(`cowork scenario ${runName}: ${s.who} turn from a delivery`, MODELS[s.model].budget);
        s.autoCounted = (s.autoCounted ?? 0) + 1;
        turns.push({ at: Date.now() - t0, who: s.who, model: s.model });
        log(`${s.who} (${s.model}) started a turn by itself (#${turnItems.length})`);
      }
      const state = await s.host.api("GET", "/api/state");
      s.status = state.sessions.find((x) => x.id === s.sessionId)?.status ?? "?";
    }
    const total = turnCount();
    if (total >= maxTurns) {
      stopping = `turn cap ${maxTurns} reached`;
      break;
    }
    if (Date.now() > deadline) {
      stopping = `time cap ${maxMinutes} min reached`;
      break;
    }

    const detail = await planner.cowork(c.id);
    // Drafts: their owner sends each after a few seconds (as the 中转 client's 「发出」).
    for (const [client, who] of [[planner, "策划"], [coder, "程序"]]) {
      for (const d of await client.coworkDrafts(c.id)) {
        if (d.state !== "pending") continue;
        if (!draftSeen.has(d.id)) draftSeen.set(d.id, Date.now());
        if (Date.now() - draftSeen.get(d.id) < 4000) continue;
        await client.decideCoworkDraft(c.id, d.id, { action: "send" });
        actions.push({ at: Date.now() - t0, who, what: `sent their AI's draft (${d.kind}${d.kind === "ask" ? ` 「${d.ask?.title}」 to ${d.ask?.to}` : ""})` });
        log(`${who} sent draft ${d.id} (${d.kind})`);
        // On once a 子会话 went out as a draft too (so both kinds of draft are seen), or after the third draft.
        sentDrafts.push(d.kind);
        if (!aiInitiate && (d.kind === "ask" || sentDrafts.length >= 3)) {
          aiInitiate = true;
          await planner.updateCowork(c.id, { options: { aiInitiate: true } });
          actions.push({ at: Date.now() - t0, who: "策划", what: "turned 「AI 发起 @ 和提问」 on" });
          log("aiInitiate on");
        }
      }
    }
    // A 子会话 waiting on a person: the person answers; the other person 插话 there once.
    for (const sub of detail.cowork.sessions) {
      if (sub.state === "done" || answered.has(sub.id) || !sub.waitingOn || !["策划", "程序"].includes(sub.waitingOn)) continue;
      answered.add(sub.id);
      const asked = sub.waitingOn === "策划" ? planner : coder;
      const other = sub.waitingOn === "策划" ? coder : planner;
      const otherName = sub.waitingOn === "策划" ? "程序" : "策划";
      await asked.send(sub.id, { kind: "reply", body: "按你的建议来；默认值保持 10，maxRate 最大不要超过 60（超过当填错处理）。" });
      actions.push({ at: Date.now() - t0, who: sub.waitingOn, what: `answered 子会话「${sub.title}」` });
      await sleep(1500);
      await other.postCowork(c.id, { kind: "text", threadId: sub.id, body: "我插一句：说明里写清楚改完 config/rate.json 要重启游戏才生效。" });
      actions.push({ at: Date.now() - t0, who: otherName, what: `插话 in 子会话「${sub.title}」` });
      log(`子会话「${sub.title}」 answered by ${sub.waitingOn}, 插话 by ${otherName}`);
    }
    // 策划 in the 群聊: once without @ (wakes nobody), later with @ to the coder's AI.
    const aiMsgs = (await planner.coworkFeed(c.id, 0)).messages.filter((m) => m.via?.kind === "ai").length;
    if (!chatNoAt && aiMsgs >= 3) {
      chatNoAt = true;
      await planner.postCowork(c.id, { kind: "text", body: "（顺便说一下：配置表以后可能还会加 minRate，先不用做。）" });
      actions.push({ at: Date.now() - t0, who: "策划", what: "said something in the 群聊 without @" });
      log("策划 posted without @");
    }
    if (!chatWithAt && aiMsgs >= 6 && sessions.coder.mark) {
      chatWithAt = true;
      await planner.postCowork(c.id, { kind: "text", body: "warn 的那句话请带上文件路径，方便策划查。", agentMentions: [sessions.coder.mark] });
      actions.push({ at: Date.now() - t0, who: "策划", what: "@-ed the coder's AI in the 群聊" });
      log("策划 @-ed the coder's AI");
    }
    // Done: both idle, nothing queued, no drafts, no 子会话 waiting on someone, for 60 s.
    const busy = Object.values(sessions).some((s) => s.status === "running" || s.status === "starting") || detail.deliveries.some((d) => d.state === "queued") || detail.cowork.sessions.some((x) => x.state !== "done" && x.waitingOn && !answered.has(x.id));
    const pendingDrafts = [...draftSeen.keys()].length > 0 && (await planner.coworkDrafts(c.id)).concat(await coder.coworkDrafts(c.id)).some((d) => d.state === "pending");
    if (busy || pendingDrafts) quietSince = 0;
    else if (!quietSince) quietSince = Date.now();
    else if (Date.now() - quietSince > 60_000) {
      stopping = "quiet for 60 s (both 待命, nothing queued)";
      break;
    }
  }
  log(`stopping: ${stopping}`);
  for (const s of Object.values(sessions)) await s.host.api("POST", `/api/sessions/${s.sessionId}/interrupt`).catch(() => undefined);

  // ---- what happened

  const detail = await coder.cowork(c.id);
  const feed = (await coder.coworkFeed(c.id, 0)).messages;
  const threads = {};
  for (const sub of detail.cowork.sessions) threads[sub.id] = (await coder.messages(sub.id, 0)).messages;
  const board = await coder.coworkBoard(c.id, 0);
  const perSide = {};
  for (const s of Object.values(sessions)) {
    const list = await s.host.api("GET", `/api/sessions/${s.sessionId}/items`);
    writeFileSync(path.join(outDir, `${s.who}-items.json`), JSON.stringify(list, null, 1));
    const turnItems = list.filter((i) => i.type === "turn");
    const tools = {};
    for (const i of list.filter((x) => x.type === "tool")) {
      const m = /cowork_(\w+)/.exec(i.name) || /^(team_\w+)/.exec(i.name);
      const key = m ? (m[0].startsWith("cowork") ? `cowork_${m[1]}` : m[1]) : i.kind ?? "other";
      tools[key] = (tools[key] ?? 0) + 1;
    }
    const boardWrites = list.filter((x) => x.type === "tool" && /cowork_board/.test(x.name) && /"ops"\s*:\s*\[\s*\{/.test(x.input ?? "")).length;
    const myMsgs = [...feed, ...Object.values(threads).flat()].filter((m) => m.via?.kind === "ai" && m.via.conv === s.mark);
    const mentions = myMsgs.filter((m) => (m.agentMentions?.length ?? 0) + (m.mentions?.length ?? 0) > 0).map((m) => ({ seq: m.seq, thread: m.threadId === c.id ? "群聊" : "子会话", agents: m.agentMentions ?? [], people: m.mentions ?? [], body: m.body.slice(0, 120) }));
    const delivered = detail.deliveries.filter((d) => d.agent === s.mark);
    perSide[s.who] = {
      model: s.model,
      turns: turnItems.map((t) => ({ state: t.state, ms: t.endedAt && t.startedAt ? Date.parse(t.endedAt) - Date.parse(t.startedAt) : null, usage: t.usage ?? null, error: t.error ?? null })),
      tools,
      boardWrites,
      messages: myMsgs.length,
      mentions,
      // What woke it each time: the message (#seq, where, who, an excerpt) and why (an @, or a reply in its 子会话).
      deliveries: delivered.map((d) => ({ seq: d.seq, where: d.threadId === c.id ? "群聊" : "子会话", reason: d.reason, state: d.state, from: d.fromAgent ? `${d.from} 的 AI` : d.from, body: ([...feed, ...Object.values(threads).flat()].find((m) => m.id === d.messageId)?.body ?? "").replace(/\s+/g, " ").slice(0, 80), waitMs: d.deliveredAt ? d.deliveredAt - d.createdAt : null, replyMs: d.repliedAt && d.deliveredAt ? d.repliedAt - d.deliveredAt : null })),
    };
  }
  const commits = git(repo.coder, "--git-dir", repo.origin, "log", "--format=%h %an %s", "main").split("\n");
  const result = {
    run: runName,
    planner: plannerModel,
    coder: coderModel,
    notes: [plannerModel, coderModel].filter((m) => MODELS[m].note).map((m) => `${m}：${MODELS[m].note}`),
    stopped: stopping,
    minutes: +((Date.now() - t0) / 60_000).toFixed(1),
    turnsCounted: turnCount(),
    actions,
    perSide,
    events: detail.events.map((e) => ({ kind: e.kind, actor: e.actor, agent: e.agent, text: e.text, data: e.data })),
    subSessions: detail.cowork.sessions.map((x) => ({ title: x.title, from: x.from, to: x.to, agent: x.agent ? "AI" : "人", state: x.state, conclusion: x.conclusion })),
    board: (board.items ?? []).filter((i) => !i.deleted).map((i) => ({ kind: i.kind, text: i.text.slice(0, 160), stale: i.stale, by: i.updatedAgent ? "AI" : i.updatedBy })),
    guardrail: detail.events.some((e) => /连续往来/.test(e.text)),
    commits,
    chat: feed.map((m) => ({ seq: m.seq, who: m.via?.kind === "ai" ? `${m.author} 的 AI` : m.author, kind: m.kind, body: m.body.slice(0, 400), agentMentions: m.agentMentions ?? [] })),
  };
  writeFileSync(path.join(outDir, "result.json"), JSON.stringify(result, null, 1));
  log(`result: ${path.join(outDir, "result.json")}`);
} catch (err) {
  if (err?.dry) log(stopping);
  else {
  stopping = stopping || `error: ${err?.message ?? err}`;
  log(`error: ${err?.stack ?? err}`);
  process.exitCode = 1;
  }
} finally {
  for (const h of Object.values(hosts)) {
    h.flush();
    await h.api("POST", "/api/shutdown", { interrupt: true }).catch(() => undefined);
  }
  await sleep(2000);
  for (const h of Object.values(hosts)) if (h.child.exitCode === null) h.child.kill();
  await server.close().catch(() => undefined);
  store.close();
  writeFileSync(path.join(outDir, "log.txt"), logLines.join("\n") + "\n");
  log(`sandbox left at ${root} (look at the repositories and Hosts' data there; delete it when done)`);
}
