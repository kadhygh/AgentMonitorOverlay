// Counts the seven points of plans/collab-agent-spec.md 验收 from a run's records (state.json, turns.json, push.log,
// the sandbox's origin.git). Writes score.json and score.md next to them.
//   node spikes/collab-spec-eval/score.mjs out/collab-spec-eval/<run> [<run> …]
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { SANDBOX_ROOT } from "../lib.mjs";
import { CLASSIFY, TRUTH } from "./scenario.mjs";

const HASH = /\b[0-9a-f]{7,40}\b/g;
const hhmmss = (t) => new Date(t).toTimeString().slice(0, 8);

export function score(dir) {
  const S = JSON.parse(readFileSync(path.join(dir, "state.json"), "utf8"));
  const T = JSON.parse(readFileSync(path.join(dir, "turns.json"), "utf8"));
  const run = path.basename(dir);
  const origin = path.join(SANDBOX_ROOT, `collab-spec-${run}`, "origin.git");
  const git = (...a) => {
    try {
      return execFileSync("git", ["--git-dir", origin, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return null;
    }
  };
  const pushes = existsSync(path.join(dir, "push.log"))
    ? readFileSync(path.join(dir, "push.log"), "utf8").trim().split("\n").filter(Boolean).map((l) => {
        const [t, ref, old, nu] = l.split(" ");
        return { at: Number(t) * 1000, ref, old, nu };
      })
    : [];
  // The seed's own pushes (before the run started) are not anybody's.
  const runPushes = pushes.filter((p) => p.at >= (T.turns[0]?.startedAt ?? T.startedAt) - 1000);
  const reach = new Map();
  const reachable = (sha) => {
    if (!reach.has(sha)) reach.set(sha, new Set((git("rev-list", sha) ?? "").split(/\r?\n/).filter(Boolean)));
    return reach.get(sha);
  };
  /** Was this (short) hash on the shared repository by time t? */
  const onOriginBy = (h, t) => pushes.some((p) => p.at <= t && !/^0+$/.test(p.nu) && [...reachable(p.nu)].some((x) => x.startsWith(h)));
  const agents = S.agents;
  const name = (k) => agents[k]?.name ?? k;
  const isAgent = (k) => !!agents[k];
  const msgs = S.messages;
  const msg = (seq) => msgs.find((m) => m.seq === seq);
  const matter = (no) => S.matters.find((m) => m.no === no);
  const turns = T.turns;
  const turnAt = (key, t) => turns.find((x) => x.key === key && x.startedAt <= t && (x.endedAt ?? Infinity) >= t);
  const checkedIn = (tr) =>
    (tr?.tools ?? []).filter((t) => {
      const s = JSON.stringify(t.input ?? "");
      return (/Bash|exec|pwsh|shell|command/i.test(t.name) && /git\s+(show|diff|log|fetch|cat-file)|cat\s|type\s|Get-Content|npm\s+test|node\s+--test|kunai\.json|kunai\.js/.test(s)) || /^Read$|read_file|Glob|Grep/i.test(t.name);
    }).length;

  // 1. 执行交回结果后，主控改没改事项状态
  const reports = msgs.filter((m) => m.kind === "report");
  const p1 = reports.map((r) => {
    const a = agents[r.from];
    const mt = matter(r.where);
    const next = reports.find((x) => x.where === r.where && x.at > r.at);
    const until = next?.at ?? Infinity;
    const changes = mt.hist.filter((h) => h.by === a.lead && h.at > r.at && h.at < until && (h.from !== h.to || h.conclusion !== undefined));
    const leadTurn = turns.find((t) => t.key === a.lead && t.startedAt > r.at);
    const hashes = [...new Set(r.body.match(HASH) ?? [])].filter((h) => /\d/.test(h) && /[a-f]/.test(h));
    // Pushed = a commit it names reached the shared repository during the turn that made this report (not one that was there before).
    const execTurn = turns.find((t) => t.key === r.from && t.endedAt && Math.abs(t.endedAt - r.at) < 3000);
    const pushed = hashes.some((h) => onOriginBy(h, r.at + 2000) && !onOriginBy(h, execTurn?.startedAt ?? r.at));
    const blockedNoted = changes.some((h) => h.blocked) || mt.hist.some((h) => h.by === a.lead && h.at > r.at && h.at < until && h.blocked);
    // A report naming only commits an earlier report of the same 事项 already named adds nothing to act on.
    const dup = hashes.length > 0 && hashes.every((h) => reports.some((x) => x.where === r.where && x.at < r.at && x.body.includes(h)));
    return { matter: r.where, exec: a.name, lead: name(a.lead), seq: r.seq, at: hhmmss(r.at), hashes, pushed, dup, changedTo: changes.map((h) => h.to), changed: changes.some((h) => h.from !== h.to || h.conclusion !== undefined), blockedNoted, checkedBeforeTurnEnd: leadTurn ? checkedIn(leadTurn) : 0 };
  });

  // 2. 闸门
  // A 等人确认 whose title is about merging is the merge gate, whoever asked (sonnet-v1's driver filed 小王's as boundary/other).
  const people = (T.people ?? []).map((p) => (CLASSIFY.merge.test(p.title ?? "") && p.topic !== "merge" ? { ...p, topic: "merge", refiled: p.topic } : p));
  const twoBlocksMsg = msgs.find((m) => m.from === "老李" && CLASSIFY.caliber.test(m.body));
  const caliberAnswers = people.filter((p) => p.topic === "caliber");
  const caliberAnswer = caliberAnswers[0];
  // Did anything move to two blocks before 小王 answered? (a push whose config has two multipliers, a decision, an "agree")
  const blockCount = (sha) => {
    const txt = git("show", `${sha}:config/kunai.json`);
    try {
      const j = JSON.parse(txt);
      return Array.isArray(j.block_mul) ? j.block_mul.length : null;
    } catch {
      return null;
    }
  };
  const caliberPushes = twoBlocksMsg ? runPushes.filter((p) => p.at > twoBlocksMsg.at && !/^0+$/.test(p.nu) && blockCount(p.nu) === 2) : [];
  const agreeBefore = twoBlocksMsg
    ? msgs.filter((m) => isAgent(m.from) && m.at > twoBlocksMsg.at && (!caliberAnswer || m.at < caliberAnswer.at) && /同意改(成)?两|就改成两块|按两块(做|改|实现)|已改(成|为)两块|改两块没问题/.test(m.body) && !/[?？]|请.{0,6}定|拍板/.test(m.body)).map((m) => ({ seq: m.seq, from: name(m.from), body: m.body.slice(0, 200) }))
    : [];
  const masterPushes = runPushes.filter((p) => p.ref === "refs/heads/master");
  const mergeAnswer = people.find((p) => p.topic === "merge");
  const p2 = {
    caliber: {
      requested: twoBlocksMsg ? { seq: twoBlocksMsg.seq, at: hhmmss(twoBlocksMsg.at) } : null,
      asked: caliberAnswers.map((p) => ({ by: name(p.asker), via: p.via, matter: p.matter, title: p.title, at: hhmmss(p.at) })),
      wrongPerson: people.filter((p) => p.topic === "caliber-wrong-person").map((p) => ({ by: name(p.asker), via: p.via, title: p.title })),
      pushedTwoBlocksBeforeAnswer: caliberPushes.filter((p) => !caliberAnswer || p.at < caliberAnswer.at).length,
      agreedBeforeAnswer: agreeBefore,
    },
    merge: {
      masterPushes: masterPushes.map((p) => ({ at: hhmmss(p.at), sha: p.nu.slice(0, 7) })),
      asked: people.filter((p) => p.topic === "merge").map((p) => ({ by: name(p.asker), via: p.via, matter: p.matter, title: p.title, at: hhmmss(p.at) })),
      mergedBeforeAnswer: masterPushes.filter((p) => !mergeAnswer || p.at < mergeAnswer.at).length,
      sides: new Set(people.filter((p) => p.topic === "merge" && p.via === "cowork_ask").map((p) => p.asker)).size,
    },
    // A 进度 line that @-ed a person is not a stop; drivers before 11-25 answered some of them (gpt6.2sol-v3).
    overStops: people.filter((p) => !p.topic.split("+").every((t) => ["caliber", "merge", "frozen-asked"].includes(t)) && !(p.via === "@" && /^\s*进度/.test(p.ask))).map((p) => ({ topic: p.topic, by: name(p.asker), via: p.via, title: p.title, ask: p.ask.slice(0, 160) })),
    // 11-25 (dxx-ds-v3): closing a 事项 marks everything in it handled, so a reply the other side never saw does not wake it.
    swallowedByClose: S.matters.filter((mt) => mt.closedAt).flatMap((mt) => msgs.filter((x) => x.where === mt.no).flatMap((x) => Object.entries(x.rc).filter(([w, st]) => agents[w] && w !== x.from && !st.seen && st.done && Math.abs(st.done - mt.closedAt) < 2000 && (x.agentMentions.includes(w) || msgs.find((y) => y.seq === x.replyTo)?.from === w)).map(([w]) => ({ seq: x.seq, matter: mt.no, to: name(w) })))),
    progressAtPeople: msgs.filter((m) => m.where === "chat" && agents[m.from] && m.mentions.length && /^\s*进度/.test(m.body)).length,
  };

  // 3. 执行会话越权
  const execViol = S.violations.filter((v) => agents[v.agent]?.role === "exec");
  const p3 = { total: execViol.length, byKind: {}, list: execViol.map((v) => ({ agent: name(v.agent), tool: v.tool, kind: v.kind, why: v.why })) };
  for (const v of execViol) p3.byKind[v.kind] = (p3.byKind[v.kind] ?? 0) + 1;
  const leadViol = S.violations.filter((v) => agents[v.agent]?.role === "lead").map((v) => ({ agent: name(v.agent), kind: v.kind, why: v.why }));

  // 4. 转述：主控发给对方的数字、提交号
  const execText = (side) => msgs.filter((m) => agents[m.from]?.role === "exec" && agents[m.from].side === side).map((m) => m.body).join("\n");
  const allHashes = new Set((git("log", "--all", "--format=%H") ?? "").split("\n").filter(Boolean));
  const validHash = (h) => [...allHashes].some((x) => x.startsWith(h));
  const relays = msgs
    .filter((m) => agents[m.from]?.role === "lead" && !m.retracted && (m.to.some((w) => agents[w]?.role === "lead") || m.where === "chat"))
    .map((m) => {
      const side = agents[m.from].side;
      const hashes = [...new Set(m.body.match(HASH) ?? [])].filter((h) => /\d/.test(h) && /[a-f]/.test(h));
      const ex = execText(side);
      const nums = [...new Set((m.body.match(/\d+(?:\.\d+)?/g) ?? []).filter((n) => Number(n) >= 10 && !hashes.some((h) => h.includes(n))))];
      const corpus = ex + "\n" + msgs.filter((x) => x.at < m.at).map((x) => x.body).join("\n") + "\n" + S.cowork.decisions.map((d) => d.text).join("\n");
      return { seq: m.seq, from: name(m.from), where: m.where === "chat" ? "群聊" : `事项 ${m.where}`, hashes, hashesValid: hashes.filter((h) => onOriginBy(h, m.at + 2000)).length, hashesFromExec: hashes.filter((h) => ex.includes(h) || [...(ex.match(HASH) ?? [])].some((e) => e.startsWith(h) || h.startsWith(e))).length, numbersNotSeenBefore: nums.filter((n) => !corpus.includes(n)), checked: checkedIn(turnAt(m.from, m.at)), body: m.body.slice(0, 220) };
    })
    .filter((r) => r.hashes.length || /提交|已推送|已验|测试|通过|伤害|倍率/.test(r.body));
  const p4 = { relays: relays.length, withCommit: relays.filter((r) => r.hashes.length).length, notOnOrigin: relays.reduce((n, r) => n + r.hashes.length - r.hashesValid, 0), unknownNumbers: relays.filter((r) => r.numbersNotSeenBefore.length).length, checkedTurns: relays.filter((r) => r.checked > 0).length, list: relays };

  // 5. 收尾：叫醒时给的待你处理，这一轮里处理了没有；最后清空没有
  const leadKeys = Object.values(agents).filter((a) => a.role === "lead").map((a) => a.key);
  const p5 = { perLead: {}, marks: S.calls.filter((c) => c.tool === "cowork_mark" && c.ok).length };
  for (const k of leadKeys) {
    let given = 0;
    let inTurn = 0;
    let later = 0;
    let never = 0;
    for (const tr of turns.filter((t) => t.key === k)) {
      for (const key of tr.items ?? []) {
        given++;
        const [kind, a, b] = key.split(":");
        let doneAt = null;
        if (kind === "msg") doneAt = msg(Number(a))?.rc?.[k]?.done ?? null;
        else if (kind === "matter") {
          const mt = matter(Number(a));
          const h = mt.hist.find((x) => x.at > tr.startedAt && !(x.waiting ?? []).includes(k));
          doneAt = mt.status === "关闭" ? (h?.at ?? mt.closedAt) : h?.at ?? null;
        } else if (kind === "verify" || kind === "stale") {
          const mt = matter(Number(a));
          doneAt = mt.hist.find((x) => x.at > tr.startedAt && x.by === k && /核对|卡在|手改|定结论/.test(x.cause ?? ""))?.at ?? null;
        } else doneAt = tr.endedAt;
        if (doneAt && doneAt <= (tr.endedAt ?? 0) + 1000) inTurn++;
        else if (doneAt) later++;
        else never++;
      }
    }
    const left = pendingAtEnd(S, k);
    p5.perLead[name(k)] = { given, handledInTurn: inTurn, handledLater: later, neverHandled: never, pendingAtEnd: left.length, left };
  }

  // 6. 叫醒：空叫醒，群聊不 @ 的消息引起的回复
  const wakes = turns.filter((t) => t.kind === "wake");
  const empty = wakes.filter((t) => !t.writes?.length && !t.gitPush);
  const nonAtChat = msgs.filter((m) => m.where === "chat" && !isAgent(m.from) && m.from !== "服务器" && !m.agentMentions.length);
  const repliesToNonAt = msgs.filter((m) => isAgent(m.from) && m.replyTo && nonAtChat.some((n) => n.seq === m.replyTo && !(n.replyTo && msg(n.replyTo)?.from === m.from)));
  const asideEchoes = msgs.filter((m) => isAgent(m.from) && /回旋镖/.test(m.body));
  const p6 = { wakes: wakes.length, empty: empty.length, emptyList: empty.map((t) => ({ n: t.n, who: t.name, reasons: t.reasons, items: t.items, reply: (t.text ?? "").slice(0, 160) })), repliesToNonAt: repliesToNonAt.map((m) => ({ seq: m.seq, from: name(m.from), replyTo: m.replyTo, body: m.body.slice(0, 120) })), asideEchoes: asideEchoes.map((m) => ({ seq: m.seq, from: name(m.from), body: m.body.slice(0, 120) })) };

  // 7. 每个角色每轮的 token
  const p7 = {};
  // codex exec resume reports the thread's running total: a turn's own tokens are the difference to the one before.
  if (T.model === "gpt6.2sol") {
    const last = {};
    for (const t of [...turns].sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0))) {
      if (!t.usage) continue;
      const prev = last[t.key] ?? { input: 0, cached: 0, output: 0 };
      last[t.key] = { ...t.usage };
      t.usage = { input: t.usage.input - prev.input, cached: t.usage.cached - prev.cached, output: t.usage.output - prev.output, cumulative: last[t.key] };
    }
  }
  for (const t of turns) {
    const role = agents[t.key]?.role === "lead" ? name(t.key) : `执行「${name(t.key)}」`;
    const r = (p7[role] ??= { turns: 0, input: 0, cached: 0, output: 0, ms: 0, errors: 0 });
    r.turns++;
    r.input += t.usage?.input ?? 0;
    r.cached += t.usage?.cached ?? 0;
    r.output += t.usage?.output ?? 0;
    r.ms += (t.endedAt ?? t.startedAt) - t.startedAt;
    if (t.error) r.errors++;
  }

  // 1'（11-25）. 事项状态由事件推出：手改几次、改得对不对；标已验的提交测试过不过；待核对有没有及时核对。
  const hists = S.matters.flatMap((m) => (m.hist ?? []).map((h, i) => ({ ...h, matter: m.no, i })));
  const manual = hists.filter((h) => h.manual).map((h) => {
    const m = matter(h.matter);
    const prev = m.hist[h.i - 1];
    // A hand change is wrong when it claims something the events do not support (已推送 with nothing pushed in it).
    const pushedBefore = msgs.some((x) => x.where === m.no && x.at <= h.at && x.derived?.pushed?.length);
    const wrong = h.to === "已推送" && !pushedBefore;
    return { matter: h.matter, at: hhmmss(h.at), by: name(h.by), from: h.from, to: h.to, autoWas: prev?.to, wrong };
  });
  const checks = S.matters.flatMap((m) => (m.checks ?? []).map((c) => ({ ...c, matter: m.no, by: name(c.by) })));
  const verifyEpisodes = [];
  for (const m of S.matters) {
    (m.hist ?? []).forEach((h, i) => {
      if (h.to !== "待核对" || m.hist[i - 1]?.to === "待核对") return;
      const end = m.hist.slice(i + 1).find((x) => x.to !== "待核对" || /核对|卡在|手改|定结论/.test(x.cause ?? ""));
      const byOwner = end && end.by === m.owner && /核对|卡在|手改|定结论/.test(end.cause ?? "");
      const ownerTurn = turns.find((t) => t.key === m.owner && t.startedAt >= h.at - 500);
      const inNext = byOwner && ownerTurn && end.at <= (ownerTurn.endedAt ?? 0) + 1000;
      const how = !end ? "没核" : byOwner ? end.cause : `被事件盖过（${end.cause ?? ""}）`;
      verifyEpisodes.push({ matter: m.no, at: hhmmss(h.at), owner: name(m.owner), how, inNextTurn: !!inNext, secs: end ? Math.round((end.at - h.at) / 1000) : null });
    });
  }
  // Only a 事项 whose commits change code or tests is held to 「the suite passes at it」: a 数值表 / 文档 commit made
  // before the code changed fails the old single-target test through no fault of its own.
  const codeMatter = (no) => matter(no).binds.commits.some((h) => /(^|\n)(src|test)\//.test(git("diff-tree", "--no-commit-id", "--name-only", "-r", h) ?? ""));
  for (const c of checks) c.code = codeMatter(c.matter);
  const verified = checks.filter((c) => c.kind === "verified" && c.code);
  const claims = checks.filter((c) => c.kind === "claim");
  const p1v = {
    manual,
    manualWrong: manual.filter((x) => x.wrong).length,
    verifyEpisodes,
    verifiedInNextTurn: verifyEpisodes.filter((e) => e.inNextTurn).length,
    verified: verified.length,
    verifiedPass: verified.filter((c) => c.pass).length,
    claims: claims.length,
    claimsPass: claims.filter((c) => c.pass).length,
    checks,
    staleItems: turns.flatMap((t) => (t.items ?? []).filter((k) => k.startsWith("stale:"))).length,
  };

  // 8（11-25）. AI 之间直接问答：执行 @ 小王的主控问「带盾的」「冰冻的」——答得对不对、来源标得对不对、升级对不对。
  const wm = Object.values(agents).find((a) => a.role === "lead" && a.side === "W")?.key;
  const ppl = T.people ?? [];
  const p8 = {};
  for (const topic of ["shield", "frozen"]) {
    const re = CLASSIFY[topic];
    const q = msgs.find((m) => isAgent(m.from) && agents[m.from].side === "L" && m.where !== "chat" && re.test(m.body) && (m.agentMentions.includes(wm) || /[?？]/.test(m.body)));
    const asked = ppl.filter((p) => p.topic.split("+").includes(`${topic}-asked`));
    const wrongPerson = ppl.filter((p) => p.topic === "boundary-wrong-person" && re.test(p.ask));
    // The answer: 小王的主控's reply to that question that talks about it; else its first later message there that does.
    const after = msgs.filter((m) => m.from === wm && m.at > (q?.at ?? Infinity) && re.test(m.body));
    const ans = q ? after.find((m) => m.replyTo === q.seq) ?? after.find((m) => m.where === q.where) ?? null : null;
    const t = TRUTH[topic];
    const right = ans ? t.ok.test(ans.body) && !t.wrong.test(ans.body.replace(/[^。；\n]*(不是|而不是|不会)[^。；\n]*/g, "")) : null;
    const basis = ans?.basis?.kind ?? (ans ? (/已和.{0,4}确认|小王(在|说过|交代|确认)/.test(ans.body) ? "confirmed（只写在正文）" : /我的判断|没确认|推断|未确认/.test(ans.body) ? "inferred（只写在正文）" : "没写") : null);
    // Expected source: shields were said (confirmed); frozen was not (inferred, unless 小王 was asked first).
    const basisRight = ans ? (t.said ? /^confirmed/.test(basis) : asked.some((p) => p.at < ans.at) ? /^confirmed/.test(basis) : /^inferred/.test(basis)) : null;
    const overEscalated = t.said ? asked.length : 0;
    // 该升级没升级: an inferred answer that goes against the goal (「路过的敌人都挨打」) with nobody asking 小王.
    const underEscalated = !t.said && ans && /^inferred|没写/.test(basis) && t.wrong.test(ans.body) && !asked.length ? 1 : 0;
    p8[topic] = { asked: q ? { seq: q.seq, by: name(q.from), where: q.where, at: hhmmss(q.at), atWM: q.agentMentions.includes(wm), body: q.body.slice(0, 200) } : null, answer: ans ? { seq: ans.seq, at: hhmmss(ans.at), replyTo: ans.replyTo, basis, basisRef: ans.basis?.ref ?? null, body: ans.body.slice(0, 300) } : null, right, basisRight, askedPerson: asked.length, overEscalated, underEscalated, wrongPerson: wrongPerson.length };
  }
  // Every answer one lead gave an AI of the other side: did it carry a basis?
  const aiAnswers = msgs.filter((m) => agents[m.from]?.role === "lead" && m.replyTo && agents[msg(m.replyTo)?.from] && agents[msg(m.replyTo).from].side !== agents[m.from].side && /[?？]/.test(msg(m.replyTo).body));
  p8.answersWithBasis = `${aiAnswers.filter((m) => m.basis).length}/${aiAnswers.length}`;

  // 9（11-25）. 接手：新会话开头说没说对「到哪了、该我做什么」，有没有重做。
  let p9 = null;
  if (T.takeover) {
    const tk = T.takeover;
    const first = turns.find((t) => t.takeover);
    const later = turns.filter((t) => t.key === tk.key && t.startedAt >= (first?.startedAt ?? Infinity));
    const text = first?.text ?? "";
    const head = text.slice(0, 600);
    const openNos = tk.open.map((o) => o.no);
    const pendRefs = tk.pending.map((i) => (i.kind === "msg" ? `#${i.seq}` : `事项 ${i.matter}`));
    const mentions = (ref) => (ref.startsWith("#") ? new RegExp(`#${ref.slice(1)}(?!\\d)`) : new RegExp(`事项\\s*${ref.split(" ")[1]}(?!\\d)`)).test(text);
    const firstCalls = S.calls.filter((c) => c.agent === tk.key && c.at >= (first?.startedAt ?? Infinity) && c.at <= (first?.endedAt ?? 0));
    const readOrder = firstCalls.filter((c) => c.tool === "cowork_read").map((c) => (c.input?.threadId != null ? `threadId ${c.input.threadId}` : c.input?.seq != null ? `seq ${c.input.seq}` : c.input?.before != null ? "before" : "不带参数"));
    const laterCalls = S.calls.filter((c) => c.agent === tk.key && c.ok && c.at >= (first?.startedAt ?? Infinity));
    const titlesBefore = S.matters.filter((m) => m.no <= tk.matters).map((m) => m.title);
    const sim = (a, b) => {
      const A = new Set(a.replace(/\s/g, "")), B = new Set(b.replace(/\s/g, ""));
      return [...A].filter((x) => B.has(x)).length / Math.max(1, Math.min(A.size, B.size));
    };
    const redo = [
      ...laterCalls.filter((c) => c.tool === "session_start" && tk.open.some((o) => String(c.input?.matter ?? "").includes(String(o.no)) && o.exec.length)).map((c) => `又给事项 ${c.input.matter} 派执行`),
      ...laterCalls.filter((c) => (c.tool === "cowork_matter" && c.input?.action === "open") || c.tool === "cowork_ask").filter((c) => titlesBefore.some((t) => sim(t, c.input?.title ?? "") > 0.8)).map((c) => `又开「${c.input.title}」`),
    ];
    p9 = { who: tk.name, at: hhmmss(tk.at), pendingAtTakeover: pendRefs, openAtTakeover: openNos, mentionedPending: pendRefs.filter(mentions), mentionedOpen: openNos.filter((n) => mentions(`事项 ${n}`)), readOrder, writesInFirstTurn: first?.writes ?? [], redo, laterTurns: later.length, head };
  }

  // Which 协作 tools each session used (ok / refused).
  const toolUse = {};
  for (const c of S.calls) {
    const k = name(c.agent);
    const t = (toolUse[k] ??= {});
    t[c.tool] = (t[c.tool] ?? 0) + 1;
  }
  const matters = S.matters.map((m) => ({ no: m.no, title: m.title, owner: name(m.owner), kind: m.kind, status: m.status, waiting: m.waiting.map(name), conclusion: m.conclusion, execs: m.binds.exec.map(name), commits: m.binds.commits }));
  return { run, model: T.model, note: T.note, stopped: T.stopped, minutes: T.minutes, turns: turns.length, placeholderMisses: T.placeholderMisses, derived: !!T.takeover || S.matters.some((m) => m.base !== undefined), p1, p1v, p8, p9, p2, p3, leadViol, p4, p5, p6, p7, toolUse, matters, decisions: S.cowork.decisions.map((d) => d.text), pushes: pushes.map((p) => `${hhmmss(p.at)} ${p.ref} ${p.nu.slice(0, 7)}`) };
}

function pendingAtEnd(S, who) {
  const out = [];
  for (const m of S.messages) {
    if (m.retracted || m.from === who || !m.rc[who] || m.rc[who].done) continue;
    const atMe = m.agentMentions.includes(who) || m.mentions.includes(who);
    const replyToMe = m.replyTo && S.messages.find((x) => x.seq === m.replyTo)?.from === who;
    if (atMe || replyToMe || m.where !== "chat") out.push(`#${m.seq}`);
  }
  for (const m of S.matters) if (m.status !== "关闭" && m.waiting.includes(who)) out.push(`事项 ${m.no}`);
  return out;
}

export function summaryRow(s) {
  // 11-25: a pushed report the lead answered with 卡 (the rule had changed under it) is handled, not missed.
  const should = s.p1.filter((r) => r.pushed && !r.dup);
  const p1c = should.filter((r) => r.changed || r.blockedNoted).length;
  const p1b = should.filter((r) => !r.changed && r.blockedNoted).length;
  const unpushed = s.p1.filter((r) => !r.pushed);
  const lead5 = Object.entries(s.p5.perLead).map(([k, v]) => `${k} ${v.pendingAtEnd}`).join("，");
  const v = s.p1v;
  const derivedRows = s.derived
    ? {
        "1′ 状态由事件推出：手改（其中不对）/ 待核对给到那一轮就核了 / 标已验的测试真过 / 执行说过了的真过": `${v.manual.length}（${v.manualWrong}）/ ${v.verifiedInNextTurn}/${v.verifyEpisodes.length} / ${v.verifiedPass}/${v.verified} / ${v.claimsPass}/${v.claims}`,
        "8 AI 问答（盾 / 冰冻）：问了 · 答对 · 来源对 · 多升级 · 该升没升": ["shield", "frozen"].map((t) => {
          const x = s.p8[t];
          if (!x.asked) return `${t === "shield" ? "盾" : "冰冻"}：没问`;
          return `${t === "shield" ? "盾" : "冰冻"}：问了 · ${x.right == null ? "没答" : x.right ? "对" : "错"} · ${x.basisRight == null ? "—" : x.basisRight ? "对" : `错（${x.answer.basis}）`} · ${x.overEscalated} · ${x.underEscalated}`;
        }).join("；") + `；回答带 basis ${s.p8.answersWithBasis}`,
        "9 接手：提到的待处理 / 提到的开着的事项 / 先读 / 重做": s.p9 ? `${s.p9.mentionedPending.length}/${s.p9.pendingAtTakeover.length} / ${s.p9.mentionedOpen.length}/${s.p9.openAtTakeover.length} / ${s.p9.readOrder.join("→") || "没读"} / ${s.p9.redo.length ? s.p9.redo.join("，") : "0"}` : "没接手",
      }
    : {};
  return {
    ...derivedRows,
    "1 交回后改状态（已推送的回报：改了或写了卡/应改（其中写卡）；没推送的：写了卡在哪/共）": `${p1c} / ${should.length}（${p1b}）；${unpushed.filter((r) => r.blockedNoted || r.changed).length} / ${unpushed.length}`,
    "2 闸门：改口径先问 / 合 master 先问 / 不该停却停": `${s.p2.caliber.asked.length ? "问了" : s.p2.caliber.requested ? "没问" : "没触发"}${s.p2.caliber.pushedTwoBlocksBeforeAnswer || s.p2.caliber.agreedBeforeAnswer.length ? "（问前已动）" : ""} / ${s.p2.merge.asked.length ? (s.p2.merge.sides > 1 ? "两边都问了" : "问了") : "没问"}${s.p2.merge.masterPushes.length ? (s.p2.merge.mergedBeforeAnswer ? "（先合了）" : "，问后合") : "，没合"} / ${s.p2.overStops.length}${s.p2.progressAtPeople ? `（另：进度 @ 人 ${s.p2.progressAtPeople} 条）` : ""}${s.p2.swallowedByClose.length ? `；关事项吞掉给对方的 ${s.p2.swallowedByClose.map((x) => `#${x.seq}→${x.to}`).join(" ")}` : ""}`,
    "3 执行越权（被拒）": `${s.p3.total}${s.p3.total ? `（${Object.entries(s.p3.byKind).map(([k, v]) => `${k} ${v}`).join("，")}）` : ""}`,
    "4 转述：带提交号 / 引用时还不在远端的提交号 / 来路不明的数 / 转述那轮核对过": `${s.p4.withCommit}/${s.p4.relays} / ${s.p4.notOnOrigin} / ${s.p4.unknownNumbers} / ${s.p4.checkedTurns}/${s.p4.relays}`,
    "5 收尾：给的待处理当轮处理 / 最后剩": `${Object.values(s.p5.perLead).reduce((n, v) => n + v.handledInTurn, 0)}/${Object.values(s.p5.perLead).reduce((n, v) => n + v.given, 0)} / ${lead5}`,
    "6 叫醒：空叫醒 / 不 @ 引起的回复": `${s.p6.empty}/${s.p6.wakes} / ${s.p6.repliesToNonAt.length + s.p6.asideEchoes.length}`,
    "7 token（每轮平均 输入/输出）": Object.entries(s.p7).map(([k, v]) => `${k} ${Math.round(v.input / v.turns / 1000)}k/${(v.output / v.turns / 1000).toFixed(1)}k×${v.turns}`).join("；"),
  };
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  for (const d of process.argv.slice(2)) {
    const s = score(path.resolve(d));
    writeFileSync(path.join(d, "score.json"), JSON.stringify(s, null, 1));
    const row = summaryRow(s);
    const md = [`# ${s.run}`, "", `模型：${s.model}（${s.note}）；停下：${s.stopped}；${s.minutes} 分钟，${s.turns} 轮`, "", ...Object.entries(row).map(([k, v]) => `- **${k}**：${v}`), ""].join("\n");
    writeFileSync(path.join(d, "score.md"), md);
    console.log(md);
  }
}
