// Turns the result.json of one or more runs (run.mjs) into one short report.md beside them.
//   node spikes/cowork-scenario/report.mjs out/cowork-scenario/<run> [<run> …] [--out out/cowork-scenario/report.md]
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const oi = args.indexOf("--out");
const outFile = oi >= 0 ? args[oi + 1] : null;
const dirs = args.filter((a, i) => !a.startsWith("--") && i !== oi + 1);
const runs = dirs.map((d) => ({ dir: d, r: JSON.parse(readFileSync(path.join(d, "result.json"), "utf8")) }));

const sec = (ms) => (ms == null ? "—" : `${(ms / 1000).toFixed(0)} s`);
const med = (xs) => {
  const v = xs.filter((x) => x != null).sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : null;
};
const sum = (xs) => xs.reduce((a, b) => a + (b ?? 0), 0);

const lines = ["# 协作真模型场景", ""];
for (const { dir, r } of runs) {
  lines.push(`## ${r.planner}（策划）× ${r.coder}（程序）`, "");
  for (const n of r.notes ?? []) lines.push(`- 注意：${n}`);
  lines.push(`- 运行：${r.run}，${r.minutes} 分钟，计数 ${r.turnsCounted} 轮；停下的原因：${r.stopped}`);
  lines.push(`- 提交（origin main）：${r.commits.length} 个`);
  for (const c of r.commits) lines.push(`  - ${c}`);
  lines.push(`- 子会话：${r.subSessions.length ? r.subSessions.map((s) => `「${s.title}」${s.from}→${s.to}（${s.agent} 发起，${s.state}${s.conclusion ? `，结论：${s.conclusion}` : ""}）`).join("；") : "没有"}`);
  lines.push(`- 白板：${r.board.length} 张卡；事件：${r.events.filter((e) => e.kind === "commit").length} 条提交、${r.events.filter((e) => e.kind === "note").length} 条记事、${r.events.filter((e) => e.kind === "decision").length} 条结论；AI 之间连续往来上限：${r.guardrail ? "**触发了**" : "没触发"}`);
  lines.push("", "| | 模型 | 轮数 | 每轮输入（中位） | 其中缓存（中位） | 每轮输出（中位） | 输入合计 | 每轮用时（中位） | 送达 | 等它空下来（中位） | 送达到回复（中位） | 没回的 | 发言 | 带 @ 的发言 | 写白板 | cowork_* 调用 |", "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const [who, s] of Object.entries(r.perSide)) {
    const usage = s.turns.map((t) => t.usage).filter(Boolean);
    const cowork = Object.entries(s.tools).filter(([k]) => k.startsWith("cowork_")).map(([k, n]) => `${k.slice(7)} ${n}`).join("、");
    const unanswered = s.deliveries.filter((d) => d.state === "delivered").length;
    lines.push(`| ${who === "planner" ? "策划" : "程序"} | ${s.model} | ${s.turns.length} | ${med(usage.map((u) => u.input)) ?? "—"} | ${med(usage.map((u) => u.cachedInput)) ?? "—"} | ${med(usage.map((u) => u.output)) ?? "—"} | ${sum(usage.map((u) => u.input))} | ${sec(med(s.turns.map((t) => t.ms)))} | ${s.deliveries.length} | ${sec(med(s.deliveries.map((d) => d.waitMs)))} | ${sec(med(s.deliveries.map((d) => d.replyMs)))} | ${unanswered} | ${s.messages} | ${s.mentions.length} | ${s.boardWrites} | ${cowork || "—"} |`);
  }
  lines.push("");
  for (const [who, s] of Object.entries(r.perSide)) {
    if (!s.mentions.length) continue;
    lines.push(`${who === "planner" ? "策划" : "程序"}的 AI 的 @：`);
    for (const m of s.mentions) lines.push(`- #${m.seq}（${m.thread}）@ ${[...m.people, ...m.agents.map((a) => (a.includes(":") ? "AI" : a))].join("、")}：${m.body.replace(/\s+/g, " ")}`);
    lines.push("");
  }
  for (const [who, s] of Object.entries(r.perSide)) {
    lines.push(`${who === "planner" ? "策划" : "程序"}的 AI 被叫醒的原因（除了主人交代的第一轮）：`);
    if (s.deliveries.some((d) => d.seq === undefined)) {
      lines.push("- （这次运行的结果没记消息号，见 log 和 result.json 的 chat）");
      continue;
    }
    for (const d of s.deliveries) lines.push(`- #${d.seq}（${d.where}）${d.from} ${d.reason === "mention" ? "@ 了它" : "回复了它发起的子会话"}，${d.state === "replied" ? "它回了" : d.state === "delivered" ? "送到了，没回" : d.state}：${d.body ?? ""}`);
    if (!s.deliveries.length) lines.push("- 没有");
    lines.push("");
  }
  const errs = Object.entries(r.perSide).flatMap(([who, s]) => s.turns.filter((t) => t.error).map((t) => `${who}: ${t.error}`));
  if (errs.length) lines.push("出错的轮：", ...errs.map((e) => `- ${e}`), "");
  lines.push(`人做的事：${r.actions.map((a) => `${sec(a.at)} ${a.who} ${a.what}`).join("；")}`, "", `数据：${path.join(dir, "result.json")}`, "");
}
const out = outFile ?? path.join(path.dirname(dirs[0]), "report.md");
writeFileSync(out, lines.join("\n"));
console.log(out);
