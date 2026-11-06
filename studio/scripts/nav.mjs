#!/usr/bin/env node
// The navigation index (2026-11-06, plans/doc-architecture.md): where a feature lives, which places a common change
// touches, literal anchors in the code, and which document to read next. No implementation details — those are the
// code, its tests and CHANGELOG. Topics are the JSON files in studio/docs/nav/; scripts/nav.test.mjs checks that
// every anchor still points at something.
//
//   node scripts/nav.mjs                      the catalog, one line per topic
//   node scripts/nav.mjs --query 远程 额度      topics matching the words (label, aliases, purpose, steps); the best
//                                               two in full, the rest one line each
//   node scripts/nav.mjs --id studio.remote   one topic in full, with its related topics one line each
//
// Nothing found is not "AMO does not have it": search the code, and when it is a gap, add a topic.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
/** Paths in topics are relative to the repository root (they start with studio/ or .github/). */
export const REPO = resolve(here, "..", "..");
export const NAV_DIR = join(REPO, "studio", "docs", "nav");

export const CATEGORIES = ["workflow", "flow", "host", "runtime", "app", "ui", "tool", "infra"];
const CATEGORY_LABEL = { workflow: "常见改动", flow: "跨模块流程", host: "Studio · Host", runtime: "Studio · runtime", app: "Studio · 外壳", ui: "Studio · 界面", tool: "其他工具", infra: "发布、测试、文档" };
const TOPIC_KEYS = ["id", "label", "aliases", "category", "purpose", "steps", "anchors", "related", "next"];
const ANCHOR_KEYS = ["label", "path", "anchor"];

/** Every topic of every docs/nav/*.json, each with the file it came from (`file`). Throws on JSON that does not parse. */
export function loadTopics(dir = NAV_DIR) {
  const topics = [];
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) {
    const doc = JSON.parse(readFileSync(join(dir, name), "utf8").replace(/^﻿/, ""));
    for (const t of Array.isArray(doc?.topics) ? doc.topics : []) topics.push({ ...t, file: `docs/nav/${name}` });
    if (doc?.schemaVersion !== 1 || !Array.isArray(doc?.topics)) topics.push({ id: `<${name}>`, file: `docs/nav/${name}`, broken: "文件要是 { \"schemaVersion\": 1, \"topics\": [...] }" });
  }
  return topics;
}

const text = (v) => typeof v === "string" && v.trim() !== "";
const strings = (v) => Array.isArray(v) && v.every(text);
const repoPath = (p) => text(p) && !p.startsWith("/") && !p.includes("\\") && !/^[A-Za-z]:/.test(p) && !p.split("/").includes("..");

