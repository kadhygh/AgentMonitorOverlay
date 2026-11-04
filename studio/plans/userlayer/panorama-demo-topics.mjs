// 全景 preview, 0.3 (2026-11-03): four topics on one panorama, each a block — the real 「AMO迭代」 (panorama-snapshot.json,
// with its tasks put in the project they are in: the snapshot leaves the project out) and three made up to show what the
// real data does not have yet: 「mining 迭代」 (three projects with status boards of their own fields, the topic's specs on
// its shelf, a spine of 主控 rounds that proposed tasks, points on its board and by the rounds, two things waiting on
// you), 「官网改版」 (one project, two tasks, one spec) and 「美术资源管线」 (a tool and an asset repository with other
// fields, one task done to its goal). Names and numbers are made to look real; the page says 「演示」 all the same.
// Writes panorama-snapshot-topics.json next to this file; run from studio/: node plans/userlayer/panorama-demo-topics.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const snap = JSON.parse(readFileSync(join(here, "panorama-snapshot.json"), "utf8"));
const now = Date.parse(snap.takenAt);
const iso = (t) => new Date(t).toISOString();
const H = 3_600_000;
const ago = (h) => now - h * H;

// 「AMO迭代」: real, with its project named and its description (the topic's, as Studio has it).
const amo = { ...snap.topic, description: "AMO的迭代Topic", workspaceIds: ["ws-amo"] };
for (const t of snap.tasks) t.workspaceId = "ws-amo";
for (const s of snap.sessions) s.workspaceId = "ws-amo";

const topics = [amo];
const workspaces = [{ id: "ws-amo", name: "AgentMonitorOverlay" }];
const docs = [];
const extra = { projects: {}, proposedBy: {}, merges: {}, cards: [] };

function topic(id, title, description, ws, createdH) {
  const t = { id, title, description, workspaceIds: ws.map((w) => w.id), createdAt: iso(ago(createdH)), updatedAt: iso(ago(1)), archivedAt: null };
  topics.push(t);
  workspaces.push(...ws);
  return t;
}

/** A session; `minutes` how long it ran (to now when it still runs or waits). */
function session(id, { task = null, topic = null, ws, title, status = "idle", at, minutes = 60, model = "opus", kind = "main", parentId = null, startedBy, archived = false }) {
  const s = { id, taskId: task, topicId: topic, parentId, kind, runtime: "claude", profileId: "claude-subscription", workspaceId: ws, title, status, writer: "workbench", runtimeRef: null, options: { model }, createdAt: iso(at), updatedAt: iso(status === "idle" || status === "completed" ? at + minutes * 60_000 : now), archivedAt: archived ? iso(at + (minutes + 10) * 60_000) : null };
  if (startedBy) s.startedBy = startedBy;
  snap.sessions.push(s);
  return s;
}

/** A task with its rounds (title and status of each; the last one's status is the task's latest). */
function task(id, tp, ws, title, column, startH, rounds, { proposedBy, stepH = 5, branches = [] } = {}) {
  const at0 = ago(startH);
  snap.tasks.push({ id, title, workspaceId: ws, topicId: tp.id, column, createdAt: iso(at0), updatedAt: iso(ago(Math.max(0.5, startH - rounds.length * stepH))), archivedAt: null });
  if (proposedBy) extra.proposedBy[id] = proposedBy;
  const ids = rounds.map(([t, status = "idle", model = "opus"], i) => session(`${id}-r${i + 1}`, { task: id, ws, title: t, status, at: at0 + i * stepH * H, minutes: 40 + ((i * 37) % 90), model }).id);
  // A branch: [the round it leaves, its title, "fork" | "started", the round it merged back into (optional)].
  for (const [round, t, how, merge] of branches) {
    const from = ids[round - 1];
    if (merge) extra.merges[`${from}-b`] = ids[merge - 1];
    session(`${from}-b`, { task: id, ws, title: t, status: "completed", at: at0 + ((round - 1) * stepH + 1) * H, minutes: 35, model: "sonnet", kind: how === "fork" ? "fork" : "main", parentId: how === "fork" ? from : null, startedBy: how === "fork" ? undefined : from, archived: true });
  }
  return ids;
}

