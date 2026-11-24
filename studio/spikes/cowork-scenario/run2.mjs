// 协作 with real models on the 11-24/25 architecture (plans/collab-framework.md 「本轮分六步」, plans/collab-agent-spec.md
// 「验收」): roles (each side one 主控, the 程序 side's 主控 opening an 执行 from a 事项 with session_start + matter), 事项 whose
// status follows events, AI↔AI answers with a basis, gates through cowork_ask, the Host's 巡检. run.mjs (11-23, 子会话 and
// drafts) stays as it was. Everything in a sandbox under %TEMP%\amo-studio-sandbox\: a relay service of this checkout's
// code (port 47900–47949), accounts 「策划」 and 「程序」, two Hosts of this checkout (each its own data folder, AMO_HOME,
// CODEX_HOME), a small git repository both clone. Never the person's Studio, .data, ~/.codex settings or the team server.
//
//   node spikes/cowork-scenario/run2.mjs --lead sonnet --worker gpt6.2sol [--turns 40] [--minutes 40] [--patrol 30] [--dry]
//
// --patrol: the Hosts' 巡检 in seconds (default 30; the product's is 2 minutes) through patrol-preload.mjs.
//
// The people are this script (RelayClient, and the Hosts' session API for what a person types to their own AI):
//   1. 策划 opens the 协作 with the goal and one 已定的事 (the 口径: 1–60, default 10), brings both 主控 in (role lead).
//   2. 策划 briefs its 主控 (it has said two things about warn and 0 / negative values — the confirmed half of the
//      boundary question), 程序 briefs its 主控 (code is ours; ask the planner's 主控 two things before starting; 派执行
//      with session_start + matter, the model named).
//   3. 策划 says something in the 群聊 without @ once an AI has spoken there (wakes nobody).
//   4. A 事项 waiting on a person (等人确认, cowork_ask): that person answers in it.
//   5. Once the 程序 side's 事项 got to 已推送 / 待核对 / 已验, 程序 tells their own 主控 the cap should be 120: a change of
//      the other side's 口径 (已定的事 1) — the gate is the planner's 主控's (it should ask 策划, who agrees).
//   6. Once 120 is settled, 策划 posts a 知会 to 程序 in the 群聊 (wakes no AI); 程序 marks it 看过 a few seconds later.
//   7. The merge to master is the 程序 side's gate: 程序 answers its cowork_ask 「确认，合吧」.
// Stops when every 事项 is closed and master has the change, both quiet for 60 s; or at --turns / --minutes; or quiet for
// 3 minutes with something still open. Every model turn is counted in budget.json (countTurn) — the script's own messages
// before they go, the turns the Hosts start (deliveries, the 巡检, an 执行's result) when the script first sees them.
// Results: studio/out/cowork-scenario/<run>/ (not in git): result.json, each session's items, log.txt; report2.mjs scores.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
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
const leadModel = arg("lead", "sonnet");
const workerModel = arg("worker", "gpt6.2sol");
const maxTurns = Number(arg("turns", "40"));
const maxMinutes = Number(arg("minutes", "40"));
const patrolSec = Number(arg("patrol", "30"));
const dry = args.includes("--dry");
for (const m of [leadModel, workerModel]) if (!MODELS[m]) throw new Error(`unknown model ${m}: ${Object.keys(MODELS).join(", ")}`);

try {
  os.setPriority(os.constants.priority.PRIORITY_BELOW_NORMAL);
} catch {
  // not allowed: run as is
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const runName = `v2-${stamp}-${leadModel}-${workerModel}`;
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

// ---- the repository

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
  git(root, "init", "-q", "--bare", "-b", "master", origin);
  git(seed, "init", "-q", "-b", "master");
  git(seed, "-c", "user.name=seed", "-c", "user.email=seed@example.invalid", "add", ".");
  git(seed, "-c", "user.name=seed", "-c", "user.email=seed@example.invalid", "commit", "-q", "-m", "fire-rate: 射速上限写死在 src/rate.js");
  git(seed, "remote", "add", "origin", origin);
  git(seed, "push", "-q", "origin", "master");
  const clone = (who, name) => {
    const dir = path.join(root, who, "repo");
    git(root, "clone", "-q", origin, dir);
    git(dir, "config", "user.name", name);
    git(dir, "config", "user.email", `${who}@example.invalid`);
    return dir;
  };
  return { origin, seedHead: git(seed, "rev-parse", "--short", "HEAD"), planner: clone("planner", "策划"), coder: clone("coder", "程序") };
}

