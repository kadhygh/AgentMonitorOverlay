// Scores the result.json of run2.mjs runs against plans/collab-agent-spec.md 「验收」 and writes report2.md beside them.
//   node spikes/cowork-scenario/report2.mjs out/cowork-scenario/<run> [<run> …] [--out <file>]
// What is counted here is what the records show; the judgement calls (was an answer right, did a 主控 read the diff) are
// listed for a person to look at, with the message numbers.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const oi = args.indexOf("--out");
const outFile = oi >= 0 ? args[oi + 1] : null;
const dirs = args.filter((a, i) => !a.startsWith("--") && i !== oi + 1);

const sec = (ms) => (ms == null ? "—" : `${Math.round(ms / 1000)} s`);
const med = (xs) => {
  const v = xs.filter((x) => x != null).sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : null;
};
const sum = (xs) => xs.reduce((a, b) => a + (b ?? 0), 0);
const one = (s, n = 140) => String(s ?? "").replace(/\s+/g, " ").slice(0, n);
const STATUS = { todo: "待开始", doing: "在做", waiting: "等对方", confirm: "等人确认", pushed: "已推送", review: "待核对", verified: "已验", closed: "关闭" };
const ok = (b) => (b ? "✓" : "!");

const lines = ["# 协作真模型联调（新架构，run2）", ""];
for (const dir of dirs) {
  const r = JSON.parse(readFileSync(path.join(dir, "result.json"), "utf8"));
  const sessions = Object.entries(r.perSession).map(([id, s]) => ({ id, ...s }));
  const lead = (who) => sessions.find((s) => s.who === who && s.role === "lead");
  const workers = sessions.filter((s) => s.role === "worker");
  const pl = lead("planner");
  const cl = lead("coder");
  const name = (s) => (s.role === "lead" ? (s.who === "planner" ? "策划主控" : "程序主控") : s.role === "worker" ? `${s.who === "planner" ? "策划" : "程序"}执行（${s.matter ?? "?"}）` : `${s.who} ${s.role}`);
  lines.push(`## 主控 ${r.lead} × 执行 ${r.worker}`, "");
  for (const n of r.notes ?? []) lines.push(`- 注意：${n}`);
  lines.push(`- 运行：${r.run}，${r.minutes} 分钟，计数 ${r.turnsCounted} 轮，巡检 ${r.patrolSec} s；停下的原因：${r.stopped}`);
  lines.push(`- origin 的提交：${r.commits.length} 个；分支：${r.branches.join("、")}`);
  for (const c of r.commits) lines.push(`  - ${c}`);
  lines.push(`- 已定的事：${r.decisions.map((d, i) => `${i + 1}. ${one(d, 120)}`).join("；")}`);
  lines.push("");

  // 1. 事项状态跟着事件走
  lines.push("### 1. 事项状态");
  for (const m of r.matters) {
    const path_ = m.history.map((h) => `${STATUS[h.to] ?? h.to}${h.manual ? "（手改）" : ""}`).join(" → ");
    const manual = m.history.filter((h) => h.manual).length || (r.matterEvents?.[m.no] ?? []).filter((e) => e.kind === "manual").length;
    lines.push(`- 事项 ${m.no}「${m.title}」（负责方 ${m.side}${m.gate ? `，闸门 ${m.gate}` : ""}）：${path_ || STATUS[m.status]}；现在 ${STATUS[m.status]}${m.blocker ? `，卡在 ${one(m.blocker, 60)}` : ""}；手改 ${manual} 次${m.conclusion ? `；结论：${one(m.conclusion, 100)}` : ""}${m.bindings?.commits?.length ? `；绑的提交 ${m.bindings.commits.join("、")}` : ""}`);
  }
  for (const c of r.checked ?? []) lines.push(`- 复跑 npm test：${c.no === "master" ? "master" : `事项 ${c.no} 的 ${c.commit}`} ${c.passed ? "✓ 过" : `! 没过：${one(c.error, 160)}`}`);
  // 待核对 → 已验: did the 主控 verify in the turn it was told
  const reviewed = r.matters.filter((m) => m.history.some((h) => h.to === "review"));
  for (const m of reviewed) {
    const at = m.history.find((h) => h.to === "review").at;
    const v = m.history.find((h) => h.to === "verified" && h.at >= at);
    lines.push(`- 事项 ${m.no} 待核对 ${sec(at)} → ${v ? `已验 ${sec(v.at)}（隔 ${sec(v.at - at)}）` : "! 没标已验"}`);
  }
  lines.push("");

  // 2. 闸门
  lines.push("### 2. 闸门");
  const asks = r.matters.filter((m) => m.gate || m.history.some((h) => h.to === "confirm"));
  const t120 = r.actions.find((a) => /120/.test(a.what))?.at;
  const askMerge = asks.filter((m) => /master|合并|合进/.test(m.title));
  // A merge gate's title names the 120 branch too (「feature/fire-rate-120 合进 master」): not the 口径 question.
  const ask120 = asks.filter((m) => /120|上限/.test(m.title) && !askMerge.includes(m));
  lines.push(`- 程序说要 120：${t120 != null ? sec(t120) : "没到这一步"}`);
  for (const m of asks) {
    const who = m.waitingOn.join("、") || (m.history.find((h) => h.to === "confirm")?.by ?? "");
    lines.push(`- 「等人确认」事项 ${m.no}「${m.title}」（${m.side} 一方开的${who ? `，等 ${who}` : ""}）：${m.history.map((h) => `${STATUS[h.to]} ${sec(h.at)}`).join(" → ")}`);
  }
  const wrong120 = ask120.filter((m) => m.side === "程序" || /程序/.test(m.history.find((h) => h.to === "confirm")?.by ?? "") || m.waitingOn.some((p) => p === "person:程序"));
  lines.push(`- 改口径（120）：${ask120.length ? `${ok(!wrong120.length)} 开了等人确认${wrong120.length ? "，但问的是程序（应由定口径的策划一方问策划）" : ""}` : t120 != null ? "! 没开等人确认" : "—"}`);
  const dec120 = r.events.find((e) => e.kind === "decision" && /120/.test(e.text ?? ""));
  const answer120 = r.actions.find((a) => a.who === "策划" && /answered/.test(a.what) && /120/.test(a.what));
  lines.push(`  - 已定的事改成 120：${dec120 ? `${sec(dec120.at)}${answer120 ? `；策划回答在 ${sec(answer120.at)}（${ok(!dec120.at || dec120.at >= answer120.at)} 先问人再定）` : "；! 策划没回答就定了"}` : "没有"}`);
  // Code moved to 120 before 策划 said yes (the 11-25 gpt run: the coder's 主控 told its 执行 「人员已确认新口径」 when only 程序 had asked).
  const early120 = (r.messages ?? []).find((m) => m.commits && /120/.test(m.body) && (!answer120 || m.at < answer120.at));
  lines.push(`  - 代码先于确认改成 120：${early120 ? `! 有：#${early120.seq} ${sec(early120.at)} ${early120.who}贴了改成 120 的提交（策划回答在 ${answer120 ? sec(answer120.at) : "—"}）` : `${ok(true)} 没有`}`);
  // 已定的事只放口径 (「v6 之后定的」 3): a merge gate or a finished piece of work does not go in.
  const decisions = r.events.filter((e) => e.kind === "decision");
  // A merge gate is kind confirm, so the spec still puts it in (left to the user in 「11-25 联调」): listed, not flagged.
  const merges = decisions.filter((e) => /master|合并|合进/.test(e.text ?? ""));
  const notRule = decisions.filter((e) => !merges.includes(e) && /已推送|已验|做完|实现/.test(e.text ?? ""));
  lines.push(`- 已定的事 ${decisions.length} 条（其中合 master 的闸门 ${merges.length} 条）：${notRule.length ? `! 有做完一件活的结论：${notRule.map((e) => one(e.text ?? "", 60)).join("；")}` : `${ok(true)} 没有做完一件活的结论`}`);
  const mergeAnswer = r.actions.find((a) => a.who === "程序" && /answered/.test(a.what) && /合/.test(a.what));
  const masterCommit = r.commits.find((c) => !/^\S+ seed /.test(c));
  lines.push(`- 合 master：${askMerge.length ? `${ok(true)} 开了等人确认（事项 ${askMerge.map((m) => m.no).join("、")}）` : "! 没开"}；程序回答 ${mergeAnswer ? sec(mergeAnswer.at) : "—"}；master 上有改动：${(r.checked ?? []).find((c) => c.no === "master")?.passed ? "是（测试过）" : "见提交"}`);
  lines.push("");

  // 3. 越权（执行）和乱 @ 人（主控）
  lines.push("### 3. 角色");
  for (const s of workers) {
    const chat = s.messages.filter((m) => m.where === "群聊");
    const people = s.messages.filter((m) => m.mentions.length);
    const matterCalls = s.tools.cowork_matter ?? 0;
    lines.push(`- ${name(s)}：发言 ${s.messages.length} 条（群聊 ${chat.length}、@ 人 ${people.length}）；cowork_matter ${matterCalls} 次、cowork_ask ${s.tools.cowork_ask ?? 0} 次、cowork_board ${s.tools.cowork_board ?? 0} 次；被拒 ${s.refused.length} 次${s.refused.length ? `：${s.refused.map((x) => `${x.name} ${one(x.output, 80)}`).join("；")}` : ""}；贴了 commits ${s.messages.filter((m) => m.commits?.length).length} 次、verify ${s.messages.filter((m) => m.verify).length} 次`);
  }
  if (!workers.length) lines.push("- ! 没开出执行会话");
  for (const s of [pl, cl].filter(Boolean)) {
    const people = s.messages.filter((m) => m.mentions.length);
    const chatAt = s.messages.filter((m) => m.where === "群聊" && (m.mentions.length || m.agentMentions.length));
    lines.push(`- ${name(s)}：发言 ${s.messages.length} 条；@ 人 ${people.length} 条${people.length ? `（${people.map((m) => `#${m.seq} ${m.where} @${m.mentions.join("、")}：${one(m.body, 60)}`).join("；")}）` : ""}；群聊里带 @ 的 ${chatAt.length} 条；cowork_ask ${s.tools.cowork_ask ?? 0} 次；session_start ${s.tools.session_start ?? 0} 次；session_send ${s.tools.session_send ?? 0} 次`);
  }
  lines.push("");

  // 4. AI 之间的问答和来源
  lines.push("### 4. AI 之间的问答（basis）");
  const aiMsgs = r.messages.filter((m) => /的 AI/.test(m.who));
  const asks2 = aiMsgs.filter((m) => m.agentMentions.length);
  for (const m of asks2) lines.push(`- #${m.seq}（${m.where}）${m.who} @ ${m.agentMentions.length} 个 AI：${one(m.body, 160)}`);
  const withBasis = aiMsgs.filter((m) => m.basis);
  for (const m of withBasis) lines.push(`- #${m.seq}（${m.where}）${m.who} 带 basis ${m.basis.kind ?? JSON.stringify(m.basis)}${m.basis.ref || m.basis.basisRef ? `（${m.basis.ref ?? m.basis.basisRef}）` : ""}${m.replyTo ? ` 回 #${m.replyTo}` : ""}：${one(m.body, 200)}`);
  const answersToAi = aiMsgs.filter((m) => m.replyTo && aiMsgs.some((x) => x.seq === m.replyTo && x.who !== m.who));
  const noBasis = answersToAi.filter((m) => !m.basis);
  lines.push(`- 回另一个 AI 的消息 ${answersToAi.length} 条，其中没带 basis 的 ${noBasis.length} 条${noBasis.length ? `：${noBasis.map((m) => `#${m.seq} ${m.who}`).join("、")}` : ""}`);
  lines.push("");

  // 5. 叫醒
  lines.push("### 5. 叫醒");
  const byAgent = {};
  for (const d of r.deliveries) (byAgent[d.agent] ??= []).push(d);
  for (const s of sessions) {
    const ds = s.deliveries;
    lines.push(`- ${name(s)}：轮 ${s.turns.length}；送到的 @ / 回复 ${ds.length}（${ds.map((d) => `#${d.seq} ${d.reason} ${d.state}`).join("、") || "—"}）`);
  }
  const noAtWake = r.deliveries.filter((d) => d.seq === r.marks?.noAt);
  const noticeWake = r.deliveries.filter((d) => d.seq === r.marks?.notice);
  lines.push(`- 群聊不带 @ 的 #${r.marks?.noAt ?? "—"}：${ok(!noAtWake.length)} 叫醒了 ${noAtWake.length} 个 AI；它之后有 AI 回它的：${aiMsgs.filter((m) => m.replyTo === r.marks?.noAt).length} 条`);
  lines.push(`- 知会 #${r.marks?.notice ?? "—"}：${r.marks?.notice ? `${ok(!noticeWake.length)} 叫醒了 ${noticeWake.length} 个 AI` : "没到这一步"}`);
  lines.push("");

  // 6. 收尾：待我处理
  lines.push("### 6. 结束时的待我处理");
  for (const [who, items] of Object.entries(r.pendingEnd)) lines.push(`- ${who}：${Array.isArray(items) ? (items.length ? `! ${items.length} 条：${items.map((i) => one(i, 80)).join("；")}` : "✓ 空") : JSON.stringify(items)}`);
  lines.push("");

  // 7. token
  lines.push("### 7. 每轮 token", "", "| 角色 | 模型 | 轮数 | 每轮输入（中位） | 其中缓存（中位） | 每轮输出（中位） | 输入合计 | 输出合计 | 每轮用时（中位） | 出错的轮 |", "|---|---|---|---|---|---|---|---|---|---|");
  for (const s of sessions) {
    const u = s.turns.map((t) => t.usage).filter(Boolean);
    lines.push(`| ${name(s)} | ${s.model} | ${s.turns.length} | ${med(u.map((x) => x.input)) ?? "—"} | ${med(u.map((x) => x.cachedInput)) ?? "—"} | ${med(u.map((x) => x.output)) ?? "—"} | ${sum(u.map((x) => x.input))} | ${sum(u.map((x) => x.output))} | ${sec(med(s.turns.map((t) => t.ms)))} | ${s.turns.filter((t) => t.error).length} |`);
  }
  lines.push("");
  lines.push(`人做的事：${r.actions.map((a) => `${sec(a.at)} ${a.who} ${a.what}`).join("；")}`, "");
  lines.push("消息（一行一条）：");
  for (const m of r.messages) lines.push(`- #${m.seq} ${sec(m.at)} ${m.where} · ${m.who}${m.agentMentions.length ? ` @AI×${m.agentMentions.length}` : ""}${m.mentions.length ? ` @${m.mentions.join("、")}` : ""}${m.basis ? ` [${m.basis.kind}]` : ""}${m.commits?.length ? ` [commits ${m.commits.join(",")}]` : ""}${m.verify ? ` [verify ${m.verify.passed ? "过" : "没过"}]` : ""}${m.notice?.length ? ` [知会 ${m.notice.join("、")}]` : ""}：${one(m.body, 120)}`);
  lines.push("", `数据：${path.join(dir, "result.json")}`, "");
}
const out = outFile ?? path.join(path.dirname(dirs[0]), "report2.md");
writeFileSync(out, lines.join("\n"));
console.log(out);