/** The topic's own sessions (主控), one a round, the last one `last`. */
function spine(tp, ws, titles, startH, stepH, last = "idle") {
  return titles.map((t, i) => session(`${tp.id}-lead${i + 1}`, { topic: tp.id, ws, title: t, status: i === titles.length - 1 ? last : "idle", at: ago(startH - i * stepH), minutes: 50 }).id);
}

function doc(tp, id, title, updatedH, body) {
  docs.push({ id, topicId: tp.id, title, updatedAt: iso(ago(updatedH)), body });
}

function board(tp, wsId, status, summary, by, updatedH) {
  extra.projects[`${tp.id}/${wsId}`] = { status, summary, by, updatedAt: iso(ago(updatedH)) };
}

function card(tp, id, type, title, body, atH, { session: sid, needsYou } = {}) {
  extra.cards.push({ id, topicId: tp.id, ...(sid ? { sessionId: sid, taskId: snap.sessions.find((s) => s.id === sid)?.taskId ?? undefined } : {}), type, title, body, at: iso(ago(atH)), ...(needsYou ? { needsYou: true } : {}) });
}

// ── mining 迭代 ──────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const C = { id: "ws-pm-client", name: "project_mining" };
  const S = { id: "ws-pm-server", name: "project_mining_server" };
  const D = { id: "ws-pm-design", name: "project_mining_design" };
  const tp = topic("tp-mining", "mining 迭代", "11 月 20 日出 0.18 测试版：新矿洞玩法、掉落表重构、服务端扩到 3 区", [C, S, D], 9 * 24);
  const lead = spine(tp, C.id, ["定 0.18 的范围和日期", "拆任务：矿洞玩法三端", "看测试服反馈，调优先级", "包体涨了 40MB，安排瘦身", "本周收尾：评审和测试服"], 8 * 24, 36, "running");

  task("task-pm-cave-client", tp, C.id, "新矿洞玩法 · 客户端", "doing", 6 * 24, [["矿洞入口和场景切换"], ["挖矿手感和震屏"], ["层数 UI 接配置表 v3"], ["接掉落服务新接口", "running"]], { proposedBy: lead[1], stepH: 20, branches: [[2, "震屏换个曲线试试", "fork", 4]] });
  const slim = task("task-pm-slim", tp, C.id, "包体瘦身", "doing", 2.5 * 24, [["查包体组成"], ["音效包改成 Vorbis"], ["删掉旧版本 UI 图集", "awaiting-approval"]], { proposedBy: lead[3], stepH: 16 });
  task("task-pm-fps", tp, C.id, "中端机帧率掉到 45", "review", 4 * 24, [["抓 Profiler，定位到粒子"], ["粒子合批，回到 52 fps"]], { proposedBy: lead[2], stepH: 18 });

  const drop = task("task-pm-drop", tp, S.id, "掉落服务重构", "doing", 6 * 24, [["新掉落表结构和接口草案"], ["按权重表走服务端"], ["灰度 10%", "running", "sonnet"]], { proposedBy: lead[1], stepH: 30, branches: [[2, "压测：每秒 2000 次掉落", "started"]] });
  task("task-pm-zone3", tp, S.id, "扩到 3 区", "todo", 1 * 24, [["扩区方案和机器清单"]], { proposedBy: lead[4], stepH: 10 });

  const cfg = task("task-pm-cave-cfg", tp, D.id, "矿洞配置表 v3", "doing", 5.5 * 24, [["层数、矿石分布字段"], ["和客户端对字段名"], ["层数字段要不要改成数组"]], { proposedBy: lead[1], stepH: 30 });
  task("task-pm-drop-review", tp, D.id, "掉落表评审", "review", 3 * 24, [["整理 4 张表的改动"], ["评审意见改完"]], { stepH: 20 });

  board(tp, C.id, [{ label: "当前版本", value: "0.18.0-beta3", tone: "info" }, { label: "包体", value: "1.42 GB（+40 MB）", tone: "warn" }, { label: "中端机帧率", value: "52 fps", tone: "good" }], "包体在瘦身，帧率已回到 52", "专项管理 · 第 5 轮", 2);
  board(tp, S.id, [{ label: "部署环境", value: "测试服 test-2", tone: "info" }, { label: "在线人数", value: "1,284", tone: "good" }, { label: "接口错误率", value: "0.8%", tone: "warn" }], "掉落服务新接口灰度 10%", "专项管理 · 第 5 轮", 2);
  board(tp, D.id, [{ label: "配置表进度", value: "23 / 31 张", tone: "info" }, { label: "待评审", value: "4 张", tone: "warn" }], "矿洞表 v3 等程序确认字段", "专项管理 · 第 5 轮", 3);

  doc(tp, "doc-pm-version", "版本规范", 7 * 24, "版本号：主版本.次版本.修订-阶段（0.18.0-beta3）。每个测试版在测试服停 3 天再提审。\n包体上限 1.4 GB，超了要在专题里说明原因和计划。帧率以中端机（骁龙 778G）为准，不低于 50 fps。");
  doc(tp, "doc-pm-config", "配置表规范", 5 * 24, "配置表放在 project_mining_design/tables，一张表一个 xlsx，导出成 json 由客户端和服务端共用。\n字段名用小写下划线；新增字段先在专题里提，程序确认后再加。改动走评审，评审过的表才能进版本。");
  doc(tp, "doc-pm-commit", "提交规范", 8 * 24, "提交信息：<端>: <做了什么>（client: / server: / design:）。一个提交只做一件事。\n合进 release 分支前跑完冒烟测试；配置表改动附导出后的 json diff。");
  doc(tp, "doc-pm-board", "项目状态牌规范", 6 * 24, "每个项目的状态牌写什么：\n客户端：当前版本、包体、中端机帧率。\n服务端：部署环境、在线人数、接口错误率。\n策划配置：配置表进度、待评审张数。\n超标的标成警告。专项管理任务每轮结束更新一次，写上第几轮。");
  doc(tp, "doc-pm-scope", "0.18 范围说明", 8 * 24, "做：新矿洞玩法（三层）、掉落表重构、服务端扩到 3 区。\n不做：跨服矿洞、新角色。日期：11 月 20 日测试版，11 月 27 日提审。");

  card(tp, "card-pm-noxserver", "decision", "0.18 不做跨服矿洞", "跨服要改匹配和存档，两周做不完，放到 0.19。", 7 * 24 + 20, { session: lead[0] });
  card(tp, "card-pm-size", "question", "包体 1.42 GB 还发不发测试版？", "超了规范的 1.4 GB 上限 20 MB。瘦身还要 1～2 天，可以先发测试服，提审前再压。", 5, { needsYou: true });
  card(tp, "card-pm-maint", "note", "周五 14:00 测试服维护", "停服 1 小时，扩容用。", 20);
  card(tp, "card-pm-audio", "finding", "音效包没压缩，占 180 MB", "全是 wav；改成 Vorbis 质量 6 能省 140 MB 左右。", 2 * 24 - 4, { session: slim[0] });
  card(tp, "card-pm-weight", "decision", "掉落按权重表，结果只在服务端算", "客户端只播表现，防改包刷矿。", 4 * 24, { session: drop[1] });
  card(tp, "card-pm-layers", "question", "层数字段改成数组？", "改成数组每层能单独配矿石，客户端解析要改。等客户端确认。", 3, { session: cfg[2] });
}

