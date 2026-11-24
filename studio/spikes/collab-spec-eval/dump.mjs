// A run as readable text, for looking at the originals: every message in order (with where, @, receipts), the 事项 and
// their status changes, every turn (why it was woken, what it wrote, refusals, tokens, the start of its final reply).
//   node spikes/collab-spec-eval/dump.mjs out/collab-spec-eval/<run>  → <run>/transcript.md
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const dir = path.resolve(process.argv[2]);
const S = JSON.parse(readFileSync(path.join(dir, "state.json"), "utf8"));
const T = JSON.parse(readFileSync(path.join(dir, "turns.json"), "utf8"));
const name = (k) => S.agents[k]?.name ?? k;
const t = (ms) => new Date(ms).toTimeString().slice(0, 8);
const out = [`# ${path.basename(dir)}`, "", "## 时间线（消息、事项变化、轮）", ""];
const ev = [];
for (const m of S.messages) {
  const rc = Object.entries(m.rc).map(([w, s]) => `${name(w)}:${s.done ? "处理了" : s.seen ? "看过" : "送到"}`).join(" ");
  const tags = [m.kind !== "text" ? m.kind : "", m.replyTo ? `回#${m.replyTo}` : "", m.agentMentions.length || m.mentions.length ? `@${[...m.mentions, ...m.agentMentions.map(name)].join(",")}` : "", m.supersedes ? `取代#${m.supersedes}` : "", m.supersededBy ? `被#${m.supersededBy}取代` : "", m.retracted ? "已撤回" : "", m.basis ? `basis ${m.basis.kind}${m.basis.ref ? `：${m.basis.ref}` : ""}` : ""].filter(Boolean).join(" ");
  ev.push([m.at, `**#${m.seq}** ${t(m.at)} [${m.where === "chat" ? "群聊" : `事项 ${m.where}`}] **${name(m.from)}** ${tags ? `(${tags})` : ""}\n\n> ${m.body.replace(/\n/g, "\n> ")}\n\n<sub>${rc}</sub>`]);
}
for (const mt of S.matters) for (const h of mt.hist) ev.push([h.at, `- ${t(h.at)} 事项 ${mt.no}「${mt.title}」${h.from || "开"} → ${h.to}${h.waiting?.length ? ` 等 ${h.waiting.map(name).join("、")}` : ""}${h.blocked ? ` 卡 ${h.blocked}` : ""}${h.conclusion ? ` 结论：${h.conclusion}` : ""}（${h.cause ? `${h.cause}${h.manual ? "，手改" : ""}，` : ""}${name(h.by)}）`]);
for (const mt of S.matters) for (const c of mt.checks ?? []) ev.push([c.at, `- ${t(c.at)} 〔脚本核对〕事项 ${mt.no} 在 ${c.commit ?? "—"} 上跑测试：${c.pass ? "过" : "不过"}（${c.kind === "claim" ? "执行说过了" : "主控标了已验"}）${c.tail ? ` ${c.tail}` : ""}`]);
for (const tr of T.turns) {
  ev.push([tr.startedAt, `- ${t(tr.startedAt)} ▶ 轮 ${tr.n} **${tr.name}**${tr.takeover ? `〔新会话接手，第 ${tr.session} 个会话〕` : ""}（${tr.kind}${tr.reasons.length ? `：${tr.reasons.join("；")}` : ""}${tr.items.length ? `；给了 ${tr.items.join(", ")}` : ""}）`]);
  if (tr.endedAt) ev.push([tr.endedAt, `- ${t(tr.endedAt)} ■ 轮 ${tr.n} ${tr.name} 写=[${(tr.writes ?? []).join(",")}] 拒=${tr.refused?.length ?? 0}${tr.refused?.length ? ` (${tr.refused.join(" | ")})` : ""} token=${JSON.stringify(tr.usage ?? {})}${tr.error ? ` 错：${tr.error}` : ""}\n  - 工具：${(tr.tools ?? []).map((x) => x.name.replace("mcp__amo__", "") + (/Bash|exec|pwsh/i.test(x.name) ? `(${String(x.input?.command ?? "").slice(0, 80)})` : "")).join("; ")}\n  - 最后的回复：${(tr.text ?? "").replace(/\s+/g, " ").slice(0, 400)}`]);
}
ev.sort((a, b) => a[0] - b[0]);
out.push(...ev.map((e) => e[1]), "", "## 事项", "");
for (const mt of S.matters) out.push(`- 事项 ${mt.no}「${mt.title}」${mt.kind === "confirm" ? "（等人确认）" : ""} 负责 ${name(mt.owner)} · ${mt.status} · 等 ${mt.waiting.map(name).join("、") || "—"} · 执行 ${mt.binds.exec.map(name).join("、") || "—"} · 提交 ${mt.binds.commits.join(" ") || "—"}${mt.conclusion ? ` · 结论：${mt.conclusion}` : ""}`);
out.push("", "## 已定的事", "", ...S.cowork.decisions.map((d) => `- ${d.text}（${d.src}）`), "", "## 拒绝和记录", "", ...S.violations.map((v) => `- ${name(v.agent)} ${v.tool} ${v.kind}：${v.why}`), "", "## 人的回答", "", ...(T.people ?? []).map((p) => `- ${p.person} 回 #${p.askSeq}（${p.topic}，经 ${p.via}，${name(p.asker)} 问：${p.title ?? ""}）`));
writeFileSync(path.join(dir, "transcript.md"), out.join("\n") + "\n");
console.log(path.join(dir, "transcript.md"));