/** npm test at a commit of origin, in a throwaway clone: did it pass. */
function testAt(origin, commit) {
  const dir = path.join(root, `check-${commit.slice(0, 12)}-${Date.now()}`);
  try {
    git(root, "clone", "-q", origin, dir);
    git(dir, "checkout", "-q", commit);
    execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["test"], { cwd: dir, stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32", timeout: 60_000 });
    return { commit, passed: true };
  } catch (err) {
    return { commit, passed: false, error: String(err?.stderr ?? err?.message ?? err).slice(-600) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- a Host of this checkout, in its own folders, with a shorter 巡检

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
    AMO_STUDIO_VERSION: "cowork-scenario-v2",
    AMO_SCENARIO_PATROL_MS: String(patrolSec * 1000),
  };
  for (const k of Object.keys(env)) if (/^(CLAUDE|ANTHROPIC)/.test(k) || k === "AMO_STUDIO_TEST") delete env[k];
  mkdirSync(env.CODEX_HOME, { recursive: true });
  await account.saveAccount({ server: relayUrl, name, key }, { env: { AMO_HOME: amoHome } });
  const logFile = path.join(dir, "host.log");
  const out = [];
  const preload = pathToFileURL(path.join(here, "patrol-preload.mjs")).href;
  const child = spawn(process.execPath, ["--import", preload, path.join(studio, "packages", "host", "dist", "bin.js")], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
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

/** The profile a session of this model runs on, set up in that Host (a channel, or DSH's clone): { id, label }. */
async function profileFor(host, model) {
  const m = MODELS[model];
  let id = m.profileId;
  if (m.channel) {
    const have = (await host.api("GET", "/api/state")).profiles.find((x) => x.label === m.channel.label);
    id = have ? have.id : (await host.api("POST", "/api/channels", m.channel)).id;
  }
  if (m.dsh) {
    await host.api("PUT", "/api/dsh", { path: m.dsh.path, source: "clone" });
    const s = await host.api("POST", "/api/dsh/check");
    if (!s.check?.ok) throw new Error(`DSH check failed: ${s.check?.message ?? JSON.stringify(s).slice(0, 300)}`);
  }
  const p = (await host.api("GET", "/api/state")).profiles.find((x) => x.id === id);
  if (!p) throw new Error(`${host.who}: no profile ${id}`);
  if (p.unavailable) throw new Error(`${host.who}: profile ${id} unavailable: ${p.unavailable}`);
  return { id: p.id, label: p.label };
}

// ---- what the people write

const TITLE = "射速上限可配";
const GOAL = [
  "射速上限现在写死在 src/rate.js 的 MAX_RATE 里，要改成策划能在表里调。",
  "分工：口径（数值、允许的范围、填错怎么办）归策划这一方定；代码、测试、合 master 归程序这一方。",
  "1. 上限从 config/rate.json 读（字段 maxRate，单位 发/秒）；",
  "2. 填错（文件没有、读不出来、不是数、超出允许的范围）时用默认值，并 console.warn 一句；",
  "3. 有测试覆盖读到、没文件、填错三种情况（npm test）；",
  "4. 做完合进 master。",
].join("\n");
const DECISION_1 = "射速口径：maxRate 允许 1–60（发/秒）；默认值 10；超出 1–60、不是数、文件没有或读不出来都算填错，用默认值 10。";

const plannerBrief = () =>
  [
    `我是策划。我在 AMO 中转上开了协作「${TITLE}」，你是我这一方的主控（拉进去时给了你角色卡）。口径归我们定，代码归程序那边。已定的事第 1 条是射速口径。`,
    "我先交代两件，程序那边问到就照这个答：",
    "- console.warn 那句要带上配置文件的路径和读到的值，方便策划查；",
    "- maxRate 填 0 或负数都算填错（用默认值）。",
    "请你：先 cowork_read 看一下，然后开一件事项交给程序那边做（在等 程序的主控），把目标里要做的写清楚。",
    "之后按你的角色卡来，不用每步问我。",
  ].join("\n");

const coderBrief = (workerLabel) =>
  [
    `我是程序。协作「${TITLE}」里你是我这一方的主控，代码、测试、合 master 归我们。策划的主控会开事项交给我们。`,
    "接到以后：",
    "- 动手前先在那件事项里直接问策划的主控两件拿不准的：console.warn 那句写什么；maxRate 写成字符串（比如 \"30\"）算不算填错。",
    `- 然后从那件事项派一个执行会话去写（session_start 带 matter，model 写「${workerLabel}」，permission 写 full），在功能分支 feature/fire-rate 上做，推上去。`,
    "- 它做完你按角色卡核对。",
    "现在先 cowork_read 看一下协作，然后结束这一轮，等事项来。",
  ].join("\n");

const CODER_120 = "我看了一下：测试服那边射速要到 120，上限 60 太低了。跟策划那边说一下，改成允许 1–120。";

/** What a person answers a 事项 waiting on them (等人确认). */
function answerFor(person, m, firstMessage) {
  const t = `${m.title}\n${firstMessage ?? ""}`;
  if (person === "策划") {
    if (/120/.test(t)) return "可以，上限改成允许 1–120，默认值还是 10。";
    if (/字符串|"30"|“30”|string/i.test(t)) return "字符串也算填错，用默认值。";
    return "按你的建议来。";
  }
  if (/master|合并|合进|merge/i.test(t)) return "确认，合吧。";
  return "按你的建议来。";
}

// ---- the run

const ports = new Set();
const relayPort = await freePort(ports);
const store = new relay.RelayStore(path.join(root, "relay", "relay.db"));
const server = await relay.startRelayServer({ store, filesDir: path.join(root, "relay", "files"), host: "127.0.0.1", port: relayPort, name: "协作场景 v2" });
log(`relay ${server.url}; sandbox ${root}; patrol ${patrolSec} s`);
const plannerAcc = store.register("策划", `pw-${Math.random().toString(36).slice(2, 10)}`);
const coderAcc = store.register("程序", `pw-${Math.random().toString(36).slice(2, 10)}`);
const people = { 策划: new relay.RelayClient(server.url, plannerAcc.key), 程序: new relay.RelayClient(server.url, coderAcc.key) };
const repo = makeRepo();

const hosts = {};
const actions = []; // the people's scripted steps
const timeline = []; // 事项 status as seen: { at, no, title, status, waitingOn, blocker }
const turnLog = []; // { at, session, role, model, why }
let stopping = "";
/** Every session of both Hosts as seen: sessionId → { who (planner|coder), host, model, role, counted, seen }. */
const sessions = new Map();
const marks = {}; // name → seq of the script's own messages worth checking
const act = (who, what) => {
  actions.push({ at: Date.now() - t0, who, what });
  log(`${who}: ${what}`);
};

try {
  hosts.planner = await startHost("planner", await freePort(ports), server.url, "策划", plannerAcc.key);
  hosts.coder = await startHost("coder", await freePort(ports), server.url, "程序", coderAcc.key);
  log("hosts up", hosts.planner.url, hosts.coder.url);

  const plannerLeadProfile = await profileFor(hosts.planner, leadModel);
  const coderLeadProfile = await profileFor(hosts.coder, leadModel);
  const workerProfile = await profileFor(hosts.coder, workerModel);
  log(`profiles: lead ${leadModel} (${coderLeadProfile.label}), worker ${workerModel} (${workerProfile.label})`);

  const makeLead = async (who, host, profile, dir, title) => {
    const ws = await host.api("POST", "/api/workspaces", { path: dir });
    const { session } = await host.api("POST", "/api/tasks", { title, workspaceId: ws.id, firstSession: { profileId: profile.id, title, options: MODELS[leadModel].options } });
    sessions.set(session.id, { who, host, model: leadModel, role: "lead", counted: 0, seen: 0, sessionId: session.id });
    return session.id;
  };
  const plannerLead = await makeLead("planner", hosts.planner, plannerLeadProfile, repo.planner, "协作：射速（策划）");
  const coderLead = await makeLead("coder", hosts.coder, coderLeadProfile, repo.coder, "协作：射速（程序）");
  log(`leads: planner ${plannerLead}, coder ${coderLead}`);

  // 1. The 协作, its 已定的事 1 (a 事项 the person opens and settles), both 主控 brought in as 主控.
  const c = await people.策划.createCowork({ title: TITLE, goal: GOAL, repo: "fire-rate", branch: "master", members: ["程序"] });
  const d1 = await people.策划.openMatter(c.id, { title: "射速口径", body: DECISION_1, side: "策划" });
  await people.策划.patchMatter(c.id, d1.matter.id, { conclusion: DECISION_1 });
  log(`cowork ${c.id}; 已定的事 1 from 事项 ${d1.matter.no}`);
  for (const [sid, host, label] of [[plannerLead, hosts.planner, "策划主控"], [coderLead, hosts.coder, "程序主控"]]) {
    // The Host reads the account a moment after it starts: retry while it says it is not signed in yet.
    let j;
    for (let i = 0; ; i++) {
      try {
        j = await host.api("POST", "/api/cowork/join", { sessionId: sid, coworkId: c.id, label, role: "lead" });
        break;
      } catch (err) {
        if (i > 40 || !/登录/.test(err.message)) throw err;
        await sleep(500);
      }
    }
    sessions.get(sid).mark = j.mark;
    log(`${label} joined as ${j.name} (${j.mark}, ${j.role ?? "?"})`);
  }

  if (dry) {
    stopping = "dry run: set up, no model turn";
    const d = await people.策划.cowork(c.id);
    log(`agents: ${d.cowork.agents.map((a) => `${a.name} ${a.role} ${a.state}`).join(", ")}`);
    log(`matters: ${(d.cowork.matters ?? []).map((m) => `事项 ${m.no} ${m.status}`).join(", ")}; decisions: ${d.events.filter((e) => e.kind === "decision").length}`);
    for (const [sid, s] of sessions) {
      const ws = await s.host.api("GET", `/api/sessions/${sid}/ref`).catch((e) => ({ error: String(e.message) }));
      log(`${s.who} lead ref: ${JSON.stringify(ws).slice(0, 200)}`);
    }
    throw Object.assign(new Error("dry"), { dry: true });
  }

  const say = async (sid, text, note) => {
    const s = sessions.get(sid);
    countTurn(`cowork scenario ${runName}: ${note}`, MODELS[s.model].budget);
    s.counted++;
    turnLog.push({ at: Date.now() - t0, session: sid, role: s.role, model: s.model, why: note });
    await s.host.api("POST", `/api/sessions/${sid}/messages`, { text });
    act(s.who === "planner" ? "策划" : "程序", note);
  };
  // The coder's brief first (its 主控 reads and waits), then the planner's.
  await say(coderLead, coderBrief(workerProfile.label), "程序 briefs their 主控");
  await say(plannerLead, plannerBrief(), "策划 briefs their 主控");

  // ---- watch
  const answered = new Set();
  let noAtDone = false;
  let told120 = false;
  let noticeDone = false;
  let noticeSeenAt = 0;
  let quietSince = 0;
  const deadline = t0 + maxMinutes * 60_000;
  const lastStatus = new Map();
  const turnCount = () => [...sessions.values()].reduce((n, s) => n + s.counted, 0);

  while (!stopping) {
    await sleep(2000);
    // Sessions (an 执行 appears when the 主控 starts one) and their turns.
    for (const host of [hosts.planner, hosts.coder]) {
      const state = await host.api("GET", "/api/state");
      for (const x of state.sessions) {
        if (!sessions.has(x.id)) {
          const p = state.profiles.find((pp) => pp.id === x.profileId);
          const model = p?.id === workerProfile.id ? workerModel : leadModel;
          sessions.set(x.id, { who: host.who, host, model, role: "worker?", counted: 0, seen: 0, sessionId: x.id, profile: p?.label });
          log(`new session on ${host.who}: ${x.id} (${p?.label ?? x.profileId}) «${x.title}»`);
        }
        const s = sessions.get(x.id);
        s.status = x.status;
      }
    }
    for (const [sid, s] of sessions) {
      const turnItems = (await s.host.api("GET", `/api/sessions/${sid}/items`)).filter((i) => i.type === "turn");
      const auto = Math.max(0, turnItems.length - s.counted);
      for (let i = 0; i < auto; i++) {
        countTurn(`cowork scenario ${runName}: ${s.who} ${s.role} turn the Host started`, MODELS[s.model].budget);
        s.counted++;
        turnLog.push({ at: Date.now() - t0, session: sid, role: s.role, model: s.model, why: "Host" });
        log(`${s.who} ${s.role} (${s.model}) started a turn by itself (#${turnItems.length})`);
      }
    }
    if (turnCount() >= maxTurns) {
      stopping = `turn cap ${maxTurns} reached`;
      break;
    }
    if (Date.now() > deadline) {
      stopping = `time cap ${maxMinutes} min reached`;
      break;
    }

    const detail = await people.策划.cowork(c.id);
    const cw = detail.cowork;
    for (const a of cw.agents) for (const [sid, s] of sessions) if (a.mark.endsWith(sid)) {
      s.mark = a.mark;
      s.role = a.role ?? "unassigned";
      s.matter = a.matter ?? null;
    }
    const matters = cw.matters ?? [];
    for (const m of matters) {
      const key = `${m.status}|${m.waitingOn.join(",")}|${m.blocker ?? ""}`;
      if (lastStatus.get(m.id) !== key) {
        lastStatus.set(m.id, key);
        timeline.push({ at: Date.now() - t0, no: m.no, title: m.title, side: m.side, status: m.status, waitingOn: m.waitingOn, blocker: m.blocker });
        log(`事项 ${m.no}「${m.title}」→ ${m.status}${m.waitingOn.length ? ` 等 ${m.waitingOn.join("、")}` : ""}${m.blocker ? ` 卡在 ${m.blocker}` : ""}`);
      }
    }
    const feed = (await people.策划.coworkFeed(c.id, 0)).messages;

    // 3. Once an AI spoke in the 群聊: a line without @.
    if (!noAtDone && feed.some((m) => m.via?.kind === "ai" && m.threadId === c.id && m.kind === "text")) {
      noAtDone = true;
      const r = await people.策划.postCowork(c.id, { kind: "text", body: "（顺便说一下：配置表以后可能还会加 minRate，这次先不用做。）" });
      marks.noAt = r.message?.seq;
      act("策划", `said something in the 群聊 without @ (#${marks.noAt})`);
    }
    // 4. A 事项 waiting on a person: they answer in it.
    for (const m of matters) {
      if (m.status !== "confirm" || answered.has(`${m.id}:${m.version}`)) continue;
      const person = m.waitingOn.map((p) => (p.startsWith("person:") ? p.slice(7) : null)).find((p) => p && people[p]);
      if (!person) continue;
      answered.add(`${m.id}:${m.version}`);
      await sleep(3000);
      const msgs = (await people[person].messages(m.id, 0)).messages;
      const first = msgs.find((x) => x.kind !== "event");
      const body = answerFor(person, m, first?.body);
      const r = await people[person].postCowork(c.id, { kind: "text", threadId: m.id, body, ...(first ? { replyTo: first.seq } : {}) });
      act(person, `answered 事项 ${m.no}「${m.title}」: ${body} (#${r.message?.seq})`);
    }
    // 5. The implementation got far enough: 程序 tells their 主控 the cap should be 120. Any 事项 but the 口径 one and gates
    // (an AI opens 事项 on its own side only, so the planner's 主控 delegating the work leaves it on the 策划 side).
    if (!told120 && matters.some((m) => m.id !== d1.matter.id && !m.gate && ["pushed", "review", "verified"].includes(m.status))) {
      told120 = true;
      await say(coderLead, CODER_120, "程序 asks their 主控 for 120 (the other side's 口径)");
    }
    // 6. 120 settled: 策划 知会 程序 in the 群聊; 程序 looks a few seconds later.
    if (!noticeDone && detail.events.some((e) => e.kind === "decision" && /120/.test(e.text ?? ""))) {
      noticeDone = true;
      const r = await people.策划.postCowork(c.id, { kind: "text", body: "知会一下：射速上限改成允许 1–120 了（见已定的事），测试服可以按这个配。", notice: ["程序"] });
      marks.notice = r.message?.seq;
      noticeSeenAt = Date.now() + 8000;
      act("策划", `知会 程序 in the 群聊 (#${marks.notice})`);
    }
    if (noticeSeenAt && Date.now() > noticeSeenAt && marks.notice) {
      noticeSeenAt = 0;
      await people.程序.markCowork(c.id, { mark: "seen", seqs: [marks.notice] }).catch((e) => log(`mark seen failed: ${e.message}`));
      act("程序", `marked the 知会 #${marks.notice} 看过`);
    }

    // Done?
    const busy = [...sessions.values()].some((s) => s.status === "running" || s.status === "starting") || detail.deliveries.some((d) => d.state === "queued");
    const open = matters.filter((m) => m.status !== "closed");
    let masterHasIt = false;
    try {
      masterHasIt = /maxRate/.test(execFileSync("git", ["--git-dir", repo.origin, "show", "master:src/rate.js"], { encoding: "utf8" }));
    } catch {
      // not yet
    }
    if (busy) quietSince = 0;
    else if (!quietSince) quietSince = Date.now();
    else if (!open.length && masterHasIt && Date.now() - quietSince > 60_000) stopping = "done: every 事项 closed, master has it, quiet 60 s";
    else if (Date.now() - quietSince > 180_000) stopping = `quiet 3 min with ${open.length} 事项 open${masterHasIt ? "" : ", master without the change"}`;
  }
  log(`stopping: ${stopping}`);
  for (const [sid, s] of sessions) await s.host.api("POST", `/api/sessions/${sid}/interrupt`).catch(() => undefined);
  await sleep(1500);

  // ---- what happened
  const detail = await people.程序.cowork(c.id);
  const cw = detail.cowork;
  const feed = (await people.程序.coworkFeed(c.id, 0)).messages;
  const threads = {};
  for (const m of cw.matters ?? []) threads[m.id] = (await people.程序.messages(m.id, 0)).messages;
  const allMsgs = [...feed, ...Object.values(threads).flat()];
  const seqDup = new Set();
  const msgs = allMsgs.filter((m) => (seqDup.has(m.id) ? false : (seqDup.add(m.id), true))).sort((a, b) => a.seq - b.seq);
  const matterEvents = {};
  for (const m of cw.matters ?? []) matterEvents[m.no] = (await people.程序.matterEvents(c.id, m.id).catch(() => ({ events: [] }))).events;
  const pendingEnd = {};
  for (const [name, client] of Object.entries(people)) {
    const own = await client.coworkPending({ coworkId: c.id }).catch((e) => ({ error: e.message }));
    pendingEnd[name] = own.lists ? own.lists.flatMap((l) => l.items.map((i) => `${l.party}: ${i.kind} ${i.text}`)) : own;
  }
  for (const [sid, s] of sessions) {
    if (!s.mark) continue;
    const owner = s.who === "planner" ? people.策划 : people.程序;
    const p = await owner.coworkPending({ coworkId: c.id, party: `agent:${s.mark}` }).catch((e) => ({ error: e.message }));
    pendingEnd[`${s.who} ${s.role}`] = p.lists ? p.lists.flatMap((l) => l.items.map((i) => `${i.kind} ${i.text}`)) : p;
  }
  const perSession = {};
  for (const [sid, s] of sessions) {
    const list = await s.host.api("GET", `/api/sessions/${sid}/items`);
    writeFileSync(path.join(outDir, `${s.who}-${s.role}-${sid.slice(0, 10)}-items.json`), JSON.stringify(list, null, 1));
    const toolItems = list.filter((x) => x.type === "tool");
    const tools = {};
    for (const i of toolItems) {
      const m = /(cowork_\w+|session_\w+|amo_whoami)/.exec(i.name ?? "");
      const key = m ? m[1] : i.kind ?? "other";
      tools[key] = (tools[key] ?? 0) + 1;
    }
    // A tool item that failed carries the Host's sentence in `detail`.
    const refused = toolItems.filter((i) => /cowork_|session_/.test(i.name ?? "") && i.status === "failed").map((i) => ({ name: i.name, input: String(i.input ?? "").slice(0, 300), output: String(i.detail ?? "").slice(0, 300) }));
    const mine = msgs.filter((m) => m.via?.kind === "ai" && s.mark && m.via.conv === s.mark);
    const delivered = detail.deliveries.filter((d) => d.agent === s.mark);
    const turnItems = list.filter((i) => i.type === "turn");
    perSession[sid] = {
      who: s.who,
      role: s.role,
      matter: s.matter ? `事项 ${(cw.matters ?? []).find((x) => x.id === s.matter)?.no ?? "?"}` : null,
      model: s.model,
      profile: s.profile,
      turns: turnItems.map((t) => ({ state: t.state, ms: t.endedAt && t.startedAt ? Date.parse(t.endedAt) - Date.parse(t.startedAt) : null, usage: t.usage ?? null, error: t.error ?? null })),
      tools,
      refused,
      messages: mine.map((m) => ({ seq: m.seq, where: m.threadId === c.id ? "群聊" : `事项 ${(cw.matters ?? []).find((x) => x.id === m.threadId)?.no ?? "?"}`, kind: m.kind, mentions: m.mentions ?? [], agentMentions: m.agentMentions ?? [], basis: m.basis ?? null, notice: m.notice ?? null, commits: m.commits ?? null, verify: m.verify ?? null, body: m.body.slice(0, 300) })),
      deliveries: delivered.map((d) => ({ seq: d.seq, reason: d.reason, state: d.state, from: d.fromAgent ? `${d.from} 的 AI` : d.from })),
    };
  }
  const log2 = git(repo.coder, "--git-dir", repo.origin, "log", "--all", "--format=%h %an %ci %s");
  const branches = git(repo.coder, "--git-dir", repo.origin, "for-each-ref", "--format=%(refname:short) %(objectname:short)", "refs/heads");
  // 已验 checked again: npm test at each commit bound to a verified / closed 事项, and at master.
  const checked = [];
  for (const m of cw.matters ?? []) for (const commit of m.bindings?.commits ?? []) if (["verified", "closed"].includes(m.status) || m.history.some((h) => h.to === "verified")) checked.push({ no: m.no, ...testAt(repo.origin, commit) });
  checked.push({ no: "master", ...testAt(repo.origin, "master") });
  const result = {
    run: runName,
    lead: leadModel,
    worker: workerModel,
    notes: [leadModel, workerModel].filter((m) => MODELS[m].note).map((m) => `${m}：${MODELS[m].note}`),
    patrolSec,
    stopped: stopping,
    minutes: +((Date.now() - t0) / 60_000).toFixed(1),
    turnsCounted: turnCount(),
    actions,
    marks,
    timeline,
    turnLog,
    perSession,
    matters: (cw.matters ?? []).map((m) => ({ no: m.no, title: m.title, side: m.side, kind: m.kind, gate: m.gate, status: m.status, waitingOn: m.waitingOn, blocker: m.blocker, conclusion: m.conclusion, bindings: m.bindings, history: m.history.map((h) => ({ at: h.at - t0, from: h.from, to: h.to, by: h.by, note: h.note, event: h.event, seq: h.seq ?? null, manual: h.manual === true })), limited: m.limited })),
    matterEvents,
    decisions: detail.events.filter((e) => e.kind === "decision").map((e) => e.text),
    events: detail.events.map((e) => ({ at: e.createdAt ? e.createdAt - t0 : null, kind: e.kind, actor: e.actor, agent: e.agent, text: e.text })),
    deliveries: detail.deliveries.map((d) => ({ seq: d.seq, agent: d.agent, reason: d.reason, state: d.state, from: d.from })),
    pendingEnd,
    commits: log2.split("\n"),
    branches: branches.split("\n"),
    checked,
    messages: msgs.map((m) => ({ seq: m.seq, at: m.createdAt - t0, where: m.threadId === c.id ? "群聊" : `事项 ${(cw.matters ?? []).find((x) => x.id === m.threadId)?.no ?? m.threadId}`, who: m.via?.kind === "ai" ? `${m.author} 的 AI（${[...sessions.values()].find((s) => s.mark === m.via.conv)?.role ?? "?"}）` : m.author, kind: m.kind, mentions: m.mentions ?? [], agentMentions: m.agentMentions ?? [], basis: m.basis ?? null, notice: m.notice ?? null, commits: m.commits ?? null, verify: m.verify ?? null, replyTo: m.replyTo ?? null, body: m.body.slice(0, 600) })),
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
  log(`sandbox left at ${root} (delete it when done)`);
}