/** What is wrong with the topics' shape: fields, ids, categories, related ids. One line per problem, saying where and how to fix it. */
export function shapeProblems(topics) {
  const out = [];
  const ids = new Map();
  for (const t of topics) {
    const at = `${t.file} 主题 ${t.id ?? "(没有 id)"}`;
    if (t.broken) { out.push(`${t.file}：${t.broken}`); continue; }
    for (const k of Object.keys(t)) if (k !== "file" && !TOPIC_KEYS.includes(k)) out.push(`${at}：不认识的字段 ${k}（只能有 ${TOPIC_KEYS.join("、")}）`);
    if (!text(t.id) || !/^[a-z]+\.[a-z][A-Za-z0-9]*$/.test(t.id)) out.push(`${at}：id 要写成「类别.名字」，例如 studio.remote`);
    else if (ids.has(t.id.toLowerCase())) out.push(`${at}：id 和 ${ids.get(t.id.toLowerCase())} 里的重复了，改一个`);
    else ids.set(t.id.toLowerCase(), t.file);
    if (!text(t.label)) out.push(`${at}：缺 label`);
    if (!text(t.purpose)) out.push(`${at}：缺 purpose（一两句：管什么、在哪）`);
    if (!CATEGORIES.includes(t.category)) out.push(`${at}：category 要是 ${CATEGORIES.join(" / ")} 之一`);
    if (!strings(t.aliases)) out.push(`${at}：aliases 要是字符串数组`);
    if (!strings(t.related)) out.push(`${at}：related 要是主题 id 的数组（没有就写 []）`);
    if (!strings(t.next) || t.next.length === 0) out.push(`${at}：next 至少写一份下一步读的文档或代码（仓库根目录起的路径）`);
    if (t.steps !== undefined && (!strings(t.steps) || t.steps.length === 0 || t.steps.length > 12)) out.push(`${at}：steps 是 1～12 条字符串`);
    if (!Array.isArray(t.anchors) || t.anchors.length === 0) out.push(`${at}：至少要有一个锚点`);
    for (const a of Array.isArray(t.anchors) ? t.anchors : []) {
      for (const k of Object.keys(a ?? {})) if (!ANCHOR_KEYS.includes(k)) out.push(`${at}：锚点里不认识的字段 ${k}（只能有 label、path、anchor）`);
      if (!repoPath(a?.path)) out.push(`${at}：锚点的 path「${a?.path}」要是仓库根目录起的相对路径，用 /`);
      if (a?.anchor !== undefined && !text(a.anchor)) out.push(`${at}：锚点「${a.path}」的 anchor 是空的：删掉这个字段，或写文件里的一段原文`);
    }
    for (const p of Array.isArray(t.next) ? t.next : []) if (!repoPath(p)) out.push(`${at}：next 的「${p}」要是仓库根目录起的相对路径，用 /`);
  }
  for (const t of topics) for (const r of Array.isArray(t.related) ? t.related : []) {
    if (!ids.has(String(r).toLowerCase())) out.push(`${t.file} 主题 ${t.id}：related 里的 ${r} 不存在：改成现有的 id（node scripts/nav.mjs 列目录），或删掉`);
    if (r === t.id) out.push(`${t.file} 主题 ${t.id}：related 里写了自己`);
  }
  return out;
}

const cache = new Map();
function read(path) {
  if (!cache.has(path)) {
    const full = join(REPO, path);
    cache.set(path, existsSync(full) && statSync(full).isFile() ? readFileSync(full, "utf8") : existsSync(full) ? "" : null);
  }
  return cache.get(path);
}

/** The 1-based line of an anchor in its file, 0 when the anchor is not there, null when the file (or folder) is not there. */
export function anchorLine(a) {
  const content = read(a.path);
  if (content === null) return null;
  if (!a.anchor) return 1;
  const i = content.indexOf(a.anchor);
  return i < 0 ? 0 : content.slice(0, i).split("\n").length;
}

/** Anchors and next paths that point at nothing. One line per problem, with the fix. */
export function anchorProblems(topics) {
  const out = [];
  for (const t of topics) {
    if (t.broken) continue;
    for (const a of t.anchors ?? []) {
      const line = anchorLine(a);
      if (line === null) out.push(`${t.file} 主题 ${t.id}：锚点「${a.label ?? a.path}」的文件 ${a.path} 不在了：改指到现在的文件（git log --follow 找它去哪了），或删掉这条锚点`);
      else if (line === 0) out.push(`${t.file} 主题 ${t.id}：锚点「${a.label ?? a.path}」在 ${a.path} 里找不到「${a.anchor}」：改成现在代码里的原文（函数名、类名），或删掉这条锚点`);
    }
    for (const p of t.next ?? []) if (read(p) === null) out.push(`${t.file} 主题 ${t.id}：next 的 ${p} 不在了：改成现在的路径（方案做完会挪进 plans/done/），或删掉`);
  }
  return out;
}