// ── 官网改版 ──────────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const W = { id: "ws-site", name: "official_site" };
  const tp = topic("tp-site", "官网改版", "首页换成新版主视觉，下载页走 CDN，11 月 15 日上线", [W], 5 * 24);
  const lead = spine(tp, W.id, ["定改版范围，拆成两个任务"], 4.5 * 24, 0);
  task("task-site-home", tp, W.id, "首页改版", "doing", 4 * 24, [["新主视觉和首屏布局"], ["移动端适配"], ["动画减到 3 个，首屏 1.8 s", "running", "sonnet"]], { proposedBy: lead[0], stepH: 26 });
  task("task-site-cdn", tp, W.id, "下载页接入 CDN", "review", 4 * 24, [["选 CDN，配回源"], ["下载链接换成 CDN，测速"]], { proposedBy: lead[0], stepH: 30 });
  board(tp, W.id, [{ label: "线上版本", value: "v2.3", tone: "info" }, { label: "Lighthouse", value: "91", tone: "good" }], "", "专项管理 · 第 1 轮", 20);
  doc(tp, "doc-site-copy", "官网文案规范", 4 * 24, "标题不超过 12 个字，不用感叹号。游戏名写全称。下载按钮只写「下载」，不写「立即下载」。");
  card(tp, "card-site-anim", "decision", "首屏动画只留 3 个", "动画多了首屏 3 s，留 3 个回到 1.8 s。", 30);
}

