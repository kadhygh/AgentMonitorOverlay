// AMO 维护记录 (2026-11-11, the user: 本地最好有一个维护记录，这样我每次开启的时候，它可以自动增加轮次，issue 也自动迭代版本):
// the rounds of AMO's maintenance and what each did, numbered R<round>-<n> so a session can carry it in its name
// (「R12-3 · 修 Focus 闪烁」, session_rename). Local only, never in git: it lives in this repository's git folder
// (`.git/amo-maint.json`), which the main checkout, the 值守 directory and the 打包 directory share.
//   node scripts/maint.mjs [show] [R12 | R12-3] [--all] [--json]
//                                    the round going on (or that one, or that item); --all: every round
//   node scripts/maint.mjs round start [--n <number>] [--note <text>]
//                                    a new round: the last one ends (what it left open is listed), this one is N+1 (--n: the
//                                    number, for the first one); prints 「第 N 轮」
//   node scripts/maint.mjs item add <bug|small|feature|issue> <title> [--issue <n>] [--session <id>] [--note <text>]
//                                    an item of the round going on; prints its number (R12-3)
//   node scripts/maint.mjs item set <R12-3> [--status doing|asking|done|parked|dropped] [--title <t>] [--issue <n>]
//                                    [--session <id>] [--commit <sha>]… [--note <text>]
//                                    done = committed into master; 已发布 is set by release.mjs (noteRelease below) with the
//                                    versions the item's commits went out in — its --commit ones and those naming it (R12-3)
// Several sessions write it at once: every change takes a lock (`amo-maint.lock` beside it) and writes a new file whole.
import { execFileSync } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The repository's root: release.mjs's tool paths (studio/packages/…) are from there.
const repo = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const git = (...a) => execFileSync("git", a, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const gitOk = (...a) => {
  try {
    git(...a);
    return true;
  } catch {
    return false;
  }
};

/** The record's file: AMO_MAINT_FILE (the tests), else the shared git folder's amo-maint.json. */
export const recordFile = () => process.env.AMO_MAINT_FILE || join(git("rev-parse", "--path-format=absolute", "--git-common-dir"), "amo-maint.json");

export const KINDS = { bug: "修 bug", small: "小需求", feature: "新功能", issue: "问题页" };
export const STATUSES = { doing: "进行中", asking: "待确认", done: "做完", released: "已发布", parked: "搁置", dropped: "放弃" };
/** Still open when a round ends. */
const OPEN = new Set(["doing", "asking", "parked"]);

export function load(file = recordFile()) {
  if (!existsSync(file)) return { version: 1, rounds: [] };
  return JSON.parse(readFileSync(file, "utf8"));
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Runs `change` on the record under the lock and writes it; returns what `change` returns. */
export function mutate(change, file = recordFile()) {
  const lock = `${file}.lock`.replace(/\.json\.lock$/, ".lock");
  let fd;
  for (let i = 0; fd === undefined; i++) {
    try {
      fd = openSync(lock, "wx");
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      // A writer that died holding it: a change takes milliseconds.
      try {
        if (Date.now() - statSync(lock).mtimeMs > 30_000) rmSync(lock, { force: true });
      } catch {
        // Gone meanwhile.
      }
      if (i > 100) throw new Error(`维护记录被锁着（${lock}），过一会儿再试`);
      sleep(100);
    }
  }
  try {
    const record = load(file);
    const out = change(record);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`);
    renameSync(tmp, file);
    return out;
  } finally {
    closeSync(fd);
    rmSync(lock, { force: true });
  }
}

const now = () => new Date().toISOString();
const current = (record) => {
  const r = record.rounds.at(-1);
  return r && !r.endedAt ? r : undefined;
};
const parseId = (id) => {
  const m = /^R(\d+)-(\d+)$/i.exec(String(id ?? "").trim());
  if (!m) throw new Error(`编号写成 R12-3 这样：${id ?? "（没给）"}`);
  return { round: Number(m[1]), n: Number(m[2]) };
};
function findItem(record, id) {
  const { round, n } = parseId(id);
  const r = record.rounds.find((x) => x.n === round);
  const item = r?.items.find((x) => x.id === `R${round}-${n}`);
  if (!item) throw new Error(`没有 ${id}`);
  return { r, item };
}
/** A commit as its full hash (HEAD, a short one…). */
const resolveCommit = (c) => {
  try {
    return git("rev-parse", "--verify", "-q", `${c}^{commit}`);
  } catch {
    throw new Error(`git 不认识这个提交：${c}`);
  }
};

export function startRound(record, { n, note } = {}) {
  const last = record.rounds.at(-1);
  const at = now();
  const left = last && !last.endedAt ? last.items.filter((i) => OPEN.has(i.status)) : [];
  if (last && !last.endedAt) last.endedAt = at;
  const number = n !== undefined ? Number(n) : (last?.n ?? 0) + 1;
  if (!Number.isInteger(number) || number < 1) throw new Error(`轮次要是正整数：${n}`);
  if (record.rounds.some((r) => r.n === number)) throw new Error(`已经有第 ${number} 轮了`);
  if (last && number < last.n) throw new Error(`轮次只能往上加：上一轮是第 ${last.n} 轮`);
  const round = { n: number, startedAt: at, endedAt: null, ...(note ? { note } : {}), items: [] };
  record.rounds.push(round);
  return { round, ended: last && last.endedAt === at ? last : undefined, left };
}

export function addItem(record, { kind, title, issue, session, note }) {
  const r = current(record);
  if (!r) throw new Error("现在没有在进行的一轮：先 node scripts/maint.mjs round start");
  if (!KINDS[kind]) throw new Error(`种类是 ${Object.keys(KINDS).join(" / ")} 之一：${kind ?? "（没给）"}`);
  const t = String(title ?? "").trim();
  if (!t) throw new Error("要写做的是什么（标题）");
  const at = now();
  const item = { id: `R${r.n}-${r.items.length + 1}`, kind, title: t, status: "doing", ...(issue ? { issue: Number(issue) } : {}), ...(session ? { session } : {}), commits: [], released: {}, notes: note ? [{ at, text: note }] : [], createdAt: at, updatedAt: at };
  r.items.push(item);
  return item;
}

export function setItem(record, id, { status, title, issue, session, commits = [], note }) {
  const { item } = findItem(record, id);
  if (status !== undefined) {
    if (!STATUSES[status]) throw new Error(`状态是 ${Object.keys(STATUSES).join(" / ")} 之一：${status}`);
    item.status = status;
  }
  if (title !== undefined && String(title).trim()) item.title = String(title).trim();
  if (issue !== undefined) item.issue = Number(issue);
  if (session !== undefined) item.session = session;
  for (const c of commits) {
    const sha = resolveCommit(c);
    if (!item.commits.includes(sha)) item.commits.push(sha);
  }
  item.updatedAt = now();
  if (note) item.notes.push({ at: item.updatedAt, text: note });
  return item;
}

/**
 * release.mjs, after a build went out (`sha`, the tools in `done`: [{ label, version, paths }]): each item whose commits
 * are in it and touch a tool that went out gets that tool's version; a 做完 one becomes 已发布. Its commits are those
 * given with --commit and those whose message names it (R12-3), since its round began. Returns the items it changed.
 */
export function noteRelease(record, sha, done) {
  const changed = [];
  for (const r of record.rounds)
    for (const item of r.items) {
      if (item.status === "dropped") continue;
      const named = git("log", "-E", `--grep=(^|[^0-9A-Za-z-])${item.id}([^0-9]|$)`, `--since=${r.startedAt}`, "--format=%H", sha).split("\n").filter(Boolean);
      const commits = [...new Set([...item.commits, ...named])].filter((c) => gitOk("merge-base", "--is-ancestor", c, sha));
      let hit = false;
      for (const t of done) {
        if (item.released[t.label]) continue;
        if (!commits.some((c) => git("diff-tree", "--no-commit-id", "--name-only", "-r", c, "--", ...t.paths) !== "")) continue;
        item.released[t.label] = t.version;
        hit = true;
      }
      for (const c of named) if (!item.commits.includes(c)) item.commits.push(c);
      if (!hit) continue;
      // One still 进行中 may have more to come: it keeps its status, the version is noted.
      if (item.status === "done") item.status = "released";
      item.updatedAt = now();
      changed.push(item);
    }
  return changed;
}

// ---- showing it

const day = (iso) => {
  const d = new Date(iso);
  const p = (x) => String(x).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
/** Pads to `w` columns of a terminal, where a Chinese character takes two. */
const pad = (text, w) => text + " ".repeat(Math.max(0, w - [...text].reduce((n, c) => n + (c.codePointAt(0) > 0x2e80 ? 2 : 1), 0)));
export const itemLine = (i) =>
  [
    pad(i.id, 7),
    pad(KINDS[i.kind], 6),
    pad(STATUSES[i.status] ?? i.status, 6),
    i.title,
    i.issue ? `#${i.issue}` : "",
    i.commits.length ? i.commits.map((c) => c.slice(0, 8)).join(" ") : "",
    Object.entries(i.released).map(([t, v]) => `${t} ${v}`).join("、"),
  ]
    .filter(Boolean)
    .join("  ");
const count = (items) => {
  const by = {};
  for (const i of items) by[i.status] = (by[i.status] ?? 0) + 1;
  return Object.entries(by).map(([s, k]) => `${k} ${STATUSES[s] ?? s}`).join("、");
};
export function roundText(r, full = true) {
  const head = `第 ${r.n} 轮（${day(r.startedAt)} 起${r.endedAt ? `，${day(r.endedAt)} 结束` : "，进行中"}）· ${r.items.length} 项${r.items.length ? `：${count(r.items)}` : ""}${r.note ? `\n  ${r.note}` : ""}`;
  return full ? [head, ...r.items.map((i) => `  ${itemLine(i)}`)].join("\n") : head;
}

function show(record, what, { all, json }) {
  if (what && /-/.test(what)) {
    const { item } = findItem(record, what);
    if (json) return console.log(JSON.stringify(item, null, 2));
    console.log(itemLine(item));
    if (item.session) console.log(`  会话 ${item.session}`);
    for (const n of item.notes) console.log(`  ${day(n.at)}  ${n.text}`);
    return;
  }
  const rounds = what ? record.rounds.filter((r) => `R${r.n}` === what.toUpperCase()) : all ? record.rounds : record.rounds.slice(-1);
  if (what && !rounds.length) throw new Error(`没有 ${what}`);
  if (json) return console.log(JSON.stringify(what || !all ? rounds[0] ?? null : record, null, 2));
  if (!record.rounds.length) return console.log(`还没有维护记录。开第一轮：node scripts/maint.mjs round start [--n <轮次>]（记录在 ${recordFile()}）`);
  console.log(rounds.map((r) => roundText(r)).join("\n\n"));
  if (!all && !what && !current(record)) console.log("\n（这一轮已经结束：round start 开新的一轮）");
}

// ---- the command line

function parse(argv) {
  const opts = { commits: [] };
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--all" || a === "--json") opts[a.slice(2)] = true;
    else if (a === "--commit") opts.commits.push(argv[++i]);
    else if (a.startsWith("--")) opts[a.slice(2)] = argv[++i];
    else pos.push(a);
  }
  return { pos, opts };
}

function main(argv) {
  const { pos, opts } = parse(argv);
  const [cmd = "show", sub, ...more] = pos;
  if (cmd === "show") return show(load(), sub, opts);
  if (/^R\d+/i.test(cmd)) return show(load(), cmd, opts);
  if (cmd === "round" && sub === "start") {
    const { round, ended, left } = mutate((r) => startRound(r, opts));
    if (ended) console.log(`第 ${ended.n} 轮结束：${ended.items.length} 项${ended.items.length ? `（${count(ended.items)}）` : ""}`);
    if (left.length) console.log(`它留下没做完的（还在第 ${ended.n} 轮里，要接着做就在这一轮重新 item add）：\n${left.map((i) => `  ${itemLine(i)}`).join("\n")}`);
    return console.log(`第 ${round.n} 轮`);
  }
  if (cmd === "item" && sub === "add") {
    const [kind, ...title] = more;
    const item = mutate((r) => addItem(r, { kind, title: title.join(" "), ...opts }));
    return console.log(item.id);
  }
  if (cmd === "item" && sub === "set") {
    const item = mutate((r) => setItem(r, more[0], opts));
    return console.log(itemLine(item));
  }
  throw new Error(`不认识：${argv.join(" ")}（用法在 scripts/maint.mjs 开头）`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}