/** Topics for a query: an exact id / label / alias first; otherwise ranked by how much of the query they cover. */
export function search(topics, query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const names = (t) => [t.id, t.label, ...(t.aliases ?? [])].map((s) => s.toLowerCase());
  const exact = topics.filter((t) => names(t).includes(q));
  if (exact.length) return exact;
  const words = q.split(/\s+/).filter(Boolean);
  const scored = topics.map((t) => {
    const hay = [t.id, t.label, t.purpose, ...(t.aliases ?? []), ...(t.steps ?? [])].join(" ").toLowerCase();
    let score = 0;
    for (const w of words) if (hay.includes(w)) score += 3;
    // A query in Chinese is often one run of characters ("被控端额度推送频率"): a name inside it counts too.
    for (const n of names(t)) if (n.length >= 2 && q.includes(n)) score += 2 + Math.min(n.length, 6);
    return { t, score };
  });
  return scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score).map((s) => s.t);
}

const oneLine = (t) => `${t.id}  ${t.label}`;
// 2026-11-06's comparison: one of the three agents answered from the index alone, without opening a line of code.
// The index can be stale or leave a place out; the code is what counts.
const READ_ON = "索引只指路：回答或动手前，至少打开上面一处代码或「下一步读」核对；和代码对不上的，以代码为准并顺手改主题。";

function full(t) {
  const lines = [`## ${t.id}  ${t.label}  （${CATEGORY_LABEL[t.category] ?? t.category}，${t.file}）`, t.purpose];
  if (t.steps?.length) lines.push(t.category === "flow" ? "经过哪些地方：" : "要改的地方：", ...t.steps.map((s, i) => `  ${i + 1}. ${s}`));
  lines.push("代码：");
  for (const a of t.anchors ?? []) {
    const line = anchorLine(a);
    const where = line === null ? `${a.path}（文件不在了）` : line === 0 ? `${a.path}（找不到「${a.anchor}」）` : a.anchor ? `${a.path}:${line}` : a.path;
    lines.push(`  - ${a.label ? `${a.label}：` : ""}${where}${a.anchor ? `  ${a.anchor}` : ""}`);
  }
  if (t.next?.length) lines.push(`下一步读：${t.next.join("、")}`);
  if (t.related?.length) lines.push(`相关：${t.related.join("、")}`);
  return lines.join("\n");
}

export function render(topics, { id, query } = {}) {
  if (id) {
    const t = topics.find((x) => x.id.toLowerCase() === id.toLowerCase()) ?? search(topics, id)[0];
    if (!t) return `没有主题 ${id}。node scripts/nav.mjs 列目录；找不到不等于没有这个功能，去搜代码。`;
    const rel = (t.related ?? []).map((r) => topics.find((x) => x.id === r)).filter(Boolean);
    return [full(t), ...(rel.length ? ["", "相关主题：", ...rel.map((r) => `  ${oneLine(r)}`)] : []), "", READ_ON].join("\n");
  }
  if (query) {
    const found = search(topics, query);
    if (!found.length) return `「${query}」没有匹配的主题。找不到不等于没有这个功能：去搜代码（git grep），确认是索引的缺口就在 docs/nav/ 补一个主题。`;
    const rest = found.slice(2, 8);
    const blocks = found.slice(0, 2).map(full);
    if (rest.length) blocks.push(["也可能是：", ...rest.map((r) => `  ${oneLine(r)}`)].join("\n"));
    blocks.push(READ_ON);
    return blocks.join("\n\n");
  }
  const lines = [`导航索引：${topics.length} 个主题。--query 关键词 查，--id 主题 看全文。`];
  for (const c of CATEGORIES) {
    const of = topics.filter((t) => t.category === c);
    if (of.length) lines.push("", `${CATEGORY_LABEL[c]}`, ...of.map((t) => `  ${oneLine(t)}`));
  }
  return lines.join("\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(name);
    return i < 0 ? undefined : args.slice(i + 1).filter((a) => !a.startsWith("--")).join(" ");
  };
  const topics = loadTopics();
  const shape = shapeProblems(topics);
  if (shape.length) console.error(`索引本身有问题（npx vitest run scripts/nav.test.mjs 看全部）：\n${shape.slice(0, 5).join("\n")}\n`);
  console.log(render(topics.filter((t) => !t.broken), { id: flag("--id"), query: flag("--query") }));
}