// ── 美术资源管线 ──────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const T = { id: "ws-art-tool", name: "art_pipeline_tool" };
  const A = { id: "ws-art-assets", name: "mining_art_assets" };
  const tp = topic("tp-art", "美术资源管线", "资源从提交到进包全自动：命名、贴图规格、模型检查不过的进不了库", [T, A], 12 * 24);
  const lead = spine(tp, T.id, ["定管线要卡哪几关", "贴图压缩做完了，下一步模型检查"], 11 * 24, 6 * 24);
  task("task-art-tex", tp, T.id, "贴图自动压缩", "done", 10 * 24, [["按规格选压缩格式"], ["批量处理和缓存"], ["接进提交钩子"], ["全量跑一遍，1,862 张通过"]], { proposedBy: lead[0], stepH: 30 });
  const mesh = task("task-art-mesh", tp, T.id, "模型导入检查", "doing", 4 * 24, [["面数、骨骼数上限检查"], ["报错写回提交说明", "running"]], { proposedBy: lead[1], stepH: 40 });
  task("task-art-roles", tp, A.id, "角色资源入库", "doing", 6 * 24, [["角色 A～F 入库"], ["补齐缺的 LOD"], ["37 件等美术审", "idle", "sonnet"]], { stepH: 40 });
  board(tp, T.id, [{ label: "工具版本", value: "1.4.2", tone: "info" }, { label: "导入失败率", value: "2.1%", tone: "warn" }], "失败多是骨骼数超了", "专项管理 · 第 2 轮", 10);
  board(tp, A.id, [{ label: "已入库", value: "1,862 件", tone: "info" }, { label: "待审", value: "37 件", tone: "warn" }, { label: "贴图超规", value: "0", tone: "good" }], "", "专项管理 · 第 2 轮", 10);
  doc(tp, "doc-art-name", "资源命名规范", 11 * 24, "<类型>_<名字>_<变体>，全小写：chr_miner_a、tex_rock_02_n。贴图后缀 _d/_n/_m 分别是颜色、法线、金属度。");
  doc(tp, "doc-art-tex", "贴图规格规范", 11 * 24, "角色 1024，场景 2048，UI 按实际尺寸。安卓 ASTC 6x6，iOS ASTC 4x4。超规的提交会被钩子拦下。");
  card(tp, "card-art-bones", "finding", "导入失败多半是骨骼数超了", "上限 75 根，超的多是带披风的角色。", 2 * 24, { session: mesh[0] });
}

snap.topics = topics;
snap.workspaces = workspaces;
snap.docs = docs;
snap.reviews = [];
snap.extra = extra;
snap.demo = "演示：4 个专题。「AMO迭代」是真实快照（补上了它的项目）；「mining 迭代」「官网改版」「美术资源管线」是虚构的，名字和数字只是看起来像真的";
writeFileSync(join(here, "panorama-snapshot-topics.json"), JSON.stringify(snap, null, 1));
console.log("panorama-snapshot-topics.json:", topics.length, "topics,", snap.tasks.length, "tasks,", snap.sessions.length, "sessions,", docs.length, "docs,", extra.cards.length, "cards");
